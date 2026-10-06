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
}

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
 * the bound covers 4,096 distinct removals in between; an add later than
 * that is missed, and the K2 shadow check would show it in tests.
 */
const RECENT_REMOVALS = 4096;

const toBigInt = (value: unknown): bigint =>
    typeof value === "bigint" ? value : BigInt((value as number) ?? 0);

const keyString = (key: IdKey) =>
    typeof key === "string" ? key : "b:" + toBase64(key);

const sameDigest = (a: Uint8Array, b: Uint8Array) => {
    for (let i = 0; i < DIGEST_BYTES; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
};

/** The raw index of a store (`Documents.index.index`), read at call time. */
const rawIndex = (documents: Pick<DocumentsLike<any, any>, "index">) => {
    const index = (documents.index as any)?.index;
    if (!index) {
        throw new Error("readiness: the store has no local index");
    }
    return index;
};

/** Index reads of a Documents store for one scope. */
export const documentsIndexPort = (
    documents: Pick<DocumentsLike<any, any>, "index">,
    scope: ScopeDescriptor
): ScopeIndexPort => ({
    readHead: async (key) => {
        const result = await rawIndex(documents).get(toId(key), {
            shape: scope.scanShape,
        });
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
        const iterator = rawIndex(documents).iterate(
            { query: scope.scanQuery() },
            { shape: scope.scanShape }
        );
        let pageRows = SCAN_PAGE_ROWS;
        try {
            while (!iterator.done()) {
                const page = await iterator.next(pageRows);
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
        } finally {
            await iterator.close();
        }
    },
    count: async () => rawIndex(documents).count({ query: scope.scanQuery() }),
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
    /** Called with every id an event or a verify names (the shadow check). */
    private readonly watchers: Array<(key: IdKey) => void> = [];
    private readonly digest = new Uint8Array(DIGEST_BYTES);

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
                stale = !sameDigest(this.digest, this.map.head(slot));
            }
            const { prev } = this.map.delete(key);
            this.emit(prev!, -1);
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
        if (slot >= 0 && sameDigest(this.digest, this.map.head(slot))) {
            this.stats.idempotentSkips++;
            return "same";
        }
        const { prev } = this.map.set(key, this.digest, modified);
        if (prev) {
            this.emit(prev, -1);
            this.stats.replaces++;
        } else {
            this.stats.adds++;
        }
        this.emit(this.digest, 1);
        if (modified > this.hlc) {
            this.hlc = modified;
        }
        if (prev && verifyReplace) {
            this.scheduleVerify(key);
        }
        return prev ? "replaced" : "added";
    }

    private scheduleVerify(key: IdKey) {
        if (this.sealedValue) {
            this.faulted ??= new Error("replace verify after the close began");
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
                this.faulted ??= new Error(
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
                this.faulted ??= new Error(
                    "replace verify after the close began"
                );
                this.verifyVersions.delete(ks);
                return;
            }
            if (this.verifyVersions.get(ks) !== version) {
                if (this.draining) {
                    // The close waits for no further read of this id.
                    this.faulted ??= new Error(
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
            return;
        }
    }

    private reconcile(key: IdKey, indexed: IndexedHead | undefined) {
        if (indexed === undefined) {
            if (this.map.get(key) >= 0) {
                const { prev } = this.map.delete(key);
                this.emit(prev!, -1);
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
            this.faulted ??= new Error("sealed with a replace verify pending");
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
        for await (const rows of this.port.scan()) {
            if (!this.is("buffering")) return;
            for (const row of rows) {
                this.applyHead(row.key, row.head, row.modified, false);
            }
        }
        if (!this.is("buffering")) return;
        this.goLive();
    }

    /**
     * Adopts a persisted state (map, `hlc`, epoch), then applies the events
     * buffered since `attach`. The caller restores its sinks to the same
     * point first and then checks the count with `restoredCountMatches`.
     */
    restore(state: { map: IdHeadMap; hlc: bigint; epoch: number }) {
        if (!this.is("buffering")) {
            throw new Error(`cannot restore a ${this.stateValue} tap`);
        }
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
     * epoch (no change applied and no verify pending across the await).
     * `undefined` when no stable point was found in `tries` attempts.
     */
    async restoredCountMatches(tries = 3): Promise<boolean | undefined> {
        for (let i = 0; i < tries; i++) {
            await this.verifyIdle();
            if (!this.is("live")) return undefined;
            const epoch = this.epoch;
            const indexed = await this.port.count();
            if (
                this.is("live") &&
                this.epoch === epoch &&
                this.pendingVerify === 0
            ) {
                return indexed === this.map.size;
            }
        }
        return undefined;
    }

    /**
     * Discards the live state and seeds again by scan. Events are buffered
     * from now on, so none is lost between the reset and the scan.
     */
    async reseed(): Promise<void> {
        if (this.is("disposed")) return;
        await this.verifyIdle();
        if (this.is("disposed")) return;
        this.stateValue = "buffering";
        // A fresh seed. The epoch keeps counting, so a sink that numbers
        // its applies re-aligns to it on reset.
        this.map = new IdHeadMap();
        this.hlc = 0n;
        for (const sink of this.sinks) {
            sink.reset?.();
        }
        await this.seedFromScan();
    }
}
