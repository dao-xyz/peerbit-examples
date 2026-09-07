import { performance } from "node:perf_hooks";
import { SparseQueryProfile } from "./sparse-query-profile.js";
import type { SparseQueryTransportProfile } from "./sparse-query-transport-profile.js";

type Entries = Parameters<SparseQueryProfile["wrap"]>[0];
type Iterate = Entries["index"]["iterate"];
type PhaseSnapshot = ReturnType<SparseQueryProfile["snapshot"]>;
type TransportSnapshot = ReturnType<SparseQueryTransportProfile["snapshot"]>;
type QueryKind =
    | "naming-slot"
    | "naming-node"
    | "versions-node"
    | "chunk-id"
    | "unknown";
type Aggregate = {
    queries: number;
    nextCalls: number;
    nextTotalMs: number;
    nextMaxMs: number;
    nextBuckets: [number, number, number, number, number];
    nextRejected: number;
    closeCalls: number;
    closeRejected: number;
};
type ScanWindow = {
    ordinal: number;
    durationMs: number;
    outcome: "fulfilled" | "rejected";
    rejectionType?: string;
    phase?: PhaseSnapshot;
    transport?: TransportSnapshot;
};
const emptyAggregate = (): Aggregate => ({
    queries: 0,
    nextCalls: 0,
    nextTotalMs: 0,
    nextMaxMs: 0,
    nextBuckets: [0, 0, 0, 0, 0],
    nextRejected: 0,
    closeCalls: 0,
    closeRejected: 0,
});
const facade = <T extends object>(
    target: T,
    key: PropertyKey,
    value: unknown
): T =>
    new Proxy(target, {
        get(object, property) {
            if (property === key) return value;
            const found = Reflect.get(object, property, object);
            return typeof found === "function" ? found.bind(object) : found;
        },
        set: () => false,
    });

/** TEST ONLY. Bounded temporal windows, not request/response pairing or wire time.
 * Window duration excludes final snapshot/drain/top-K work; the outer scan does not.
 * Transport counters are lifetime snapshots and must never be summed across windows.
 */
export class SparseQueryScanProfile {
    private readonly source: string;
    private readonly maxWindows: number;
    private readonly transport?: SparseQueryTransportProfile;
    private original?: Entries;
    private activeEntries?: Entries;
    private activePhase?: SparseQueryProfile;
    private begun = false;
    private closed = false;
    private busy = false;
    private readonly windows: ScanWindow[] = [];
    private firstFailure?: ScanWindow;
    private preamble?: {
        eventCount: number;
        counters: TransportSnapshot["counters"];
    };
    private transportCounters?: TransportSnapshot["counters"];
    private readonly aggregates: Record<QueryKind, Aggregate> = {
        "naming-slot": emptyAggregate(),
        "naming-node": emptyAggregate(),
        "versions-node": emptyAggregate(),
        "chunk-id": emptyAggregate(),
        unknown: emptyAggregate(),
    };
    private readonly counters = {
        completedWindows: 0,
        failedWindows: 0,
        diagnosticErrors: 0,
        phaseDropped: 0,
        phaseObserverErrors: 0,
    };

    constructor(options: {
        source: string;
        transport?: SparseQueryTransportProfile;
        maxWindows?: number;
    }) {
        if (
            typeof options.source !== "string" ||
            !options.source.trim() ||
            options.source.length > 128
        )
            throw new Error("Scan profile requires a bounded source identity");
        this.source = options.source;
        this.transport = options.transport;
        this.maxWindows = options.maxWindows ?? 8;
        if (
            !Number.isSafeInteger(this.maxWindows) ||
            this.maxWindows < 0 ||
            this.maxWindows > 8
        )
            throw new RangeError("Scan maxWindows must be an integer in 0..8");
    }

    private diagnostic<T>(fn: () => T): T | undefined {
        try {
            return fn();
        } catch {
            this.counters.diagnosticErrors++;
            return undefined;
        }
    }

    wrap(originalEntries: Entries, beforeBeginEntries?: Entries): Entries {
        if (this.original || this.begun || this.closed)
            throw new Error(
                "Scan entries may only be wrapped once before begin"
            );
        this.original = originalEntries;
        const iterate = (...args: Parameters<Iterate>): ReturnType<Iterate> => {
            const entries =
                this.activeEntries ??
                (!this.begun && !this.closed
                    ? beforeBeginEntries
                    : undefined) ??
                originalEntries;
            return Reflect.apply(
                entries.index.iterate,
                entries.index,
                args
            ) as ReturnType<Iterate>;
        };
        return facade(
            originalEntries,
            "index",
            facade(originalEntries.index, "iterate", iterate)
        );
    }

    private drain(): TransportSnapshot | undefined {
        if (!this.transport) return;
        const window = this.transport.takeWindow();
        this.transportCounters = { ...window.counters };
        return window;
    }

    begin(): void {
        if (this.begun || this.closed)
            throw new Error("Scan profile already begun or stopped");
        this.begun = true;
        this.diagnostic(() => {
            const preamble = this.drain();
            if (preamble)
                this.preamble = {
                    eventCount: preamble.events.length,
                    counters: { ...preamble.counters },
                };
        });
    }

    private aggregate(phase: PhaseSnapshot): void {
        this.counters.phaseDropped += phase.dropped;
        this.counters.phaseObserverErrors += phase.observerErrors;
        for (const event of phase.events) {
            const aggregate = this.aggregates[event.queryKind ?? "unknown"];
            if (event.phase === "query.create.end") aggregate.queries++;
            if (event.phase === "query.next.end") {
                aggregate.nextCalls++;
                if (event.outcome === "rejected") aggregate.nextRejected++;
                const duration = event.durationMs;
                if (
                    typeof duration !== "number" ||
                    !Number.isFinite(duration) ||
                    duration < 0
                ) {
                    this.counters.diagnosticErrors++;
                    continue;
                }
                aggregate.nextTotalMs += duration;
                aggregate.nextMaxMs = Math.max(aggregate.nextMaxMs, duration);
                const bucket = [1, 10, 100, 1000].findIndex(
                    (limit) => duration <= limit
                );
                aggregate.nextBuckets[bucket < 0 ? 4 : bucket]++;
            }
            if (event.phase === "query.close.end") {
                aggregate.closeCalls++;
                if (event.outcome === "rejected") aggregate.closeRejected++;
            }
        }
    }

    async measure<T>(ordinal: number, fn: () => Promise<T>): Promise<T> {
        if (!this.begun || this.closed || this.busy)
            throw new Error(
                "Scan measure requires begun, open, non-overlapping window"
            );
        if (!Number.isSafeInteger(ordinal) || ordinal < 1)
            throw new RangeError(
                "Scan ordinal must be a positive safe integer"
            );
        this.busy = true;
        const phase = this.diagnostic(() => {
            const value = new SparseQueryProfile({
                source: this.source,
                maxEvents: 128,
            });
            this.activePhase = value;
            if (this.original) this.activeEntries = value.wrap(this.original);
            return value;
        });
        const start = performance.now();
        let outcome: ScanWindow["outcome"] = "fulfilled";
        let rejectionType: string | undefined;
        try {
            return await (phase ? phase.measure("scan-file", fn) : fn());
        } catch (error) {
            outcome = "rejected";
            rejectionType = error === null ? "null" : typeof error;
            throw error;
        } finally {
            const durationMs = performance.now() - start;
            this.activeEntries = undefined;
            this.counters.completedWindows++;
            if (outcome === "rejected") this.counters.failedWindows++;
            this.diagnostic(() => this.activePhase?.stop());
            this.activePhase = undefined;
            const window: ScanWindow = {
                ordinal,
                durationMs,
                outcome,
                rejectionType,
            };
            window.phase = phase
                ? this.diagnostic(() => phase.snapshot())
                : undefined;
            window.transport = this.diagnostic(() => this.drain());
            if (window.phase)
                this.diagnostic(() => this.aggregate(window.phase!));
            this.diagnostic(() => {
                if (outcome === "rejected" && !this.firstFailure)
                    this.firstFailure = window;
                const index = this.windows.findIndex(
                    (kept) => durationMs > kept.durationMs
                );
                this.windows.splice(
                    index < 0 ? this.windows.length : index,
                    0,
                    window
                );
                if (this.windows.length > this.maxWindows) this.windows.pop();
            });
            this.busy = false;
        }
    }

    /** An already-running fn is not cancelled; its window settles normally. */
    stop(): void {
        if (this.closed) return;
        this.closed = true;
        this.diagnostic(() => this.activePhase?.stop());
        this.activeEntries = undefined;
    }

    snapshot() {
        // All retained values are known profiler snapshots containing primitives.
        return structuredClone({
            windows: this.windows,
            firstFailure: this.firstFailure,
            preamble: this.preamble,
            aggregates: this.aggregates,
            counters: this.counters,
            transportCounters: this.transportCounters,
        });
    }
}
