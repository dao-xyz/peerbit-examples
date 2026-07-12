import { describe, expect, it, vi } from "vitest";
import type { AbstractFile } from "@peerbit/please-lib";
import {
    applyRemoteRootConfirmation,
    createRemoteRootConfirmationScheduler,
    createRemoteRootReconciliationState,
    invalidateRemoteRootAbsenceForVisibleRoots,
    isRemoteRootObservationCurrent,
    observeLocalRootSnapshot,
    observeRemoteRootSnapshot,
    recordExplicitRootChange,
} from "../src/remote-root-reconciliation";

const root = (id: string, modified = 1n, head = `${id}-${modified}`) =>
    ({
        id,
        name: `${id}.bin`,
        size: 1n,
        __context: { head, modified },
    }) as AbstractFile;

describe("remote root reconciliation", () => {
    it("retains a partial absence until an exact lookup confirms missing", () => {
        const state = createRemoteRootReconciliationState();
        const discovered = root("remote");
        observeLocalRootSnapshot(state, []);
        expect(observeRemoteRootSnapshot(state, [discovered])).toMatchObject({
            visibleRoots: [discovered],
            confirmationIds: [],
        });
        expect(state.remoteOnlyIds.has("remote")).toBe(true);

        const partial = observeRemoteRootSnapshot(state, []);
        expect(partial.confirmationIds).toEqual(["remote"]);
        expect(state.remoteOnlyIds.has("remote")).toBe(true);
        expect(
            applyRemoteRootConfirmation(state, "remote", {
                status: "unknown",
            })
        ).toEqual({ type: "retain", retry: true });
        expect(state.remoteOnlyIds.has("remote")).toBe(true);

        expect(
            applyRemoteRootConfirmation(state, "remote", {
                status: "missing",
            })
        ).toEqual({ type: "remove", retry: false });
        expect(state.remoteOnlyIds.has("remote")).toBe(false);
        expect(state.suppressedIds.has("remote")).toBe(true);
        expect(state.suppressedIds.get("remote")?.version).toEqual({
            head: "remote-1",
            modified: 1n,
        });
    });

    it("never schedules or removes a locally observed root for remote absence", () => {
        const state = createRemoteRootReconciliationState();
        const local = root("local");
        observeLocalRootSnapshot(state, [local]);
        observeRemoteRootSnapshot(state, [local]);

        expect(observeRemoteRootSnapshot(state, []).confirmationIds).toEqual(
            []
        );
        expect(
            applyRemoteRootConfirmation(state, "local", {
                status: "missing",
            })
        ).toEqual({ type: "retain", retry: false });
        expect(state.localRootIds.has("local")).toBe(true);
        expect(state.suppressedIds.has("local")).toBe(false);
    });

    it("moves a root that vanished locally into exact-confirmation provenance", () => {
        const state = createRemoteRootReconciliationState();
        observeLocalRootSnapshot(state, [root("local")]);

        observeLocalRootSnapshot(state, []);
        expect(state.localRootIds.has("local")).toBe(false);
        expect(state.remoteOnlyIds.has("local")).toBe(true);
        expect(observeRemoteRootSnapshot(state, []).confirmationIds).toEqual([
            "local",
        ]);
    });

    it("filters stale bulk additions without clearing suppression", () => {
        const state = createRemoteRootReconciliationState();
        recordExplicitRootChange(state, {
            removed: [root("root", 5n)],
            added: [],
        });

        const bulk = observeRemoteRootSnapshot(state, [root("root", 5n)]);
        expect(bulk.visibleRoots).toEqual([]);
        expect(bulk.confirmationIds).toEqual(["root"]);
        expect(state.suppressedIds.has("root")).toBe(true);
    });

    it("rejects stale or unversioned exact presence and accepts only a newer recreation", () => {
        const state = createRemoteRootReconciliationState();
        const removed = root("root", 5n);
        recordExplicitRootChange(state, {
            removed: [removed],
            added: [],
        });

        expect(
            applyRemoteRootConfirmation(state, "root", {
                status: "present",
                root: removed,
            })
        ).toEqual({ type: "retain", retry: true });
        expect(
            applyRemoteRootConfirmation(state, "root", {
                status: "present",
                root: root("root", 4n),
            })
        ).toEqual({ type: "retain", retry: true });
        expect(
            applyRemoteRootConfirmation(state, "root", {
                status: "present",
                root: {
                    id: "root",
                    name: "root.bin",
                    size: 1n,
                } as AbstractFile,
            })
        ).toEqual({ type: "retain", retry: true });
        expect(state.suppressedIds.has("root")).toBe(true);

        const recreated = root("root", 6n);
        expect(
            applyRemoteRootConfirmation(state, "root", {
                status: "present",
                root: recreated,
            })
        ).toEqual({ type: "merge", root: recreated, retry: false });
        expect(state.suppressedIds.has("root")).toBe(false);
        expect(state.remoteOnlyIds.has("root")).toBe(true);
    });

    it("lets an authoritative explicit add win after a removal", () => {
        const state = createRemoteRootReconciliationState();

        recordExplicitRootChange(state, {
            removed: [root("root", 5n)],
            added: [root("root", 6n)],
        });
        expect(state.suppressedIds.has("root")).toBe(false);
        expect(state.remoteOnlyIds.has("root")).toBe(false);
        expect(state.localRootIds.has("root")).toBe(true);
    });

    it("invalidates an older missing confirmation when a newer bulk snapshot sees the root", async () => {
        const state = createRemoteRootReconciliationState();
        const discovered = root("remote", 1n);
        observeRemoteRootSnapshot(state, [discovered]);
        expect(observeRemoteRootSnapshot(state, []).confirmationIds).toEqual([
            "remote",
        ]);

        let releaseMissing: () => void = () => {};
        const onResult = vi.fn((id: string) => {
            applyRemoteRootConfirmation(state, id, { status: "missing" });
            return "complete" as const;
        });
        const scheduler = createRemoteRootConfirmationScheduler<
            { revision: number },
            { status: "missing" }
        >({
            confirm: () =>
                new Promise((resolve) => {
                    releaseMissing = () => resolve({ status: "missing" });
                }),
            onResult,
        });

        const pending = scheduler.schedule(["remote"], { revision: 1 });
        await Promise.resolve();
        await Promise.resolve();
        const visible = observeRemoteRootSnapshot(state, [root("remote", 2n)]);
        invalidateRemoteRootAbsenceForVisibleRoots(
            scheduler,
            visible.visibleRoots
        );
        releaseMissing();
        await pending;

        expect(onResult).not.toHaveBeenCalled();
        expect(state.remoteOnlyIds.has("remote")).toBe(true);
        expect(state.suppressedIds.has("remote")).toBe(false);
    });

    it("rejects stale generation, program, and root-revision observations", () => {
        const program = {};
        const expected = { generation: 2, program, rootRevision: 4 };
        expect(isRemoteRootObservationCurrent(expected, expected)).toBe(true);
        expect(
            isRemoteRootObservationCurrent(
                { ...expected, generation: 3 },
                expected
            )
        ).toBe(false);
        expect(
            isRemoteRootObservationCurrent(
                { ...expected, program: {} },
                expected
            )
        ).toBe(false);
        expect(
            isRemoteRootObservationCurrent(
                { ...expected, rootRevision: 5 },
                expected
            )
        ).toBe(false);
    });

    it("caps and rotates work while respecting concurrency", async () => {
        let active = 0;
        let maxActive = 0;
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const calls: string[] = [];
        let firstRetry = true;
        const scheduler = createRemoteRootConfirmationScheduler<
            { revision: number },
            string
        >({
            maxCandidatesPerRun: 8,
            concurrency: 2,
            confirm: async (id) => {
                calls.push(id);
                active += 1;
                maxActive = Math.max(maxActive, active);
                await gate;
                active -= 1;
                return id;
            },
            onResult: (id) => {
                if (id === "root-0" && firstRetry) {
                    firstRetry = false;
                    return "retry";
                }
                return "complete";
            },
        });

        const firstRun = scheduler.schedule(
            Array.from({ length: 10 }, (_, index) => `root-${index}`),
            { revision: 1 }
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(calls).toEqual(["root-0", "root-1"]);
        expect(maxActive).toBe(2);
        release();
        await firstRun;
        expect(calls).toEqual(
            Array.from({ length: 8 }, (_, index) => `root-${index}`)
        );
        expect(scheduler.queuedSize).toBe(3);

        await scheduler.schedule([], { revision: 2 });
        expect(calls.slice(8)).toEqual(["root-8", "root-9", "root-0"]);
        expect(maxActive).toBe(2);
        expect(scheduler.queuedSize).toBe(0);
    });

    it("defers an immediate reschedule after forgetting an in-flight id", async () => {
        const releases: Array<() => void> = [];
        const calls: string[] = [];
        const scheduler = createRemoteRootConfirmationScheduler<
            { revision: number },
            string
        >({
            confirm: (id) => {
                calls.push(id);
                return new Promise<string>((resolve) => {
                    releases.push(() => resolve(id));
                });
            },
            onResult: () => "complete",
        });

        const first = scheduler.schedule(["root"], { revision: 1 });
        await Promise.resolve();
        await Promise.resolve();
        expect(scheduler.isPending("root")).toBe(true);
        scheduler.forget("root");
        const replacement = scheduler.schedule(["root"], { revision: 2 });
        expect(scheduler.isPending("root")).toBe(true);

        releases.shift()!();
        await vi.waitFor(() => {
            expect(calls).toEqual(["root", "root"]);
        });
        releases.shift()!();
        await Promise.all([first, replacement]);
        expect(scheduler.isPending("root")).toBe(false);
    });

    it("requeues a stale result with the latest observed context", async () => {
        let releaseFirst: () => void = () => {};
        let attempt = 0;
        const appliedRevisions: number[] = [];
        const scheduler = createRemoteRootConfirmationScheduler<
            { revision: number },
            string
        >({
            confirm: async (id) => {
                attempt += 1;
                if (attempt === 1) {
                    await new Promise<void>((resolve) => {
                        releaseFirst = resolve;
                    });
                }
                return id;
            },
            onResult: (_id, _result, context) => {
                appliedRevisions.push(context.revision);
                return context.revision === 2 ? "complete" : "retry";
            },
        });

        const first = scheduler.schedule(["root"], { revision: 1 });
        await Promise.resolve();
        await Promise.resolve();
        const latest = scheduler.schedule(["root"], { revision: 2 });
        releaseFirst();
        await Promise.all([first, latest]);

        expect(attempt).toBe(2);
        expect(appliedRevisions).toEqual([1, 2]);
        expect(scheduler.isPending("root")).toBe(false);
    });

    it("starts and awaits a new epoch immediately after reset", async () => {
        let releaseFresh: () => void = () => {};
        const scheduler = createRemoteRootConfirmationScheduler<
            { revision: number },
            string
        >({
            confirm: (id, signal) => {
                if (id === "old") {
                    return new Promise<string>((resolve) => {
                        signal.addEventListener("abort", () => resolve(id), {
                            once: true,
                        });
                    });
                }
                return new Promise<string>((resolve) => {
                    releaseFresh = () => resolve(id);
                });
            },
            onResult: () => "complete",
        });

        const oldDrain = scheduler.schedule(["old"], { revision: 1 });
        await Promise.resolve();
        await Promise.resolve();
        scheduler.reset();
        const freshDrain = scheduler.schedule(["fresh"], { revision: 2 });
        expect(freshDrain).not.toBe(oldDrain);
        let freshSettled = false;
        void freshDrain.then(() => {
            freshSettled = true;
        });
        await oldDrain;
        await Promise.resolve();
        expect(freshSettled).toBe(false);

        releaseFresh();
        await freshDrain;
        expect(freshSettled).toBe(true);
        expect(scheduler.isPending("fresh")).toBe(false);
    });

    it("singleflights ids and aborts shared in-flight work on reset", async () => {
        const signals: AbortSignal[] = [];
        const onResult = vi.fn(() => "complete" as const);
        const scheduler = createRemoteRootConfirmationScheduler<
            { revision: number },
            string
        >({
            confirm: (id, signal) => {
                signals.push(signal);
                return new Promise<string>((resolve) => {
                    signal.addEventListener("abort", () => resolve(id), {
                        once: true,
                    });
                });
            },
            onResult,
        });

        const first = scheduler.schedule(["root"], { revision: 1 });
        await Promise.resolve();
        await Promise.resolve();
        const duplicate = scheduler.schedule(["root"], { revision: 1 });
        expect(signals).toHaveLength(1);
        scheduler.reset();
        await Promise.all([first, duplicate]);

        expect(signals[0].aborted).toBe(true);
        expect(onResult).not.toHaveBeenCalled();
        expect(scheduler.inFlightSize).toBe(0);
        expect(scheduler.queuedSize).toBe(0);
    });
});
