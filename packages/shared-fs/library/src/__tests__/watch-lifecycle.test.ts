import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangesetBarrierHub, type ChangesetHost } from "../changeset.js";
import {
    IgnoreFilteredWatcher,
    type IgnoreWatchHost,
} from "../ignore/watch-filter.js";
import type { CompiledIgnoreRules } from "../ignore/patterns.js";
import {
    WatchHub,
    type FsWatchEvent,
    type FsWatcher,
    type WatchHost,
} from "../watch.js";

const makeError = (code: string, message: string) =>
    Object.assign(new Error(message), { code });

const watchHost = (
    listByParentId: WatchHost["listByParentId"] = async () => []
): WatchHost => ({
    resolvePathDetailed: async (path) => ({
        resolved: { kind: "root", nodeId: "root", path },
        spine: [],
    }),
    listByParentId,
    headsForNodes: async () => new Map(),
    namingStatesForNodes: async () => new Map(),
    localAuthorKey: () => undefined,
    clock: () => Date.now(),
    guardPendingFor: () => false,
    makeError,
    nodeKindOf: () => "directory",
});

const changesetHost = (
    manifestsFor: ChangesetHost["manifestsFor"] = async () => []
): ChangesetHost => ({
    manifestsFor,
    arrivedMemberIds: async () => new Set(),
    hasDocumentId: async () => false,
    bootstrapPhase: () => "off",
    overlayActive: () => false,
    awaitBootstrapConverged: async () => undefined,
    clock: () => Date.now(),
    makeError,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("condition timed out");
        await sleep(1);
    }
};

class StubWatcher implements FsWatcher {
    readonly path = "/";
    readonly ready = Promise.resolve();
    closed = false;
    closeCalls = 0;

    private changeCbs = new Set<(batch: FsWatchEvent[]) => void>();
    private errorCbs = new Set<(error: Error) => void>();
    private closeCbs = new Set<() => void>();

    on(type: any, cb: any): () => void {
        const set =
            type === "change"
                ? this.changeCbs
                : type === "error"
                  ? this.errorCbs
                  : this.closeCbs;
        set.add(cb);
        return () => set.delete(cb);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.closeCalls += 1;
        for (const cb of [...this.closeCbs]) cb();
    }

    [Symbol.asyncIterator](): AsyncIterator<FsWatchEvent[]> {
        return {
            next: async () => ({ value: undefined, done: true }),
        };
    }
}

describe("watcher lifecycle cleanup", () => {
    afterEach(() => vi.restoreAllMocks());

    it("detaches filesystem and changeset abort listeners on manual close", async () => {
        const fsAbort = new AbortController();
        const fsAdd = vi.spyOn(fsAbort.signal, "addEventListener");
        const fsRemove = vi.spyOn(fsAbort.signal, "removeEventListener");
        const watcher = new WatchHub(watchHost()).watch("/", {
            signal: fsAbort.signal,
        });
        await watcher.ready;
        const fsHandler = fsAdd.mock.calls.find(
            ([type]) => type === "abort"
        )?.[1];
        expect(fsHandler).toBeDefined();

        watcher.close();
        expect(fsRemove).toHaveBeenCalledWith("abort", fsHandler);

        const changesetAbort = new AbortController();
        const changesetAdd = vi.spyOn(
            changesetAbort.signal,
            "addEventListener"
        );
        const changesetRemove = vi.spyOn(
            changesetAbort.signal,
            "removeEventListener"
        );
        const stream = new ChangesetBarrierHub(changesetHost()).watch({
            signal: changesetAbort.signal,
        });
        const changesetHandler = changesetAdd.mock.calls.find(
            ([type]) => type === "abort"
        )?.[1];
        expect(changesetHandler).toBeDefined();

        stream.close();
        expect(changesetRemove).toHaveBeenCalledWith("abort", changesetHandler);
    });

    it("aborting closes pending iterators exactly once", async () => {
        const fsAbort = new AbortController();
        const watcher = new WatchHub(watchHost()).watch("/", {
            signal: fsAbort.signal,
        });
        await watcher.ready;
        const fsClosed = vi.fn();
        watcher.on("close", fsClosed);
        const fsNext = watcher[Symbol.asyncIterator]().next();

        fsAbort.abort();

        await expect(fsNext).resolves.toMatchObject({ done: true });
        expect(watcher.closed).toBe(true);
        expect(fsClosed).toHaveBeenCalledTimes(1);
        watcher.close();
        expect(fsClosed).toHaveBeenCalledTimes(1);

        const changesetAbort = new AbortController();
        const stream = new ChangesetBarrierHub(changesetHost()).watch({
            signal: changesetAbort.signal,
        });
        const changesetClosed = vi.fn();
        stream.on("close", changesetClosed);
        const changesetNext = stream[Symbol.asyncIterator]().next();

        changesetAbort.abort();

        await expect(changesetNext).resolves.toMatchObject({ done: true });
        expect(stream.closed).toBe(true);
        expect(changesetClosed).toHaveBeenCalledTimes(1);
        stream.close();
        expect(changesetClosed).toHaveBeenCalledTimes(1);
    });

    it("cancels an owned retry when a filesystem watcher closes", async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
        let retryListCalls = 0;
        const retryHost = watchHost(async () => {
            retryListCalls += 1;
            if (retryListCalls === 1) return [];
            throw new Error("transient read failure");
        });
        const retryHub = new WatchHub(retryHost);
        const retryWatcher = retryHub.watch("/", {
            settleMs: 0,
            maxSettleMs: 0,
        });
        await retryWatcher.ready;
        retryHub.resyncAll("data");

        await waitFor(() =>
            setTimeoutSpy.mock.calls.some(([, delay]) => delay === 50)
        );
        const retryIndex = setTimeoutSpy.mock.calls.findIndex(
            ([, delay]) => delay === 50
        );
        const retryHandle = setTimeoutSpy.mock.results[retryIndex]?.value;
        const callsAtClose = retryListCalls;

        retryWatcher.close();
        expect(clearTimeoutSpy).toHaveBeenCalledWith(retryHandle);
        await sleep(75);
        expect(retryListCalls).toBe(callsAtClose);
    });

    it("cancels a retry when an already-queued flush attempt begins", async () => {
        type Children = Awaited<ReturnType<WatchHost["listByParentId"]>>;
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
        let rejectFirst!: (error: Error) => void;
        let resolveSecond!: (children: Children) => void;
        let markFirstStarted!: () => void;
        let markSecondStarted!: () => void;
        const firstResult = new Promise<Children>((_resolve, reject) => {
            rejectFirst = reject;
        });
        const secondResult = new Promise<Children>((resolve) => {
            resolveSecond = resolve;
        });
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const secondStarted = new Promise<void>((resolve) => {
            markSecondStarted = resolve;
        });
        let listCalls = 0;
        const host = watchHost(async () => {
            listCalls += 1;
            if (listCalls === 1) return [];
            if (listCalls === 2) {
                markFirstStarted();
                return firstResult;
            }
            if (listCalls === 3) {
                markSecondStarted();
                return secondResult;
            }
            return [];
        });
        const hub = new WatchHub(host);
        const watcher = hub.watch("/", {
            settleMs: 0,
            maxSettleMs: 0,
        });
        await watcher.ready;

        hub.resyncAll("data");
        await firstStarted;
        hub.resyncAll("data");
        // Let the second zero-delay flush append behind the blocked first.
        await sleep(10);
        rejectFirst(new Error("first attempt failed"));
        await secondStarted;

        const retryIndex = setTimeoutSpy.mock.calls.findIndex(
            ([, delay]) => delay === 50
        );
        expect(retryIndex).toBeGreaterThanOrEqual(0);
        const retryHandle = setTimeoutSpy.mock.results[retryIndex]?.value;
        expect(clearTimeoutSpy).toHaveBeenCalledWith(retryHandle);

        resolveSecond([]);
        await sleep(0);
        watcher.close();
    });

    it("does not repopulate a file watcher closed during its initial read", async () => {
        type Children = Awaited<ReturnType<WatchHost["listByParentId"]>>;
        let resolveChildren!: (children: Children) => void;
        let markReadStarted!: () => void;
        const children = new Promise<Children>((resolve) => {
            resolveChildren = resolve;
        });
        const readStarted = new Promise<void>((resolve) => {
            markReadStarted = resolve;
        });
        const host: WatchHost = {
            ...watchHost(),
            resolvePathDetailed: async (path) => ({
                resolved: { kind: "file", nodeId: "file", path },
                spine: [{ parentId: "root", name: "file", nodeId: "file" }],
            }),
            listByParentId: async () => {
                markReadStarted();
                return children;
            },
        };
        const watcher = new WatchHub(host).watch("/file", undefined);
        const ready = watcher.ready.catch((error) => error);
        await readStarted;

        watcher.close();
        resolveChildren([
            {
                name: "file",
                nodeId: "file",
                kind: "file",
                state: {
                    nodeId: "file",
                    conflicted: false,
                    winner: {
                        id: "naming",
                        nodeId: "file",
                        parentId: "root",
                        name: "file",
                        deleted: false,
                    },
                },
                contested: false,
                heads: [{ id: "version", nodeId: "file" }],
            },
        ]);

        await expect(ready).resolves.toMatchObject({ code: "EINVAL" });
        await Promise.resolve();
        expect(
            (
                watcher as FsWatcher & {
                    viewSnapshot(): unknown[];
                }
            ).viewSnapshot()
        ).toEqual([]);
    });

    it("prevents an in-flight changeset probe from restoring state after close", async () => {
        let resolveManifests!: (
            value: Awaited<ReturnType<ChangesetHost["manifestsFor"]>>
        ) => void;
        const manifests = new Promise<
            Awaited<ReturnType<ChangesetHost["manifestsFor"]>>
        >((resolve) => {
            resolveManifests = resolve;
        });
        const hub = new ChangesetBarrierHub(
            changesetHost(async () => manifests)
        );
        const result = hub.ensure("closing-probe").catch((error) => error);

        hub.close();
        resolveManifests([]);

        await expect(result).resolves.toMatchObject({ code: "ECLOSED" });
    });

    it("closes an ignore wrapper idempotently despite inner close re-entry", () => {
        const inner = new StubWatcher();
        const unsubscribeRules = vi.fn();
        const rules = {} as CompiledIgnoreRules;
        const host: IgnoreWatchHost = {
            currentRules: () => rules,
            isIgnored: () => false,
            viewSnapshot: () => [],
            onRulesChanged: () => unsubscribeRules,
        };
        const watcher = new IgnoreFilteredWatcher(inner, host, makeError, {
            seedBaseline: false,
        });
        const closeCb = vi.fn();
        watcher.on("close", closeCb);

        watcher.close();
        watcher.close();

        expect(inner.closeCalls).toBe(1);
        expect(unsubscribeRules).toHaveBeenCalledTimes(1);
        expect(closeCb).toHaveBeenCalledTimes(1);
    });

    it("isolates close-listener failures and still notifies later listeners", async () => {
        const watcher = new WatchHub(watchHost()).watch("/", undefined);
        await watcher.ready;
        const later = vi.fn();
        watcher.on("close", () => {
            throw new Error("subscriber failure");
        });
        watcher.on("close", later);

        expect(() => watcher.close()).not.toThrow();
        expect(later).toHaveBeenCalledTimes(1);
    });
});
