type StartupPerfState = {
    runId: string;
    t0: number;
    marks: Record<string, number>;
    data: Record<string, unknown>;
    published: Record<string, boolean>;
};

type PerfEventRecord = { type: string; detail: unknown; t: number };

const getGlobal = (): any => (typeof window !== "undefined" ? (window as any) : {});

const nowMs = () => {
    try {
        return performance.now();
    } catch {
        return Date.now();
    }
};

export const isPerfEnabled = () => {
    try {
        const g = getGlobal();
        const dbg = g.__DBG || {};
        if (dbg.perfEnabled === true || dbg.perf === true) return true;
        // Enable with `?perf`, `?perf=`, or `?perf=1` (search or hash router query)
        const search = new URLSearchParams(window.location.search);
        if (search.get("perf") !== null) return true;

        const hash = window.location.hash || "";
        const qIndex = hash.indexOf("?");
        if (qIndex !== -1) {
            const hashQuery = hash.substring(qIndex + 1);
            const clean = hashQuery.replace(/^\/?/, "");
            const hashParams = new URLSearchParams(clean);
            if (hashParams.get("perf") !== null) return true;
        }

        return false;
    } catch {
        return false;
    }
};

export const initStartupPerf = () => {
    try {
        const g = getGlobal();
        if (g.__STARTUP_PERF) return;
        const t0 = nowMs();
        const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const state: StartupPerfState = {
            runId,
            t0,
            marks: { "app:init": 0 },
            data: {},
            published: {},
        };
        g.__STARTUP_PERF = state;

        // Capture early lifecycle events emitted by @peerbit/react and our app.
        if (!g.__STARTUP_PERF_LISTENERS__) {
            g.__STARTUP_PERF_LISTENERS__ = true;
            window.addEventListener("peer:ready", (e: Event) => {
                try {
                    startupMark("peer:event:ready", (e as CustomEvent).detail);
                } catch {
                    startupMark("peer:event:ready");
                }
            });
            window.addEventListener("draft:ready", (e: Event) => {
                try {
                    startupMark("draft:event:ready", (e as CustomEvent).detail);
                } catch {
                    startupMark("draft:event:ready");
                }
                // Draft ready is a good "app interactive" proxy; publish a summary if perf is enabled.
                publishStartupPerfSnapshot("draft:ready");
            });
            window.addEventListener("__DBG:changed", () => {
                // Allow toggling perf after load and still see the startup snapshot.
                publishStartupPerfSnapshot("dbg:changed");
            });
        }
    } catch {
        // no-op
    }
};

export const startupMark = (name: string, data?: unknown) => {
    try {
        const g = getGlobal();
        const state = g.__STARTUP_PERF as StartupPerfState | undefined;
        if (!state) return;

        if (state.marks[name] === undefined) {
            state.marks[name] = Math.max(0, nowMs() - state.t0);
        }
        if (data !== undefined && state.data[name] === undefined) {
            state.data[name] = data;
        }
    } catch {
        // no-op
    }
};

export const getStartupPerfSnapshot = () => {
    try {
        const g = getGlobal();
        return g.__STARTUP_PERF as StartupPerfState | undefined;
    } catch {
        return undefined;
    }
};

export const emitPerfEvent = (type: string, detail: unknown) => {
    try {
        if (!isPerfEnabled()) return;
        const g = getGlobal();
        const arr = (g.__DBG_PERF_EVENTS ||= []) as PerfEventRecord[];
        const rec: PerfEventRecord = { type, detail, t: Date.now() };
        arr.push(rec);
        if (arr.length > 200) arr.splice(0, arr.length - 200);
        g.__DBG_PERF_EVENTS_COUNT = (g.__DBG_PERF_EVENTS_COUNT ?? 0) + 1;
        window.dispatchEvent(new CustomEvent(`perf:${type}`, { detail }));
    } catch {
        // no-op
    }
};

const computeDurations = (marks: Record<string, number>) => {
    const get = (k: string) => marks[k];
    const d: Record<string, number> = {};

    const pairs: Array<[string, string, string]> = [
        ["auth:keypair:fetch", "auth:keypair:fetch:start", "auth:keypair:fetch:end"],
        ["peer:create", "peer:init:start", "peer:event:ready"],
        ["peer:waitForConnected", "peer:event:ready", "peer:context:ready"],
        ["scope:public:open", "scope:@public:open:start", "scope:@public:open:end"],
        ["scope:private:open", "scope:@private:open:start", "scope:@private:open:end"],
        ["canvas:path:sync", "canvas:path:sync:start", "canvas:path:sync:end"],
        ["canvas:root:create", "canvas:root:create:start", "canvas:root:create:end"],
        ["canvas:root:load", "canvas:root:load:start", "canvas:root:load:end"],
        ["canvas:viewRoot", "peer:context:ready", "canvas:viewRoot:ready"],
        ["draft:readyAfterPeer", "peer:context:ready", "draft:event:ready"],
        ["total:toPeerReadyEvent", "app:init", "peer:event:ready"],
        ["total:toPeerContextReady", "app:init", "peer:context:ready"],
        ["total:toViewRoot", "app:init", "canvas:viewRoot:ready"],
        ["total:toDraftReady", "app:init", "draft:event:ready"],
    ];

    for (const [name, a, b] of pairs) {
        const av = get(a);
        const bv = get(b);
        if (typeof av === "number" && typeof bv === "number") {
            d[name] = Math.max(0, bv - av);
        }
    }
    return d;
};

export const publishStartupPerfSnapshot = (reason: string) => {
    try {
        const g = getGlobal();
        const state = g.__STARTUP_PERF as StartupPerfState | undefined;
        if (!state) return;
        if (!isPerfEnabled()) return;
        if (state.published[reason]) return;
        state.published[reason] = true;

        const payload = {
            kind: "startup",
            reason,
            runId: state.runId,
            marks: { ...state.marks },
            durations: computeDurations(state.marks),
            data: { ...state.data },
        };
        // eslint-disable-next-line no-console
        console.info("[Perf] startup snapshot", payload);
        emitPerfEvent("peer", payload);
    } catch {
        // no-op
    }
};

const storageSnapshot = async () => {
    const out: Record<string, unknown> = {};
    try {
        out.persisted = await navigator.storage?.persisted?.();
    } catch {}
    try {
        out.estimate = await navigator.storage?.estimate?.();
    } catch {}
    try {
        const idb: any = indexedDB as any;
        if (typeof idb.databases === "function") {
            const dbs = await idb.databases();
            out.indexedDB = {
                count: Array.isArray(dbs) ? dbs.length : undefined,
                names: Array.isArray(dbs)
                    ? dbs.map((d: any) => d?.name).filter(Boolean)
                    : undefined,
            };
        }
    } catch {}
    return out;
};

export const markStorageSnapshot = async (label: string) => {
    try {
        if (!isPerfEnabled()) return;
        const snap = await storageSnapshot();
        startupMark(`storage:${label}`, snap);
        emitPerfEvent("peer", { kind: "startup", phase: "storage", label, snap });
    } catch {
        // no-op
    }
};
