import { toBase64 } from "@peerbit/crypto";
import { toId, type DocumentsLike } from "@peerbit/document";
import { DIGEST_BYTES } from "./constants.js";
import { headDigestInto } from "./digest.js";
import { IdHeadMap, type IdKey } from "./id-map.js";
import type { ScopeDescriptor } from "./scopes.js";

/**
 * The per-scope change tap: keeps the live row set of one scope (document
 * id -> head, the count, `hlc`, the epoch) from that scope's Documents
 * `change` events, and feeds every element change to its sinks (the cells
 * and the anchor lanes) in the same synchronous call, so `epoch` and a sink's
 * sequence number agree at every synchronous point.
 *
 * Rules from M0 P4 (WRITE_READINESS_V2.md section 4.4), each one tested:
 * rows are scoped by class; `__context` is read synchronously in the
 * listener; empty events are ignored; an add whose head the map already
 * holds changes nothing (re-dispatch is idempotent); and a replace or a
 * stale removal re-reads that id's indexed head (serialized, with a per-id
 * version so a newer event retries) because Documents can dispatch an older
 * entry's event after the newer one the index kept.
 *
 * One more order needs the same re-read: an add of an id that an event
 * removed lately. A local delete reads the removed value, appends, deletes
 * the whole id row from the index and only then dispatches; a concurrent
 * put of the same id can index its head inside that window and dispatch
 * its add after the removal (`@peerbit/document program.js:3664-3705`,
 * `3725-3911`). That add names a row the index no longer holds, and the map
 * does not hold the id either, so without the re-read it would stay.
 */

/** Receives every element change, in order. */
export interface ScopeSink {
    /** `digest` is valid during the call only: the tap reuses it. */
    apply(digest: Uint8Array, sign: 1 | -1): void;
    /** Drops everything applied so far (a discarded restore). */
    reset?(): void;
}

export interface IndexedHead {
    head: string;
    modified: bigint;
}

/** The index reads a tap needs; one per scope and open generation. */
export interface ScopeIndexPort {
    readHead(key: IdKey): Promise<IndexedHead | undefined>;
    /** The scope's rows, in pages (a 200k-row scan never sits in one array). */
    scan(): AsyncIterable<Array<IndexedHead & { key: IdKey }>>;
    count(): Promise<number>;
}

type EventSource = {
    addEventListener(type: "change", listener: (event: any) => void): void;
    removeEventListener(type: "change", listener: (event: any) => void): void;
};

type Captured = {
    removed: Array<{ key: IdKey; head?: string }>;
    added: Array<{ key: IdKey; head: string; modified: bigint }>;
};

export type TapState = "buffering" | "live" | "disposed";

export interface TapStats {
    events: number;
    emptyEvents: number;
    adds: number;
    removes: number;
    replaces: number;
    idempotentSkips: number;
    staleRemoves: number;
    verifies: number;
    verifyRetries: number;
    repairs: number;
    /** Adds of an absent id an event removed lately, verified. */
    readdVerifies: number;
    /** Seeds scanned again because the count did not match the index. */
    rescans: number;
    /**
     * Rescans an event raced (one arrived during the scan): they may miss
     * rows again, so they back off instead of counting toward
     * `COUNT_RESCANS`.
     */
    exposedRescans: number;
    /** Index count reads of the count check (`ScopeIndexPort.count`). */
    countReads: number;
    /**
     * Count comparisons that neither verified nor rescanned: no stable
     * point, or a difference not yet seen twice. Later changes or a
     * consumer compare again (`countNext`).
     */
    deferredCounts: number;
}

/**
 * A fault the close caused, not the maintained state: a verify the close
 * would not wait for or could no longer read. The set is dropped (never
 * persisted), and the shadow check counts the scope as skipped.
 */
export class CloseFault extends Error {}

/**
 * Rows per page of a seed scan: the first page, doubling up to the cap. The
 * sqlite3 index pages by OFFSET, so every page skips all rows before it
 * again: fixed 4,096-row pages took 6.5-21 s to seed 200k rows, doubling
 * pages 2.1-4.6 s (bench). The skipped rows stay near 2n and a page holds at
 * most 64k rows.
 */
const SCAN_PAGE_ROWS = 4096;
const SCAN_PAGE_ROWS_MAX = 65_536;
/**
 * Ids an event removed that an add of the same absent id is verified
 * against (oldest forgotten first). The add that needs it was indexed
 * before the removal's event and is dispatched once its batch finishes, so
 * the bound covers 4,096 distinct in-scope removals in between. A batch
 * holds at most 256 live entries or 512 KiB, and the removals that could
 * land inside it share the connection's FIFO barrier with its puts (review
 * probe: 0 removals inside any batch, across 14k adds under a GC loop). An
 * add later than the bound is missed: the map keeps a row the index does
 * not hold until the next open's count check. No test reaches the bound in
 * a real store; `readiness-shadow.test.ts` shows the K2 check reports such
 * a row.
 */
const RECENT_REMOVALS = 4096;
/**
 * Clean rescans (no event during the scan) the count check may start in one
 * open generation before the tap faults (an index whose count never matches
 * its scan, a bug). A rescan an event raced may miss rows again under the
 * same ingest, which says nothing about the index: it only backs off
 * (`countBackoff`).
 */
const COUNT_RESCANS = 3;
/**
 * The most element changes between two count comparisons of a tap whose
 * count is not verified. Every comparison that neither verifies nor
 * rescans doubles the distance to the next one, from 1 up to this cap, so
 * over n changes an unverified tap reads the count about log2(cap) + n /
 * cap times however its events arrive (a consumer adds at most one read
 * per such read): never once per event, and never waiting for the events
 * to stop.
 */
export const COUNT_STRIDE_MAX = 1024;

const toBigInt = (value: unknown): bigint =>
    typeof value === "bigint" ? value : BigInt((value as number) ?? 0);

const keyString = (key: IdKey) =>
    typeof key === "string" ? key : "b:" + toBase64(key);

/** The raw index of a store (`Documents.index.index`), read at call time. */
const rawIndex = (documents: Pick<DocumentsLike<any, any>, "index">) => {
    const index = (documents.index as any)?.index;
    if (!index) {
        throw new Error("readiness: the store has no local index");
    }
    return index;
};

/**
 * Raw index reads fail closed, as `readLocalIndex` in index.ts makes the
 * filesystem's own reads do. The raw index answers a closing store with no
 * rows (`get` undefined, `count` 0, an empty page) rather than an error, and
 * the store's DocumentIndex is marked closed before its index starts
 * closing: a read that starts, returns or fails on a closed DocumentIndex
 * throws a CloseFault and never reports a row as absent. (`readLocalIndex`
 * itself would refuse the close's reads: the close moves to a new open
 * generation before it lets them run.)
 */
const assertOpen = (documents: Pick<DocumentsLike<any, any>, "index">) => {
    if ((documents.index as any)?.closed === true) {
        throw new CloseFault("readiness: index read on a closed store");
    }
};

/** One raw index read, under `assertOpen` before and after. */
const readOpen = async <T>(
    documents: Pick<DocumentsLike<any, any>, "index">,
    read: () => Promise<T>
): Promise<T> => {
    assertOpen(documents);
    let result: T;
    try {
        result = await read();
    } catch (error) {
        assertOpen(documents);
        throw error;
    }
    assertOpen(documents);
    return result;
};

/** Index reads of a Documents store for one scope. */
export const documentsIndexPort = (
    documents: Pick<DocumentsLike<any, any>, "index">,
    scope: ScopeDescriptor
): ScopeIndexPort => ({
    readHead: async (key) => {
        const result = await readOpen<{ value: unknown } | undefined>(
            documents,
            () => rawIndex(documents).get(toId(key), { shape: scope.scanShape })
        );
        const row = result?.value as any;
        if (!row?.__context?.head || !scope.indexedRowInScope(row)) {
            return undefined;
        }
        return {
            head: row.__context.head,
            modified: toBigInt(row.__context.modified),
        };
    },
    scan: async function* () {
        assertOpen(documents);
        const iterator = rawIndex(documents).iterate(
            { query: scope.scanQuery() },
            { shape: scope.scanShape }
        );
        let pageRows = SCAN_PAGE_ROWS;
        try {
            while (!iterator.done()) {
                // An empty page from a closing store would end the scan
                // early, and the seed would go live on part of the rows.
                const page = await readOpen<Array<{ value: unknown }>>(
                    documents,
                    () => iterator.next(pageRows)
                );
                pageRows = Math.min(2 * pageRows, SCAN_PAGE_ROWS_MAX);
                const out: Array<IndexedHead & { key: IdKey }> = [];
                for (const result of page) {
                    const row = result.value as any;
                    const key = scope.key(row);
                    if (key === undefined || !row?.__context?.head) continue;
                    out.push({
                        key,
                        head: row.__context.head,
                        modified: toBigInt(row.__context.modified),
                    });
                }
                if (page.length === 0) break;
                yield out;
            }
            // The raw iterator also reports done() once its store is
            // closing, which would end the scan early the same way.
            assertOpen(documents);
        } finally {
            await iterator.close();
        }
    },
    count: () =>
        readOpen<number>(documents, () =>
            rawIndex(documents).count({ query: scope.scanQuery() })
        ),
});

export class ScopeTap {
    map: IdHeadMap;
    /** Highest `__context.modified` ever inserted; never decreases. */
    hlc = 0n;
    /** Element changes applied (each add or removal of one head). */
    epoch = 0;
    readonly stats: TapStats = {
        events: 0,
        emptyEvents: 0,
        adds: 0,
        removes: 0,
        replaces: 0,
        idempotentSkips: 0,
        staleRemoves: 0,
        verifies: 0,
        verifyRetries: 0,
        repairs: 0,
        readdVerifies: 0,
        rescans: 0,
        exposedRescans: 0,
        countReads: 0,
        deferredCounts: 0,
    };
    /** Set when a verify read failed; the maintained set is then unreliable. */
    faulted?: unknown;
    /**
     * Set when the close began: the stores close next, so a verify read from
     * now on could see a closing index. A verify that would run after the
     * seal faults the tap instead (it is then never persisted).
     */
    private sealedValue = false;
    private stateValue: TapState = "buffering";
    private readonly sinks: ScopeSink[] = [];
    private buffered: Captured[] = [];
    private source?: EventSource;
    private listener?: (event: any) => void;
    private readonly verifyVersions = new Map<string, number>();
    private verifyChain: Promise<void> = Promise.resolve();
    /**
     * Set when the close began draining: a verify whose id changed again
     * during its read faults the tap instead of reading again, so the close
     * waits for a bounded number of reads however long remote replaces go
     * on.
     */
    private draining = false;
    /** Ids an event removed lately, oldest first (`RECENT_REMOVALS`). */
    private readonly recentRemovals = new Set<string>();
    /** The count matched the index at a stable epoch (`checkCount`). */
    private countVerifiedValue = false;
    /**
     * From a seed or restore until the count is verified: applied changes,
     * a drained verify queue and consumers start comparisons.
     */
    private countDue = false;
    /** The comparison running, until it settled (at most one). */
    private countRun?: Promise<void>;
    /** Applied changes start the next comparison from this epoch on. */
    private countNext = 0;
    /** Element changes from one comparison to the next (`COUNT_STRIDE_MAX`). */
    private countStride = 1;
    /** Clean rescans in this open generation (`COUNT_RESCANS`). */
    private countCleanRescans = 0;
    /**
     * The stride an exposed rescan's comparisons start from: doubles with
     * each one, up to `COUNT_STRIDE_MAX`, so rescans under a steady stream
     * of deletes thin out instead of faulting.
     */
    private countBackoff = 1;
    /** No comparison was conclusive since the seed or restore. */
    private countFirst = false;
    /** The last conclusive difference and the epoch it was read at. */
    private countSeen?: { difference: number; epoch: number };
    /** The epoch of the last conclusive count read. */
    private countReadAt = 0;
    /** A consumer started a comparison since changes last started one. */
    private countDemanded = false;
    /** Called with every id an event or a verify names (the shadow check). */
    private readonly watchers: Array<(key: IdKey) => void> = [];
    /** The element an event names, and the head it replaced or removed. */
    private readonly digest = new Uint8Array(DIGEST_BYTES);
    private readonly prev = new Uint8Array(DIGEST_BYTES);

    constructor(
        readonly scope: ScopeDescriptor,
        readonly port: ScopeIndexPort,
        map?: IdHeadMap
    ) {
        this.map = map ?? new IdHeadMap();
    }

    get state(): TapState {
        return this.stateValue;
    }

    // A method, so the state is re-read after every await (no narrowing).
    private is(state: TapState): boolean {
        return this.stateValue === state;
    }

    get count(): number {
        return this.map.size;
    }

    /** Live rows with `__context.modified` above `hlc` (an O(n) scan). */
    above(hlc: bigint): number {
        return this.map.forEachAbove(hlc);
    }

    /** Ids whose replace verify is queued or running. */
    get pendingVerify(): number {
        return this.verifyVersions.size;
    }

    /**
     * Calls `fn` with the id of every element an event applies or skips and
     * of every finished verify, synchronously (test mode: the shadow check
     * tells an in-flight difference from a real one by it).
     */
    watch(fn: (key: IdKey) => void): () => void {
        this.watchers.push(fn);
        return () => {
            const at = this.watchers.indexOf(fn);
            if (at >= 0) this.watchers.splice(at, 1);
        };
    }

    private notify(key: IdKey) {
        for (const watcher of this.watchers) watcher(key);
    }

    addSink(sink: ScopeSink): () => void {
        this.sinks.push(sink);
        return () => {
            const at = this.sinks.indexOf(sink);
            if (at >= 0) this.sinks.splice(at, 1);
        };
    }

    /**
     * Listens on `source`, buffering events until a seed or restore ends.
     * Attach before the store ingests (or before a seed scan starts), so no
     * row change can fall between the seed and the first applied event.
     */
    attach(source: EventSource) {
        this.detach();
        const listener = (event: any) => {
            // A removed listener may still fire once on older main-event
            // versions; only the attached one may apply.
            if (this.listener !== listener || this.is("disposed")) {
                return;
            }
            this.onChange(event);
        };
        this.source = source;
        this.listener = listener;
        source.addEventListener("change", listener);
    }

    detach() {
        if (this.source && this.listener) {
            this.source.removeEventListener("change", this.listener);
        }
        this.source = undefined;
        this.listener = undefined;
    }

    dispose() {
        this.detach();
        this.stateValue = "disposed";
        this.buffered = [];
        this.verifyVersions.clear();
        this.recentRemovals.clear();
    }

    /** Synchronous: captures `__context` now, applies or buffers. */
    onChange(event: any) {
        if (this.is("disposed")) return;
        const detail = event?.detail ?? {};
        const added: unknown[] = detail.added ?? [];
        const removed: unknown[] = detail.removed ?? [];
        if (added.length === 0 && removed.length === 0) {
            this.stats.emptyEvents++;
            return;
        }
        const captured: Captured = { removed: [], added: [] };
        for (const value of removed) {
            if (!this.scope.classify(value)) continue;
            const key = this.scope.key(value);
            if (key === undefined) continue;
            captured.removed.push({
                key,
                head: (value as any).__context?.head,
            });
        }
        for (const value of added) {
            if (!this.scope.classify(value)) continue;
            const key = this.scope.key(value);
            const head = (value as any).__context?.head;
            if (key === undefined || typeof head !== "string") continue;
            captured.added.push({
                key,
                head,
                modified: toBigInt((value as any).__context.modified),
            });
        }
        if (captured.removed.length === 0 && captured.added.length === 0) {
            return;
        }
        this.stats.events++;
        if (this.is("buffering")) {
            this.buffered.push(captured);
            return;
        }
        this.applyCaptured(captured);
        if (this.countDue) this.countOnChange();
    }

    private emit(digest: Uint8Array, sign: 1 | -1) {
        this.epoch++;
        for (const sink of this.sinks) {
            sink.apply(digest, sign);
        }
    }

    private touch(key: IdKey) {
        if (this.verifyVersions.size === 0) return;
        const ks = keyString(key);
        const version = this.verifyVersions.get(ks);
        if (version !== undefined) {
            this.verifyVersions.set(ks, version + 1);
        }
    }

    /** Remembers an id an event removed (see `RECENT_REMOVALS`). */
    private noteRemoval(key: IdKey) {
        const ks = keyString(key);
        // Re-inserted, so the order stays oldest first.
        this.recentRemovals.delete(ks);
        this.recentRemovals.add(ks);
        if (this.recentRemovals.size > RECENT_REMOVALS) {
            const oldest = this.recentRemovals.values().next().value!;
            this.recentRemovals.delete(oldest);
        }
    }

    private applyCaptured(captured: Captured) {
        for (const { key, head } of captured.removed) {
            this.touch(key);
            this.noteRemoval(key);
            if (this.watchers.length > 0) this.notify(key);
            const slot = this.map.get(key);
            if (slot < 0) {
                this.stats.idempotentSkips++;
                continue;
            }
            let stale = head === undefined;
            if (head !== undefined) {
                headDigestInto(head, this.digest);
                stale = !this.map.headEquals(slot, this.digest);
            }
            this.map.remove(key, this.prev);
            this.emit(this.prev, -1);
            this.stats.removes++;
            if (stale) {
                this.stats.staleRemoves++;
                this.scheduleVerify(key);
            }
        }
        for (const { key, head, modified } of captured.added) {
            this.touch(key);
            if (this.watchers.length > 0) this.notify(key);
            if (
                this.applyHead(key, head, modified, true) === "added" &&
                this.recentRemovals.size > 0 &&
                this.recentRemovals.has(keyString(key))
            ) {
                // Possibly a put whose row a delete already removed from the
                // index (see the class comment): read the index like a
                // replace.
                this.stats.readdVerifies++;
                this.scheduleVerify(key);
            }
        }
    }

    /** Sets `key` to `head`; returns what changed. */
    private applyHead(
        key: IdKey,
        head: string,
        modified: bigint,
        verifyReplace: boolean
    ): "same" | "added" | "replaced" {
        headDigestInto(head, this.digest);
        const slot = this.map.get(key);
        if (slot >= 0 && this.map.headEquals(slot, this.digest)) {
            this.stats.idempotentSkips++;
            return "same";
        }
        const replaced = this.map.put(key, this.digest, modified, this.prev);
        if (replaced) {
            this.emit(this.prev, -1);
            this.stats.replaces++;
        } else {
            this.stats.adds++;
        }
        this.emit(this.digest, 1);
        if (modified > this.hlc) {
            this.hlc = modified;
        }
        if (replaced && verifyReplace) {
            this.scheduleVerify(key);
        }
        return replaced ? "replaced" : "added";
    }

    private scheduleVerify(key: IdKey) {
        if (this.sealedValue) {
            this.faulted ??= new CloseFault(
                "replace verify after the close began"
            );
            return;
        }
        const ks = keyString(key);
        if (this.verifyVersions.has(ks)) {
            this.touch(key);
            return;
        }
        this.verifyVersions.set(ks, 0);
        this.verifyChain = this.verifyChain.then(() => this.runVerify(key, ks));
    }

    private async runVerify(key: IdKey, ks: string) {
        for (;;) {
            if (this.is("disposed")) return;
            if (this.sealedValue) {
                // Queued before the seal: the stores may be closing, so no
                // read. The set is then not persisted.
                this.faulted ??= new CloseFault(
                    "replace verify after the close began"
                );
                this.verifyVersions.delete(ks);
                return;
            }
            const version = this.verifyVersions.get(ks);
            let indexed: IndexedHead | undefined;
            try {
                this.stats.verifies++;
                indexed = await this.port.readHead(key);
            } catch (error) {
                if (!this.is("disposed")) {
                    this.faulted ??= error;
                }
                this.verifyVersions.delete(ks);
                return;
            }
            if (this.is("disposed")) return;
            if (this.sealedValue) {
                this.faulted ??= new CloseFault(
                    "replace verify after the close began"
                );
                this.verifyVersions.delete(ks);
                return;
            }
            if (this.verifyVersions.get(ks) !== version) {
                if (this.draining) {
                    // The close waits for no further read of this id.
                    this.faulted ??= new CloseFault(
                        "replace verify still moving when the close began"
                    );
                    this.verifyVersions.delete(ks);
                    return;
                }
                this.stats.verifyRetries++;
                continue;
            }
            this.reconcile(key, indexed);
            this.verifyVersions.delete(ks);
            if (this.watchers.length > 0) this.notify(key);
            // A drained queue: a comparison it held back may start.
            if (this.countDue && this.verifyVersions.size === 0) {
                this.countOnChange();
            }
            return;
        }
    }

    private reconcile(key: IdKey, indexed: IndexedHead | undefined) {
        if (indexed === undefined) {
            if (this.map.remove(key, this.prev)) {
                this.emit(this.prev, -1);
                this.stats.repairs++;
            }
            return;
        }
        if (
            this.applyHead(key, indexed.head, indexed.modified, false) !==
            "same"
        ) {
            this.stats.repairs++;
        }
    }

    /**
     * The close began and the stores close next: no index read from now on.
     * Call after `drainVerifies`; a verify still pending faults the tap, so
     * its set is not persisted.
     */
    seal() {
        this.sealedValue = true;
        if (this.verifyVersions.size > 0) {
            this.faulted ??= new CloseFault(
                "sealed with a replace verify pending"
            );
        }
    }

    get sealed(): boolean {
        return this.sealedValue;
    }

    /**
     * Resolves once no replace verify is queued or running. Unbounded while
     * replaces of one id keep arriving faster than its read; the open path
     * and the responder's freeze wait so, the close uses `drainVerifies`.
     */
    async verifyIdle(): Promise<void> {
        while (this.verifyVersions.size > 0) {
            await this.verifyChain;
        }
    }

    /**
     * The close's bounded wait: the verifies queued now run once each (an id
     * that changed again during its read faults the tap instead of reading
     * again), and verifies queued later are not waited for.
     */
    async drainVerifies(): Promise<void> {
        this.draining = true;
        await this.verifyChain;
    }

    /** Resolves once the verifies queued now finished (a later one may run). */
    async verifiesSettled(): Promise<void> {
        await this.verifyChain;
    }

    /**
     * Seeds an empty tap from one index scan, then applies the events
     * buffered since `attach` under the idempotent and verify rules. The
     * scan starts after the attach, so every row change is either in the
     * scan or in the buffer (or both, which the rules absorb).
     */
    async seedFromScan(): Promise<void> {
        if (!this.is("buffering")) {
            throw new Error(`cannot seed a ${this.stateValue} tap`);
        }
        await this.scanThenGoLive(false);
    }

    /**
     * The scan of a seed or a rescan, then the buffered events. Resolves
     * whether nothing was buffered (for a rescan, which buffers from a live
     * state: no event raced its pages), or undefined when it did not finish.
     */
    private async scanThenGoLive(
        rescan: boolean
    ): Promise<boolean | undefined> {
        for await (const rows of this.port.scan()) {
            // Sealed: the stores close next, so no further page (a rescan
            // that began before the close stays buffering, unpersisted). A
            // rescan stops once the close drains, too: the close waits for
            // the comparison that runs it (`confirmCount`).
            if (
                !this.is("buffering") ||
                this.sealedValue ||
                (rescan && this.draining)
            ) {
                return undefined;
            }
            for (const row of rows) {
                this.applyHead(row.key, row.head, row.modified, false);
            }
        }
        if (!this.is("buffering")) return undefined;
        const clean = this.buffered.length === 0;
        this.goLive();
        return clean;
    }

    /** `seedFromScan`, then `checkCount`. */
    async seedChecked(): Promise<void> {
        await this.seedFromScan();
        await this.checkCount();
    }

    /**
     * Whether the count matched the index at a stable epoch since the last
     * seed, restore or rescan. Only such a state is persisted (and, from
     * PR-3, trusted).
     */
    get countVerified(): boolean {
        return this.countVerifiedValue;
    }

    /**
     * The count check after a seed or a restore (plan section 6.2), checked
     * until it holds. The sqlite3 index pages a scan by OFFSET and checks for
     * writes before a page waits for the connection: a delete admitted ahead
     * of the page shifts a row past it unseen, and no event ever names that
     * row. A comparison reads the index's projected count at a stable point
     * (`countDifferenceOnce`): a change applied during the read leaves it
     * inconclusive. A stable read can still differ while a remote batch is
     * indexed but not yet dispatched, so:
     *
     * - a match verifies the state;
     * - the first conclusive difference since the seed or restore scans
     *   again at once (in a quiet store it is real; a remote batch in flight
     *   costs one scan more);
     * - a later difference scans again once a comparison read after more
     *   changes applied sees the same difference. A missed row never has an
     *   event, so its difference stays; a batch in flight does not repeat
     *   one because the sqlite3 index admits whole database operations in
     *   one connection-wide FIFO (`@peerbit/indexer-sqlite3 engine.js:97-125`,
     *   coarse on purpose, TODO(perf) upstream): on 5.4.10 no stable read
     *   started from a change event differed (review probe: 0 of 8.5k under
     *   local writers and replication). The real-store case in
     *   `readiness-tap.test.ts` fails without that barrier;
     * - anything else keeps the state unverified. The next comparison starts
     *   from the changes that follow (`countOnChange`, at most one running
     *   and one per `countStride` changes) or from a consumer
     *   (`requestCount`, `confirmCount`); never from a timer.
     *
     * So ingest drives the check instead of starving it: a comparison is
     * conclusive unless a change applies during its one count read, and the
     * next change after an inconclusive one is the next chance. A restore
     * whose count cannot be compared during ingest is kept, not discarded: a
     * scan under the same ingest is no more trustworthy. A rescan an event
     * raced (a delete stream races every OFFSET-paged scan) may miss rows
     * again: it keeps the state unverified and backs off (`countBackoff`).
     * Only clean rescans count: a difference that a later change confirms
     * after `COUNT_RESCANS` of them faults the tap. A store that stays quiet
     * after a difference cannot tell, without a clock, a missed row from a
     * batch still being indexed: its state stays unverified (never
     * persisted) until a change confirms the difference or the next open
     * scans. Resolves with the first comparison (false: the tap has scanned
     * again).
     */
    async checkCount(): Promise<boolean | undefined> {
        while (this.countRun) await this.countRun;
        this.countVerifiedValue = false;
        this.countDue = true;
        this.countFirst = true;
        this.countSeen = undefined;
        this.countStride = 1;
        this.countDemanded = false;
        return this.runCount(true);
    }

    /** Runs `settleCount`, one at a time (`countRun`). */
    private runCount(atStart: boolean): Promise<boolean | undefined> {
        let settled!: () => void;
        const running = new Promise<void>((resolve) => (settled = resolve));
        this.countRun = running;
        return this.settleCount(atStart).finally(() => {
            if (this.countRun === running) this.countRun = undefined;
            settled();
            // Changes applied during the run may have made the next
            // comparison due.
            if (this.countDue) this.countOnChange();
        });
    }

    /**
     * One comparison and what follows from it (`checkCount`). The start's
     * comparison waits for the verify queue and tries three times; any other
     * reads once, from the point it starts.
     */
    private async settleCount(atStart: boolean): Promise<boolean | undefined> {
        let from = this.epoch;
        let difference = atStart
            ? await this.countDifference(3)
            : await this.countDifferenceOnce();
        const first = difference === undefined ? undefined : difference === 0;
        for (;;) {
            if (
                !this.countDue ||
                !this.is("live") ||
                this.sealedValue ||
                this.faulted !== undefined
            ) {
                return first;
            }
            if (difference === 0) {
                this.countVerifiedValue = true;
                this.countDue = false;
                return first;
            }
            let rescan = false;
            if (difference !== undefined) {
                const seen = this.countSeen;
                rescan =
                    this.countFirst ||
                    (seen?.difference === difference &&
                        seen.epoch < this.countReadAt);
                this.countFirst = false;
                this.countSeen = { difference, epoch: this.countReadAt };
            }
            if (!rescan) {
                this.stats.deferredCounts++;
                this.countNext = from + this.countStride;
                this.countStride = Math.min(
                    2 * this.countStride,
                    COUNT_STRIDE_MAX
                );
                return first;
            }
            // The close began: no scan from now on, and the state is not
            // persisted.
            if (this.draining) return first;
            if (this.countCleanRescans >= COUNT_RESCANS) {
                this.faulted ??= new Error(
                    `readiness: ${this.scope.name} count differs from its index after ${COUNT_RESCANS} clean rescans`
                );
                return first;
            }
            this.stats.rescans++;
            const clean = await this.reseed();
            if (clean === true) {
                this.countCleanRescans++;
                this.countStride = 1;
            } else if (clean === false) {
                this.stats.exposedRescans++;
                this.countStride = this.countBackoff;
                this.countBackoff = Math.min(
                    2 * this.countBackoff,
                    COUNT_STRIDE_MAX
                );
            }
            from = this.epoch;
            difference = await this.countDifference(3);
        }
    }

    /**
     * After an applied change, a drained verify queue or a comparison: the
     * next comparison of an unverified count, once `countNext` is reached.
     */
    private countOnChange() {
        if (this.epoch < this.countNext || !this.countMayStart()) return;
        this.countDemanded = false;
        this.startCount();
    }

    /**
     * A consumer reads the state now (the responder's freeze): an
     * unverified count is compared at once, before `countNext`. At most once
     * between two comparisons that changes started, so consumers add at most
     * one count read per stride.
     */
    requestCount() {
        if (this.countDemanded || !this.countMayStart()) return;
        this.countDemanded = true;
        this.startCount();
    }

    private countMayStart(): boolean {
        return (
            this.countDue &&
            this.countRun === undefined &&
            // A drained queue starts it (`runVerify`).
            this.verifyVersions.size === 0 &&
            this.faulted === undefined &&
            // The close compares once itself (`confirmCount`).
            !this.draining &&
            !this.sealedValue &&
            this.is("live")
        );
    }

    private startCount() {
        this.runCount(false).catch((error) => {
            // The start's errors fault the tap in the runtime; this run has
            // no caller.
            if (!this.is("disposed") && !this.sealedValue) {
                this.faulted ??= error;
            }
        });
    }

    /** Resolves once no count comparison runs (tests). */
    async countSettled(): Promise<void> {
        while (this.countRun) await this.countRun;
    }

    /**
     * The close's last comparison for a count never verified: one read, and
     * only with no verify pending (the close waits for no further read).
     * Never rescans. A comparison still running ends first, so one count
     * read is in flight at a time; once the close drains, that comparison
     * reads no more and starts no rescan, and a rescan's scan stops at its
     * next page.
     */
    async confirmCount(): Promise<void> {
        while (this.countRun) await this.countRun;
        if (
            this.countVerifiedValue ||
            !this.is("live") ||
            this.sealedValue ||
            this.faulted !== undefined ||
            this.pendingVerify > 0
        ) {
            return;
        }
        if ((await this.countDifferenceOnce()) === 0) {
            this.countVerifiedValue = true;
            this.countDue = false;
        }
    }

    /**
     * Adopts a persisted state (map, `hlc`, epoch), then applies the events
     * buffered since `attach`. The caller restores its sinks to the same
     * point first and then checks the count with `checkCount`.
     */
    restore(state: { map: IdHeadMap; hlc: bigint; epoch: number }) {
        if (!this.is("buffering")) {
            throw new Error(`cannot restore a ${this.stateValue} tap`);
        }
        this.countVerifiedValue = false;
        this.map = state.map;
        this.hlc = state.hlc;
        this.epoch = state.epoch;
        this.goLive();
    }

    private goLive() {
        this.stateValue = "live";
        for (const captured of this.buffered.splice(0)) {
            this.applyCaptured(captured);
        }
    }

    /**
     * Compares the live count with the index's projected count at a stable
     * epoch (no change applied and no verify pending across the await),
     * after a restore or a seed.
     * `undefined` when no stable point was found in `tries` attempts.
     */
    async restoredCountMatches(tries = 3): Promise<boolean | undefined> {
        const difference = await this.countDifference(tries);
        return difference === undefined ? undefined : difference === 0;
    }

    /** `countDifferenceOnce` with the verify queue drained, `tries` times. */
    private async countDifference(tries: number): Promise<number | undefined> {
        for (let i = 0; i < tries; i++) {
            await this.countVerifyIdle();
            // Sealed: the stores close next, so no index read. Draining: the
            // close compares once itself (`confirmCount`).
            if (!this.is("live") || this.sealedValue || this.draining) {
                return undefined;
            }
            const difference = await this.countDifferenceOnce();
            if (difference !== undefined) return difference;
        }
        return undefined;
    }

    /**
     * `verifyIdle` for the count check, which the close waits for
     * (`confirmCount`): once the close drains, verifies queued later are not
     * waited for (each queued one reads once, `drainVerifies`).
     */
    private async countVerifyIdle(): Promise<void> {
        while (this.verifyVersions.size > 0 && !this.draining) {
            await this.verifyChain;
        }
    }

    /**
     * The index's projected count minus the live count, read at a stable
     * point: no change applied and no verify pending across the read.
     * Undefined, without a read, when a verify is pending or the tap is not
     * live or sealed; and after the read when a change applied during it.
     */
    private async countDifferenceOnce(): Promise<number | undefined> {
        if (
            !this.is("live") ||
            this.sealedValue ||
            this.verifyVersions.size > 0
        ) {
            return undefined;
        }
        const { epoch, map } = this;
        this.stats.countReads++;
        const indexed = await this.port.count();
        if (
            !this.is("live") ||
            this.sealedValue ||
            this.epoch !== epoch ||
            this.map !== map ||
            this.verifyVersions.size > 0
        ) {
            return undefined;
        }
        this.countReadAt = epoch;
        return indexed - map.size;
    }

    /**
     * Discards the live state and seeds again by scan. Events are buffered
     * from now on, so none is lost between the reset and the scan. Nothing
     * once the close sealed the tap (no index read from then on) or began
     * draining. Resolves whether the scan was clean (no event raced it), or
     * undefined when it did not start or finish.
     */
    async reseed(): Promise<boolean | undefined> {
        if (this.is("disposed") || this.sealedValue) return undefined;
        await this.countVerifyIdle();
        if (this.is("disposed") || this.sealedValue || this.draining) {
            return undefined;
        }
        this.stateValue = "buffering";
        this.countVerifiedValue = false;
        // Compared again, and its differences must be seen twice
        // (`checkCount`); `settleCount` sets the stride once it knows
        // whether the scan was clean.
        this.countDue = true;
        this.countFirst = false;
        this.countSeen = undefined;
        // A fresh seed. The epoch keeps counting, so a sink that numbers
        // its applies re-aligns to it on reset.
        this.map = new IdHeadMap();
        this.hlc = 0n;
        for (const sink of this.sinks) {
            sink.reset?.();
        }
        return this.scanThenGoLive(true);
    }
}
