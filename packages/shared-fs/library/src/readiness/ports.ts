import { deserialize } from "@dao-xyz/borsh";
import { PublicSignKey, getPublicKeyFromPeerId } from "@peerbit/crypto";
import { isDeleteOperation, isPutOperation } from "@peerbit/document";
import { PULL_LANES } from "./constants.js";
import {
    Explainer,
    RejectionRecord,
    type EntryFacts,
    type ExplainPorts,
    type Rejection,
    type RejectionReason,
} from "./explain.js";
import {
    PullQueue,
    type PullPorts,
    type PullQueueOptions,
} from "./pull-queue.js";
import type { ResponderScope } from "./responder.js";
import {
    SCOPE_TRUST_V1,
    type ScopeDescriptor,
    type ScopeId,
} from "./scopes.js";
import { localScopeOf, type SessionScopePorts } from "./session.js";
import { scopeRowKey, type ScopeIndexPort, type ScopeTap } from "./tap.js";

/**
 * The production bindings of the joiner session's ports (PR-3 commit 2): the
 * explainer's reads of J's log and index, the pull queue's `join` and index
 * subscription, and the per-scope bundle a session opens. Commit 1 left them
 * as interfaces (session.ts, explain.ts, pull-queue.ts) and tested against
 * fakes; these read the real store, and `readiness-ports.test.ts` tests them
 * against real Documents and SharedLog.
 *
 * Soundness rests on `inspect`: a `not-row` it returns wrongly excludes an
 * honest peer (`unsubstantiated`), and a `row` with the wrong id makes the
 * newest-wins comparison read the wrong row. So `inspect` derives the id
 * exactly as the tap does (the scope's `classify` and `key` on the value
 * Documents decodes with its own value encoding), answers only for entries
 * J's log holds (`Log.has`; `Log.get` alone reads the block store, which
 * also holds blocks that never entered the log), reads nothing remote, and
 * says `unknown` (never `not-row`) for anything it cannot decode.
 */

const REJECTIONS: Readonly<Record<RejectionReason, Rejection>> = {
    structure: Object.freeze({ reason: "structure", permanent: true }),
    untrusted: Object.freeze({ reason: "untrusted", permanent: false }),
    "trust-cache": Object.freeze({ reason: "trust-cache", permanent: false }),
    transient: Object.freeze({ reason: "transient", permanent: false }),
};

/**
 * A `canPerform` refusal as the rejection record stores it: only a
 * structural one is permanent (explain.ts `RejectionReason`). An
 * `untrusted` or `trust-cache` refusal carries the keys whose trust would
 * reverse it, when given (a new object); otherwise the shared frozen one.
 */
export const rejectionOf = (
    reason: RejectionReason,
    signers?: readonly PublicSignKey[]
): Rejection => {
    const rejection = REJECTIONS[reason] ?? REJECTIONS.transient;
    if (
        signers === undefined ||
        signers.length === 0 ||
        (rejection.reason !== "untrusted" && rejection.reason !== "trust-cache")
    ) {
        return rejection;
    }
    return { ...rejection, signers: [...signers] };
};

/** The log entry fields `inspect` reads (`@peerbit/log` `Entry`). */
export interface LoggedEntry {
    readonly meta: {
        readonly clock: { readonly timestamp: { readonly wallTime: bigint } };
    };
    getPayloadValue(): unknown;
}

/** `EntryIndex.getHasNext`'s iterator (`@peerbit/log entry-index.d.ts:20`). */
export interface HasNextIterator {
    next(amount: number): unknown[] | Promise<unknown[]>;
    close(): void | Promise<void>;
}

/**
 * The public reads of a scope's store the explainer needs: `Log.has`,
 * `Log.get` (local only, no `remote` option), `log.entryIndex.getHasNext`
 * (`@peerbit/log log.d.ts:168`, `215`, `196`; `entry-index.d.ts:404`), and
 * the store's value encoding (`@peerbit/document search.d.ts:271`).
 * `Documents` satisfies it.
 */
export interface ExplainStore {
    readonly log: {
        readonly log: {
            has(hash: string): Promise<boolean>;
            get(hash: string): Promise<LoggedEntry | undefined>;
            readonly entryIndex: {
                getHasNext(next: string, resolve: false): HasNextIterator;
            };
        };
    };
    readonly index: {
        readonly valueEncoding: { decoder(bytes: Uint8Array): unknown };
    };
}

const describeError = (error: unknown): string =>
    (error as any)?.message ?? String(error);

/** A value's class name, for a `not-row` detail. */
const classNameOf = (value: unknown): string => {
    const name = (value as any)?.constructor?.name;
    return typeof name === "string" && name.length > 0 ? name : typeof value;
};

/**
 * What J's log holds for `head` (`ExplainPorts.inspect`). Undefined unless
 * J's log holds the entry. Throws only when a log read throws (the
 * explainer then classifies the head `unknown`).
 */
const inspectEntry = async (
    store: ExplainStore,
    scope: ScopeDescriptor,
    head: string
): Promise<EntryFacts | undefined> => {
    const log = store.log.log;
    // The entry index, pending index writes included (`log.js:577`,
    // `entry-index.js:1532-1543`). `Log.get` resolves from the block store
    // without this check (`entry-index.js:3123-3153`), and the block store
    // also holds blocks that never entered the log (G2-18).
    if (!(await log.has(head))) return undefined;
    // No options: `{ type: "full", ignoreMissing: true }` (`log.js:770-777`)
    // with no `remote`, so the block store reads only its local store
    // (`@peerbit/blocks remote.js:762-780`). A storage-hollow cached entry
    // is re-read from the store (`entry-index.js:3110-3122`).
    const entry = await log.get(head);
    // Removed since the `has`: J's log no longer holds it.
    if (!entry) return undefined;
    let payload: any;
    try {
        payload = await entry.getPayloadValue();
    } catch (error) {
        return { kind: "unknown", detail: `payload: ${describeError(error)}` };
    }
    // A CUT: R's set never holds one, it holds the heads of indexed puts.
    if (isDeleteOperation(payload)) {
        return { kind: "not-row", detail: "a delete" };
    }
    if (!isPutOperation(payload)) {
        return { kind: "unknown", detail: `operation ${classNameOf(payload)}` };
    }
    let value: unknown;
    try {
        // The store's own decoder, as Documents decodes an arrival before
        // its change event (`@peerbit/document program.js:3798-3800`).
        value = store.index.valueEncoding.decoder(
            new Uint8Array((payload as any).data)
        );
    } catch (error) {
        return { kind: "unknown", detail: `value: ${describeError(error)}` };
    }
    // The tap's key of the same value (`scopeRowKey`, `ScopeTap.onChange`):
    // a class outside the scope is never a row of R's set either, because
    // both sides classify by class under the same scope id.
    const key = scopeRowKey(scope, value);
    if (key === null) return { kind: "not-row", detail: classNameOf(value) };
    if (key === undefined) {
        return {
            kind: "unknown",
            detail: `${classNameOf(value)} without an id`,
        };
    }
    const wallTime = (entry.meta as any)?.clock?.timestamp?.wallTime;
    if (typeof wallTime !== "bigint") {
        return { kind: "unknown", detail: "no wall time" };
    }
    // What Documents' newest-wins compares against the indexed row
    // (`item.meta.clock.timestamp.wallTime`, `program.js:3822-3829`).
    return { kind: "row", key, wallTime };
};

/**
 * `ExplainPorts` on a scope's store:
 *
 * - `hasNext(head)`: `getHasNext(head, false)`, one result, iterator closed;
 * - `inspect(head)`: undefined unless `Log.has(head)`; then `Log.get` and
 *   the payload: a delete is `not-row`; a put whose value (decoded with the
 *   store's value encoding) the scope does not `classify` is `not-row`; one
 *   it classifies is a `row` with `scope.key(value)` and the entry's
 *   `meta.clock.timestamp.wallTime` (what Documents' newest-wins compares,
 *   `@peerbit/document program.js:3822-3829`); a decode failure, another
 *   operation or a missing key is `unknown`;
 * - `readHead(key)`: the tap's own index port (`ScopeTap.port`), so both
 *   read the same row the same way.
 */
export const documentsExplainPorts = (
    store: ExplainStore,
    scope: ScopeDescriptor,
    index: ScopeIndexPort
): ExplainPorts => ({
    hasNext: async (head) => {
        // An exact `meta.next` match on the entry index, pending writes
        // flushed first (`entry-index.js:1136-1146`, `1268-1313`).
        const iterator = store.log.log.entryIndex.getHasNext(head, false);
        try {
            return (await iterator.next(1)).length > 0;
        } finally {
            await iterator.close();
        }
    },
    inspect: (head) => inspectEntry(store, scope, head),
    readHead: (key) => index.readHead(key),
});

/**
 * The scope log's pull (`SharedLog.join`, `@peerbit/shared-log
 * index.d.ts:1124-1131`) and the read that tells whether a joined head
 * landed (`Log.has`, `@peerbit/log log.d.ts:168`). `Documents` satisfies
 * it.
 */
export interface PullStore {
    readonly log: {
        /**
         * `signal` reaches `Log.join` (`SharedLog.join` passes its options
         * on, `@peerbit/log log.js:3152-3158`).
         */
        join(
            heads: string[],
            options: { timeout: number; signal: AbortSignal }
        ): Promise<void>;
        readonly log: { has(hash: string): Promise<boolean> };
    };
}

export interface PullPortsOptions {
    /** Joins in flight at once over every batch (`PULL_LANES`). */
    lanes?: number;
    /** The batch deadline's clock, in ms (`performance.now`). */
    now?: () => number;
}

const resolved = Promise.resolve();

/**
 * `lanes` slots, handed out first come, first served. A waiter whose
 * signal aborts leaves without one.
 */
class Lanes {
    private free: number;
    private readonly waiting: Array<() => void> = [];

    constructor(size: number) {
        this.free = Math.max(1, Math.floor(size));
    }

    /** True with a slot (`release` it), false once `signal` aborted. */
    acquire(signal: AbortSignal): Promise<boolean> {
        if (signal.aborted) return Promise.resolve(false);
        if (this.free > 0) {
            this.free--;
            return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
            const grant = () => {
                signal.removeEventListener("abort", leave);
                resolve(true);
            };
            const leave = () => {
                const at = this.waiting.indexOf(grant);
                if (at >= 0) this.waiting.splice(at, 1);
                resolve(false);
            };
            this.waiting.push(grant);
            signal.addEventListener("abort", leave, { once: true });
        });
    }

    release() {
        const next = this.waiting.shift();
        if (next) next();
        else this.free++;
    }
}

/**
 * `PullPorts` on a scope's store. `subscribe` is a second sink on the
 * scope's tap that calls the listener once per microtask in which rows
 * changed or the tap re-seeded (an index change, design 4.9), and returns
 * the sink's removal. `join` runs one `SharedLog.join([head], { timeout,
 * signal })` per head, on `PULL_LANES` lanes shared by every batch of the
 * store, within one deadline per batch (design 4.9: "pull join timeout
 * 10 s, one batch"):
 *
 * - **Lanes.** A provider that lacks a block sends no negative answer, so a
 *   head nobody serves always waits its whole timeout, and meanwhile every
 *   other replica lacking it proxies the request to the rest for J's
 *   remaining time, each hop on one of the 9 background slots of that
 *   replica's log (`@peerbit/blocks remote.js:183-191`, `843-882`,
 *   `1008-1014`). Side by side (one join per head, all at once), a batch of
 *   such heads held every slot of the other replicas for more than its
 *   timeout, and their ordinary background reads (sync's parent fetches,
 *   other joiners' pulls) waited seconds. Two lanes kept those reads at
 *   milliseconds (`PULL_LANES`).
 * - **One deadline.** Each join gets an equal share of the time left until
 *   the batch's deadline, per lane, over the heads still to start (itself
 *   included), so a few unserved heads cannot hold back the rest: a batch
 *   of served heads finishes long before the deadline, and an unserved
 *   head costs its share. (In one `Log.join` the heads are fetched one
 *   after another with the full timeout each, `@peerbit/log
 *   log.js:3216-3240`: N unserved heads took N timeouts and held every
 *   served head behind them.)
 * - **One more try.** A head J's log still lacks after its join goes once
 *   more, at the back, with the share of what is left then: a served head
 *   slower than its first share (a loaded provider, a missing parent) lands
 *   there, and a head nobody serves costs one more share.
 * - **The end.** No join starts after the deadline or once `signal`
 *   aborted (the queue's dispose: joins in flight abort through it). If
 *   that left a head without its first try, the batch fails with the
 *   abort's reason or an error that counts them; otherwise with a join
 *   error of a head whose last join threw, if any (`Log.join` resolves on
 *   a timeout, `log.js:3240-3246`). Every head J's log lacks
 *   afterwards is fetch-failed either way (the explainer reads the log),
 *   and the queue retries it on its events.
 *
 * Removals count as changes too: a CUT that arrives for a head whose fetch
 * failed removes the id's older row and makes that head superseded, and
 * only a retry classifies it so. A retry costs at most one batch in flight
 * per owner (pull-queue.ts), so the extra triggers cost nothing while no
 * fetch failed.
 */
export const sharedLogPullPorts = (
    store: PullStore,
    tap: Pick<ScopeTap, "addSink">,
    options: PullPortsOptions = {}
): PullPorts => {
    const width = Math.max(1, Math.floor(options.lanes ?? PULL_LANES));
    const lanes = new Lanes(width);
    const now = options.now ?? (() => performance.now());
    return {
        // No `replicate` option: a full replica holds what it joins anyway.
        join: async (heads, { timeout, signal }) => {
            const deadline = now() + timeout;
            const queue = [...new Set(heads)].map((head) => ({
                head,
                again: false,
            }));
            const total = queue.length;
            /** Each head's join error, while its last join threw. */
            const errors = new Map<string, unknown>();
            const lane = async () => {
                while (queue.length > 0 && !signal.aborted) {
                    if (!(await lanes.acquire(signal))) return;
                    try {
                        const left = deadline - now();
                        if (left <= 0 || signal.aborted) return;
                        const next = queue.shift();
                        if (!next) return;
                        const rounds = Math.ceil((queue.length + 1) / width);
                        const share = Math.max(1, Math.floor(left / rounds));
                        try {
                            await store.log.join([next.head], {
                                timeout: share,
                                signal,
                            });
                            errors.delete(next.head);
                        } catch (error) {
                            errors.set(next.head, error);
                        }
                        if (signal.aborted || next.again) continue;
                        let landed = true;
                        try {
                            landed = await store.log.log.has(next.head);
                        } catch {
                            // Unknown: the explainer reads the log afterwards.
                        }
                        if (!landed) {
                            queue.push({ head: next.head, again: true });
                        }
                    } finally {
                        lanes.release();
                    }
                }
            };
            await Promise.all(
                Array.from({ length: Math.min(width, total) }, lane)
            );
            const unstarted = queue.filter((next) => !next.again).length;
            if (unstarted > 0 && signal.aborted) {
                throw (
                    signal.reason ??
                    new Error("readiness: the pull was aborted")
                );
            }
            if (unstarted > 0) {
                throw new Error(
                    `readiness: ${unstarted} of ${total} heads not joined: the pull's ${timeout} ms ran out first`
                );
            }
            if (errors.size > 0) throw errors.values().next().value;
        },
        subscribe: (listener) => {
            let attached = true;
            let scheduled = false;
            const schedule = () => {
                if (scheduled || !attached) return;
                scheduled = true;
                void resolved.then(() => {
                    scheduled = false;
                    if (!attached) return;
                    try {
                        listener();
                    } catch {
                        // The pull queue's retry never throws (S15).
                    }
                });
            };
            const remove = tap.addSink({ apply: schedule, reset: schedule });
            return () => {
                if (!attached) return;
                attached = false;
                remove();
            };
        },
    };
};

/** One scope's session ports and the per-generation objects behind them. */
export interface SessionScopeBundle {
    readonly id: ScopeId;
    readonly ports: SessionScopePorts;
    readonly pulls: PullQueue;
    readonly explainer: Explainer;
    /** The record `canPerformEntry` notes into (runtime `noteRejection`). */
    readonly rejections: RejectionRecord;
    /**
     * Disposes the pull queue: its joins in flight abort, and
     * `pulls.whenIdle()` settles once they did (pending reports resolve).
     */
    dispose(): void;
}

/**
 * The bundle of one runtime scope: `localScopeOf` over its tap and lane set,
 * its log id, one `RejectionRecord`, one `PullQueue` on
 * `sharedLogPullPorts`, and one `Explainer` on `documentsExplainPorts` with
 * the tap's index port. One per scope and open generation; the runtime
 * creates it on the first `sessionScope(id)` and disposes it with the
 * generation. `options.pull` sets the queue's batch and join timeout
 * (tests).
 */
export const sessionScopeOf = (
    scope: ResponderScope,
    store: ExplainStore & PullStore,
    cellKey: readonly [number, number],
    options: { pull?: PullQueueOptions } = {}
): SessionScopeBundle => {
    const id = scope.descriptor.id;
    const rejections = new RejectionRecord();
    const pulls = new PullQueue(
        sharedLogPullPorts(store, scope.tap),
        rejections,
        options.pull
    );
    const explainer = new Explainer(
        documentsExplainPorts(store, scope.descriptor, scope.tap.port)
    );
    const ports: SessionScopePorts = {
        id,
        logId: scope.logId,
        local: localScopeOf(scope, cellKey),
        pulls,
        explain: explainer,
    };
    return {
        id,
        ports,
        pulls,
        explainer,
        rejections,
        dispose: () => pulls.dispose(),
    };
};

/**
 * A key as `@peerbit/trusted-network` coerces a relation's `from` and an
 * entry's signer (`controller.js` `coercePublicKey`); throws when it cannot.
 */
const coerceKey = (key: unknown): PublicSignKey => {
    if (key instanceof PublicSignKey) return key;
    const bytes = (key as any)?.bytes;
    if (bytes instanceof Uint8Array) return deserialize(bytes, PublicSignKey);
    return getPublicKeyFromPeerId(key as any);
};

/** What the trust graph's own `canPerform` was asked (Documents' properties). */
export interface TrustCanPerformProperties {
    readonly type?: string;
    readonly value?: { readonly from?: unknown } | undefined;
    readonly entry?: {
        readonly hash?: string;
        getPublicKeys(): Promise<readonly unknown[]> | readonly unknown[];
    };
}

/**
 * Why `TrustedNetwork.canPerform` refused a put of a trust relation, by the
 * rule it applies (`@peerbit/trusted-network controller.js:67-104`
 * `canPerformByRelation`): the relation's owner (`from`) must have signed
 * it and be trusted.
 *
 * - no value, or a `from` that is not a key, or no entry signer equal to
 *   `from`: `structure`, permanent (the entry alone decides it);
 * - a signer equal to `from`: the owner is not trusted, `untrusted` with
 *   signers `[from]`.
 *
 * Undefined for a delete: a CUT is never a row of the trust scope, so a
 * pulled head is never one (a CUT a peer lists is a lie). Classification
 * only, after the refusal: the boolean is `canPerform`'s. Throws when the
 * entry's keys cannot be read (the head is then `failed`).
 */
export const trustRelationRejection = async (
    properties: TrustCanPerformProperties
): Promise<
    { reason: RejectionReason; signers?: PublicSignKey[] } | undefined
> => {
    if (properties?.type !== "put") return undefined;
    let owner: PublicSignKey;
    try {
        if (!properties.value) return { reason: "structure" };
        owner = coerceKey(properties.value.from);
    } catch {
        return { reason: "structure" };
    }
    const keys = (await properties.entry?.getPublicKeys()) ?? [];
    for (const key of keys) {
        let signer: PublicSignKey;
        try {
            signer = coerceKey(key);
        } catch {
            continue;
        }
        if (owner.equals(signer)) {
            return { reason: "untrusted", signers: [owner] };
        }
    }
    return { reason: "structure" };
};

/** Where trust-graph refusals are noted (`ReadinessRuntime.noteRejection`). */
export interface TrustRejectionSink {
    noteRejection(
        scope: ScopeId,
        head: unknown,
        reason: RejectionReason,
        signers?: readonly PublicSignKey[]
    ): void;
}

/** The part of `TrustedNetwork` the notes wrap. */
export interface TrustCanPerformer {
    canPerform(properties: any): Promise<boolean>;
}

const TRUST_NOTES = Symbol("shared-fs readiness trust notes");

interface TrustNotes {
    runtimeOf: () => TrustRejectionSink | undefined;
    readonly original: (properties: any) => Promise<boolean>;
}

/**
 * Notes the trust graph's own refusals into the readiness runtime, scope
 * `TRUST_V1` (design 4.6 "Rejections", 4.2 `TRUST_V1`, review R11): without
 * them a pulled trust row that J's graph refuses is unlabelled, `failed`,
 * and gates J until the caller's timeout.
 *
 * `TrustedNetwork.open` binds `this.canPerform` into its Documents' open
 * arguments (`controller.js:198-211`), so an own property set before the
 * open is the one Documents calls. It calls the `canPerform` it replaced and
 * returns its boolean unchanged; on `false` it labels the refusal
 * (`trustRelationRejection`) and notes it into the runtime read at entry,
 * as `canPerformEntry` captures its runtime (G2-23). A throw of the
 * original propagates; a labelling that throws notes nothing.
 *
 * Idempotent: a symbol marks the installed wrapper, and a second install
 * (every open of the program) only replaces `runtimeOf`. The property is no
 * borsh field, so the program's serialization and address are unchanged.
 * A trust Documents reused from another opener (`existing: "reuse"`) keeps
 * that opener's binding, and this runtime then gets no trust notes: a
 * refused trust row is `failed` and gates (liveness only, G3-10).
 */
export const installTrustRejectionNotes = (
    network: TrustCanPerformer,
    runtimeOf: () => TrustRejectionSink | undefined
): void => {
    const target = network as TrustCanPerformer & {
        [TRUST_NOTES]?: TrustNotes;
    };
    const installed = target[TRUST_NOTES];
    if (installed) {
        installed.runtimeOf = runtimeOf;
        return;
    }
    const notes: TrustNotes = { runtimeOf, original: target.canPerform };
    Object.defineProperty(target, TRUST_NOTES, { value: notes });
    Object.defineProperty(target, "canPerform", {
        configurable: true,
        writable: true,
        value: async function canPerform(this: unknown, properties: any) {
            let runtime: TrustRejectionSink | undefined;
            try {
                runtime = notes.runtimeOf();
            } catch {
                // No runtime: nothing to note.
            }
            const allowed = await notes.original.call(this, properties);
            if (allowed === false && runtime) {
                try {
                    const label = await trustRelationRejection(properties);
                    if (label) {
                        runtime.noteRejection(
                            SCOPE_TRUST_V1,
                            properties?.entry?.hash,
                            label.reason,
                            label.signers
                        );
                    }
                } catch {
                    // Diagnostics of a pull; never the admission's concern.
                }
            }
            return allowed;
        },
    });
};
