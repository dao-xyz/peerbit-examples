import type { PublicSignKey } from "@peerbit/crypto";
import type { IdKey } from "./id-map.js";
import type { IndexedHead } from "./tap.js";

/**
 * Explained rows (WRITE_READINESS_V2.md section 4.6, M1 plan section 7.3).
 * A hash a peer's snapshot holds that J will correctly never index is
 * explained, and joins E in the certificate (section 4.5 step 9): J holds an
 * entry whose `meta.next` names it (superseded), J's indexed row for the same
 * document id wins under Documents' newest-wins rule (ignored-older), or
 * `canPerform` rejected it.
 *
 * Every lookup goes through `ExplainPorts`; nothing here keeps state that
 * grows with the store's history. Superseded is a lookup in J's own log,
 * so it survives a crash and reopen, and applies only to the exact head: a
 * re-put of the same id is a new entry with no child in J, so it stays
 * required. Rejections are recorded only for hashes in flight in a pull
 * batch (`RejectionRecord`).
 *
 * An explanation is only ever a reason not to wait for a row; the
 * certificate still has to match exactly. But E is part of the proof (an
 * element of E counts as a row J does not need), so when unsure a verdict
 * keeps the hash pending: a lookup that fails classifies it as `unknown`,
 * an entry J cannot decode is `logged` (it waits for an event), and only an
 * entry that is in J's log and provably not a row of the scope is evidence
 * against the peer that named it (`lie`).
 *
 * Two orders leave a logged head that Documents will never index and that
 * no rule here explains: J indexed another head of the same id with the
 * same wall time after it, or a concurrent newer put replaced it and a CUT
 * of that put then removed the id. The first needs two different heads of
 * one id with identical `__context.modified` times, which Documents orders
 * by arrival (equal times are indexed, the later one wins), arriving in a
 * different order at J and at R. Such a head stays `logged`, and only a
 * fetch failure renews a session, so J stays gated against that R until
 * the caller's timeout or the operator escape (design D11). Known limit: it
 * denies readiness, it never makes J ready.
 */

/** Why a hash is explained (design 4.6). */
export type ExplainedReason =
    | "superseded"
    | "ignored-older"
    | "rejected-structure"
    | "rejected-untrusted";

/**
 * The trust classes of design 4.6 and 4.5 step 8, which the session consumes
 * (PR-3 commit 3): an `untrusted` or `trust-cache` rejection is
 * `trust-pending` until a fresh signer check at an unchanged trust epoch,
 * with every trust scope that counts contained, finds no recorded signer
 * trusted. Then it is `rejected-untrusted`, provisionally: re-checked on
 * every trust-graph change, and back into D when a signer turns trusted.
 */
export type TrustClass = "trust-pending" | "rejected-untrusted";

/**
 * Why `canPerform` refused an entry. Only `structure` with `permanent` set
 * explains a hash (`rejected-structure`), so the label must say what the
 * refusal depends on, not where in `canPerformEntry` it sits (commit 2 wires
 * the hook at each `return false`):
 *
 * - `structure`, permanent: a check of the entry alone that no later state
 *   reverses: `structurallyValidEntry`, a sealed name, the payload caps, a
 *   decode failure, an id, store, mirror or signature mismatch.
 * - `untrusted`: a signer the trust graph does not trust yet, the inner
 *   signer of a `ChangesetManifest` included (`src/index.ts:4595-4599`),
 *   although it sits in the block commented as structural.
 * - `trust-cache`: the 1 s negative trust cache.
 * - `transient`: anything a later state or clock can reverse: a lifecycle
 *   fence, a trust check that went stale, and the `ChangesetManifest`
 *   clock-skew bound (`createdAtWallMs` more than 1 h past J's clock,
 *   `src/index.ts:4583-4587`; soundness never uses a clock, design 4.12
 *   #40). That bound shares one condition with permanent checks
 *   (`src/index.ts:4572-4593`), so the hook splits it.
 */
export type RejectionReason =
    | "structure"
    | "untrusted"
    | "trust-cache"
    | "transient";

export interface Rejection {
    readonly permanent: boolean;
    readonly reason: RejectionReason;
    /**
     * `untrusted` and `trust-cache` only: the keys whose trust would reverse
     * the refusal (every entry signer, or a manifest's inner signer, or a
     * trust relation's owner). The session checks them against J's trust
     * graph (design 4.6 "re-checked ... if its signer is trusted"). Omitted,
     * never empty, when unknown.
     */
    readonly signers?: readonly PublicSignKey[];
}

/**
 * What J's log holds for a head: a row of this scope (its document id and
 * entry wall time), an entry that is not a row of this scope (a delete, or a
 * value of another class), or an entry that could not be decoded. Only
 * `not-row` is evidence against the peer that named the head.
 */
export type EntryFacts =
    | { kind: "row"; key: IdKey; wallTime: bigint }
    | { kind: "not-row"; detail: string }
    | { kind: "unknown"; detail: string };

/** The scope's log and index, as the explainer reads them. */
export interface ExplainPorts {
    /**
     * Whether J's log of the scope holds an entry whose `meta.next` includes
     * `head` (`log.entryIndex.getHasNext(head)`, an exact match).
     */
    hasNext(head: string): Promise<boolean>;
    /** The logged entry's facts, or undefined when J's log lacks it. */
    inspect(head: string): Promise<EntryFacts | undefined>;
    /** J's indexed head and `__context.modified` of a document id. */
    readHead(key: IdKey): Promise<IndexedHead | undefined>;
}

/**
 * J's index shows the head as the live row of document `key`. Either J's
 * maintained set holds it already (then it is in S_J and needs nothing),
 * or its change event is still to come; the session tells which.
 */
export interface IndexedVerdict {
    kind: "indexed";
    key: IdKey;
}

/** Design 4.5 step 7: a pending hash before J pulls it. */
export type BeforePullVerdict =
    | { kind: "explained"; reason: "superseded" | "ignored-older" }
    /** In J's log but not indexed: wait for its change event, never pull. */
    | { kind: "logged" }
    | IndexedVerdict
    | { kind: "pull" }
    /** The entry is in J's log and is not a row of this scope. */
    | { kind: "lie"; detail: string }
    /** A lookup failed: keep the hash pending and try again later. */
    | { kind: "unknown" };

/** Design 4.5 step 8: a pending hash after its pull batch finished. */
export type AfterPullVerdict =
    | { kind: "explained"; reason: ExplainedReason }
    | { kind: "logged" }
    | IndexedVerdict
    /**
     * Refused for trust: parked (design 4.5 step 8). `signers` and `reason`
     * come with a rejection that recorded its signers.
     */
    | {
          kind: "trust-pending";
          reason?: "untrusted" | "trust-cache";
          signers?: readonly PublicSignKey[];
      }
    /** Not in J's log and not rejected: fetch-failed. */
    | { kind: "failed" }
    | { kind: "lie"; detail: string }
    | { kind: "unknown" };

/**
 * Documents' newest-wins rule for a mutable store, which shared-fs uses
 * (`immutable` defaults to false, `program.js:460`; shared-fs passes none
 * and leaves `strictHistory` off): an arrival whose id J already indexes is
 * ignored only when the indexed `__context.modified` is strictly greater
 * than the entry's wall time (`@peerbit/document` 15.1.11
 * `dist/src/program.js:3814-3832`, and the same comparison at `2944-2952`,
 * `2968-2975` and `3776-3789`). Equal wall times are indexed. A local
 * `unique` put never reads the indexed row (`program.js:3815`), so it is
 * always indexed; a pulled entry is remote and always compared.
 * `readiness-explain.test.ts` pins this against Documents.
 */
export const newestWinsIgnores = (
    indexedModified: bigint,
    entryWallTime: bigint
): boolean => indexedModified > entryWallTime;

/**
 * When `canPerform` refuses one head more than once while it is tracked,
 * the strongest reason is kept: a structural refusal is permanent and
 * explains the head, an untrusted signer parks it, and a transient refusal
 * says nothing about the entry.
 */
const REJECTION_RANK: Readonly<Record<RejectionReason, number>> = {
    transient: 0,
    "trust-cache": 1,
    untrusted: 2,
    structure: 3,
};

const rankOf = (rejection: Rejection) => REJECTION_RANK[rejection.reason] ?? -1;

/** A copy the record keeps: signers only when there are some. */
const copyRejection = (
    rejection: Rejection,
    signers: readonly PublicSignKey[] | undefined
): Rejection =>
    signers !== undefined && signers.length > 0
        ? {
              permanent: rejection.permanent,
              reason: rejection.reason,
              signers: [...signers],
          }
        : { permanent: rejection.permanent, reason: rejection.reason };

/**
 * `canPerform` rejections of the hashes in flight in pull batches (design
 * 4.6 "Rejections"). Bounded by the heads tracked, never by history: a
 * rejection of an untracked head is not recorded, and an entry pushed and
 * rejected before J asked for it is checked again when the pull runs
 * `canPerform` again. A head's record goes once its last tracker releases
 * it.
 *
 * The heads tracked are those of the joins in flight, which the pull queue
 * bounds: one batch per live session, and the batch of a session that ended
 * runs until its join settles (at most `PULL_TIMEOUT_MS`). So the record
 * sets no cap of its own; a cap would fail a pull that the queue allows.
 */
export class RejectionRecord {
    private readonly refs = new Map<string, number>();
    private readonly noted = new Map<string, Rejection>();

    /** Heads tracked now (each counted once). */
    get size(): number {
        return this.refs.size;
    }

    /**
     * Starts recording `heads` (refcounted across overlapping batches; a
     * head listed twice in one call counts once).
     */
    track(heads: Iterable<string>): void {
        for (const head of new Set(heads)) {
            this.refs.set(head, (this.refs.get(head) ?? 0) + 1);
        }
    }

    /**
     * The `canPerform` hook: records the rejection of a tracked head and
     * returns true; an untracked head costs one lookup and returns false. A
     * refusal at the same rank adds its signers (by `hashcode()`), so the
     * record holds at most the entry's signers.
     */
    note(head: string, rejection: Rejection): boolean {
        if (!this.refs.has(head)) return false;
        const previous = this.noted.get(head);
        if (!previous || rankOf(rejection) > rankOf(previous)) {
            this.noted.set(head, copyRejection(rejection, rejection.signers));
        } else if (
            rankOf(rejection) === rankOf(previous) &&
            rejection.signers !== undefined
        ) {
            const signers = new Map<string, PublicSignKey>();
            for (const key of [
                ...(previous.signers ?? []),
                ...rejection.signers,
            ]) {
                signers.set(key.hashcode(), key);
            }
            this.noted.set(
                head,
                copyRejection(previous, [...signers.values()])
            );
        }
        return true;
    }

    /**
     * The recorded rejections of `heads` (tracked ones only). A copy: the
     * records stay until `release`.
     */
    take(heads: Iterable<string>): Map<string, Rejection> {
        const out = new Map<string, Rejection>();
        for (const head of heads) {
            const rejection = this.noted.get(head);
            if (rejection && this.refs.has(head)) out.set(head, rejection);
        }
        return out;
    }

    /**
     * Stops tracking `heads` once their batch is classified (once per head
     * per call, as `track` counts them). The last release drops the record.
     */
    release(heads: Iterable<string>): void {
        for (const head of new Set(heads)) {
            const count = this.refs.get(head);
            if (count === undefined) continue;
            if (count > 1) {
                this.refs.set(head, count - 1);
                continue;
            }
            this.refs.delete(head);
            this.noted.delete(head);
        }
    }

    /** Whether `head` is tracked (tests). */
    tracked(head: string): boolean {
        return this.refs.has(head);
    }
}

const SUPERSEDED = Object.freeze({
    kind: "explained",
    reason: "superseded",
} as const);
const IGNORED_OLDER = Object.freeze({
    kind: "explained",
    reason: "ignored-older",
} as const);
const REJECTED_STRUCTURE = Object.freeze({
    kind: "explained",
    reason: "rejected-structure",
} as const);
const LOGGED = Object.freeze({ kind: "logged" } as const);
const PULL = Object.freeze({ kind: "pull" } as const);
const FAILED = Object.freeze({ kind: "failed" } as const);
const TRUST_PENDING = Object.freeze({ kind: "trust-pending" } as const);
const UNKNOWN = Object.freeze({ kind: "unknown" } as const);

type InLogVerdict =
    | typeof IGNORED_OLDER
    | typeof LOGGED
    | IndexedVerdict
    | { kind: "lie"; detail: string };

/**
 * Classifies pending hashes of one scope before and after a pull. Lookups of
 * one call run concurrently (one batch, at most 256 hashes). A port that
 * throws makes that hash `unknown`. Verdicts come back in the order of the
 * heads.
 */
export class Explainer {
    constructor(readonly ports: ExplainPorts) {}

    /**
     * Design 4.5 step 7, per head: superseded (`hasNext`); not in J's log →
     * `pull`; in the log and not a row of this scope → `lie`; undecodable →
     * `logged`; J's indexed head of that id is this head → `indexed` (held,
     * or its change event is still to come); the indexed row wins under
     * `newestWinsIgnores` → `ignored-older`; otherwise `logged` (the index
     * write is still pending).
     */
    beforePull(heads: readonly string[]): Promise<BeforePullVerdict[]> {
        return Promise.all(heads.map((head) => this.before(head)));
    }

    /**
     * Design 4.5 step 8, per head: the checks of `beforePull` first
     * (superseded, then what J's log holds); for an entry J's log still
     * lacks, a recorded rejection (a permanent `structure` one →
     * `rejected-structure`; `untrusted` and `trust-cache` → `trust-pending`,
     * with the rejection's signers), else `failed`.
     */
    afterPull(
        heads: readonly string[],
        rejections: ReadonlyMap<string, Rejection>
    ): Promise<AfterPullVerdict[]> {
        return Promise.all(
            heads.map((head) => this.after(head, rejections.get(head)))
        );
    }

    private async before(head: string): Promise<BeforePullVerdict> {
        try {
            if (await this.ports.hasNext(head)) return SUPERSEDED;
            const facts = await this.ports.inspect(head);
            if (facts === undefined) return PULL;
            return await this.inLog(head, facts);
        } catch {
            return UNKNOWN;
        }
    }

    private async after(
        head: string,
        rejection: Rejection | undefined
    ): Promise<AfterPullVerdict> {
        // Explained comes before trust-pending (design 4.5 step 8), and a
        // rejection speaks only for an entry J's log lacks: one in the log
        // passed `canPerform` once, so Documents decides it (a refusal by
        // the 1 s trust cache followed by an accepted push, say), and its
        // change event drains it.
        try {
            if (await this.ports.hasNext(head)) return SUPERSEDED;
            const facts = await this.ports.inspect(head);
            if (facts !== undefined) return await this.inLog(head, facts);
        } catch {
            return UNKNOWN;
        }
        switch (rejection?.reason) {
            case "structure":
                // E is part of the proof: only a refusal no later state
                // reverses explains a row. One that could be reversed was
                // labelled wrong; J pulls it again on the next event.
                return rejection.permanent === true
                    ? REJECTED_STRUCTURE
                    : FAILED;
            case "untrusted":
            case "trust-cache":
                // The session checks the signers against J's trust graph
                // (design 4.5 step 8); without them it can only re-pull.
                return rejection.signers !== undefined &&
                    rejection.signers.length > 0
                    ? {
                          kind: "trust-pending",
                          reason: rejection.reason,
                          signers: rejection.signers,
                      }
                    : TRUST_PENDING;
            default:
                // No rejection, or a transient one: fetch-failed.
                return FAILED;
        }
    }

    /** A head J's log holds and its index does not show as live yet. */
    private async inLog(
        head: string,
        facts: EntryFacts
    ): Promise<InLogVerdict> {
        if (facts.kind === "not-row") {
            return { kind: "lie", detail: facts.detail };
        }
        if (facts.kind !== "row") return LOGGED;
        const indexed = await this.ports.readHead(facts.key);
        // Indexed: J's maintained set holds it, or its change event is
        // still to come.
        if (indexed?.head === head) return { kind: "indexed", key: facts.key };
        if (indexed && newestWinsIgnores(indexed.modified, facts.wallTime)) {
            return IGNORED_OLDER;
        }
        // Documents has not written it yet (or wrote it and an event will
        // follow): its change event drains it.
        return LOGGED;
    }
}
