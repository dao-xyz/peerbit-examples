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
