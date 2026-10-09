import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedFileSystem } from "../index.js";

const START_MS = 100_000;
const SETTLE_MS = 5_000;
const CONFIRMATION_GAP_MS = 100;

const readinessFixture = () => {
    const program: any = new SharedFileSystem();
    Object.assign(program, {
        openGeneration: 7,
        lifecycleRequestGeneration: 3,
        writeReadinessLifecycleBlocked: false,
        writeReadinessRequired: true,
        writesReady: false,
        writeReadinessDecisionSettled: true,
        writeReadinessRemoteEvidence: true,
        writeReadinessStartedAtMs: START_MS,
        lastRemoteArrivalMs: START_MS,
        writeReadinessSettleMs: SETTLE_MS,
        writeReadinessQuietChecks: 0,
        writeReadinessCheckRunning: false,
        writeReadinessCheckRunningRequestGeneration: undefined,
        writeReadinessWaiters: [],
        writeReadinessTransitionChain: Promise.resolve(),
        bootstrapPhase: "off",
        replicate: { factor: 1 },
        clock: Date.now,
    });
    program.hasConnectedRemoteReplicator = vi.fn(async () => true);
    program.synchronizerIdle = vi.fn(() => true);
    program.emitSynchronizerIdleOnce = vi.fn();
    program.writeBootstrapState = vi.fn(async () => undefined);
    program.setGuardArmed = vi.fn();
    program.emitWriteReadyOnce = vi.fn();
    program.bootstrapStatus = vi.fn(() => ({
        writeReady: program.writesReady,
    }));
    // Prerequisite mode (PR-3 commit 2): the tracker also requires the
    // readiness coordinator's containment (`satisfied()`). These cases pin
    // the tracker's own scheduling, so the coordinator is satisfied unless
    // a case says otherwise; `onEvaluate` is the hook the tracker gave it.
    const readiness = {
        satisfied: true,
        onEvaluate: undefined as
            | undefined
            | ((evaluation: { satisfied: boolean; changed: boolean }) => void),
    };
    program.readinessRuntime = {
        startJoin: vi.fn((options: any) => {
            readiness.onEvaluate = options.onEvaluate;
        }),
        satisfied: vi.fn(() => readiness.satisfied),
        evaluate: vi.fn(),
        markReady: vi.fn(),
        status: vi.fn(() => undefined),
    };
    program.readinessFixture = readiness;
    return program;
};

describe("shared fs write-readiness scheduler", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(START_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("checks on the exact quiet deadline and confirms independently", async () => {
        const program = readinessFixture();
        program.startWriteReadinessTracking(program.openGeneration);
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
        expect(program.writeReadinessQuietChecks).toBe(0);
        expect(program.writesReady).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(program.writeReadinessQuietChecks).toBe(1);
        expect(program.writesReady).toBe(false);

        await vi.advanceTimersByTimeAsync(CONFIRMATION_GAP_MS - 1);
        expect(program.writesReady).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        expect(program.writesReady).toBe(true);
        expect(program.writeBootstrapState).toHaveBeenCalledTimes(1);
        expect(program.hasConnectedRemoteReplicator).toHaveBeenCalledTimes(3);
    });

    it("rechecks as soon as the bootstrap decision settles", async () => {
        // Both peers called bootstrap(): discovery waits out its deadline,
        // so the decision settles after the quiet window already elapsed,
        // between interval ticks (at 5 s and 6 s).
        const program = readinessFixture();
        program.writeReadinessDecisionSettled = false;
        let settleDecision!: () => void;
        program.trackBootstrapDecision(
            new Promise<void>((resolve) => {
                settleDecision = resolve;
            }),
            program.openGeneration,
            program.lifecycleRequestGeneration
        );
        program.startWriteReadinessTracking(program.openGeneration);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
        expect(program.writeReadinessQuietChecks).toBe(0);
        expect(program.hasConnectedRemoteReplicator).not.toHaveBeenCalled();

        settleDecision();
        await vi.advanceTimersByTimeAsync(CONFIRMATION_GAP_MS);
        expect(program.writeReadinessDecisionSettled).toBe(true);
        // The #403 hook also re-evaluates the coordinator.
        expect(program.readinessRuntime.evaluate).toHaveBeenCalledTimes(1);
        expect(program.writeReadinessQuietChecks).toBe(1);
        await vi.advanceTimersByTimeAsync(CONFIRMATION_GAP_MS);

        // Before the next interval tick at 6 s.
        expect(program.writesReady).toBe(true);
        expect(program.hasConnectedRemoteReplicator).toHaveBeenCalledTimes(2);
    });

    it("waits for the next tick when the decision settles without a recheck", async () => {
        // The contrast for the test above: flipping only the flag leaves the
        // check on the interval.
        const program = readinessFixture();
        program.writeReadinessDecisionSettled = false;
        program.startWriteReadinessTracking(program.openGeneration);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);

        program.writeReadinessDecisionSettled = true;
        await vi.advanceTimersByTimeAsync(2 * CONFIRMATION_GAP_MS);
        expect(program.writesReady).toBe(false);
        expect(program.hasConnectedRemoteReplicator).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(300 + CONFIRMATION_GAP_MS);
        expect(program.writesReady).toBe(true);
    });

    it("pulls the check forward when an injected clock runs ahead", async () => {
        // The due time is on setTimeout's timebase, so a test clock moved
        // ahead of the timers does not make the pending tick look imminent.
        const program = readinessFixture();
        let clockOffsetMs = 0;
        program.clock = () => Date.now() + clockOffsetMs;
        program.writeReadinessDecisionSettled = false;
        program.startWriteReadinessTracking(program.openGeneration);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);

        clockOffsetMs = 60_000;
        program.settleWriteReadinessDecision(
            program.openGeneration,
            program.lifecycleRequestGeneration
        );
        await vi.advanceTimersByTimeAsync(2 * CONFIRMATION_GAP_MS);
        expect(program.writesReady).toBe(true);
    });

    it("ignores a decision settled for an older lifecycle", async () => {
        const program = readinessFixture();
        program.writeReadinessDecisionSettled = false;
        program.startWriteReadinessTracking(program.openGeneration);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);

        program.settleWriteReadinessDecision(
            program.openGeneration,
            program.lifecycleRequestGeneration - 1
        );
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(program.writeReadinessDecisionSettled).toBe(false);
        expect(program.writesReady).toBe(false);
        expect(program.hasConnectedRemoteReplicator).not.toHaveBeenCalled();
        program.clearBootstrapTimers();
    });

    it("keeps a recheck that lands during a check for a prompt rerun", async () => {
        // Scheduler contract only: today's single caller (the bootstrap
        // decision) cannot land mid-check, since a check awaits only after
        // the decision settled. This drives writeReadinessRecheck directly.
        const program = readinessFixture();
        program.writeReadinessStartedAtMs = START_MS - SETTLE_MS;
        program.lastRemoteArrivalMs = START_MS - SETTLE_MS;
        let releaseProbe!: (value: boolean) => void;
        program.hasConnectedRemoteReplicator = vi
            .fn()
            .mockReturnValueOnce(
                new Promise<boolean>((resolve) => {
                    releaseProbe = resolve;
                })
            )
            .mockResolvedValue(true);

        program.startWriteReadinessTracking(program.openGeneration);
        await vi.advanceTimersByTimeAsync(0);
        expect(program.writeReadinessCheckRunning).toBe(true);

        // Two rechecks mid-await coalesce into one prompt rerun instead of
        // being dropped until the next interval tick.
        program.writeReadinessRecheck();
        program.writeReadinessRecheck();
        releaseProbe(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(program.writeReadinessQuietChecks).toBe(0);

        await vi.advanceTimersByTimeAsync(CONFIRMATION_GAP_MS);
        expect(program.writeReadinessQuietChecks).toBe(1);
        await vi.advanceTimersByTimeAsync(CONFIRMATION_GAP_MS);
        expect(program.writesReady).toBe(true);
        expect(program.hasConnectedRemoteReplicator).toHaveBeenCalledTimes(3);
    });

    it("reparks when metadata arrives during the deadline wait", async () => {
        const program = readinessFixture();
        program.startWriteReadinessTracking(program.openGeneration);
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(4_000);
        program.lastRemoteArrivalMs = Date.now();
        program.writeReadinessQuietChecks = 0;

        // The original deadline still wakes, but must plan from the newer
        // arrival rather than count it as a qualified quiet check.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(program.writeReadinessQuietChecks).toBe(0);
        expect(program.writesReady).toBe(false);

        await vi.advanceTimersByTimeAsync(SETTLE_MS - 1_001);
        expect(program.writesReady).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(program.writeReadinessQuietChecks).toBe(1);
        expect(program.writesReady).toBe(false);

        await vi.advanceTimersByTimeAsync(CONFIRMATION_GAP_MS);
        expect(program.writesReady).toBe(true);
    });

    it("restarts the full quiet window for an arrival between confirmations", async () => {
        const program = readinessFixture();
        program.startWriteReadinessTracking(program.openGeneration);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(program.writeReadinessQuietChecks).toBe(1);

        await vi.advanceTimersByTimeAsync(CONFIRMATION_GAP_MS / 2);
        program.lastRemoteArrivalMs = Date.now();
        program.writeReadinessQuietChecks = 0;
        await vi.advanceTimersByTimeAsync(CONFIRMATION_GAP_MS / 2);
        expect(program.writeReadinessQuietChecks).toBe(0);
        expect(program.writesReady).toBe(false);

        await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
        expect(program.writesReady).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(program.writeReadinessQuietChecks).toBe(1);
        await vi.advanceTimersByTimeAsync(CONFIRMATION_GAP_MS);
        expect(program.writesReady).toBe(true);
    });

    it("keeps an in-flight old-generation probe from owning a reopen", async () => {
        const program = readinessFixture();
        let releaseOld!: (value: boolean) => void;
        let releaseNew!: (value: boolean) => void;
        const oldProbe = new Promise<boolean>((resolve) => {
            releaseOld = resolve;
        });
        const newProbe = new Promise<boolean>((resolve) => {
            releaseNew = resolve;
        });
        program.hasConnectedRemoteReplicator = vi
            .fn()
            .mockReturnValueOnce(oldProbe)
            .mockReturnValueOnce(newProbe);

        program.startWriteReadinessTracking(program.openGeneration);
        await vi.advanceTimersByTimeAsync(0);
        expect(program.writeReadinessCheckRunningRequestGeneration).toBe(3);

        program.writeReadinessLifecycleBlocked = true;
        program.lifecycleRequestGeneration = 4;
        program.clearBootstrapTimers();
        program.openGeneration = 8;
        program.lifecycleRequestGeneration = 5;
        program.writeReadinessLifecycleBlocked = false;
        program.writeReadinessCheckRunning = false;
        program.writeReadinessCheckRunningRequestGeneration = undefined;
        program.writeReadinessStartedAtMs = Date.now();
        program.lastRemoteArrivalMs = Date.now();
        program.startWriteReadinessTracking(program.openGeneration);
        await vi.advanceTimersByTimeAsync(0);
        const reopenedTimer = program.writeReadinessTimer;
        expect(program.writeReadinessCheckRunningRequestGeneration).toBe(5);

        releaseOld(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(program.writeReadinessTimer).toBe(reopenedTimer);
        expect(program.writeReadinessCheckRunning).toBe(true);
        expect(program.writeReadinessCheckRunningRequestGeneration).toBe(5);

        releaseNew(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(program.writeReadinessCheckRunning).toBe(false);
        expect(program.writeReadinessTimer).toBeDefined();
        program.clearBootstrapTimers();
    });

    it("retries a failed durable marker from two fresh checks", async () => {
        const program = readinessFixture();
        program.writeBootstrapState = vi
            .fn()
            .mockRejectedValueOnce(new Error("simulated marker failure"))
            .mockResolvedValueOnce(undefined);
        program.startWriteReadinessTracking(program.openGeneration);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(SETTLE_MS + CONFIRMATION_GAP_MS);

        expect(program.writesReady).toBe(false);
        expect(program.writeReadinessQuietChecks).toBe(0);
        expect(program.writeBootstrapState).toHaveBeenCalledTimes(1);

        // Marker failures retain the normal prerequisite polling interval,
        // then the successful first check still needs a fresh confirmation.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(program.writeReadinessQuietChecks).toBe(1);
        expect(program.writesReady).toBe(false);
        await vi.advanceTimersByTimeAsync(CONFIRMATION_GAP_MS);

        expect(program.writesReady).toBe(true);
        expect(program.writeBootstrapState).toHaveBeenCalledTimes(2);
        expect(program.writeReadinessTimer).toBeUndefined();
    });

    it("waits for the coordinator's containment, pulled forward when it is satisfied", async () => {
        const program = readinessFixture();
        program.readinessFixture.satisfied = false;
        program.startWriteReadinessTracking(program.openGeneration);
        expect(program.readinessRuntime.startJoin).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
        // Every condition of today's tracker holds; the containment does
        // not, so no quiet check counts.
        expect(program.writeReadinessQuietChecks).toBe(0);
        expect(program.writesReady).toBe(false);
        expect(program.hasConnectedRemoteReplicator).not.toHaveBeenCalled();

        // An evaluation that turns satisfied pulls the next check forward
        // (the interval tick is at 6 s); the two checks still apply.
        program.readinessFixture.satisfied = true;
        program.readinessFixture.onEvaluate({
            satisfied: true,
            changed: true,
        });
        await vi.advanceTimersByTimeAsync(CONFIRMATION_GAP_MS);
        expect(program.writeReadinessQuietChecks).toBe(1);
        expect(program.writesReady).toBe(false);
        await vi.advanceTimersByTimeAsync(CONFIRMATION_GAP_MS);
        expect(program.writesReady).toBe(true);
        expect(program.readinessRuntime.markReady).toHaveBeenCalledTimes(1);
        expect(program.writeBootstrapState).toHaveBeenCalledTimes(1);
    });

    it("decides on the containment in the transition: lost between the checks, it stays gated", async () => {
        const program = readinessFixture();
        program.startWriteReadinessTracking(program.openGeneration);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(program.writeReadinessQuietChecks).toBe(1);

        // A new required peer appears before the confirmation.
        program.readinessFixture.satisfied = false;
        await vi.advanceTimersByTimeAsync(CONFIRMATION_GAP_MS);
        expect(program.writeReadinessQuietChecks).toBe(0);
        // Even a check already past its prerequisites does not commit:
        // markWriteReady reads the predicate again in its slot.
        program.writeReadinessQuietChecks = 2;
        await program.markWriteReady(program.openGeneration);
        expect(program.writesReady).toBe(false);
        expect(program.writeBootstrapState).not.toHaveBeenCalled();
        expect(program.readinessRuntime.markReady).not.toHaveBeenCalled();
        program.clearBootstrapTimers();
    });

    it("cancels an owned deadline across a lifecycle change", async () => {
        const program = readinessFixture();
        program.startWriteReadinessTracking(program.openGeneration);
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(2_000);
        program.writeReadinessLifecycleBlocked = true;
        program.clearBootstrapTimers();
        expect(program.writeReadinessTimer).toBeUndefined();

        await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
        expect(program.writesReady).toBe(false);
        expect(program.writeBootstrapState).not.toHaveBeenCalled();
    });
});
