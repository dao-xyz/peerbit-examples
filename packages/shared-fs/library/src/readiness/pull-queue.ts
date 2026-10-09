import { PULL_BATCH, PULL_TIMEOUT_MS } from "./constants.js";
import type { Rejection, RejectionRecord } from "./explain.js";

/**
 * The joiner's pull queue for one scope (WRITE_READINESS_V2.md section 4.5
 * steps 7-8, M1 plan section 7.3). Every session of the scope pulls through
 * it, so a hash is in flight once however many peers name it (M0 P5: two
 * donors each pulled the same 256 hashes).
 *
 * - **Batches.** At most `PULL_BATCH` hashes per batch and one batch per
 *   owner (a session) in flight. An owner's batch is in flight from `pull`
 *   until the owner reports it classified (`settled`), so a retry that
 *   arrives while the owner still classifies waits for it. Hashes already
 *   in flight in another owner's batch are not joined again; the report
 *   waits for that batch.
 * - **Join.** One `join(heads, { timeout })` per batch, the scope log's
 *   `SharedLog.join`. It reports nothing per hash, so the owner classifies
 *   every hash afterwards (explain.ts). Its timeout is the only bound; the
 *   queue arms no timer.
 * - **Failed hashes** are kept per owner. They are retried on events only:
 *   a sign of life from the owner's peer (`retry(owner)`), any local index
 *   change (`noteIndexChange`), and a batch of another owner that made
 *   progress (`settled`). A batch without progress triggers nothing, so a
 *   hash nobody serves never loops: under steady arrivals it costs at most
 *   one batch in flight per owner at a time.
 * - **Rejections.** The heads of a batch are tracked in the scope's
 *   `RejectionRecord` while its join runs. When the join settles, the
 *   queue copies what `canPerform` recorded for them and releases them, so
 *   a later join of the same head starts with no record. A report carries
 *   the copies of every batch its heads rode on.
 */

/** The scope's log, as the queue uses it. */
export interface PullPorts {
    /**
     * `SharedLog.join(heads, { timeout })` on the scope's log. Resolves or
     * rejects; no per-hash result.
     */
    join(heads: string[], options: { timeout: number }): Promise<void>;
    /**
     * Calls `listener` on every local index change of the scope (the retry
     * trigger); returns its removal.
     */
    subscribe?(listener: () => void): () => void;
}

export interface PullQueueOptions {
    /** Hashes per batch (`PULL_BATCH`). */
    batch?: number;
    /** `join` timeout of one batch (`PULL_TIMEOUT_MS`). */
    timeoutMs?: number;
}

/** One finished `pull`: every batch carrying one of its heads settled. */
export interface PullReport {
    readonly heads: readonly string[];
    /** `canPerform` rejections recorded for these heads while they ran. */
    readonly rejections: ReadonlyMap<string, Rejection>;
    /** Heads this owner's own batch carried (the rest rode on others). */
    readonly joined: number;
    /** The join's error, a timeout included; the heads are reported anyway. */
    readonly error?: unknown;
}

export interface PullQueueStats {
    batches: number;
    joined: number;
    /** Heads that waited on another owner's batch instead of a second join. */
    deduped: number;
    joinErrors: number;
    /** Failed sets handed back to their owners. */
    retries: number;
}

/** One `join` in flight or settled. */
interface Batch {
    readonly heads: readonly string[];
    /** Settles after the join and `finish`, never rejects. */
    readonly done: Promise<void>;
    failed: boolean;
    error?: unknown;
    /** What `canPerform` recorded for `heads` during the join. */
    rejections?: ReadonlyMap<string, Rejection>;
}

interface Owner {
    /** From `pull` until `settled` (or `release`). */
    busy: boolean;
    /** A retry arrived while busy: run it at `settled`. */
    due: boolean;
    readonly failed: Set<string>;
    listener?: (heads: string[]) => void;
}

const NO_HEADS: ReadonlySet<string> = new Set();
const NO_REJECTIONS: ReadonlyMap<string, Rejection> = new Map();

export class PullQueue {
    readonly stats: PullQueueStats = {
        batches: 0,
        joined: 0,
        deduped: 0,
        joinErrors: 0,
        retries: 0,
    };

    private readonly owners = new Map<string, Owner>();
    /** Head -> the batch whose join carries it now. */
    private readonly inFlight = new Map<string, Batch>();
    private readonly unsubscribe?: () => void;
    private disposed = false;

    constructor(
        private readonly ports: PullPorts,
        readonly rejections: RejectionRecord,
        readonly options: PullQueueOptions = {}
    ) {
        this.unsubscribe = ports.subscribe?.(() => this.noteIndexChange());
    }

    /** Hashes per batch. */
    get batch(): number {
        return this.options.batch ?? PULL_BATCH;
    }

    /** `join` timeout per batch. */
    get timeoutMs(): number {
        return this.options.timeoutMs ?? PULL_TIMEOUT_MS;
    }

    /** Heads in flight in some batch now. */
    get inFlightHeads(): number {
        return this.inFlight.size;
    }

    /**
     * Pulls `heads` for `owner`. Throws (a bug) for more than `batch` heads
     * or while a batch of the owner is in flight (until its `settled`).
     * Never rejects: a join error is in the report. After `dispose` it joins
     * nothing and reports at once with an error.
     */
    pull(owner: string, heads: readonly string[]): Promise<PullReport> {
        if (heads.length > this.batch) {
            throw new Error(
                `readiness: a pull of ${heads.length} hashes exceeds the batch of ${this.batch}`
            );
        }
        if (this.disposed) {
            return Promise.resolve({
                heads: [...heads],
                rejections: NO_REJECTIONS,
                joined: 0,
                error: new Error("readiness: the pull queue is disposed"),
            });
        }
        const state = this.ownerOf(owner);
        if (state.busy) {
            throw new Error("readiness: a pull of this owner is in flight");
        }
        const riding = new Set<Batch>();
        const rest: string[] = [];
        let deduped = 0;
        for (const head of new Set(heads)) {
            const carrier = this.inFlight.get(head);
            if (carrier) {
                riding.add(carrier);
                deduped++;
            } else {
                rest.push(head);
            }
        }
        // Busy before `join` runs, so a retry of this owner that the join
        // causes is marked due instead of starting a second batch.
        state.busy = true;
        const own = rest.length > 0 ? this.startBatch(rest) : undefined;
        this.stats.deduped += deduped;
        // A head pulled again is no longer waiting for a retry.
        for (const head of heads) state.failed.delete(head);
        const batches = own ? [own, ...riding] : [...riding];
        const requested = [...heads];
        return Promise.all(batches.map((batch) => batch.done)).then(() =>
            this.reportOf(requested, own, batches)
        );
    }

    /** Whether a batch of `owner` is in flight (until its `settled`). */
    busy(owner: string): boolean {
        return this.owners.get(owner)?.busy === true;
    }

    /**
     * Adds fetch-failed heads of `owner` (design 4.5 step 8). Ignored for an
     * owner that never pulled or was released.
     */
    fail(owner: string, heads: Iterable<string>): void {
        const state = this.owners.get(owner);
        if (!state) return;
        for (const head of heads) state.failed.add(head);
    }

    /** The fetch-failed heads of `owner`. */
    failed(owner: string): ReadonlySet<string> {
        return this.owners.get(owner)?.failed ?? NO_HEADS;
    }

    /**
     * The owner classified its last report: its batch is no longer in
     * flight. A batch that made progress (a head indexed or explained)
     * retries every other owner's failed heads; an owner marked due while
     * its batch ran is retried now. Once per pull: without a batch in
     * flight it does nothing.
     */
    settled(owner: string, progressed: boolean): void {
        const state = this.owners.get(owner);
        if (!state?.busy) return;
        state.busy = false;
        if (progressed) {
            for (const other of [...this.owners.keys()]) {
                if (other !== owner) this.retryOwner(other);
            }
        }
        if (state.due) {
            state.due = false;
            this.retryOwner(owner);
        }
    }

    /**
     * Hands the failed heads of `owner` (or of every owner) back to its
     * retry listener; an owner with a batch in flight is marked due instead.
     * An owner without a listener keeps its failed heads.
     */
    retry(owner?: string): void {
        if (this.disposed) return;
        if (owner !== undefined) {
            this.retryOwner(owner);
            return;
        }
        for (const id of [...this.owners.keys()]) this.retryOwner(id);
    }

    /**
     * A local index change of the scope: idle owners with failed heads are
     * retried, owners with a batch in flight are marked due.
     */
    noteIndexChange(): void {
        this.retry();
    }

    /** Registers the owner's retry listener; returns its removal. */
    onRetry(owner: string, listener: (heads: string[]) => void): () => void {
        if (this.disposed) return () => {};
        const state = this.ownerOf(owner);
        state.listener = listener;
        return () => {
            if (state.listener === listener) state.listener = undefined;
        };
    }

    /**
     * The owner ended: its failed set, listener and due mark go. A batch it
     * has in flight still completes for the owners waiting on it, and its
     * own report still resolves.
     */
    release(owner: string): void {
        this.owners.delete(owner);
    }

    /** Unsubscribes; reports still pending resolve when their joins settle. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.owners.clear();
        try {
            this.unsubscribe?.();
        } catch {
            // The scope's sink set is gone with its tap: nothing to remove.
        }
    }

    private ownerOf(owner: string): Owner {
        let state = this.owners.get(owner);
        if (!state) {
            state = { busy: false, due: false, failed: new Set() };
            this.owners.set(owner, state);
        }
        return state;
    }

    private retryOwner(owner: string) {
        const state = this.owners.get(owner);
        if (!state) return;
        if (state.busy) {
            state.due = true;
            return;
        }
        const listener = state.listener;
        if (!listener || state.failed.size === 0) return;
        const heads = [...state.failed];
        state.failed.clear();
        this.stats.retries++;
        try {
            listener(heads);
        } catch {
            // A listener never throws (S15); if one does, its heads are
            // gone from the failed set and its owner pulls them again on
            // its own events.
        }
    }

    private startBatch(heads: string[]): Batch {
        this.rejections.track(heads);
        let settle!: () => void;
        const batch: Batch = {
            heads,
            done: new Promise<void>((resolve) => (settle = resolve)),
            failed: false,
        };
        // In flight before `join` runs: an index change it causes may make
        // another owner pull the same heads at once, and they must ride.
        for (const head of heads) this.inFlight.set(head, batch);
        this.stats.batches++;
        this.stats.joined += heads.length;
        let joining: Promise<void>;
        try {
            joining = Promise.resolve(
                this.ports.join([...heads], { timeout: this.timeoutMs })
            );
        } catch (error) {
            joining = Promise.reject(error);
        }
        joining
            .then(
                () => this.finish(batch, false, undefined),
                (error) => this.finish(batch, true, error)
            )
            .then(settle, settle);
        return batch;
    }

    /** The join settled: copy its rejections, release its heads. */
    private finish(batch: Batch, failed: boolean, error: unknown) {
        if (failed) {
            batch.failed = true;
            batch.error =
                error ?? new Error("readiness: join rejected without a reason");
            this.stats.joinErrors++;
        }
        batch.rejections = this.rejections.take(batch.heads);
        this.rejections.release(batch.heads);
        for (const head of batch.heads) {
            if (this.inFlight.get(head) === batch) this.inFlight.delete(head);
        }
    }

    private reportOf(
        heads: readonly string[],
        own: Batch | undefined,
        batches: readonly Batch[]
    ): PullReport {
        const rejections = new Map<string, Rejection>();
        for (const head of heads) {
            for (const batch of batches) {
                const rejection = batch.rejections?.get(head);
                if (rejection) {
                    rejections.set(head, rejection);
                    break;
                }
            }
        }
        const joined = own?.heads.length ?? 0;
        // The owner's own join error first, else one its heads rode on.
        const failed = own?.failed
            ? own
            : batches.find((batch) => batch.failed);
        return failed
            ? { heads, rejections, joined, error: failed.error }
            : { heads, rejections, joined };
    }
}
