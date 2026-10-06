import {
    createAnchorMath,
    type AnchorCrypto,
    type AnchorMath,
} from "./anchor.js";
import { anchorWorkerMain } from "./anchor-worker.js";
import { DIGEST_BYTES, LANES } from "./constants.js";

/**
 * The process-wide anchor host (M1 plan section 4). One worker thread per
 * process, created lazily by the first lane set and shared by every open
 * filesystem and scope; each user holds a lane set by a process-unique id
 * (never derived from the address or scope, so a late `drop` of an old
 * generation cannot hit a reopened one).
 *
 * - **Sequence points.** `apply` is synchronous and numbers every element
 *   (`seq`). Elements are batched (flushed on a microtask or at 256) and a
 *   request flushes the pending batch before it is posted, so the worker
 *   answers for exactly the current `seq`; the API takes no seq argument.
 * - **Process lifetime (S14).** The worker is unref'ed while no request is
 *   outstanding and ref'ed while any `digestNow`, `digestOf` or `lanesNow`
 *   is pending, so a one-shot process cannot exit before persistence gets
 *   its lanes, and an idle host never keeps a process alive.
 * - **Failure.** On a worker `error`, `messageerror` or unintended `exit`,
 *   pending requests reject with `EAGAIN`, the worker is respawned once and
 *   every lane set of the process is rebuilt from its tap's id-map slab
 *   (posted before any later batch, so ordering holds). A second failure
 *   within 10 minutes switches the process to the inline fallback.
 * - **Inline fallback.** The same math (anchor.ts) on the main thread
 *   through the same interface: used without `worker_threads`, after
 *   repeated failure, and by unit tests. Degraded (M0 P4: the expansion's
 *   4 KiB allocation is slow on a large main heap) and reported by `mode`.
 * - **Shutdown.** Refcounted by lane sets: when the last one closes (and no
 *   request is pending) the worker is terminated; an intentional terminate
 *   never triggers a respawn.
 *
 * `node:worker_threads` and `node:crypto` are reached by dynamic import
 * only, on the first open of any filesystem (directory or not). Without a
 * usable `node:crypto` (a browser) `create` rejects and the readiness
 * runtime runs without state; without a usable `Worker` export (a bundler's
 * empty stub included) the host runs inline.
 */

export type AnchorHostMode = "worker" | "inline";

/** The live heads a lane set is rebuilt from after a worker failure. */
export interface LaneSlab {
    readonly size: number;
    forEach(fn: (digest: Uint8Array) => void): void;
}

export interface LaneSetOptions {
    /** Persisted lanes (1,024 little-endian u32) and their sequence number. */
    restore?: { lanes: Uint8Array; seq: number };
    /** The current live set, read at rebuild time (the tap's id map). */
    slab?: () => LaneSlab;
}

export interface AnchorHostStats {
    respawns: number;
    failures: number;
    /** Why the host runs inline, when it does. */
    inlineReason?: string;
    /** Highest `seq - acked` seen on any lane set (elements). */
    lagHighWater: number;
    batches: number;
    elements: number;
}

export class AnchorUnavailableError extends Error {
    readonly code = "EAGAIN";
}

/** Elements per batch before a synchronous flush (P4). */
const BATCH_ELEMENTS = 256;
/** A second worker failure within this window switches to inline. */
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
/** Elements per rebuild batch posted after a respawn. */
const REBUILD_BATCH_ELEMENTS = 4096;

let nextLaneSetId = 1;

type WorkerLike = {
    postMessage(message: any, transfer?: any[]): void;
    on(event: string, listener: (...args: any[]) => void): unknown;
    ref(): void;
    unref(): void;
    terminate(): Promise<number>;
};
type WorkerConstructor = new (
    source: string,
    options: { eval: true }
) => WorkerLike;

type PendingRequest = {
    set: number;
    resolve(value: Uint8Array): void;
    reject(error: unknown): void;
};

/**
 * The eval source of the worker. The `__name` shim keeps the serialized
 * functions valid when a transform (tsx, esbuild `keepNames`) wrapped inner
 * functions in `__name(...)` (S13); it only sets a function name.
 */
export const anchorWorkerSource = () =>
    [
        '"use strict";',
        "var __name = (fn, _value) => fn;",
        'const { parentPort } = require("node:worker_threads");',
        `(${anchorWorkerMain.toString()})(parentPort, (${createAnchorMath.toString()})(require("node:crypto")));`,
    ].join("\n");

const packDigests = (digests: Uint8Array[] | undefined) => {
    if (!digests?.length) return undefined;
    const out = new Uint8Array(digests.length * DIGEST_BYTES);
    digests.forEach((digest, i) => {
        if (digest.length !== DIGEST_BYTES) {
            throw new Error(`expected ${DIGEST_BYTES}-byte digests`);
        }
        out.set(digest, i * DIGEST_BYTES);
    });
    return out;
};

export class LaneSet {
    readonly id = nextLaneSetId++;
    private seqValue: number;
    /** Highest seq the worker acknowledged. */
    private acked: number;
    /**
     * The unflushed batch. A partial batch is copied out at its flush and
     * the buffer reused, so one-element events (the common case on the write
     * path) do not allocate a fresh 8 KiB buffer each.
     */
    private pending?: {
        buf: ArrayBuffer;
        digests: Uint8Array;
        signs: Int8Array;
        n: number;
    };
    /** Inline lanes (inline mode only). */
    lanes?: Uint32Array;
    private closedValue = false;
    private applied = false;
    /** Set when a respawn could not rebuild this set (no slab). */
    faulted?: Error;

    /** @internal Created by `AnchorHost.open`. */
    constructor(
        private readonly host: AnchorHost,
        readonly iv: Uint8Array,
        readonly slab: (() => LaneSlab) | undefined,
        seq: number
    ) {
        this.seqValue = seq;
        this.acked = seq;
    }

    /** Elements applied so far (equals the tap's epoch). */
    get seq(): number {
        return this.seqValue;
    }

    get closed(): boolean {
        return this.closedValue;
    }

    /** Synchronous: numbers and enqueues one element change. */
    apply(digest: Uint8Array, sign: 1 | -1) {
        if (this.closedValue) return;
        if (digest.length !== DIGEST_BYTES) {
            throw new Error(`expected a ${DIGEST_BYTES}-byte digest`);
        }
        this.applied = true;
        this.seqValue++;
        this.host.enqueue(this, digest, sign);
    }

    /**
     * Drops everything applied so far and continues at `seq` (the tap's
     * epoch after a discarded restore): the lanes become the empty set.
     */
    reset(seq: number) {
        if (this.closedValue) return;
        this.pending = undefined;
        this.seqValue = seq;
        this.acked = seq;
        this.host.initSet(this);
    }

    /**
     * Adopts persisted lanes at `seq`. Only on a fresh set: nothing may have
     * been applied yet, since the restored lanes replace the whole set.
     */
    restore(lanes: Uint8Array, seq: number) {
        if (this.closedValue) return;
        if (this.applied) {
            throw new Error("restore needs an untouched lane set");
        }
        this.seqValue = seq;
        this.acked = seq;
        this.host.initSet(this, lanes);
    }

    /**
     * sha256(tag || lanes) at the current seq, after subtracting `sub` and
     * adding `add` (32-byte digests). Synchronous up to the post, so no later
     * apply can overtake it (S14). Callers await `tap.verifyIdle()` first and
     * call it only while `pendingVerify === 0` (S10).
     */
    digestNow(
        sub?: Uint8Array[],
        add?: Uint8Array[]
    ): { seq: number; digest: Promise<Uint8Array> } {
        const seq = this.seqValue;
        return {
            seq,
            digest: this.host.request(this, "digestNow", {
                seq,
                sub: packDigests(sub),
                add: packDigests(add),
            }),
        };
    }

    /** The anchor digest of an arbitrary set (n x 32 B), under this tag. */
    digestOf(set: Uint8Array): Promise<Uint8Array> {
        if (set.length % DIGEST_BYTES !== 0) {
            return Promise.reject(
                new Error(`expected n x ${DIGEST_BYTES} bytes`)
            );
        }
        return this.host.request(this, "digestOf", { buf: set.slice() });
    }

    /** The lanes (1,024 little-endian u32) at the current seq. */
    lanesNow(): { seq: number; lanes: Promise<Uint8Array> } {
        const seq = this.seqValue;
        return { seq, lanes: this.host.request(this, "lanes", { seq }) };
    }

    /** Elements posted or pending that the worker has not acknowledged. */
    lag(): number {
        return this.seqValue - this.acked;
    }

    close() {
        if (this.closedValue) return;
        this.closedValue = true;
        this.pending = undefined;
        this.host.release(this);
    }

    /**
     * @internal The unflushed batch as one transferable buffer: n x 32
     * digests, then n signs. A full batch hands over its buffer; a partial
     * one is copied out and the buffer kept for the next batch.
     */
    takePending(): { buf: ArrayBuffer; n: number } | undefined {
        const pending = this.pending;
        if (!pending || pending.n === 0) return undefined;
        const { n } = pending;
        if (n === BATCH_ELEMENTS) {
            this.pending = undefined;
            return { buf: pending.buf, n };
        }
        const packed = new Uint8Array(n * (DIGEST_BYTES + 1));
        packed.set(pending.digests.subarray(0, n * DIGEST_BYTES));
        packed.set(pending.signs.subarray(0, n), n * DIGEST_BYTES);
        pending.n = 0;
        return { buf: packed.buffer, n };
    }

    /** @internal */
    appendPending(digest: Uint8Array, sign: 1 | -1): number {
        let pending = this.pending;
        if (!pending) {
            const buf = new ArrayBuffer(BATCH_ELEMENTS * (DIGEST_BYTES + 1));
            pending = this.pending = {
                buf,
                digests: new Uint8Array(buf, 0, BATCH_ELEMENTS * DIGEST_BYTES),
                signs: new Int8Array(buf, BATCH_ELEMENTS * DIGEST_BYTES),
                n: 0,
            };
        }
        pending.digests.set(digest, pending.n * DIGEST_BYTES);
        pending.signs[pending.n] = sign;
        return ++pending.n;
    }

    /** @internal */
    noteAck(seq: number) {
        if (seq > this.acked) this.acked = seq;
    }

    /** @internal */
    noteRebuilt() {
        this.pending = undefined;
        this.acked = this.seqValue;
    }
}

export class AnchorHost {
    private static sharedHost?: Promise<AnchorHost>;

    /** The process-wide host. A failed creation is not cached. */
    static shared(): Promise<AnchorHost> {
        if (!AnchorHost.sharedHost) {
            const created = AnchorHost.create();
            AnchorHost.sharedHost = created;
            created.catch(() => {
                if (AnchorHost.sharedHost === created) {
                    AnchorHost.sharedHost = undefined;
                }
            });
        }
        return AnchorHost.sharedHost;
    }

    /** A private host (tests); `mode: "inline"` never starts a worker. */
    static async create(
        options: { mode?: AnchorHostMode } = {}
    ): Promise<AnchorHost> {
        const crypto = await import("node:crypto");
        let worker: unknown;
        if (options.mode !== "inline") {
            try {
                worker = (await import("node:worker_threads")).Worker;
            } catch {
                worker = undefined;
            }
        }
        return AnchorHost.fromModules(crypto, worker, options);
    }

    /**
     * @internal A host from the module exports `create` found (tests pass
     * stubs). Throws without a usable crypto; a missing or non-constructor
     * `Worker` means inline.
     */
    static fromModules(
        crypto: unknown,
        worker: unknown,
        options: { mode?: AnchorHostMode } = {}
    ): AnchorHost {
        const surface = crypto as Partial<AnchorCrypto> | undefined;
        if (
            typeof surface?.createCipheriv !== "function" ||
            typeof surface?.createHash !== "function"
        ) {
            throw new Error("node:crypto is unavailable");
        }
        const math = createAnchorMath(surface as AnchorCrypto);
        const workerConstructor =
            options.mode !== "inline" && typeof worker === "function"
                ? (worker as WorkerConstructor)
                : undefined;
        const inlineReason =
            options.mode === "inline"
                ? "requested"
                : workerConstructor
                  ? undefined
                  : "worker_threads unavailable";
        return new AnchorHost(math, workerConstructor, inlineReason);
    }

    readonly stats: AnchorHostStats = {
        respawns: 0,
        failures: 0,
        lagHighWater: 0,
        batches: 0,
        elements: 0,
    };
    private readonly sets = new Map<number, LaneSet>();
    private readonly requests = new Map<number, PendingRequest>();
    private nextRequestId = 1;
    private worker?: WorkerLike;
    private workerSource?: string;
    private flushScheduled = false;
    private lastFailureAt?: number;
    private modeValue: AnchorHostMode;
    /** A rebuild is running; a nested one (a failed spawn) restarts it. */
    private rebuilding = false;
    private rebuildAgain = false;

    private constructor(
        readonly math: AnchorMath,
        private readonly workerConstructor: WorkerConstructor | undefined,
        inlineReason: string | undefined
    ) {
        this.modeValue = inlineReason ? "inline" : "worker";
        this.stats.inlineReason = inlineReason;
    }

    get mode(): AnchorHostMode {
        return this.modeValue;
    }

    /** Lane sets open on this host. */
    get openSets(): number {
        return this.sets.size;
    }

    /** Whether a worker thread is running (tests). */
    get workerRunning(): boolean {
        return this.worker !== undefined;
    }

    /** Requests waiting for the worker. */
    get pendingRequests(): number {
        return this.requests.size;
    }

    /**
     * A new lane set under the 16-byte domain tag `iv`: empty at seq 0, or
     * restored from persisted lanes. `slab` rebuilds it after a worker
     * failure; a set without one is faulted by a failure instead.
     */
    open(iv: Uint8Array, options: LaneSetOptions = {}): LaneSet {
        if (iv.length !== 16) {
            throw new Error("anchor domain tag must be 16 bytes");
        }
        const set = new LaneSet(this, Uint8Array.from(iv), options.slab, 0);
        this.sets.set(set.id, set);
        if (options.restore) {
            set.restore(options.restore.lanes, options.restore.seq);
        } else {
            this.initSet(set);
        }
        return set;
    }

    /** @internal Posts (or sets inline) a set's lanes: empty or restored. */
    initSet(set: LaneSet, lanes?: Uint8Array) {
        if (lanes && lanes.length !== LANES * 4) {
            throw new Error(`expected ${LANES * 4} bytes of lanes`);
        }
        if (this.modeValue === "inline") {
            set.lanes = lanes
                ? this.math.bytesToLanes(lanes)
                : new Uint32Array(LANES);
            return;
        }
        this.post({
            type: "init",
            set: set.id,
            iv: set.iv,
            seq: set.seq,
            lanes: lanes ? lanes.slice() : undefined,
        });
    }

    /** @internal */
    enqueue(set: LaneSet, digest: Uint8Array, sign: 1 | -1) {
        this.stats.elements++;
        if (this.modeValue === "inline") {
            this.math.applyMany(set.lanes!, set.iv, digest, sign);
            set.noteAck(set.seq);
            return;
        }
        const lag = set.lag();
        if (lag > this.stats.lagHighWater) this.stats.lagHighWater = lag;
        if (set.appendPending(digest, sign) >= BATCH_ELEMENTS) {
            this.flushSet(set);
        } else if (!this.flushScheduled) {
            this.flushScheduled = true;
            // A promise job rather than queueMicrotask, which creates an
            // AsyncResource per call (measurable at one element per event).
            void resolved.then(this.flushAllBound);
        }
    }

    private readonly flushAllBound = () => this.flushAll();

    private flushAll() {
        this.flushScheduled = false;
        for (const set of this.sets.values()) this.flushSet(set);
    }

    private flushSet(set: LaneSet) {
        if (this.modeValue === "inline") return;
        const pending = set.takePending();
        if (!pending) return;
        // Signs follow the digests directly, so one transferred buffer
        // carries the batch.
        const { buf: out, n } = pending;
        this.stats.batches++;
        this.post(
            { type: "batch", set: set.id, buf: out, n, seqEnd: set.seq },
            [out]
        );
    }

    /** @internal Sends one request for `set`; settles with the reply. */
    request(
        set: LaneSet,
        type: "digestNow" | "digestOf" | "lanes",
        body: {
            seq?: number;
            sub?: Uint8Array;
            add?: Uint8Array;
            buf?: Uint8Array;
        }
    ): Promise<Uint8Array> {
        if (set.closed) {
            return Promise.reject(new Error("lane set closed"));
        }
        if (set.faulted) {
            return Promise.reject(set.faulted);
        }
        this.flushSet(set);
        // A worker that cannot start switches the host to inline here.
        const worker =
            this.modeValue === "inline"
                ? undefined
                : (this.worker ?? this.spawn());
        if (!worker || set.faulted) {
            if (set.faulted) return Promise.reject(set.faulted);
            try {
                return Promise.resolve(this.answerInline(set, type, body));
            } catch (error) {
                return Promise.reject(error);
            }
        }
        const id = this.nextRequestId++;
        const reply = new Promise<Uint8Array>((resolve, reject) => {
            this.requests.set(id, { set: set.id, resolve, reject });
        });
        if (this.requests.size === 1) {
            // A pending answer keeps the process alive (S14).
            worker.ref();
        }
        worker.postMessage({ type, id, set: set.id, ...body });
        return reply;
    }

    private answerInline(
        set: LaneSet,
        type: "digestNow" | "digestOf" | "lanes",
        body: { sub?: Uint8Array; add?: Uint8Array; buf?: Uint8Array }
    ): Uint8Array {
        if (type === "lanes") {
            return this.math.lanesToBytes(set.lanes!);
        }
        const lanes =
            type === "digestOf" ? new Uint32Array(LANES) : set.lanes!.slice();
        if (type === "digestOf") {
            this.math.applyMany(lanes, set.iv, body.buf!, 1);
        } else {
            if (body.sub) this.math.applyMany(lanes, set.iv, body.sub, -1);
            if (body.add) this.math.applyMany(lanes, set.iv, body.add, 1);
        }
        return this.math.digest(lanes, set.iv);
    }

    /** @internal */
    release(set: LaneSet) {
        if (!this.sets.delete(set.id)) return;
        if (this.worker) {
            this.post({ type: "drop", set: set.id });
        }
        this.maybeTerminate();
    }

    private maybeTerminate() {
        if (this.sets.size > 0 || this.requests.size > 0 || !this.worker) {
            return;
        }
        const worker = this.worker;
        this.worker = undefined;
        // Marked before terminate(): its exit is never read as a crash.
        intentional.add(worker);
        void worker.terminate().catch(() => {});
    }

    /** Forces a worker crash (tests): the failure path runs for real. */
    crashWorkerForTest() {
        this.worker?.postMessage({ type: "crash" });
    }

    private post(message: any, transfer?: any[]) {
        const worker = this.worker ?? this.spawn();
        if (!worker) return;
        worker.postMessage(message, transfer);
    }

    private spawn(): WorkerLike | undefined {
        if (this.modeValue === "inline") {
            return undefined;
        }
        if (!this.workerConstructor) {
            // Never a worker mode host without a way to start one.
            this.goInline("worker_threads unavailable");
            return undefined;
        }
        let worker: WorkerLike;
        try {
            this.workerSource ??= anchorWorkerSource();
            worker = new this.workerConstructor(this.workerSource, {
                eval: true,
            });
        } catch (error: any) {
            this.goInline(`worker did not start: ${error?.message ?? error}`);
            return undefined;
        }
        worker.unref();
        worker.on("message", (message: any) =>
            this.onWorkerMessage(worker, message)
        );
        worker.on("error", (error: unknown) => this.onFailure(worker, error));
        worker.on("messageerror", (error: unknown) =>
            this.onFailure(worker, error)
        );
        worker.on("exit", (code: number) => {
            if (!intentional.has(worker)) {
                this.onFailure(worker, new Error(`worker exited (${code})`));
            }
        });
        this.worker = worker;
        return worker;
    }

    private onWorkerMessage(worker: WorkerLike, message: any) {
        if (worker !== this.worker) return;
        if (message.type === "ack") {
            this.sets.get(message.set)?.noteAck(message.seq);
            return;
        }
        const request = this.requests.get(message.id);
        if (!request) return;
        this.requests.delete(message.id);
        if (message.type === "error") {
            request.reject(new Error(`anchor worker: ${message.message}`));
        } else {
            request.resolve(
                new Uint8Array(
                    message.type === "lanes" ? message.lanes : message.digest
                )
            );
        }
        this.afterRequest();
    }

    private afterRequest() {
        if (this.requests.size === 0) {
            this.worker?.unref();
            this.maybeTerminate();
        }
    }

    private onFailure(worker: WorkerLike, error: unknown) {
        if (worker !== this.worker) return;
        this.worker = undefined;
        intentional.add(worker);
        void worker.terminate().catch(() => {});
        this.stats.failures++;
        const failed = new AnchorUnavailableError(
            `anchor worker failed: ${(error as any)?.message ?? error}`
        );
        const requests = [...this.requests.values()];
        this.requests.clear();
        for (const request of requests) request.reject(failed);
        const now = Date.now();
        const repeated =
            this.lastFailureAt !== undefined &&
            now - this.lastFailureAt < FAILURE_WINDOW_MS;
        this.lastFailureAt = now;
        if (repeated) {
            this.goInline(
                `worker failed twice within 10 minutes: ${failed.message}`
            );
            return;
        }
        this.stats.respawns++;
        this.rebuildAll();
    }

    private goInline(reason: string) {
        if (this.modeValue === "inline") return;
        this.modeValue = "inline";
        this.stats.inlineReason = reason;
        this.worker = undefined;
        console.warn(
            `shared-fs: readiness anchor runs on the main thread (degraded): ${reason}`
        );
        this.rebuildAll();
    }

    /**
     * Rebuilds every lane set of the process from its slab, at its current
     * seq: in a fresh worker (init then the slab, posted before any later
     * batch) or inline. Every live head is in the slab, so no index scan.
     * Not re-entrant: a spawn that fails inside it switches the host to
     * inline, and the rebuild then starts over inline for every set (a
     * nested rebuild would apply a slab twice to the set being rebuilt).
     */
    private rebuildAll() {
        if (this.rebuilding) {
            this.rebuildAgain = true;
            return;
        }
        this.rebuilding = true;
        try {
            do {
                this.rebuildAgain = false;
                this.rebuildOnce();
            } while (this.rebuildAgain);
        } finally {
            this.rebuilding = false;
        }
    }

    private rebuildOnce() {
        const mode = this.modeValue;
        for (const set of this.sets.values()) {
            const slab = set.slab?.();
            set.noteRebuilt();
            if (!slab) {
                set.faulted = new AnchorUnavailableError(
                    "anchor worker failed and the lane set has no slab to rebuild from"
                );
                continue;
            }
            this.initSet(set);
            if (this.modeValue !== mode) return;
            if (mode === "inline") {
                slab.forEach((digest) =>
                    this.math.applyMany(set.lanes!, set.iv, digest, 1)
                );
                continue;
            }
            const buf = new Uint8Array(REBUILD_BATCH_ELEMENTS * DIGEST_BYTES);
            let n = 0;
            const flush = () => {
                if (n === 0) return;
                const out = new Uint8Array(n * (DIGEST_BYTES + 1));
                out.set(buf.subarray(0, n * DIGEST_BYTES));
                out.fill(1, n * DIGEST_BYTES);
                this.post(
                    {
                        type: "batch",
                        set: set.id,
                        buf: out.buffer,
                        n,
                        seqEnd: set.seq,
                    },
                    [out.buffer]
                );
                n = 0;
            };
            slab.forEach((digest) => {
                buf.set(digest.subarray(0, DIGEST_BYTES), n * DIGEST_BYTES);
                if (++n === REBUILD_BATCH_ELEMENTS) flush();
            });
            flush();
            if (this.modeValue !== mode) return;
        }
    }
}

const intentional = new WeakSet<object>();
const resolved = Promise.resolve();
