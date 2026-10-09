import {
    Cells,
    decodeCellsInto,
    emptyRemoteCells,
    peel,
    subtractPrefix,
    type RemoteCells,
} from "./cells.js";
import {
    CELL_BYTES,
    DIGEST_BYTES,
    FETCH_MAX,
    M,
    MAX_ANSWER_BYTES,
    PULL_BATCH,
    READINESS_FORMAT_TAG,
    REQUEST_TIMEOUT_MS,
    T_SYNC,
} from "./constants.js";
import { digestToHead, headDigest } from "./digest.js";
import type {
    AfterPullVerdict,
    BeforePullVerdict,
    ExplainedReason,
    Explainer,
} from "./explain.js";
import type { IdKey } from "./id-map.js";
import type { ExclusionReason } from "./proof.js";
import type { PullQueue, PullReport } from "./pull-queue.js";
import { systemTimers, type ResponderScope, type Timers } from "./responder.js";
import { SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1, type ScopeId } from "./scopes.js";
import {
    CellsReqV1,
    CellsV1,
    CloseV1,
    ERROR_CODE,
    ErrorV1,
    HeaderV1,
    ListPageV1,
    ListV1,
    OPEN_FLAG_LIST,
    OpenScopeV1,
    OpenV1,
    PROVENANCE_PHASES,
    PROVENANCE_SOURCES,
    READINESS_CAPS,
    StateNoticeV1,
    checkReadinessMessage,
    type ProvenancePhase,
    type ProvenanceSource,
    type ProvenanceV1,
    type ReadinessMessage,
} from "./wire.js";

/**
 * The joiner session (WRITE_READINESS_V2.md section 4.5, M1 plan sections 3
 * and 7.3): J proves that it indexes or explains every row of one peer's
 * snapshot, or that the peer lied.
 *
 * A `JoinerSession` is one wire session: one `sessionId` and one `OpenV1`
 * for every scope J asks for, so R freezes the trust scope after the
 * namespace scope in the same session (design 2.2(4)). Inside, one state
 * machine per scope runs steps 2-11 against that scope's header: the fast
 * path, the gap estimate, the wait for sync, peel and grow, drain and pull,
 * and the certificate, with re-peel, a fresh session and the exact hash list
 * as recovery. The plan's session per peer and scope is split this way
 * because `OpenV1` carries both scopes and `ErrorV1` names none.
 *
 * - **Hints and proof.** Cells, peels, `k`, `hlc` and the gap estimate are
 *   hints: a wrong one costs latency. Only the certificate makes a scope
 *   contained: `sha256(LtHash(S_J) - LtHash(X) + LtHash(E)) == D_R`, taken
 *   with `digestNow(X, E)` at one sequence point of J's lane set, with no
 *   replace verify pending and a verified count (S10, deviation k). Equality
 *   means `S_J + E = S_R + X` as multisets, so every row of R's snapshot is
 *   indexed or explained whatever X holds.
 * - **Rows above R's `hlc`** (`k` of them) cannot be in S_R, so they go to X
 *   by `forEachAbove` and leave the peel: J takes them out of its cell copy,
 *   and the gap that sizes the prefix and ends the wait for sync counts only
 *   J's rows at or below `hlc` (`gapEstimate`, `aboveJ0`, and only such
 *   arrivals re-arm the sync window). A writer that keeps adding rows during
 *   the join then grows neither the decode nor the wait. Design 4.5 steps
 *   4-6 count them (`+ k`, and J's plain cells), which never lets the gap
 *   fall to T_SYNC under such a writer (design test 50): a deviation from
 *   the design text, proposed for owner ack as plan section 11 item m.
 * - **Ports.** Every effect goes through `SessionPorts`: the directed send,
 *   J's maintained state (`LocalScope`), the scope's pull queue and
 *   explainer, and bounded timers. No Peerbit import.
 * - **Timers** bound requests in flight only: the 5, 10 and 20 s attempts of
 *   an OPEN, a cells request or a list page, and the sync-wait window
 *   (design 4.9). None is armed while the session waits for rows, pulls
 *   (the join has its own timeout) or a sign of life from R.
 * - **Exclusion needs a proof** (design 4.5 step 11, 4.7): an answer over
 *   256 KiB, a list that contradicts R's own header, or a hash R named whose
 *   entry is not a row of the scope. Silence, `BUSY`, refusals, fetch
 *   failures and mismatches never exclude. R re-creates a session it ended
 *   when an OPEN with the same id reaches it again, under a new `freezeId`:
 *   every header of a session must carry the first one's (so both scopes
 *   come from one freeze, trust after namespace), and a list is proof
 *   against a header only while J sent no OPEN after holding that header;
 *   otherwise a contradiction renews instead.
 * - **Re-entrancy (S15).** Messages may arrive in any order; each is matched
 *   by signer, `sessionId`, scope and log id and by the request in flight.
 *   Handlers never throw, and every continuation re-checks that the session
 *   is still open.
 */

/** Delays of the three attempts of any request (5, 10, 20 s; design 4.9). */
export const ATTEMPT_DELAYS_MS: readonly number[] = [
    REQUEST_TIMEOUT_MS,
    2 * REQUEST_TIMEOUT_MS,
    4 * REQUEST_TIMEOUT_MS,
];
/**
 * Sync wait without a single arrival for this long ends the wait: J peels
 * when the gap is at most `FETCH_MAX`, else pages the list (design 4.5
 * step 5). It never makes J ready.
 */
export const SYNC_WINDOW_MS = REQUEST_TIMEOUT_MS;
/** Smallest cell prefix a peel uses (design 4.5 step 6). */
export const MIN_PREFIX = 64;
/** Re-peels per session after a mismatch (design 4.5 step 10(a)). */
export const REPEELS_PER_SESSION = 1;
/**
 * Renewals of one peer chain before `nextSessionInit` parks it: a peer that
 * answers every session with `EXPIRED` would otherwise be re-asked without
 * end. Parked, the peer stays Required and is re-asked on its notice.
 */
export const MAX_RENEWALS = 16;

/**
 * A scope's state within a session. `silent`: every attempt of the request
 * in flight ended unanswered (a late answer still counts). `busy`: R
 * refused a list page with `BUSY`. `failed-fetch-wait`: only fetch-failed
 * hashes are left, retried on events (status `waiting-fetch`). `ended`: the
 * session ended without this scope contained or excluded.
 */
export type SessionState =
    | "asking"
    | "silent"
    | "certifying"
    | "waiting-sync"
    | "peeling"
    | "draining"
    | "failed-fetch-wait"
    | "recovering"
    | "busy"
    | "contained"
    | "excluded"
    | "ended";

/** How a scope was contained. */
export type SessionMode = "empty" | "fast" | "peel" | "sync-wait" | "list";

/**
 * Why a session asks for a fresh one: R ended it (`expired`), R restarted
 * under it (`restarted`: a header with another `openNonce`, or another
 * snapshot under the same id), the certificate did not match after a
 * re-peel (`mismatch`), the first fetch failure (`fetch-failed`), or the
 * list must come from a list-mode session (`list`, deviation c).
 */
export type RenewReason =
    | "expired"
    | "restarted"
    | "mismatch"
    | "fetch-failed"
    | "list";

/**
 * Recovery state carried across the sessions of one peer chain (design 4.5
 * steps 8 and 10): `first` peels; after a mismatch a `fresh` session peels
 * again; after that, the list. `fetchRenewed` once the one fresh session
 * after a fetch failure was used.
 */
export interface Ladder {
    stage: "first" | "fresh" | "list";
    fetchRenewed: boolean;
    renewals: number;
}

export const FIRST_LADDER: Readonly<Ladder> = {
    stage: "first",
    fetchRenewed: false,
    renewals: 0,
};

export interface SessionInit {
    /** R's `hashcode()`; messages from any other signer are dropped. */
    peer: string;
    /** 16 random bytes, fresh for every session. */
    sessionId: Uint8Array;
    /** The scopes to open, namespace first. */
    scopes: readonly ScopeId[];
    /** `hlcProved` from the sidecar (proof.ts `parseHlcProved`); 0 if none. */
    hlcProved: bigint;
    /** Ask R to freeze its hash list with the snapshot (`OPEN_FLAG_LIST`). */
    list: boolean;
    ladder: Ladder;
}

/** A contained scope (M1 plan section 3, extended). */
export interface SessionResult {
    peer: string;
    sessionId: Uint8Array;
    openNonce: Uint8Array;
    scope: ScopeId;
    count: number;
    hlc: bigint;
    /** D_R. */
    anchor: Uint8Array;
    /** From this session's header: the only provenance that can qualify R. */
    provenance: {
        writeReady: boolean;
        source: ProvenanceSource;
        fullReplica: boolean;
        phase: ProvenancePhase;
    };
    source: ProvenanceSource;
    /**
     * Every header of the session qualifies (`qualifies`). The trusted
     * identity check of access-controlled stores is the coordinator's.
     */
    qualified: boolean;
    mode: SessionMode;
    /** J's lane-set sequence point of the matching certificate. */
    seq: number;
    missingAtStart: number;
    pulled: number;
    explained: number;
    explainedBy: Partial<Record<ExplainedReason, number>>;
    /** Rows of J subtracted as X in the matching certificate. */
    x: number;
    /** Cells received from R. */
    cells: number;
    /** Re-peels plus renewals of the chain before this session. */
    recoveries: number;
    roundTrips: number;
    certificates: number;
    ms: number;
}

/** A session's terminal outcome, reported once. */
export type SessionOutcome =
    | { kind: "contained"; results: SessionResult[] }
    | {
          kind: "excluded";
          reason: ExclusionReason;
          scope: ScopeId;
          detail: string;
      }
    /** `BUSY` before any header: R holds nothing for this session. */
    | { kind: "busy" }
    | {
          kind: "renew";
          reason: RenewReason;
          /** The next session asks for list mode. */
          list: boolean;
          /** Scopes not contained, plus trust whenever namespace renews. */
          scopes: ScopeId[];
          /** Scopes this session contained that the renewal does not reopen. */
          results: SessionResult[];
      }
    /** `UNSUPPORTED` or `SCOPE`: R cannot serve it; R stays Required. */
    | { kind: "refused"; code: "UNSUPPORTED" | "SCOPE" }
    /** J's own maintained state faulted or was disposed. */
    | { kind: "local-unavailable"; scope: ScopeId; detail: string }
    | { kind: "closed" };

/** Receives J's element changes, in order (the tap's sink, with `modified`). */
export interface LocalSink {
    /** `digest` is valid during the call only. */
    apply(digest: Uint8Array, sign: 1 | -1, modified: bigint): void;
    /** The tap discarded its state and seeds again. */
    reset?(): void;
}

/**
 * J's maintained state of one scope: the tap and its lane set (cells and
 * anchor lanes). PR-2 keeps the cells in the lane set, so the plan's
 * `ScopeTapState.cells` is `cellsNow()` here.
 */
export interface LocalScope {
    /** The cell checksum key (k0, k1) of the store. */
    readonly cellKey: readonly [number, number];
    /** Live rows. */
    readonly count: number;
    /** Element changes applied; equals the lane set's `seq`. */
    readonly epoch: number;
    /** Replace verifies queued or running (S10). */
    readonly pendingVerify: number;
    /** Live, not faulted, and the count matched the index (`countVerified`). */
    readonly trusted: boolean;
    /** Set once the tap or its lane set failed or was disposed. */
    readonly faulted: unknown;
    /** Rows with `modified > hlc` (O(n), deviation a). */
    above(hlc: bigint): number;
    /** Calls `fn` with each such row's head (a view, valid during the call). */
    forEachAbove(hlc: bigint, fn: (digest: Uint8Array) => void): number;
    /** Every live head (a view) with its modified time. */
    forEach(fn: (digest: Uint8Array, modified: bigint) => void): void;
    /** Resolves once no replace verify is queued or running. */
    verifyIdle(): Promise<void>;
    /**
     * Compares the count when it is unverified (`ScopeTap.confirmCountNow`:
     * at most two reads, never held back by a comparison changes started)
     * and resolves with `trusted`.
     */
    confirmTrusted(): Promise<boolean>;
    /** Whether the maintained set holds `digest` as document `key`'s row. */
    holds(key: IdKey, digest: Uint8Array): boolean;
    /** Every cell in the wire layout at the current seq (`LaneSet.cellsNow`). */
    cellsNow(): { seq: number; cells: Promise<Uint8Array> };
    /** The certificate digest at the current seq (`LaneSet.digestNow`). */
    digestNow(
        sub?: Uint8Array[],
        add?: Uint8Array[]
    ): { seq: number; digest: Promise<Uint8Array> };
    /** The anchor digest of an arbitrary set (`LaneSet.digestOf`). */
    digestOf(set: Uint8Array): Promise<Uint8Array>;
    /** Adds a sink of element changes; returns its removal. */
    addSink(sink: LocalSink): () => void;
}

/** One scope J opens with R. */
export interface SessionScopePorts {
    readonly id: ScopeId;
    /** The scope's log id (J's and R's are the same store's). */
    readonly logId: Uint8Array;
    readonly local: LocalScope;
    /**
     * The scope's pull queue, shared by every session of the scope. The
     * session owns one batch at a time and reports each one `settled`.
     */
    readonly pulls: PullQueue;
    /** The scope's explainer, on J's log and index. */
    readonly explain: Explainer;
}

export interface SessionEvents {
    /** The terminal outcome, once. */
    onOutcome(session: JoinerSession, outcome: SessionOutcome): void;
    /** A scope changed state (status and telemetry). */
    onState?(session: JoinerSession, scope: ScopeId, state: SessionState): void;
    /**
     * An OPEN attempt ended with some scope still without a header: before
     * the next attempt goes out (`last` false), or before those scopes go
     * `silent` after the last one (`last` true). `attempt` counts the
     * attempts of the current series (1 to 3; `resume` starts a new one).
     * The owner may close the session in the call (a peer still gone, a
     * confirm-only peer's single attempt); nothing is sent then.
     */
    onAttempt?(
        session: JoinerSession,
        info: { attempt: number; last: boolean }
    ): void;
}

export interface SessionPorts {
    /** Directed one-way send to R; never throws, failures are the owner's. */
    send(message: ReadinessMessage): void;
    /** Bounded in-flight timers (`systemTimers` by default). */
    timers?: Timers;
    /** Milliseconds for stats only; never a decision input. */
    now?(): number;
    /** A row of `scope` arrived since this open (design 4.5 step 5). */
    syncDelivering(scope: ScopeId): boolean;
    scope(id: ScopeId): SessionScopePorts | undefined;
    events: SessionEvents;
}

/** Per-scope state for tests and status. */
export interface SessionScopeDebug {
    state: SessionState;
    pending: number;
    logged: number;
    failed: number;
    /** A lookup failed or the pull was refused: waiting for a retry. */
    retry: number;
    trustPending: number;
    explained: number;
    xPeel: number;
    have: number;
    m: number;
    k: number;
    gapEst?: number;
    repeels: number;
    mismatches: number;
    certificates: number;
}

export interface SessionDebug {
    scopes: Partial<Record<ScopeId, SessionScopeDebug>>;
    /** Timers this session holds armed. */
    armedTimers: number;
    /** Messages dropped by the acceptance rules. */
    dropped: number;
    outcome?: SessionOutcome["kind"];
}

export interface GapInput {
    countR: number;
    /** J's rows at or below R's `hlc` (J's count minus `k`). */
    countJ: number;
    aboveR: number;
    /** J's rows in (`hlcProved`, R's `hlc`]. */
    aboveJ: number;
    hlcProved: bigint;
}

/** Whether a notice is a trigger or stale (another `openNonce`). */
export type NoticeVerdict = "trigger" | "stale";

/**
 * The gap a peel has to decode: `max(|countR - countJ|, aboveR + aboveJ)`
 * over J's rows at or below R's `hlc` only, with the second term off while
 * `hlcProved` is 0 (M0 P5: "above 0" is every row). Design 4.5 step 4 has
 * `max(|countR - (countJ - k)| + k, aboveR + aboveJ)` with every row of J:
 * J's `k` rows above `hlc` leave the peel here instead (see the class
 * comment), so they count on neither side.
 */
export const gapEstimate = (input: GapInput): number =>
    Math.max(
        Math.abs(input.countR - input.countJ),
        input.hlcProved > 0n ? input.aboveR + input.aboveJ : 0
    );

/**
 * The cell prefix for a gap estimate (design 4.5 step 6):
 * `max(64, ceil(1.8 * gapEst) rounded up to 32)`, at most M. The same
 * formula as the responder's first flight.
 */
export const cellPrefix = (gapEst: number): number =>
    Math.min(M, Math.max(MIN_PREFIX, Math.ceil((1.8 * gapEst) / 32) * 32));

const QUALIFYING_SOURCES: ReadonlySet<ProvenanceSource> = new Set([
    "creator",
    "reconciled",
    "warm",
    "operator",
]);

/**
 * A qualified donor by its header (design 2.1): ready, a source in
 * {creator, reconciled, warm, operator}, a full replica, this format. M2
 * replaces `warm` with `warm-fresh`.
 */
export const qualifies = (provenance: ProvenanceV1): boolean =>
    provenance.writeReady === true &&
    QUALIFYING_SOURCES.has(PROVENANCE_SOURCES[provenance.source]) &&
    provenance.fullReplica === true &&
    provenance.formatTag === READINESS_FORMAT_TAG;

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
};

const hexOf = (bytes: Uint8Array) => {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
};

/**
 * A StateNoticeV1 is a trigger only (design 4.3): `stale` when J knows R's
 * `openNonce` from a session header and the notice carries another one (R
 * restarted). It never qualifies anyone.
 */
export const classifyNotice = (
    notice: StateNoticeV1,
    knownOpenNonce?: Uint8Array
): NoticeVerdict =>
    knownOpenNonce !== undefined &&
    !sameBytes(knownOpenNonce, notice.provenance.openNonce)
        ? "stale"
        : "trigger";

const SESSION_ID_LENGTH = 16;

const freshSessionId = () => {
    const out = new Uint8Array(SESSION_ID_LENGTH);
    globalThis.crypto.getRandomValues(out);
    return out;
};

/** Namespace first (R freezes in that order too). */
const scopeOrder = (scopes: Iterable<ScopeId>): ScopeId[] =>
    [...new Set(scopes)].sort((a, b) => a - b);

/** The first session of a peer chain (a fresh random `sessionId`). */
export const newSessionInit = (
    peer: string,
    scopes: readonly ScopeId[],
    hlcProved: bigint
): SessionInit => ({
    peer,
    sessionId: freshSessionId(),
    scopes: scopeOrder(scopes),
    hlcProved,
    list: false,
    ladder: { ...FIRST_LADDER },
});

/**
 * The recovery ladder (design 4.5 steps 8 and 10, deviation c): the next
 * session after a `renew`, with a fresh `sessionId`, or undefined when the
 * outcome is not a renew or the chain reached `MAX_RENEWALS`.
 * `expired`/`restarted` keep the stage (list mode when the outcome asks for
 * it); `mismatch` moves `first` to `fresh` and `fresh` to `list`; `list`
 * asks for list mode; `fetch-failed` sets `fetchRenewed`.
 */
export const nextSessionInit = (
    previous: SessionInit,
    outcome: SessionOutcome
): SessionInit | undefined => {
    if (outcome.kind !== "renew") return undefined;
    const renewals = previous.ladder.renewals + 1;
    if (renewals > MAX_RENEWALS) return undefined;
    let { stage, fetchRenewed } = previous.ladder;
    let list = previous.list;
    switch (outcome.reason) {
        case "expired":
        case "restarted":
            list = list || outcome.list;
            break;
        case "mismatch":
            if (stage === "first") stage = "fresh";
            else list = true;
            break;
        case "list":
            list = true;
            break;
        case "fetch-failed":
            fetchRenewed = true;
            break;
    }
    if (list) stage = "list";
    return {
        peer: previous.peer,
        sessionId: freshSessionId(),
        scopes: scopeOrder(
            outcome.scopes.length > 0 ? outcome.scopes : previous.scopes
        ),
        hlcProved: previous.hlcProved,
        list,
        ladder: { stage, fetchRenewed, renewals },
    };
};

/**
 * The `LocalScope` of a runtime scope: its tap (count, epoch, verify queue,
 * count check, id map) and its lane set (cells and anchor). Needs the tap's
 * sink to pass `modified` with every element change.
 */
export const localScopeOf = (
    scope: ResponderScope,
    cellKey: readonly [number, number]
): LocalScope => {
    const { tap, laneSet } = scope;
    const trusted = () =>
        tap.state === "live" &&
        tap.faulted === undefined &&
        tap.countVerified &&
        !laneSet.closed &&
        laneSet.faulted === undefined;
    return {
        cellKey,
        get count() {
            return tap.count;
        },
        get epoch() {
            return tap.epoch;
        },
        get pendingVerify() {
            return tap.pendingVerify;
        },
        get trusted() {
            return trusted();
        },
        get faulted() {
            return (
                tap.faulted ??
                laneSet.faulted ??
                (tap.state === "disposed"
                    ? "tap disposed"
                    : laneSet.closed
                      ? "lane set closed"
                      : undefined)
            );
        },
        above: (hlc) => tap.above(hlc),
        forEachAbove: (hlc, fn) => tap.map.forEachAbove(hlc, fn),
        forEach: (fn) => tap.map.forEach(fn),
        verifyIdle: () => tap.verifyIdle(),
        confirmTrusted: async () => {
            if (trusted()) return true;
            await tap.confirmCountNow();
            return trusted();
        },
        holds: (key, digest) => {
            const slot = tap.map.get(key);
            return slot >= 0 && tap.map.headEquals(slot, digest);
        },
        cellsNow: () => laneSet.cellsNow(),
        digestNow: (sub, add) => laneSet.digestNow(sub, add),
        digestOf: (set) => laneSet.digestOf(set),
        addSink: (sink) => tap.addSink(sink),
    };
};

// ------------------------------------------------------------ hash sets

/** A digest as a fixed-width map key (32 code units). */
const keyOf = (digest: Uint8Array): string =>
    String.fromCharCode.apply(
        null,
        digest.subarray(0, DIGEST_BYTES) as unknown as number[]
    );

const compareDigests = (
    a: Uint8Array,
    ao: number,
    b: Uint8Array,
    bo: number
) => {
    for (let i = 0; i < DIGEST_BYTES; i++) {
        const d = a[ao + i] - b[bo + i];
        if (d !== 0) return d;
    }
    return 0;
};

/** The n x 32 B `list` sorted (a copy). */
const sortDigests = (list: Uint8Array): Uint8Array => {
    const n = list.length / DIGEST_BYTES;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) =>
        compareDigests(list, a * DIGEST_BYTES, list, b * DIGEST_BYTES)
    );
    const out = new Uint8Array(list.length);
    for (let i = 0; i < n; i++) {
        const at = order[i] * DIGEST_BYTES;
        out.set(list.subarray(at, at + DIGEST_BYTES), i * DIGEST_BYTES);
    }
    return out;
};

const hasAdjacentDuplicate = (sorted: Uint8Array) => {
    for (let o = DIGEST_BYTES; o < sorted.length; o += DIGEST_BYTES) {
        if (compareDigests(sorted, o - DIGEST_BYTES, sorted, o) === 0) {
            return true;
        }
    }
    return false;
};

/** The index of `digest` in a sorted list, or -1 (binary search). */
const indexInSorted = (sorted: Uint8Array, digest: Uint8Array): number => {
    let lo = 0;
    let hi = sorted.length / DIGEST_BYTES - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const c = compareDigests(sorted, mid * DIGEST_BYTES, digest, 0);
        if (c === 0) return mid;
        if (c < 0) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
};

const concatPages = (pages: Uint8Array[], total: number) => {
    const out = new Uint8Array(total);
    let o = 0;
    for (const page of pages) {
        out.set(page, o);
        o += page.length;
    }
    return out;
};

// ------------------------------------------------------------ scope machine

/**
 * Where a pending hash (R\J, not indexed, not explained) is in steps 7-8:
 * waiting to be classified, in a classification or pull, in J's log waiting
 * for its change event, fetch-failed, parked until trust is known, or
 * waiting for a retry after a lookup failed or the queue refused its pull
 * (`retry`: the queue's events retry it as they retry a fetch failure, but
 * it never renews the session).
 */
type Status = "untried" | "flight" | "logged" | "failed" | "trust" | "retry";

interface PendingHash {
    readonly digest: Uint8Array;
    readonly head: string;
    status: Status;
}

/** The one request (cells or list page) a scope has in flight. */
interface InFlight {
    readonly kind: "cells" | "list";
    /** Cells: the first cell; list: the page's offset. */
    readonly from: number;
    /** Cells: one past the last cell. */
    readonly to: number;
    /** Sends in the current attempt series (1-3). */
    tries: number;
    timer?: unknown;
}

interface JournalEntry {
    readonly key: string;
    readonly digest: Uint8Array;
    readonly sign: 1 | -1;
    readonly modified: bigint;
}

const UNKNOWN = { kind: "unknown" } as const;

class ScopeRun {
    state: SessionState = "asking";
    header?: HeaderV1;
    /** J's rows above H.hlc, kept from the sink (deviation a). */
    k = 0;
    /** J's rows in (hlcProved, H.hlc] when the header arrived. */
    aboveJ0 = 0;
    /** Arrivals with hlcProved < modified <= H.hlc: R's `above` decays by them (G4). */
    arrivedAbove = 0;
    windowArrivals = 0;
    windowTimer?: unknown;
    waitedSync = false;
    gapEst?: number;
    missingAtStart = 0;
    /** The fast path's certificate is the next one (step 3). */
    fastTry = false;
    mode?: SessionMode;
    /** R's cells received, prefix [0, rc.have). */
    rc?: RemoteCells;
    /** The prefix in use; 0 until a peel was planned. */
    m = 0;
    request?: InFlight;
    /** Invalidates a peel whose copy of J's cells is in flight. */
    peelToken = 0;
    /** J's epoch at the cells copy of the last peel. */
    peelEpoch = -1;
    /** J's element changes since that copy, while its answer is awaited. */
    journal?: JournalEntry[];
    repeels = 0;
    mismatches = 0;
    certificates = 0;
    peels = 0;
    /** R\J hashes not yet indexed or explained. */
    readonly pending = new Map<string, PendingHash>();
    readonly sets: Record<Status, Set<string>> = {
        untried: new Set(),
        flight: new Set(),
        logged: new Set(),
        failed: new Set(),
        trust: new Set(),
        retry: new Set(),
    };
    /** E: R's hashes J explains (never in S_J; the sink removes indexed ones). */
    readonly explained = new Map<
        string,
        { digest: Uint8Array; reason: ExplainedReason }
    >();
    /** J\R from the last peel. */
    xPeel = new Map<string, Uint8Array>();
    /** R's hashes the last peel named (pending again when J loses one). */
    plusAll?: Set<string>;
    /** J's epoch when the last hashes went `logged` (G9). */
    loggedEpoch = -1;
    /** A classification or pull of this scope is in flight. */
    classifying = false;
    /** In list recovery (step 10(c)). */
    listing = false;
    pages: Uint8Array[] = [];
    listed = 0;
    /** The last page arrived; its checks run. */
    listComplete = false;
    /** R's verified hash list, sorted. */
    list?: Uint8Array;
    /** `pending` and X are derived from `list`. */
    listReady = false;
    /** An OPEN went out after this scope's header arrived (see the class comment). */
    openAfterHeader = false;
    certRunning = false;
    /** `certify` was called while the loop ran. */
    certAgain = false;
    /** The certificate waits for J's next element change (trust, M1). */
    waitChange = false;
    localErrors = 0;
    /** J's tap re-seeded (R1): recompute from its new state once trusted. */
    rebuildNeeded = false;
    kicked = false;
    pulled = 0;
    cells = 0;
    roundTrips = 0;
    result?: SessionResult;
    removeSink?: () => void;
    removeRetry?: () => void;

    constructor(
        readonly id: ScopeId,
        readonly ports: SessionScopePorts
    ) {}

    get local(): LocalScope {
        return this.ports.local;
    }

    get have(): number {
        return this.rc?.have ?? 0;
    }
}

const resolved = Promise.resolve();

/**
 * One wire session with one peer. Create it, `start()` it once every scope's
 * local state has started, route R's messages to `onMessage`, and call
 * `resume()` on R's signs of life. It reports one terminal outcome through
 * `events.onOutcome`.
 */
export class JoinerSession {
    readonly peer: string;
    readonly sessionId: Uint8Array;
    /** The pull-queue owner: the session id in hex (the queue is per scope). */
    private readonly owner: string;
    private readonly timers: Timers;
    private readonly clock: () => number;
    private readonly runs: ScopeRun[] = [];
    private readonly missing: ScopeId[] = [];
    private readonly armed = new Set<unknown>();
    private outcomeValue?: SessionOutcome;
    private started = false;
    /** An OPEN went out, so R may hold the session. */
    private openSent = false;
    /** The wire `attempt` of the last OPEN (counts across series). */
    private openAttempt = 0;
    /** OPEN sends in the current attempt series. */
    private openTries = 0;
    private openTimer?: unknown;
    /** R's `openNonce` and `freezeId` from the first header. */
    private openNonce?: Uint8Array;
    private freezeId?: Uint8Array;
    private startedAt = 0;
    private dropped = 0;

    constructor(
        readonly init: SessionInit,
        private readonly ports: SessionPorts
    ) {
        if (init.scopes.length === 0) {
            throw new Error("readiness: a session needs at least one scope");
        }
        this.peer = init.peer;
        this.sessionId = init.sessionId;
        this.owner = hexOf(init.sessionId);
        this.timers = ports.timers ?? systemTimers;
        this.clock = ports.now ?? (() => performance.now());
        for (const id of scopeOrder(init.scopes)) {
            const scope = ports.scope(id);
            if (scope) this.runs.push(new ScopeRun(id, scope));
            else this.missing.push(id);
        }
    }

    get outcome(): SessionOutcome | undefined {
        return this.outcomeValue;
    }

    private get ended() {
        return this.outcomeValue !== undefined;
    }

    state(scope: ScopeId): SessionState | undefined {
        return this.runs.find((run) => run.id === scope)?.state;
    }

    debug(): SessionDebug {
        const scopes: SessionDebug["scopes"] = {};
        for (const run of this.runs) {
            scopes[run.id] = {
                state: run.state,
                pending: run.pending.size,
                logged: run.sets.logged.size,
                failed: run.sets.failed.size,
                retry: run.sets.retry.size,
                trustPending: run.sets.trust.size,
                explained: run.explained.size,
                xPeel: run.xPeel.size,
                have: run.have,
                m: run.m,
                k: run.k,
                gapEst: run.gapEst,
                repeels: run.repeels,
                mismatches: run.mismatches,
                certificates: run.certificates,
            };
        }
        return {
            scopes,
            armedTimers: this.armed.size,
            dropped: this.dropped,
            outcome: this.outcomeValue?.kind,
        };
    }

    /**
     * Sends OPEN attempt 1 (design 4.5 step 1) with J's count and `above`
     * per scope and arms its attempt timer; subscribes one sink per scope.
     */
    start(): void {
        if (this.started || this.ended) return;
        this.started = true;
        this.startedAt = this.clock();
        this.guard(() => {
            if (this.missing.length > 0) {
                return this.finish({
                    kind: "local-unavailable",
                    scope: this.missing[0],
                    detail: "scope not open",
                });
            }
            for (const run of this.runs) {
                if (run.local.faulted !== undefined) {
                    return this.localUnavailable(run, run.local.faulted);
                }
            }
            for (const run of this.runs) {
                run.removeSink = run.local.addSink({
                    apply: (digest, sign, modified) =>
                        this.onSink(run, digest, sign, modified),
                    reset: () => this.guard(() => this.onReset(run)),
                });
                run.removeRetry = run.ports.pulls.onRetry(this.owner, (heads) =>
                    this.guard(() => this.onRetry(run, heads))
                );
            }
            this.sendOpen();
        });
    }

    /**
     * One readiness message from signer `from` (a hashcode) whose encoded
     * size is `bytes`. Drops anything not for this session (another signer,
     * another `sessionId`, a request, a notice, an unknown scope or log id,
     * an answer the wire guard drops, an answer to nothing in flight). An
     * answer over 256 KiB excludes R as inconsistent. Never throws.
     */
    onMessage(message: ReadinessMessage, from: string, bytes: number): void {
        this.guard(() => this.receive(message, from, bytes));
    }

    /**
     * R's sign of life, a matching notice, or another session of J
     * completing: re-sends the request of a `silent` or `busy` scope with
     * fresh attempts and retries this session's failed pulls and failed
     * lookups (`retry`).
     */
    resume(): void {
        if (!this.started || this.ended) return;
        this.guard(() => {
            const asking = this.runs.filter((run) => !run.header);
            if (asking.length > 0 && this.openTimer === undefined) {
                // T3: a new attempt series; the wire attempt keeps counting.
                this.openTries = 0;
                for (const run of asking) this.setState(run, "asking");
                this.sendOpen();
            }
            for (const run of this.runs) {
                const request = run.request;
                if (
                    request &&
                    request.timer === undefined &&
                    (run.state === "silent" || run.state === "busy")
                ) {
                    request.tries = 0;
                    this.setState(
                        run,
                        request.kind === "cells" ? "peeling" : "recovering"
                    );
                    this.sendRequest(run);
                }
                if (this.ended) return;
                run.ports.pulls.retry(this.owner);
            }
        });
    }

    /**
     * Classifies `trust-pending` and `logged` hashes again (a trust-graph
     * change, a trust scope contained, the contained set grew).
     */
    reclassify(): void {
        if (!this.started || this.ended) return;
        this.guard(() => {
            for (const run of this.runs) {
                for (const status of ["trust", "logged"] as const) {
                    for (const key of [...run.sets[status]]) {
                        this.setStatus(run, key, "untried");
                    }
                }
                this.kick(run);
            }
        });
    }

    /**
     * Ends the session: `CloseV1` when R may hold it, timers cleared, sinks
     * removed, the pull queue released. Reports `closed` unless an outcome
     * came first. Idempotent.
     */
    close(): void {
        if (this.ended) return;
        this.finish({ kind: "closed" });
    }

    // -------------------------------------------------------- plumbing

    /** Runs `fn`; a bug in it ends the session instead of escaping (S15). */
    private guard(fn: () => void) {
        try {
            fn();
        } catch (error) {
            this.internal(error);
        }
    }

    private internal(error: unknown) {
        if (this.ended) return;
        console.warn(
            "shared-fs: readiness session error:",
            (error as any)?.message ?? error
        );
        this.finish({
            kind: "local-unavailable",
            scope: this.runs[0]?.id ?? this.init.scopes[0],
            detail: `session error: ${(error as any)?.message ?? error}`,
        });
    }

    private send(message: ReadinessMessage) {
        try {
            this.ports.send(message);
        } catch {
            // The port never throws; a failed send is a lost message.
        }
    }

    private arm(fn: () => void, ms: number): unknown {
        let handle: unknown = undefined;
        handle = this.timers.set(() => {
            this.armed.delete(handle);
            if (this.ended) return;
            this.guard(fn);
        }, ms);
        this.armed.add(handle);
        return handle;
    }

    private disarm(handle: unknown) {
        if (handle !== undefined && this.armed.delete(handle)) {
            this.timers.clear(handle);
        }
    }

    private setState(run: ScopeRun, state: SessionState) {
        if (run.state === state) return;
        run.state = state;
        try {
            this.ports.events.onState?.(this, run.id, state);
        } catch {
            // A listener's error is the listener's.
        }
    }

    /** Runs `step` once on a microtask, however many events asked for it. */
    private kick(run: ScopeRun) {
        if (run.kicked || this.ended) return;
        run.kicked = true;
        void resolved.then(() => {
            run.kicked = false;
            this.guard(() => this.step(run));
        });
    }

    private step(run: ScopeRun) {
        if (this.ended) return;
        // T14: no certificate, and no more work, on a faulted tap.
        if (
            run.header &&
            run.state !== "contained" &&
            run.local.faulted !== undefined
        ) {
            return this.localUnavailable(run, run.local.faulted);
        }
        switch (run.state) {
            case "waiting-sync": {
                // W1-W2: the gap shrank to T_SYNC.
                const gap = this.gapNow(run);
                run.gapEst = gap;
                if (gap <= T_SYNC) this.toPeeling(run, cellPrefix(gap));
                return;
            }
            case "draining":
            case "failed-fetch-wait":
                return this.drain(run);
            case "certifying":
                if (
                    !run.certRunning &&
                    run.pending.size > 0 &&
                    !run.rebuildNeeded
                ) {
                    return this.afterPending(run);
                }
                return this.certify(run);
        }
    }

    // -------------------------------------------------------- terminal

    private finish(outcome: SessionOutcome) {
        if (this.ended) return;
        this.outcomeValue = outcome;
        const qualified = this.qualified();
        if (outcome.kind === "contained" || outcome.kind === "renew") {
            for (const result of outcome.results) result.qualified = qualified;
        }
        // R holds nothing after BUSY, a refusal or EXPIRED.
        const rHolds =
            this.openSent &&
            outcome.kind !== "busy" &&
            outcome.kind !== "refused" &&
            !(outcome.kind === "renew" && outcome.reason === "expired");
        this.disarm(this.openTimer);
        this.openTimer = undefined;
        for (const run of this.runs) {
            if (run.request) this.disarm(run.request.timer);
            this.disarm(run.windowTimer);
            run.windowTimer = undefined;
            run.journal = undefined;
            run.removeSink?.();
            run.removeSink = undefined;
            run.removeRetry?.();
            run.removeRetry = undefined;
            try {
                run.ports.pulls.release(this.owner);
            } catch {
                // Releasing never throws; nothing to undo if it did.
            }
            if (outcome.kind === "excluded" && outcome.scope === run.id) {
                this.setState(run, "excluded");
            } else if (run.state !== "contained") {
                this.setState(run, "ended");
            }
        }
        for (const handle of this.armed) this.timers.clear(handle);
        this.armed.clear();
        if (rHolds) this.send(new CloseV1({ sessionId: this.sessionId }));
        try {
            this.ports.events.onOutcome(this, outcome);
        } catch {
            // A listener's error is the listener's.
        }
    }

    /** Every header this session received qualifies (2.7). */
    private qualified() {
        const headers = this.runs.flatMap((run) =>
            run.header ? [run.header] : []
        );
        return (
            headers.length > 0 &&
            headers.every((header) => qualifies(header.provenance))
        );
    }

    /**
     * T13: a fresh session for every scope not contained, and the trust
     * scope whenever the namespace scope renews (its snapshot must not be
     * older than the namespace one, design 2.2(4)).
     */
    private renew(reason: RenewReason, list = this.init.list) {
        const scopes = this.runs
            .filter((run) => run.state !== "contained")
            .map((run) => run.id);
        if (
            scopes.includes(SCOPE_NAMESPACE_V1) &&
            this.runs.some((run) => run.id === SCOPE_TRUST_V1)
        ) {
            scopes.push(SCOPE_TRUST_V1);
        }
        const reopened = scopeOrder(scopes);
        this.finish({
            kind: "renew",
            reason,
            list,
            scopes: reopened,
            results: this.runs
                .filter((run) => run.result && !reopened.includes(run.id))
                .map((run) => run.result!),
        });
    }

    private exclude(run: ScopeRun, reason: ExclusionReason, detail: string) {
        this.finish({ kind: "excluded", reason, scope: run.id, detail });
    }

    /**
     * R's list contradicts R's header. A proof only if this session sent no
     * OPEN after holding the header: such an OPEN can reach R after it ended
     * the session (30 s idle), and R then answers the same id from a new
     * snapshot. Otherwise a list-mode session is asked again.
     */
    private listContradicts(run: ScopeRun, detail: string) {
        if (run.openAfterHeader) return this.renew("restarted", true);
        this.exclude(run, "inconsistent", detail);
    }

    private localUnavailable(run: ScopeRun, error: unknown) {
        this.finish({
            kind: "local-unavailable",
            scope: run.id,
            detail: String((error as any)?.message ?? error),
        });
    }

    /**
     * A request to J's lane set was refused (a worker respawn rebuilds the
     * set before it rejects): one retry, then the scope is unavailable.
     */
    private localError(run: ScopeRun, error: unknown, retry: () => void) {
        if (this.ended) return;
        if (run.local.faulted !== undefined || run.localErrors >= 1) {
            return this.localUnavailable(run, error);
        }
        run.localErrors++;
        retry();
    }

    // -------------------------------------------------------- OPEN

    private sendOpen() {
        const { hlcProved } = this.init;
        this.openTries++;
        this.openAttempt = Math.min(255, this.openAttempt + 1);
        const scopes = this.runs.map(
            (run) =>
                new OpenScopeV1({
                    scope: run.id,
                    logId: run.ports.logId,
                    count: run.local.count,
                    above: hlcProved > 0n ? run.local.above(hlcProved) : 0,
                })
        );
        for (const run of this.runs) {
            if (run.header) run.openAfterHeader = true;
        }
        this.openSent = true;
        this.send(
            new OpenV1({
                sessionId: this.sessionId,
                attempt: this.openAttempt,
                flags: this.init.list ? OPEN_FLAG_LIST : 0,
                caps: READINESS_CAPS,
                hlcProved,
                scopes,
            })
        );
        this.openTimer = this.arm(
            () => this.onOpenTimer(),
            ATTEMPT_DELAYS_MS[this.openTries - 1]
        );
    }

    /** T2: the next attempt, or `silent` after the third. */
    private onOpenTimer() {
        this.openTimer = undefined;
        if (!this.runs.some((run) => !run.header)) return;
        const last = this.openTries >= ATTEMPT_DELAYS_MS.length;
        try {
            this.ports.events.onAttempt?.(this, {
                attempt: this.openTries,
                last,
            });
        } catch {
            // A listener's error is the listener's.
        }
        // The owner closed the session, or resumed it (a new series is
        // already in flight).
        if (this.ended || this.openTimer !== undefined) return;
        const asking = this.runs.filter((run) => !run.header);
        if (asking.length === 0) return;
        if (!last) return this.sendOpen();
        for (const run of asking) this.setState(run, "silent");
    }

    // -------------------------------------------------------- messages

    private drop() {
        this.dropped++;
    }

    private receive(message: ReadinessMessage, from: string, bytes: number) {
        // 2.6 rules 1-4: R's signature, answers only, this session, open.
        if (from !== this.peer) return this.drop();
        if (
            !(message instanceof HeaderV1) &&
            !(message instanceof CellsV1) &&
            !(message instanceof ListV1) &&
            !(message instanceof ErrorV1)
        ) {
            // Requests and notices are not session input (the owner reads
            // notices with `classifyNotice`).
            return this.drop();
        }
        if (
            !(message.sessionId instanceof Uint8Array) ||
            !sameBytes(message.sessionId, this.sessionId)
        ) {
            return this.drop();
        }
        if (this.ended || !this.openSent) return this.drop();
        // Rule 5: R signed an answer no honest responder sends.
        if (bytes > MAX_ANSWER_BYTES) {
            const scoped =
                message instanceof ErrorV1
                    ? undefined
                    : this.runs.find((run) => run.id === message.scope);
            return this.exclude(
                scoped ?? this.runs[0],
                "inconsistent",
                `oversize answer (${bytes} bytes)`
            );
        }
        // Rule 6: a malformed answer says nothing about R's set.
        if (checkReadinessMessage(message) !== undefined) return this.drop();
        if (message instanceof ErrorV1) return this.onError(message);
        // Rule 7.
        const run = this.runs.find(
            (candidate) => candidate.id === message.scope
        );
        if (!run || !sameBytes(message.logId, run.ports.logId)) {
            return this.drop();
        }
        if (message instanceof HeaderV1) return this.onHeader(run, message);
        if (message instanceof CellsV1) return this.onCells(run, message);
        return this.onList(run, message);
    }

    /** T6-T10. `ErrorV1` names no scope: what is in flight tells. */
    private onError(error: ErrorV1) {
        switch (error.code) {
            case ERROR_CODE.BUSY: {
                if (this.runs.every((run) => !run.header)) {
                    return this.finish({ kind: "busy" });
                }
                const listing = this.runs.filter(
                    (run) => run.request?.kind === "list"
                );
                if (listing.length === 0) return this.drop();
                for (const run of listing) {
                    this.disarm(run.request!.timer);
                    run.request!.timer = undefined;
                    this.setState(run, "busy");
                }
                return;
            }
            case ERROR_CODE.EXPIRED:
                return this.renew(
                    "expired",
                    this.init.list ||
                        this.runs.some(
                            (run) => run.listing && run.list === undefined
                        )
                );
            case ERROR_CODE.UNSUPPORTED:
                return this.finish({ kind: "refused", code: "UNSUPPORTED" });
            case ERROR_CODE.SCOPE:
                return this.finish({ kind: "refused", code: "SCOPE" });
        }
        this.drop();
    }

    /** T4, T5, H1. */
    private onHeader(run: ScopeRun, header: HeaderV1) {
        const nonce = header.provenance.openNonce;
        if (this.openNonce === undefined || this.freezeId === undefined) {
            this.openNonce = Uint8Array.from(nonce);
            this.freezeId = Uint8Array.from(header.freezeId);
        } else if (
            !sameBytes(this.openNonce, nonce) ||
            !sameBytes(this.freezeId, header.freezeId)
        ) {
            // R restarted, or ended the session and froze again for a later
            // OPEN with this id. The scopes of one session must come from
            // one freeze: trust frozen after namespace (design 2.2(4)).
            return this.renew("restarted");
        }
        if (run.header) {
            const held = run.header;
            if (
                held.count === header.count &&
                held.hlc === header.hlc &&
                sameBytes(held.anchor, header.anchor)
            ) {
                // Every attempt of a session gets the same snapshot.
                return this.drop();
            }
            // R answers this id from another snapshot now.
            return this.renew("restarted");
        }
        run.header = header;
        run.roundTrips++;
        if (this.runs.every((candidate) => candidate.header)) {
            this.disarm(this.openTimer);
            this.openTimer = undefined;
        }
        if (header.cellsFrom === 0 && header.cells.length > 0) {
            run.rc = emptyRemoteCells(M);
            run.cells += decodeCellsInto(run.rc, 0, header.cells);
        }
        this.beginScope(run);
    }

    // -------------------------------------------------------- steps 2-6

    /** H2-H4. */
    private beginScope(run: ScopeRun) {
        const header = run.header!;
        const { local } = run;
        if (header.count === 0) return this.certifyEmpty(run);
        const { hlcProved } = this.init;
        run.k = local.above(header.hlc);
        run.aboveJ0 =
            hlcProved > 0n && hlcProved < header.hlc
                ? local.above(hlcProved) - run.k
                : 0;
        run.missingAtStart = Math.max(0, header.count - (local.count - run.k));
        if (header.count === local.count - run.k) {
            run.fastTry = true;
            return this.toCertifying(run);
        }
        this.planGap(run);
    }

    /** H2 (G13): R's scope is empty only if its anchor says so too. */
    private certifyEmpty(run: ScopeRun) {
        const header = run.header!;
        this.setState(run, "certifying");
        run.certificates++;
        run.local.digestOf(new Uint8Array(0)).then(
            (digest) =>
                this.guard(() => {
                    if (this.ended || run.state !== "certifying") return;
                    if (sameBytes(digest, header.anchor)) {
                        return this.contain(run, "empty", run.local.epoch, 0);
                    }
                    this.exclude(
                        run,
                        "inconsistent",
                        "count 0 with a non-empty set hash"
                    );
                }),
            (error) =>
                this.guard(() => {
                    if (this.ended) return;
                    this.localError(run, error, () => this.certifyEmpty(run));
                })
        );
    }

    /**
     * The gap the peel has to decode (steps 4-6, W1): J's rows above H.hlc
     * leave the peel (see the class comment), so neither side counts them.
     */
    private gapNow(run: ScopeRun) {
        const header = run.header!;
        return gapEstimate({
            countR: header.count,
            countJ: run.local.count - run.k,
            aboveR: Math.max(0, header.above - run.arrivedAbove),
            aboveJ: run.aboveJ0,
            hlcProved: this.init.hlcProved,
        });
    }

    /** H5-H7. */
    private planGap(run: ScopeRun) {
        if (this.init.list) return this.toRecovering(run);
        const gap = this.gapNow(run);
        run.gapEst = gap;
        if (
            gap > FETCH_MAX ||
            (gap > T_SYNC && this.ports.syncDelivering(run.id))
        ) {
            return this.toWaitingSync(run);
        }
        this.toPeeling(run, cellPrefix(gap));
    }

    private toWaitingSync(run: ScopeRun) {
        run.waitedSync = true;
        run.windowArrivals = 0;
        this.setState(run, "waiting-sync");
        this.armWindow(run);
    }

    private armWindow(run: ScopeRun) {
        this.disarm(run.windowTimer);
        run.windowTimer = this.arm(() => this.onWindow(run), SYNC_WINDOW_MS);
    }

    /** W3: a whole window without an arrival ends the wait. */
    private onWindow(run: ScopeRun) {
        run.windowTimer = undefined;
        if (run.state !== "waiting-sync") return;
        if (run.windowArrivals > 0) {
            run.windowArrivals = 0;
            return this.armWindow(run);
        }
        const gap = this.gapNow(run);
        run.gapEst = gap;
        if (gap <= FETCH_MAX) return this.toPeeling(run, cellPrefix(gap));
        this.toRecovering(run);
    }

    private toPeeling(run: ScopeRun, m: number) {
        this.disarm(run.windowTimer);
        run.windowTimer = undefined;
        run.m = m;
        this.setState(run, "peeling");
        this.continuePeel(run);
    }

    /** P1 or P3. */
    private continuePeel(run: ScopeRun) {
        if (run.have >= run.m) return this.takePeel(run);
        if (run.request) {
            if (run.request.timer === undefined) this.setState(run, "silent");
            return;
        }
        run.request = { kind: "cells", from: run.have, to: run.m, tries: 0 };
        this.sendRequest(run);
    }

    /** One attempt of the scope's request in flight (P1, L1, A1). */
    private sendRequest(run: ScopeRun) {
        const request = run.request!;
        request.tries++;
        this.disarm(request.timer);
        request.timer = this.arm(
            () => this.onRequestTimer(run, request),
            ATTEMPT_DELAYS_MS[request.tries - 1]
        );
        const { id, ports } = run;
        this.send(
            request.kind === "cells"
                ? new CellsReqV1({
                      sessionId: this.sessionId,
                      scope: id,
                      logId: ports.logId,
                      from: request.from,
                      to: request.to,
                  })
                : new ListPageV1({
                      sessionId: this.sessionId,
                      scope: id,
                      logId: ports.logId,
                      offset: request.from,
                  })
        );
    }

    /** A1 (G2): the next attempt, or `silent` after the third. */
    private onRequestTimer(run: ScopeRun, request: InFlight) {
        request.timer = undefined;
        if (run.request !== request) return;
        if (request.tries < ATTEMPT_DELAYS_MS.length) {
            return this.sendRequest(run);
        }
        if (run.state === "peeling" || run.state === "recovering") {
            this.setState(run, "silent");
        }
    }

    /** P2 (2.6 rule 8). */
    private onCells(run: ScopeRun, message: CellsV1) {
        const request = run.request;
        const n = message.cells.length / CELL_BYTES;
        if (
            request?.kind !== "cells" ||
            message.from !== request.from ||
            n !== request.to - request.from
        ) {
            return this.drop();
        }
        this.disarm(request.timer);
        run.request = undefined;
        run.rc ??= emptyRemoteCells(M);
        run.cells += decodeCellsInto(run.rc, message.from, message.cells);
        run.roundTrips++;
        // During a re-seed (R1) the peel waits for the rebuilt state.
        if (run.state === "peeling" || run.state === "silent") {
            this.setState(run, "peeling");
            this.continuePeel(run);
        }
    }

    /**
     * P3: J copies its own cells at this sequence point and journals its
     * element changes until the copy answers.
     */
    private takePeel(run: ScopeRun) {
        if (run.rebuildNeeded) return this.toCertifying(run);
        const token = ++run.peelToken;
        const { local } = run;
        let copy: { seq: number; cells: Promise<Uint8Array> };
        try {
            copy = local.cellsNow();
        } catch (error) {
            return this.localError(run, error, () => this.takePeel(run));
        }
        // The same sequence point: J's rows above H.hlc, which the peel
        // leaves out (they go to X whole).
        const above: Uint8Array[] = [];
        local.forEachAbove(run.header!.hlc, (digest) =>
            above.push(digest.slice())
        );
        run.journal = [];
        run.peelEpoch = copy.seq;
        this.setState(run, "peeling");
        copy.cells.then(
            (bytes) =>
                this.guard(() => this.onLocalCells(run, token, bytes, above)),
            (error) =>
                this.guard(() => {
                    if (this.ended || token !== run.peelToken) return;
                    run.journal = undefined;
                    this.localError(run, error, () => this.takePeel(run));
                })
        );
    }

    /** P3's answer: peel, then P4, P5 or P6 with the journal replayed. */
    private onLocalCells(
        run: ScopeRun,
        token: number,
        bytes: Uint8Array,
        above: Uint8Array[]
    ) {
        if (this.ended || token !== run.peelToken) return;
        const journal = run.journal ?? [];
        run.journal = undefined;
        const { m } = run;
        const hlc = run.header!.hlc;
        const [k0, k1] = run.local.cellKey;
        const mine = new Cells(m, k0, k1);
        decodeCellsInto(mine, 0, bytes.subarray(0, m * CELL_BYTES));
        for (const digest of above) mine.apply(digest, -1);
        const result = peel(subtractPrefix(run.rc!, mine, m), m, k0, k1);
        run.peels++;
        if (!result.ok) {
            // P4, then P5 at M (G6).
            if (m < M) {
                run.m = Math.min(M, 4 * m);
                return this.continuePeel(run);
            }
            return this.toRecovering(run);
        }
        const plus = new Map<string, Uint8Array>();
        for (const digest of result.plus) plus.set(keyOf(digest), digest);
        const minus = new Map<string, Uint8Array>();
        for (const digest of result.minus) minus.set(keyOf(digest), digest);
        // R's cells name a row J holds above R's own hlc: J holds it, and
        // the certificate (which subtracts it as X) decides.
        for (const digest of above) plus.delete(keyOf(digest));
        // The peel describes J at the copy; replay J's changes since.
        const indexed = new Set<string>();
        const added = new Set<string>();
        for (const { key, digest, sign, modified } of journal) {
            if (sign === 1) {
                if (plus.delete(key)) indexed.add(key);
                else added.add(key);
            } else if (
                !minus.delete(key) &&
                !added.delete(key) &&
                modified <= hlc
            ) {
                // In J at the copy and not J\R: R holds it, J lost it.
                indexed.delete(key);
                plus.set(key, digest);
            }
        }
        run.xPeel = minus;
        run.plusAll = new Set([...plus.keys(), ...indexed]);
        // E keeps only R's hashes J lacks.
        for (const key of [...run.explained.keys()]) {
            if (!plus.has(key)) run.explained.delete(key);
        }
        const previous = this.clearPending(run);
        for (const [key, digest] of plus) {
            if (run.explained.has(key)) continue;
            this.addPending(run, key, digest, previous.get(key));
        }
        run.mode ??= run.waitedSync ? "sync-wait" : "peel";
        this.afterPending(run);
    }

    // -------------------------------------------------------- steps 7-8

    private addPending(
        run: ScopeRun,
        key: string,
        digest: Uint8Array,
        previous?: PendingHash
    ) {
        const pending: PendingHash = previous ?? {
            digest,
            head: digestToHead(digest),
            status: "untried",
        };
        run.pending.set(key, pending);
        run.sets[pending.status].add(key);
    }

    /** Empties the pending set; returns what it held. */
    private clearPending(run: ScopeRun) {
        const previous = new Map(run.pending);
        run.pending.clear();
        for (const set of Object.values(run.sets)) set.clear();
        return previous;
    }

    private dropPending(run: ScopeRun, key: string) {
        const pending = run.pending.get(key);
        if (!pending) return;
        run.pending.delete(key);
        run.sets[pending.status].delete(key);
    }

    private setStatus(run: ScopeRun, key: string, status: Status) {
        const pending = run.pending.get(key);
        if (!pending || pending.status === status) return;
        run.sets[pending.status].delete(key);
        pending.status = status;
        run.sets[status].add(key);
    }

    private explain(run: ScopeRun, key: string, reason: ExplainedReason) {
        const pending = run.pending.get(key);
        if (!pending) return;
        this.dropPending(run, key);
        run.explained.set(key, { digest: pending.digest, reason });
    }

    /** P6, D6, D7: certifying once nothing is pending, else drain. */
    private afterPending(run: ScopeRun) {
        if (run.pending.size === 0) return this.toCertifying(run);
        this.updateDrainState(run);
        this.drain(run);
    }

    private updateDrainState(run: ScopeRun) {
        const { sets } = run;
        this.setState(
            run,
            sets.untried.size + sets.flight.size > 0 || run.classifying
                ? "draining"
                : sets.failed.size > 0
                  ? "failed-fetch-wait"
                  : "draining"
        );
    }

    /** D1 and D9: the next batch of untried hashes, one at a time. */
    private drain(run: ScopeRun) {
        if (this.ended || run.classifying) return;
        if (run.state !== "draining" && run.state !== "failed-fetch-wait") {
            return;
        }
        if (run.pending.size === 0) return this.toCertifying(run);
        const { sets } = run;
        if (
            sets.untried.size === 0 &&
            sets.logged.size > 0 &&
            run.local.epoch !== run.loggedEpoch
        ) {
            // D9 (G9): J's index moved since these were classified.
            let n = 0;
            for (const key of [...sets.logged]) {
                this.setStatus(run, key, "untried");
                if (++n >= PULL_BATCH) break;
            }
        }
        if (sets.untried.size === 0) return this.updateDrainState(run);
        const keys: string[] = [];
        for (const key of sets.untried) {
            keys.push(key);
            if (keys.length >= PULL_BATCH) break;
        }
        for (const key of keys) this.setStatus(run, key, "flight");
        run.classifying = true;
        this.updateDrainState(run);
        void this.classify(run, keys).catch((error) => this.internal(error));
    }

    /** D2-D5 for one batch: classify, pull what is missing, classify again. */
    private async classify(run: ScopeRun, keys: string[]) {
        const heads = keys.map((key) => run.pending.get(key)!.head);
        let before: readonly BeforePullVerdict[] = [];
        try {
            before = await run.ports.explain.beforePull(heads);
        } catch {
            // Every hash stays pending (`unknown`).
        }
        if (this.ended) return;
        const batch: string[] = [];
        const retry: string[] = [];
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const pending = run.pending.get(key);
            if (pending?.status !== "flight") continue;
            const verdict = before[i] ?? UNKNOWN;
            switch (verdict.kind) {
                case "explained":
                    this.explain(run, key, verdict.reason);
                    break;
                case "pull":
                    batch.push(key);
                    break;
                case "lie":
                    return this.exclude(
                        run,
                        "unsubstantiated",
                        `${pending.head}: ${verdict.detail}`
                    );
                case "indexed":
                    this.onIndexed(run, key, pending, verdict.key);
                    break;
                case "logged":
                    this.setLogged(run, key);
                    break;
                default:
                    // A lookup failed: retried on the queue's events.
                    retry.push(key);
            }
        }
        this.retryLater(run, retry);
        if (batch.length > 0) {
            await this.pullBatch(run, batch);
            if (this.ended) return;
        }
        run.classifying = false;
        if (run.state === "draining" || run.state === "failed-fetch-wait") {
            this.afterPending(run);
        }
    }

    /** D3-D5. */
    private async pullBatch(run: ScopeRun, keys: string[]) {
        const { pulls, explain } = run.ports;
        const heads = keys.map((key) => run.pending.get(key)!.head);
        run.pulled += keys.length;
        let report: PullReport;
        try {
            report = await pulls.pull(this.owner, heads);
        } catch {
            // A misuse of the queue (a bug): the hashes wait for the queue's
            // next retry event instead of looping.
            if (this.ended) return;
            this.retryLater(
                run,
                keys.filter((key) => run.pending.get(key)?.status === "flight")
            );
            return;
        }
        if (this.ended) return;
        const still = keys.filter(
            (key) => run.pending.get(key)?.status === "flight"
        );
        // A hash of the batch J indexed meanwhile is progress too.
        let progressed = still.length < keys.length;
        let after: readonly AfterPullVerdict[] = [];
        if (still.length > 0) {
            try {
                after = await explain.afterPull(
                    still.map((key) => run.pending.get(key)!.head),
                    report.rejections
                );
            } catch {
                // Every hash stays pending (`unknown`).
            }
            if (this.ended) return;
        }
        const failed: string[] = [];
        const retry: string[] = [];
        let lie: string | undefined;
        for (let i = 0; i < still.length; i++) {
            const key = still[i];
            const pending = run.pending.get(key);
            if (pending?.status !== "flight") {
                progressed = true;
                continue;
            }
            const verdict = after[i] ?? UNKNOWN;
            switch (verdict.kind) {
                case "explained":
                    this.explain(run, key, verdict.reason);
                    progressed = true;
                    break;
                case "trust-pending":
                    this.setStatus(run, key, "trust");
                    break;
                case "failed":
                    failed.push(key);
                    this.setStatus(run, key, "failed");
                    break;
                case "lie":
                    lie ??= `${pending.head}: ${verdict.detail}`;
                    break;
                case "indexed":
                    if (this.onIndexed(run, key, pending, verdict.key)) {
                        progressed = true;
                    }
                    break;
                case "logged":
                    this.setLogged(run, key);
                    break;
                default:
                    retry.push(key);
            }
        }
        if (failed.length > 0) {
            pulls.fail(
                this.owner,
                failed.map((key) => run.pending.get(key)!.head)
            );
        }
        this.retryLater(run, retry);
        pulls.settled(this.owner, progressed);
        if (this.ended) return;
        if (lie !== undefined) {
            return this.exclude(run, "unsubstantiated", lie);
        }
        if (failed.length > 0 && !this.init.ladder.fetchRenewed) {
            // D5: R may have retired the row (case 15), or the hash was a
            // false hint. One fresh session.
            return this.renew("fetch-failed");
        }
    }

    /**
     * `indexed`: J's index shows the head as its id's row. Held by J's
     * maintained set, it is in S_J and leaves the pending set (a peel that
     * named it was a lie or a false decode; the certificate decides).
     * Otherwise its change event is still to come. True when it left.
     */
    private onIndexed(
        run: ScopeRun,
        key: string,
        pending: PendingHash,
        id: IdKey
    ): boolean {
        if (run.local.holds(id, pending.digest)) {
            this.dropPending(run, key);
            return true;
        }
        this.setLogged(run, key);
        return false;
    }

    /** In J's log, not indexed: waits for its change event (D9). */
    private setLogged(run: ScopeRun, key: string) {
        this.setStatus(run, key, "logged");
        run.loggedEpoch = run.local.epoch;
    }

    /**
     * A lookup failed or the queue refused the pull: the hashes wait for the
     * queue's retry events (R's sign of life, a local index change, another
     * batch that progressed), as fetch-failed ones do (D6), never in a loop
     * and never renewing the session.
     */
    private retryLater(run: ScopeRun, keys: string[]) {
        if (keys.length === 0) return;
        for (const key of keys) this.setStatus(run, key, "retry");
        run.ports.pulls.fail(
            this.owner,
            keys.map((key) => run.pending.get(key)!.head)
        );
    }

    /** D6: the queue hands failed hashes back on an event. */
    private onRetry(run: ScopeRun, heads: string[]) {
        if (this.ended) return;
        for (const head of heads) {
            const key = keyOf(headDigest(head));
            const status = run.pending.get(key)?.status;
            if (status === "failed" || status === "retry") {
                this.setStatus(run, key, "untried");
            }
        }
        this.kick(run);
    }

    // -------------------------------------------------------- sink

    /** D7, D8, W1, the journal and `k`; O(1) per change. */
    private onSink(
        run: ScopeRun,
        digest: Uint8Array,
        sign: 1 | -1,
        modified: bigint
    ) {
        if (this.ended) return;
        const header = run.header;
        if (!header || run.state === "contained") return;
        try {
            if (modified > header.hlc) run.k += sign;
            else if (sign === 1 && !run.rebuildNeeded) {
                // Only a row R's snapshot can hold shrinks the gap (W1).
                run.windowArrivals++;
                if (modified > this.init.hlcProved) run.arrivedAbove++;
            }
            const key = keyOf(digest);
            if (run.journal) {
                run.journal.push({
                    key,
                    digest: digest.slice(),
                    sign,
                    modified,
                });
            }
            if (sign === 1) {
                // D7: indexed now.
                this.dropPending(run, key);
                run.explained.delete(key);
            } else {
                // D8.
                run.xPeel.delete(key);
                if (
                    !run.journal &&
                    !run.pending.has(key) &&
                    !run.explained.has(key) &&
                    (run.listReady && run.list
                        ? indexInSorted(run.list, digest) >= 0
                        : modified <= header.hlc &&
                          run.plusAll?.has(key) === true)
                ) {
                    // R's hash, and J lost it again.
                    this.addPending(run, key, digest.slice());
                }
            }
            switch (run.state) {
                case "waiting-sync":
                case "draining":
                case "failed-fetch-wait":
                    this.kick(run);
                    break;
                case "certifying":
                    if (run.waitChange || run.pending.size > 0) {
                        run.waitChange = false;
                        this.kick(run);
                    }
                    break;
            }
        } catch (error) {
            this.internal(error);
        }
    }

    /**
     * R1 (G8): J's tap discarded its state and seeds again (each rebuilt row
     * arrives as +1). The peel state goes; E and R's list stay. Once the
     * rebuilt state is trusted, the scope re-peels or derives its pending
     * hashes from the list again.
     */
    private onReset(run: ScopeRun) {
        if (this.ended || !run.header) return;
        // An empty R needs nothing of J's state (H2).
        if (run.state === "contained" || run.header.count === 0) return;
        run.k = 0;
        run.peelToken++;
        run.journal = undefined;
        run.xPeel = new Map();
        run.plusAll = undefined;
        this.clearPending(run);
        run.listReady = false;
        run.rebuildNeeded = true;
        switch (run.state) {
            case "waiting-sync":
            case "peeling":
            case "draining":
            case "failed-fetch-wait":
            case "certifying":
                this.toCertifying(run);
        }
        // `recovering`, `silent` and `busy` keep their request; the list
        // continues and its checks wait for the rebuilt state.
    }

    // -------------------------------------------------------- steps 9-10

    private toCertifying(run: ScopeRun) {
        this.disarm(run.windowTimer);
        run.windowTimer = undefined;
        this.setState(run, "certifying");
        this.certify(run);
    }

    /**
     * Starts the certificate loop, or marks it wanted again when one runs:
     * a transition it started (a re-peel answering on a microtask) may ask
     * before the running loop has settled.
     */
    private certify(run: ScopeRun) {
        if (this.ended) return;
        if (run.certRunning) {
            run.certAgain = true;
            return;
        }
        run.certRunning = true;
        run.certAgain = false;
        run.waitChange = false;
        void this.runCertificate(run)
            .catch((error) => this.internal(error))
            .finally(() => {
                run.certRunning = false;
                if (run.certAgain && run.state === "certifying") {
                    this.guard(() => this.certify(run));
                }
            });
    }

    /** C1-C3, M1-M3. Returns when the scope leaves `certifying` or waits. */
    private async runCertificate(run: ScopeRun) {
        const { local } = run;
        for (;;) {
            // Every pass reads the state afresh.
            run.certAgain = false;
            if (this.ended || run.state !== "certifying") return;
            if (local.faulted !== undefined) {
                return this.localUnavailable(run, local.faulted);
            }
            // C1 (S10): no replace verify pending, and a verified count.
            if (local.pendingVerify > 0) {
                await local.verifyIdle().catch(() => {});
                continue;
            }
            if (!local.trusted) {
                const epoch = local.epoch;
                let trusted = false;
                try {
                    trusted = await local.confirmTrusted();
                } catch {
                    // Not trusted; a fault shows on `faulted`.
                }
                if (this.ended || run.state !== "certifying") return;
                if (!trusted && !local.trusted) {
                    // A fault ends the scope; a change during the comparison
                    // is the next chance already.
                    if (local.faulted !== undefined || local.epoch !== epoch) {
                        continue;
                    }
                    // G12: quiet and still unverified (the tap cannot
                    // compare now, or its clean scans keep differing): the
                    // next element change compares again.
                    run.waitChange = true;
                    return;
                }
                continue;
            }
            if (run.rebuildNeeded) {
                run.rebuildNeeded = false;
                if (this.afterRebuild(run)) continue;
                return;
            }
            if (run.pending.size > 0) return this.afterPending(run);
            // C2: one synchronous step.
            const certificate = this.certificateNow(run);
            if (certificate.seq !== local.epoch) {
                certificate.digest.catch(() => {});
                return this.localUnavailable(
                    run,
                    `lane set at ${certificate.seq}, tap at epoch ${local.epoch}`
                );
            }
            run.certificates++;
            let digest: Uint8Array;
            try {
                digest = await certificate.digest;
            } catch (error) {
                if (this.ended) return;
                if (local.faulted !== undefined || run.localErrors >= 1) {
                    return this.localUnavailable(run, error);
                }
                run.localErrors++;
                continue;
            }
            if (this.ended) return;
            // C3: a match proves containment at `seq`, whatever changed since.
            if (sameBytes(digest, run.header!.anchor)) {
                return this.contain(
                    run,
                    certificate.mode,
                    certificate.seq,
                    certificate.x
                );
            }
            if (run.state !== "certifying") return;
            if (run.rebuildNeeded) continue;
            if (certificate.mode === "list") {
                // M1: with R's exact list only J's own state can move; a
                // change since `seq` is the next chance already.
                run.mismatches++;
                if (local.epoch !== certificate.seq) continue;
                run.waitChange = true;
                return;
            }
            return this.onMismatch(run, certificate.mode === "fast");
        }
    }

    /**
     * X and E at this sequence point and the digest request, in one
     * synchronous step (C2, deviation b). X: J's rows above H.hlc, plus the
     * peel's J\R, or every row outside R's list in list mode.
     */
    private certificateNow(run: ScopeRun) {
        const { local } = run;
        const x = new Map<string, Uint8Array>();
        let mode: SessionMode;
        if (run.listReady && run.list) {
            const list = run.list;
            local.forEach((digest) => {
                if (indexInSorted(list, digest) < 0) {
                    x.set(keyOf(digest), digest.slice());
                }
            });
            mode = "list";
        } else {
            if (!run.fastTry) {
                for (const [key, digest] of run.xPeel) x.set(key, digest);
            }
            local.forEachAbove(run.header!.hlc, (digest) => {
                const key = keyOf(digest);
                if (!x.has(key)) x.set(key, digest.slice());
            });
            mode = run.fastTry ? "fast" : (run.mode ?? "peel");
        }
        const add = run.fastTry
            ? []
            : [...run.explained.values()].map(({ digest }) => digest);
        const { seq, digest } = local.digestNow([...x.values()], add);
        return { seq, digest, x: x.size, mode };
    }

    /** M2-M3, and the fast path's mismatch (H4 to H5). */
    private onMismatch(run: ScopeRun, fast: boolean) {
        if (fast) {
            run.fastTry = false;
            return this.planGap(run);
        }
        run.mismatches++;
        if (
            run.repeels < REPEELS_PER_SESSION &&
            run.local.epoch !== run.peelEpoch
        ) {
            // M2: R's cells are in hand.
            run.repeels++;
            return this.takePeel(run);
        }
        if (this.init.ladder.stage === "first") return this.renew("mismatch");
        this.toRecovering(run);
    }

    /**
     * R1's second half, from C1 once the rebuilt state is trusted: true when
     * the certificate runs next.
     */
    private afterRebuild(run: ScopeRun): boolean {
        if (run.fastTry) return true;
        if (run.listing) {
            if (run.list) {
                this.listPending(run);
                return run.state === "certifying";
            }
            // The last page's checks are running; they continue from here.
            if (run.listComplete) return false;
            this.setState(run, "recovering");
            if (!run.request) this.sendListPage(run);
            else if (run.request.timer === undefined) {
                this.setState(run, "silent");
            }
            return false;
        }
        if (run.m > 0) {
            this.setState(run, "peeling");
            this.continuePeel(run);
            return false;
        }
        this.planGap(run);
        return false;
    }

    private contain(run: ScopeRun, mode: SessionMode, seq: number, x: number) {
        const header = run.header!;
        const provenance = header.provenance;
        const source = PROVENANCE_SOURCES[provenance.source];
        const explainedBy: Partial<Record<ExplainedReason, number>> = {};
        if (mode !== "empty" && mode !== "fast") {
            for (const { reason } of run.explained.values()) {
                explainedBy[reason] = (explainedBy[reason] ?? 0) + 1;
            }
        }
        run.result = {
            peer: this.peer,
            sessionId: this.sessionId,
            openNonce: Uint8Array.from(provenance.openNonce),
            scope: run.id,
            count: header.count,
            hlc: header.hlc,
            anchor: Uint8Array.from(header.anchor),
            provenance: {
                writeReady: provenance.writeReady,
                source,
                fullReplica: provenance.fullReplica,
                phase: PROVENANCE_PHASES[provenance.phase],
            },
            source,
            qualified: false,
            mode,
            seq,
            missingAtStart: run.missingAtStart,
            pulled: run.pulled,
            explained:
                mode === "empty" || mode === "fast" ? 0 : run.explained.size,
            explainedBy,
            x,
            cells: run.cells,
            recoveries: run.repeels + this.init.ladder.renewals,
            roundTrips: run.roundTrips,
            certificates: run.certificates,
            ms: this.clock() - this.startedAt,
        };
        if (run.request) this.disarm(run.request.timer);
        run.request = undefined;
        this.disarm(run.windowTimer);
        run.windowTimer = undefined;
        this.setState(run, "contained");
        // T11.
        if (this.runs.every((candidate) => candidate.state === "contained")) {
            this.finish({
                kind: "contained",
                results: this.runs.map((candidate) => candidate.result!),
            });
        }
    }

    // -------------------------------------------------------- list (10(c))

    /** L1. */
    private toRecovering(run: ScopeRun) {
        this.disarm(run.windowTimer);
        run.windowTimer = undefined;
        if (run.request?.kind === "cells") {
            this.disarm(run.request.timer);
            run.request = undefined;
        }
        run.listing = true;
        this.setState(run, "recovering");
        if (run.list) return this.listPending(run);
        if (run.listComplete || run.request) return;
        this.sendListPage(run);
    }

    private sendListPage(run: ScopeRun) {
        run.request = { kind: "list", from: run.listed, to: 0, tries: 0 };
        this.sendRequest(run);
    }

    /** L2 (2.6 rule 9). */
    private onList(run: ScopeRun, message: ListV1) {
        const request = run.request;
        if (request?.kind !== "list" || message.offset !== request.from) {
            return this.drop();
        }
        const count = run.header!.count;
        const n = message.hashes.length / DIGEST_BYTES;
        this.disarm(request.timer);
        run.request = undefined;
        run.roundTrips++;
        if (n === 0 && !message.done) {
            return this.listContradicts(run, "an empty page before the last");
        }
        if (run.listed + n > count) {
            return this.listContradicts(
                run,
                `the list holds more than the header's ${count} hashes`
            );
        }
        if (message.done && run.listed + n !== count) {
            return this.listContradicts(
                run,
                `the list holds ${run.listed + n} hashes, the header ${count}`
            );
        }
        run.pages.push(message.hashes);
        run.listed += n;
        if (message.done) {
            run.listComplete = true;
            void this.checkList(run).catch((error) => this.internal(error));
            return;
        }
        // A re-seed (R1) asks for the next page once J is trusted again.
        if (run.state === "certifying") return;
        this.setState(run, "recovering");
        this.sendListPage(run);
    }

    /** L3: the whole list against R's header, then pending = list \ S_J. */
    private async checkList(run: ScopeRun) {
        const header = run.header!;
        const list = concatPages(run.pages, run.listed * DIGEST_BYTES);
        run.pages = [list];
        let digest: Uint8Array | undefined;
        for (;;) {
            try {
                digest = await run.local.digestOf(list);
                break;
            } catch (error) {
                if (this.ended) return;
                if (run.local.faulted !== undefined || run.localErrors >= 1) {
                    return this.localUnavailable(run, error);
                }
                run.localErrors++;
            }
        }
        if (this.ended) return;
        if (!sameBytes(digest, header.anchor)) {
            return this.listContradicts(
                run,
                "the list's set hash differs from the header's"
            );
        }
        const sorted = sortDigests(list);
        if (hasAdjacentDuplicate(sorted)) {
            return this.listContradicts(run, "a duplicate hash in the list");
        }
        run.pages = [];
        run.list = sorted;
        run.mode = "list";
        if (run.rebuildNeeded || run.state === "certifying") {
            // C1 derives the pending hashes once J is trusted again.
            this.setState(run, "certifying");
            return this.certify(run);
        }
        this.listPending(run);
    }

    /**
     * pending = list \ S_J in one synchronous pass over J's rows; later
     * changes go through D7 and D8. E keeps only list hashes J lacks.
     */
    private listPending(run: ScopeRun) {
        const list = run.list!;
        const n = list.length / DIGEST_BYTES;
        const held = new Uint8Array(n);
        run.local.forEach((digest) => {
            const at = indexInSorted(list, digest);
            if (at >= 0) held[at] = 1;
        });
        for (const [key, { digest }] of [...run.explained]) {
            const at = indexInSorted(list, digest);
            if (at < 0 || held[at] === 1) run.explained.delete(key);
        }
        const previous = this.clearPending(run);
        for (let i = 0; i < n; i++) {
            if (held[i] === 1) continue;
            const digest = list.slice(i * DIGEST_BYTES, (i + 1) * DIGEST_BYTES);
            const key = keyOf(digest);
            if (run.explained.has(key)) continue;
            this.addPending(run, key, digest, previous.get(key));
        }
        run.xPeel = new Map();
        run.plusAll = undefined;
        run.listReady = true;
        this.afterPending(run);
    }
}
