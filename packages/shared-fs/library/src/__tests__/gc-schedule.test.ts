import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    computeGcFirstDelay,
    computeGcFollowUpDelay,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const patternedBytes = (size: number, seed = 0) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.byteLength; i++) {
        bytes[i] = (i + seed) % 251;
    }
    return bytes;
};

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const intervalMs = options.intervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    throw lastError;
};

const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

describe("gc schedule delay helpers", () => {
    it("spreads the first run over [initialDelay, initialDelay + interval/4]", () => {
        const initial = 5 * 60 * 1000;
        const interval = 6 * 60 * 60 * 1000;
        expect(computeGcFirstDelay(initial, interval, () => 0)).toBe(initial);
        expect(computeGcFirstDelay(initial, interval, () => 1)).toBe(
            initial + interval / 4
        );
        const mid = computeGcFirstDelay(initial, interval, () => 0.5);
        expect(mid).toBeGreaterThan(initial);
        expect(mid).toBeLessThan(initial + interval / 4);
    });

    it("never lands a follow-up before candidate maturity (worst-case rng)", () => {
        const startedMs = 1_000_000;
        const span = 60 * 60 * 1000;
        const slack = 60_000;
        for (const draw of [0, 1]) {
            // Fired immediately after the recording run: must cover the
            // whole span plus at least one slack.
            const atStart = computeGcFollowUpDelay(
                startedMs,
                span,
                startedMs,
                slack,
                () => draw
            );
            expect(startedMs + atStart).toBeGreaterThanOrEqual(
                startedMs + span + slack
            );
            expect(atStart).toBeLessThanOrEqual(span + 2 * slack);
            // Armed late (well past maturity): positive-only jitter, no
            // negative delay, still at least one slack of settling.
            const late = computeGcFollowUpDelay(
                startedMs,
                span,
                startedMs + span + 500_000,
                slack,
                () => draw
            );
            expect(late).toBeGreaterThanOrEqual(slack);
            expect(late).toBeLessThanOrEqual(2 * slack);
        }
    });
});

describe("scheduled garbage collection", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;
    /** Offset-clock: advances in real time, jumps age GC windows. */
    let clockOffset: number;
    const clock = () => Date.now() + clockOffset;

    const openScheduled = async (
        gc: any,
        extra: Record<string, unknown> = {}
    ) => {
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "gc-schedule-test",
            clock,
            gc,
            ...extra,
        });
        return fs;
    };

    const runEvents: any[] = [];
    const errorEvents: any[] = [];
    const listen = () => {
        (fs.program.events as any).addEventListener("gc:run", (e: any) =>
            runEvents.push(e.detail)
        );
        (fs.program.events as any).addEventListener("gc:error", (e: any) =>
            errorEvents.push(e.detail)
        );
    };

    /** Drive one scheduler tick as if its timer had fired. */
    const tick = (trigger: "interval" | "follow-up" = "interval") =>
        (fs.program as any).gcSchedulerTick(
            trigger,
            (fs.program as any).gcSchedulerGeneration
        ) as Promise<void>;

    beforeEach(async () => {
        clockOffset = 0;
        runEvents.length = 0;
        errorEvents.length = 0;
        peer = await Peerbit.create();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        try {
            await peer.stop();
        } catch {
            // double-stop in teardown is fine
        }
    });

    it("fires scheduled runs on a full replica and gates on bootstrap phase", async () => {
        await openScheduled({
            intervalMs: 30_000,
            initialDelayMs: 60,
            jitterRatio: 0,
            run: { settleMs: 0 },
            testOverrides: { noFloors: true },
        });
        listen();
        expect(fs.gcStatus().scheduled).toBe(true);
        expect(fs.gcStatus().nextRunAtMs).toBeGreaterThan(0);
        await waitUntil(() => {
            expect(runEvents.length).toBeGreaterThan(0);
        });
        const first = runEvents[0];
        expect(first.trigger).toBe("interval");
        expect(first.report.dryRun).toBe(false);
        expect(first.durationMs).toBeGreaterThanOrEqual(0);
        expect(fs.gcStatus().lastRun?.report).toEqual(first.report);

        // A stalled bootstrap phase silent-skips instead of running.
        const before = runEvents.length;
        (fs.program as any).bootstrapPhase = "overlay-active";
        await tick();
        expect(runEvents.length).toBe(before);
        (fs.program as any).bootstrapPhase = "off";
        await tick();
        expect(runEvents.length).toBe(before + 1);
    });

    it("does not schedule on an observer replica", async () => {
        // Create the fs with a first full peer so the observer has an
        // address to open.
        const creator = await openSharedFs({
            peerbit: peer,
            machineLabel: "creator",
        });
        const address = creator.program.address!.toString();
        const observerPeer = await Peerbit.create();
        try {
            await observerPeer.dial(peer.getMultiaddrs());
            const observer = await openSharedFs({
                peerbit: observerPeer,
                address,
                replicate: false,
                gc: {
                    intervalMs: 50,
                    initialDelayMs: 10,
                    testOverrides: { noFloors: true },
                },
            });
            expect(observer.gcStatus().scheduled).toBe(false);
            expect(observer.gcStatus().nextRunAtMs).toBeUndefined();
            await sleep(300);
            expect(observer.gcStatus().lastRun).toBeUndefined();
        } finally {
            await observerPeer.stop();
        }
    });

    it("chains the executing half of the two-run barrier automatically", async () => {
        await openScheduled({
            intervalMs: 10_000,
            initialDelayMs: 80,
            jitterRatio: 0,
            run: { settleMs: 0, keepVersions: 1, minOrphanSpanMs: 700 },
            testOverrides: { noFloors: true, followUpSlackMs: 150 },
        });
        listen();
        await fs.writeFile("/twice.bin", patternedBytes(2048, 1));
        await fs.writeFile("/twice.bin", patternedBytes(2048, 2));
        clockOffset += 40 * DAY_MS;
        await waitUntil(() => {
            expect(
                runEvents.some(
                    (e) =>
                        e.trigger === "interval" &&
                        e.report.chunkCandidatesRecorded > 0
                )
            ).toBe(true);
        });
        // The follow-up must arrive on its own — no manual call, no clock
        // jump: maturity comes from real elapsed time past the span.
        await waitUntil(() => {
            expect(
                runEvents.some(
                    (e) =>
                        e.trigger === "follow-up" &&
                        e.report.deletedChunks > 0
                )
            ).toBe(true);
        });
        expect(await fs.readFile("/twice.bin")).toBeDefined();
    });

    it("backs off on failures and recovers on success", async () => {
        await openScheduled({
            intervalMs: 20_000,
            initialDelayMs: 20_000,
            jitterRatio: 0,
            run: { settleMs: 0 },
            testOverrides: { noFloors: true, backoffBaseMs: 40 },
        });
        listen();
        const program: any = fs.program;
        const original = program.collectGarbageInner.bind(program);
        let failures = 0;
        program.collectGarbageInner = async (...args: any[]) => {
            if (failures < 2) {
                failures++;
                throw new Error("injected gc failure");
            }
            return original(...args);
        };
        const errorSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        await tick();
        expect(errorEvents.length).toBe(1);
        expect(errorEvents[0].consecutiveFailures).toBe(1);
        expect(fs.gcStatus().consecutiveFailures).toBe(1);
        // The failure re-armed a (short, backed-off) retry on its own.
        await waitUntil(() => {
            expect(errorEvents.length).toBe(2);
        });
        expect(errorEvents[1].consecutiveFailures).toBe(2);
        await waitUntil(() => {
            expect(runEvents.length).toBeGreaterThan(0);
        });
        expect(fs.gcStatus().consecutiveFailures).toBe(0);
        expect(errorSpy).toHaveBeenCalled();
    });

    it("gc: false and schedule: false both disable the schedule", async () => {
        await openScheduled(false);
        expect(fs.gcStatus().scheduled).toBe(false);
        expect(fs.gcStatus().nextRunAtMs).toBeUndefined();
        await peer.stop();

        peer = await Peerbit.create();
        await openScheduled({
            schedule: false,
            intervalMs: 30,
            initialDelayMs: 5,
            testOverrides: { noFloors: true },
        });
        listen();
        expect(fs.gcStatus().scheduled).toBe(false);
        await sleep(250);
        expect(runEvents.length).toBe(0);
        expect(fs.gcStatus().lastRun).toBeUndefined();
        // Manual runs stay available regardless of the schedule.
        const manual = await fs.collectGarbage({ settleMs: 0 });
        expect(manual.dryRun).toBe(false);
    });

    it("close() between arm and fire leaves no stray events; reopen re-arms", async () => {
        await openScheduled({
            intervalMs: 5_000,
            initialDelayMs: 60,
            jitterRatio: 0,
            run: { settleMs: 0 },
            testOverrides: { noFloors: true },
        });
        listen();
        const address = fs.program.address!.toString();
        await fs.program.close();
        await sleep(250);
        expect(runEvents.length).toBe(0);
        expect(errorEvents.length).toBe(0);

        const reopened = await openSharedFs({
            peerbit: peer,
            address,
            clock,
            gc: {
                intervalMs: 5_000,
                initialDelayMs: 60,
                jitterRatio: 0,
                run: { settleMs: 0 },
                testOverrides: { noFloors: true },
            } as any,
        });
        fs = reopened;
        // Address opens deserialize the program through borsh, which
        // bypasses field initializers: the generation must still be a
        // finite number (NaN would silently kill every tick).
        expect((fs.program as any).gcSchedulerGeneration).toBe(1);
        expect(fs.gcStatus().scheduled).toBe(true);
        listen();
        await waitUntil(() => {
            expect(runEvents.length).toBeGreaterThan(0);
        });
    });

    it("skips ticks while a manual run holds the mutex; overlap still throws", async () => {
        await openScheduled({
            intervalMs: 20_000,
            initialDelayMs: 20_000,
            run: { settleMs: 0 },
            testOverrides: { noFloors: true },
        });
        listen();
        const program: any = fs.program;
        const original = program.collectGarbageInner.bind(program);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        program.collectGarbageInner = async (...args: any[]) => {
            await gate;
            return original(...args);
        };
        const manual = fs.collectGarbage({ settleMs: 0 });
        await waitUntil(() => {
            expect(program.gcRunning).toBe(true);
        });
        await tick();
        expect(runEvents.length).toBe(0);
        expect(errorEvents.length).toBe(0);
        await expect(fs.collectGarbage({ settleMs: 0 })).rejects.toThrow(
            /already running/
        );
        release();
        await manual;
        expect(program.gcRunning).toBe(false);
    });

    it("defers scheduled runs on an unverified replica with no peer evidence", async () => {
        await openScheduled({
            intervalMs: 500,
            initialDelayMs: 20_000,
            jitterRatio: 0,
            run: { settleMs: 0 },
            testOverrides: { noFloors: true },
        });
        listen();
        const program: any = fs.program;
        const warnSpy = vi
            .spyOn(console, "warn")
            .mockImplementation(() => {});
        program.bootstrapPhase = "converged";
        program.bootstrapVerified = false;
        program.lastArrivalMs = 0; // far beyond intervalMs ago
        await tick();
        await tick();
        expect(runEvents.length).toBe(0);
        const deferrals = warnSpy.mock.calls.filter((c) =>
            String(c[0]).includes("no peer evidence")
        );
        expect(deferrals.length).toBe(1); // loud once, silent after
        // A recent arrival is peer evidence; the next tick runs.
        program.lastArrivalMs = clock();
        await tick();
        expect(runEvents.length).toBe(1);
        // And a VERIFIED converged replica is exempt outright.
        program.bootstrapVerified = true;
        program.lastArrivalMs = 0;
        await tick();
        expect(runEvents.length).toBe(2);
    });

    it("strips unsafe run options with one warning and keeps safe ones", async () => {
        const warnSpy = vi
            .spyOn(console, "warn")
            .mockImplementation(() => {});
        await openScheduled({
            intervalMs: 20_000,
            initialDelayMs: 20_000,
            run: {
                dryRun: true,
                nowMs: 5,
                chunkSweep: "immediate",
                settleMs: 0,
                keepVersions: 3,
            },
            testOverrides: { noFloors: true },
        });
        listen();
        const warnings = warnSpy.mock.calls.filter((c) =>
            String(c[0]).includes("scheduled-gc run option")
        );
        expect(warnings.length).toBe(1);
        for (const stripped of ["dryRun", "nowMs", "chunkSweep"]) {
            expect(String(warnings[0][0])).toContain(stripped);
        }
        const kept = (fs.program as any).gcScheduleConfig.run;
        expect(kept).toEqual({ settleMs: 0, keepVersions: 3 });
        await tick();
        expect(runEvents.length).toBe(1);
        // The scheduled run really ran live (dryRun stripped) on the live
        // clock (nowMs stripped).
        expect(runEvents[0].report.dryRun).toBe(false);
        expect(fs.gcStatus().lastRun?.report.dryRun).toBe(false);
    });
});
