import type { PublicSignKey } from "@peerbit/crypto";
import {
    buildProof,
    type ExclusionReason,
    type Proof,
    type ProofScope,
} from "./proof.js";
import { systemTimers, type Timers } from "./responder.js";
import {
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    scopeDescriptor,
    type ScopeId,
} from "./scopes.js";
import {
    JoinerSession,
    classifyNotice,
    newSessionInit,
    nextSessionInit,
    qualifies,
    type SessionEvents,
    type SessionInit,
    type SessionOutcome,
    type SessionPorts,
    type SessionResult,
    type SessionScopePorts,
    type SessionState,
    type SessionTrustPort,
} from "./session.js";
import {
    CellsV1,
    ErrorV1,
    HeaderV1,
    ListV1,
    StateNoticeV1,
    type ProvenanceSource,
    type ReadinessMessage,
} from "./wire.js";

/**
 * The joiner's coordinator (WRITE_READINESS_V2.md sections 4.7-4.9, M1 plan
 * sections 3 and 7.3): one per fresh full address-open, never under
 * `allowPartialWrites` (deviation h). It keeps one record per visible peer,
 * runs at most `SESSIONS_IN_FLIGHT` joiner sessions with work in flight at a
 * time (a silent, busy or fetch-waiting session, or one that waits only for
 * trust, holds no slot: G2-4), follows each peer through the states of
 * design 4.7, and answers one question: `satisfied()`, every Required peer
 * contained, left or excluded, and at least one contained peer qualified in
 * the header of the session that contained it.
 *
 * - **Prerequisite mode (PR-3 commit 2).** Today's tracker still decides
 *   when J turns ready; it additionally requires `satisfied()`. The
 *   coordinator never makes J ready by itself, so it can only gate a joiner
 *   that today's tracker would release, never release one earlier. Commit 4
 *   makes `evaluate()` the predicate.
 * - **Access-controlled stores (PR-3 commit 3).** Sessions open both scopes
 *   and read J's trust view (`ports.trust`). The predicate adds the trust
 *   clauses of design 4.8: every contained peer's trust scope contained and
 *   frozen no earlier than its namespace scope, its trust checked at the
 *   current trust epoch, and a qualified donor whose identity J trusts
 *   (design 2.1). The trust epoch moves on every trust-graph change
 *   (`trustChanged`); every check reads one epoch and applies only while it
 *   is current. A contained peer whose provisional `rejected-untrusted`
 *   rows a trust change may reverse is asked again (G3-6).
 * - **Visible peers** come from the readiness topic's subscribers (filtered
 *   by reachability, as `visibleFilesystemPeers` does), from the namespace
 *   log's replicators, and from any readiness message a peer sends J. A
 *   subscribe, a replicator announcement or a readiness message since this
 *   open is a sign of life (`live`); a replicator row with none is asked
 *   once and, unanswered, is `unconfirmed` and does not block. "Since this
 *   open" starts at J's open, not at `start`: shared-log announces an idle
 *   replicator once, often while J's open still runs, so the runtime
 *   records who showed a sign of life before the listeners attached
 *   (`signsOfLife`), and discovery counts those peers live. Visibility is
 *   still discovery's read, so a peer that left before `start` is no
 *   record. Access-controlled stores read the namespace log only, not the
 *   trust graph's: its address has no format salt, so its replicators can
 *   be peers of another format, which never answer (design case 28;
 *   deviation aq, for the owner).
 * - **Departure is reachability (D3 = A').** Every reachability event (libp2p
 *   `peer:disconnect` and `peer:connect`, a route table's `peer:reachable` and
 *   `peer:unreachable`) re-reads every record, so a relayed peer whose relay
 *   went away is re-read too, and so is a peer whose pubsub `unsubscribe` was
 *   not an explicit one. Unreachable before J held a header is
 *   `left-unanswered` until the OPEN attempt in flight ends, then `left` with a
 *   gap; after a header it is `left` at once, with the rows J still lacks as
 *   the gap (D4), and its session keeps pulling. Reachable again resumes the
 *   session or starts a new one. A read that cannot be made counts as
 *   reachable: it gates, never a wrong `left`. A peer that unsubscribes the
 *   readiness topic explicitly (`remote-unsubscribe`) and is no replicator
 *   closed the store (G2-6): it leaves however reachable it is. Required is the
 *   set at the moment of evaluation (design 2.1), so `satisfied()` re-reads the
 *   peers it counts as gone (and subscribers that were unreachable when J saw
 *   them) and answers false for one that reads reachable; a route that came
 *   back without an event cannot let J decide around it.
 * - **Silence, `BUSY`, refusals and fetch failures never unblock.** A
 *   `silent` peer's late answer counts whenever it arrives; a `busy` peer is
 *   re-asked on its notice, on any message or sign of life from it, and once
 *   per other session of J that completes. An answer of R's own session is
 *   that session's input, never a re-ask trigger, so a peer that answers
 *   every request with `BUSY` cannot make J loop. A qualification session
 *   that went silent resumes on the same triggers.
 * - **Qualification (design 4.7, "gated peers are constraints").** A
 *   contained peer that was gated in its header qualifies only through the
 *   header of a fresh session, opened on its READY notice. A notice that
 *   arrives before J contained the peer (the session in flight answers from
 *   its earlier, gated snapshot) is remembered, and the containment then
 *   opens that fresh session.
 * - **Timers.** The coordinator arms none of its own: every timer is a
 *   session's bounded attempt (5, 10 or 20 s) or sync-wait window, and
 *   `debug().armedTimers` sums them, so a test can assert that nothing is
 *   armed while J is gated with nothing in flight (M1 plan section 10.5).
 * - **`evaluate()`** runs once per microtask however many events asked for
 *   it, computes `satisfied()` and reports it to the host (`onEvaluate`). No
 *   polling and no quiet window.
 * - **Lifecycle.** Every listener is detached on `finish`/`dispose`, and
 *   every handler first checks that this coordinator is still running (as
 *   the entries change listener checks its identity: a removed listener can
 *   still fire once on older main-event versions). Sessions are detached
 *   from their record before the coordinator closes them, so their `closed`
 *   outcome changes nothing.
 */

/** Sessions run at once (design 4.7: "sessions run 4 at a time"). */
export const SESSIONS_IN_FLIGHT = 4;

/**
 * A peer's state (design 4.7, plan section 3). `refused` is added: R
 * answered `UNSUPPORTED` or `SCOPE`, so it cannot be contained in this open;
 * it blocks like `silent` and is re-asked only on its notice or when it
 * comes back after leaving.
 */
export type PeerState =
    | "asking"
    | "busy"
    | "reconciling"
    | "silent"
    | "refused"
    | "contained"
    | "left"
    | "left-unanswered"
    | "unconfirmed"
    | "excluded-inconsistent"
    | "excluded-unsubstantiated";

/** States that keep a peer Required (design 2.1 "Required", 4.7). */
export const BLOCKING_STATES: ReadonlySet<PeerState> = new Set<PeerState>([
    "asking",
    "busy",
    "reconciling",
    "silent",
    "refused",
    "left-unanswered",
]);

/** How J learned of a peer. */
export type Via = "subscriber" | "replicator" | "message";

/**
 * One visible peer of this open (plan section 3, extended). Never persisted;
 * created in this coordinator's generation only.
 */
export interface PeerRecord {
    /** R's `hashcode()`, the session's `peer`. */
    readonly hash: string;
    key?: PublicSignKey;
    state: PeerState;
    /** A sign of life since this open (design 2.1 "Live"). */
    live: boolean;
    readonly via: Set<Via>;
    /** The last reachability read (reachability.ts; unreadable is true). */
    reachable: boolean;
    /**
     * Visible only through a replicator row with no sign of life: the first
     * session gets one OPEN attempt, then the peer is `unconfirmed`.
     */
    confirmOnly: boolean;
    /** The session in flight, if any (one per peer). */
    session?: JoinerSession;
    /** The recovery chain of the current session (`nextSessionInit`). */
    chain?: SessionInit;
    /** Waiting for a session slot (`SESSIONS_IN_FLIGHT`). */
    queued: boolean;
    sessionsOpened: number;
    /** `MAX_RENEWALS` reached: re-asked only on R's notice. */
    parked: boolean;
    /**
     * R's `openNonce` from the newest header J contained a scope of
     * (notices are checked against it).
     */
    openNonce?: Uint8Array;
    /** Contained scopes, by scope, from the session that contained each. */
    readonly results: Map<ScopeId, SessionResult>;
    /**
     * Every contained scope's session qualified R in its header
     * (`SessionResult.qualified`). In access-controlled stores the predicate
     * also needs `identity` trusted at the current trust epoch.
     */
    qualified: boolean;
    /**
     * Access-controlled stores: R's identity in J's trust graph (design 2.1
     * `D:128`), checked once R is contained and again at every trust epoch;
     * `checking` until the check at the current epoch completes.
     */
    identity?: "trusted" | "untrusted" | "checking";
    /** The trust epoch of R's last completed record check (4.2). */
    trustCheckedAt?: number;
    /** A peer that left with rows J may still lack (D4). */
    gap?: { missing: number | "unknown" };
    excluded?: { reason: ExclusionReason; scope: ScopeId; detail: string };
    refused?: "UNSUPPORTED" | "SCOPE";
    /** Unreachable at the last read (a contained or excluded peer keeps its state). */
    departed: boolean;
    /** `busy`: re-ask once when another session of J completes. */
    reaskOnCompletion: boolean;
    /** The current session holds a header of R (R answered it). */
    headerHeld: boolean;
    /**
     * The session in flight or queued is a qualification session: R is
     * `contained` and unqualified and sent a notice whose provenance
     * qualifies (N2). Only its qualified containment or an exclusion
     * changes the record (G2-20).
     */
    qualifying: boolean;
    /**
     * R's `openNonce` from a notice whose provenance qualifies, received
     * before J contained R: a containment by a header of that open which
     * does not qualify R opens a qualification session (N2).
     */
    qualifyAfter?: Uint8Array;
    /** Every unfinished scope of the session waits for a fetch (S4). */
    fetchWaiting: boolean;
    /** R's `remote-unsubscribe` of the readiness topic was seen (D6). */
    unsubscribed: boolean;
    /**
     * D6 confirmed: R unsubscribed and no longer replicates, so it closed
     * the store; it is gone however reachable it is, until a sign of life.
     */
    storeClosed: boolean;
}

/**
 * Peer events the coordinator consumes (reachability.ts builds them from
 * Peerbit). `reachability` names the peer when the event does (fanout
 * `peer:unreachable`, a libp2p event whose peer id maps to a key); every
 * such event re-reads every record.
 */
export type TransportEvent =
    | { kind: "subscribe"; peer: string; key?: PublicSignKey }
    | {
          kind: "unsubscribe";
          peer: string;
          reason?:
              | "remote-unsubscribe"
              | "peer-unreachable"
              | "peer-session-reset";
      }
    | {
          kind: "replicator";
          type: "join" | "change" | "leave";
          peer: string;
          key?: PublicSignKey;
      }
    | {
          kind: "reachability";
          source: "connect" | "disconnect" | "unreachable";
          peer?: string;
      };

/** The network as the coordinator reads it (production: `PeerbitTransport`). */
export interface CoordinatorTransport {
    /** J's own `hashcode()`. */
    readonly self: string;
    /**
     * Whether `peer` is reachable on J's route table now (A'). Never throws;
     * a read that cannot be made answers true.
     */
    isReachable(peer: string): boolean;
    /** The readiness topic's subscribers, J excluded. */
    subscribers(): Promise<Array<{ hash: string; key: PublicSignKey }>>;
    /** The namespace log's replicators (`getReplicators()`), J excluded. */
    replicators(): Promise<string[]>;
    /** Starts delivering events; returns the detach. Idempotent per listener. */
    listen(listener: (event: TransportEvent) => void): () => void;
    /** Detaches everything (idempotent). */
    dispose(): void;
}

/** What one `evaluate()` found. */
export interface Evaluation {
    satisfied: boolean;
    /** `satisfied` differs from the previous evaluation's. */
    changed: boolean;
}

export interface CoordinatorPorts {
    transport: CoordinatorTransport;
    /**
     * The peers (hashcodes) that showed J a sign of life between J's open
     * and `start` (production: the runtime's `LifeRecorder`, attached
     * before the namespace store opens: a replication announcement or a
     * readiness message). Read once by `start`; discovery counts each such
     * peer it lists live (design 2.1 "Live"). Undefined (or a throw): not
     * recorded, so every replicator row discovery lists counts as live
     * (fail closed). Without the port: none (unit tests).
     */
    signsOfLife?(): Iterable<string> | undefined;
    /** Directed one-way send to `to` (a hashcode); never throws. */
    send(message: ReadinessMessage, to: string): void;
    /**
     * Scopes every session opens, namespace first: both in an
     * access-controlled store, which `trust` marks (the runtime reads it
     * from the program, never from this list); `start` faults when the two
     * disagree.
     */
    readonly scopes: readonly ScopeId[];
    /**
     * J's trust graph (access-controlled stores only, PR-3 commit 3):
     * `TrustedNetwork.isTrusted`, uncached. A throw or rejection resolves
     * toward gating (G3-13).
     */
    trust?: { isTrusted(key: PublicSignKey): Promise<boolean> };
    /** The session ports of a scope (runtime `sessionScope`). */
    scope(id: ScopeId): SessionScopePorts | undefined;
    /** Settles once every scope's local state started (session precondition). */
    started(): Promise<void>;
    /** From the sidecar (commit 4); 0 in commit 2. */
    readonly hlcProved: bigint;
    /** A row of `scope` arrived by sync since this open (design 4.5 step 5). */
    syncDelivering(scope: ScopeId): boolean;
    /** Bounded timers for the sessions (`systemTimers` by default). */
    timers?: Timers;
    /** Milliseconds for stats only. */
    now?(): number;
    /** The host's hook after each evaluation (prerequisite mode: a recheck). */
    onEvaluate?(evaluation: Evaluation): void;
    /**
     * Test mode: a session contained `results` for `peer` (the per-session
     * K2 shadow check, G18). Called after the record changed; never awaited.
     */
    onContained?(peer: string, results: readonly SessionResult[]): void;
    /** Tests: builds sessions (default `new JoinerSession`). */
    createSession?(init: SessionInit, ports: SessionPorts): JoinerSession;
}

/** `bootstrapStatus().readiness.state` (design section 7). */
export type ReadinessState =
    | "no-peer"
    | "no-qualified-donor"
    | "reconciling"
    | "waiting-silent"
    | "waiting-fetch"
    | "waiting-left"
    | "waiting-trust"
    | "waiting-phase"
    | "ready";

/** What the host knows that the coordinator does not. */
export interface StatusContext {
    writeReady: boolean;
    /** Bootstrap decision settled and phase `off` or `converged`. */
    phaseSettled: boolean;
}

/**
 * A status snapshot (design section 7, plan 7.4): which peers J waits for
 * and why. Plain data, no bigints, so `ETIMEDOUT` can carry it and callers
 * can log it.
 */
export interface ReadinessStatus {
    state: ReadinessState;
    /** The coordinator's predicate; in prerequisite mode the tracker decides when. */
    satisfied: boolean;
    /** Required peers now (hashcodes). */
    required: string[];
    contained: Array<{
        peer: string;
        /**
         * The predicate's view: qualified by its header and, in
         * access-controlled stores, an identity J trusts at the current
         * trust epoch.
         */
        qualified: boolean;
        source: ProvenanceSource;
        scopes: ProofScope[];
        departed: boolean;
        /** Access-controlled stores: R's identity in J's trust graph. */
        identity?: "trusted" | "untrusted" | "checking";
    }>;
    excluded: Array<{ peer: string; reason: ExclusionReason; detail: string }>;
    /**
     * Required peers with nothing in flight: every attempt missed ("reachable
     * and silent"), a refusal, or a chain parked at `MAX_RENEWALS`.
     */
    silent: Array<{
        peer: string;
        reachable: boolean;
        refused?: "UNSUPPORTED" | "SCOPE";
        parked?: boolean;
    }>;
    /**
     * Peers being asked or reconciled (queued ones with no scopes yet), and
     * `left-unanswered` peers whose attempt is still in flight.
     */
    inFlight: Array<{
        peer: string;
        state: PeerState;
        scopes: Partial<Record<ProofScope, SessionState>>;
    }>;
    /** Peers answered `BUSY`, waiting for a re-ask trigger. */
    busy: string[];
    /** Peers whose sessions wait for a fetch nobody served (`waiting-fetch`). */
    fetchPending: Array<{ peer: string; hashes: number }>;
    /**
     * Required peers whose session holds hashes parked until J's trust graph
     * decides them (`waiting-trust`), access-controlled stores.
     */
    trustPending?: Array<{ peer: string; hashes: number }>;
    /**
     * Contained peers whose trust check at the current trust epoch has not
     * completed (`waiting-trust`), access-controlled stores.
     */
    trustChecking?: string[];
    gaps: Array<{ peer: string; missing: number | "unknown" }>;
    /** Replicator rows asked once and unanswered (not Required). */
    unconfirmed: string[];
    /** J's own maintained state failed; nothing can be contained this open. */
    fault?: string;
}

export interface CoordinatorDebug {
    /** Timers armed by this coordinator's sessions (it arms none itself). */
    armedTimers: number;
    sessions: number;
    /** Sessions counted against `SESSIONS_IN_FLIGHT`. */
    inFlight: number;
    queued: number;
    records: number;
    evaluations: number;
    /** An evaluation is scheduled and has not run yet. */
    evaluationPending: boolean;
    /** Messages for no live session (counted, dropped). */
    dropped: number;
    /** One discovery read succeeded (G2-12). */
    discovered: boolean;
    /** Discovery reads that failed (each retried on the next event). */
    discoveryFailures: number;
    phase: CoordinatorPhase;
    /** Trust-graph changes seen (`trustChanged`). */
    trustEpoch: number;
    /** Record trust checks in flight (4.2). */
    trustChecks: number;
    /**
     * What made sessions classify their parked hashes again: a trust
     * change, every counted trust scope turning contained, or C growing.
     */
    trustTriggers: { change: number; scopesContained: number; grew: number };
}

/** Peers `describeReadiness` names before "and N more". */
const NAMED_PEERS = 3;

const named = (peers: readonly string[]) =>
    peers.length <= NAMED_PEERS
        ? peers.join(", ")
        : `${peers.slice(0, NAMED_PEERS).join(", ")} and ${peers.length - NAMED_PEERS} more`;

const plural = (n: number, word: string, many = `${word}s`) =>
    `${n} ${n === 1 ? word : many}`;

/**
 * One line naming why J waits ("waiting-silent: 1 of 2 required peers
 * reachable and silent: <peer>"), for the `ETIMEDOUT` message and, in PR-4,
 * the CLI's progress line. Peers are cut to the first few; the snapshot on
 * the error carries all of them.
 */
export const describeReadiness = (status: ReadinessStatus): string => {
    const required = status.required.length;
    const of = (n: number) => `${n} of ${plural(required, "required peer")}`;
    switch (status.state) {
        case "ready":
            return "ready";
        case "no-peer": {
            const notes = [
                status.unconfirmed.length > 0 &&
                    `${plural(status.unconfirmed.length, "replicator row")} unconfirmed`,
                status.gaps.length > 0 &&
                    `${plural(status.gaps.length, "peer")} left: ${named(status.gaps.map(({ peer }) => peer))}`,
            ].filter(Boolean);
            return `no-peer: no visible peer to reconcile with${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
        }
        case "waiting-left": {
            const left = status.inFlight
                .filter(({ state }) => state === "left-unanswered")
                .map(({ peer }) => peer);
            return `waiting-left: ${of(left.length)} left before answering, waiting for the attempt in flight: ${named(left)}`;
        }
        case "waiting-silent": {
            const plain = status.silent.every(
                ({ reachable, refused, parked }) =>
                    reachable && !refused && !parked
            );
            const peers = status.silent.map(
                ({ peer, reachable, refused, parked }) =>
                    plain
                        ? peer
                        : `${peer} (${refused ? `refused ${refused}` : parked ? "parked" : reachable ? "reachable" : "unreachable"})`
            );
            return `waiting-silent: ${of(status.silent.length)} ${plain ? "reachable and silent" : "silent"}: ${named(peers)}`;
        }
        case "waiting-fetch": {
            const hashes = status.fetchPending.reduce(
                (sum, { hashes }) => sum + hashes,
                0
            );
            return `waiting-fetch: ${plural(hashes, "hash", "hashes")} no peer served, named by ${of(status.fetchPending.length)}: ${named(status.fetchPending.map(({ peer }) => peer))}`;
        }
        case "waiting-trust": {
            const pending = status.trustPending ?? [];
            if (pending.length > 0) {
                const hashes = pending.reduce(
                    (sum, { hashes }) => sum + hashes,
                    0
                );
                return `waiting-trust: ${plural(hashes, "hash", "hashes")} wait for J's trust graph, named by ${of(pending.length)}: ${named(pending.map(({ peer }) => peer))}`;
            }
            const checking = status.trustChecking ?? [];
            if (checking.length > 0) {
                return `waiting-trust: checking J's trust graph for ${plural(checking.length, "contained peer")}: ${named(checking)}`;
            }
            return `waiting-trust: ${of(required)} wait for J's trust graph: ${named(status.required)}`;
        }
        case "no-qualified-donor":
            return `no-qualified-donor: ${plural(status.contained.length, "peer")} contained, none qualified: ${named(status.contained.map(({ peer, source, identity }) => `${peer} (${source}${identity === "untrusted" ? ", untrusted identity" : ""})`))}`;
        case "waiting-phase":
            return "waiting-phase: every required peer is accounted for; the bootstrap phase has not settled";
        case "reconciling": {
            if (status.fault !== undefined) {
                return `reconciling: J's readiness state is unavailable (${status.fault})`;
            }
            if (status.satisfied) {
                return "reconciling: every required peer is accounted for; the write-readiness tracker decides";
            }
            const parts = [
                status.inFlight.length > 0 &&
                    `${of(status.inFlight.length)} in flight: ${named(status.inFlight.map(({ peer }) => peer))}`,
                status.busy.length > 0 &&
                    `${of(status.busy.length)} busy: ${named(status.busy)}`,
            ].filter(Boolean);
            return `reconciling: ${parts.length > 0 ? parts.join("; ") : of(required)}`;
        }
    }
};

export type CoordinatorPhase = "idle" | "running" | "finished" | "disposed";

/** Session scope states doing work after a header (S1). */
const RECONCILING_SCOPE: ReadonlySet<SessionState> = new Set<SessionState>([
    "waiting-sync",
    "peeling",
    "draining",
    "certifying",
    "recovering",
]);

/** Session scope states that hold a request or local work (Q1). */
const IN_FLIGHT_SCOPE: ReadonlySet<SessionState> = new Set<SessionState>([
    "asking",
    ...RECONCILING_SCOPE,
]);

/** Session scope states that mean R's header arrived. */
const HEADER_SCOPE: ReadonlySet<SessionState> = new Set<SessionState>([
    ...RECONCILING_SCOPE,
    "failed-fetch-wait",
    "busy",
    "contained",
]);

const resolved = Promise.resolve();

/** `isTrusted` as a promise: a synchronous throw rejects it. */
const askTrust = (
    trust: { isTrusted(key: PublicSignKey): Promise<boolean> },
    key: PublicSignKey
): Promise<boolean> => {
    try {
        return Promise.resolve(trust.isTrusted(key)).then(
            (trusted) => trusted === true
        );
    } catch (error) {
        return Promise.reject(error);
    }
};

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
};

/** Answers a session consumes (they carry its `sessionId`). */
const isAnswer = (
    message: ReadinessMessage
): message is HeaderV1 | CellsV1 | ListV1 | ErrorV1 =>
    message instanceof HeaderV1 ||
    message instanceof CellsV1 ||
    message instanceof ListV1 ||
    message instanceof ErrorV1;

/** Coordinator-private fields of a record. */
interface Entry extends PeerRecord {
    /** The queue entry that is current (an older one is skipped). */
    ticket: number;
    /** The D6 `replicators()` re-read is running. */
    visibilityRead: boolean;
    /**
     * The session ordinal (`sessionsOpened`) of each held result: one
     * session freezes trust after namespace, a later session later (G3-12).
     */
    readonly ordinals: Map<ScopeId, number>;
    /** Bumped whenever the results change: a record check of older ones is stale. */
    trustToken: number;
    /** A record trust check is in flight; `trustAgain`: run it once more. */
    trustChecking: boolean;
    trustAgain: boolean;
}

export class Coordinator {
    private phaseValue: CoordinatorPhase = "idle";
    private readonly entries = new Map<string, Entry>();
    /** Live sessions to their record (detached before the coordinator closes one). */
    private readonly owners = new Map<JoinerSession, Entry>();
    /** FIFO by enqueue; qualification sessions after every other (Q3). */
    private readonly queue: Array<{ entry: Entry; ticket: number }> = [];
    private readonly qualifyQueue: Array<{ entry: Entry; ticket: number }> = [];
    private tickets = 0;
    private pumping = false;
    private pumpAgain = false;
    private readonly timers: Timers;
    private readonly clock: () => number;
    private listener?: (event: TransportEvent) => void;
    private detach?: () => void;
    private discovered = false;
    private discovering = false;
    private discoveryFailures = 0;
    /** `ports.started()` settled: sessions may start. */
    private startedSettled = false;
    private fault?: string;
    /**
     * Subscribers (and message senders) that were unreachable when J saw
     * them: no record (design 4.7), but asked as soon as a read finds them
     * reachable (a reachability event, or the decision itself).
     */
    private readonly unreachableVisible = new Map<
        string,
        { via: Via; key?: PublicSignKey }
    >();
    /** Peers with a sign of life before `start` (`signsOfLife`). */
    private readonly earlyLife = new Set<string>();
    /** The signs of life before `start` could not be read (fail closed). */
    private everyRowLive = false;
    /** A decision-time re-read found a peer to ask again (`satisfied`). */
    private refreshPending = false;
    private evaluationPending = false;
    private lastSatisfied = false;
    /** `satisfied()` when the coordinator finished (status after it). */
    private finalSatisfied = false;
    private evaluations = 0;
    private dropped = 0;
    /** Bumped on every trust-graph change (`trustChanged`, design 4.9). */
    private trustEpoch = 0;
    private trustChecks = 0;
    private readonly trustTriggers = {
        change: 0,
        scopesContained: 0,
        grew: 0,
    };
    /** `trustScopesContained()` at the last `settle()` (its flip classifies). */
    private trustScopesWere = true;
    /** `satisfied()` found a record unchecked at this epoch (3.2). */
    private trustRecheckPending = false;
    /** The sessions' trust view (access-controlled stores). */
    private readonly sessionTrust?: SessionTrustPort;

    constructor(readonly ports: CoordinatorPorts) {
        this.timers = ports.timers ?? systemTimers;
        this.clock = ports.now ?? (() => performance.now());
        const trust = ports.trust;
        if (trust) {
            this.sessionTrust = {
                epoch: () => this.trustEpoch,
                isTrusted: (key) => askTrust(trust, key),
                scopesContained: () => this.trustScopesContained(),
            };
        }
    }

    get phase(): CoordinatorPhase {
        return this.phaseValue;
    }

    private get running() {
        return this.phaseValue === "running";
    }

    private get self() {
        return this.ports.transport.self;
    }

    /**
     * Attaches the transport listeners first (so no event between the reads
     * and the attach is lost), takes the signs of life that came before
     * them, then reads the subscribers and replicators and creates a record
     * per visible peer; sessions start once `ports.started()` settles.
     * Idempotent. Never rejects.
     */
    start(): void {
        if (this.phaseValue !== "idle") return;
        this.phaseValue = "running";
        const listener = (event: TransportEvent) => {
            // A detached listener can still fire once (main-event 1.0.3-1.0.4).
            if (this.listener !== listener || !this.running) return;
            this.onTransport(event);
        };
        this.listener = listener;
        // An access-controlled join opens the trust scope and reads J's
        // trust graph, or it cannot be satisfied (gated, G3-9).
        const trustScope = this.ports.scopes.includes(SCOPE_TRUST_V1);
        if (trustScope !== (this.ports.trust !== undefined)) {
            this.setFault(trustScope ? "no trust view" : "no trust scope");
        }
        try {
            this.detach = this.ports.transport.listen(listener);
        } catch {
            // No events: fewer re-reads and no new peers, never a wrong state.
        }
        try {
            const signs = this.ports.signsOfLife
                ? this.ports.signsOfLife()
                : [];
            if (signs === undefined) this.everyRowLive = true;
            else for (const peer of signs) this.earlyLife.add(peer);
        } catch {
            // Unknown: fail closed, every replicator row discovery lists
            // counts as live (full attempts; it blocks).
            this.everyRowLive = true;
        }
        this.discover();
        let started: Promise<void>;
        try {
            started = Promise.resolve(this.ports.started());
        } catch (error) {
            started = Promise.reject(error);
        }
        // A scope whose start failed is faulted, and its first session says
        // so (`local-unavailable`).
        const go = () => {
            if (!this.running) return;
            this.startedSettled = true;
            this.settle();
        };
        started.then(go, go);
        this.evaluate();
    }

    /**
     * A readiness message from signer `from` with its encoded size. Answers
     * go to that peer's session by `sessionId`; a notice is classified
     * against the peer's `openNonce`; every message is a sign of life (a
     * peer J did not know yet becomes a record, if reachable). Never throws.
     */
    onMessage(
        message: ReadinessMessage,
        from: string,
        bytes: number,
        key?: PublicSignKey
    ): void {
        if (!this.running || from === this.self) return;
        try {
            const entry = this.entryOf(from, "message", key);
            if (!entry) {
                this.dropped++;
                return;
            }
            this.markLive(entry, "message", key);
            if (message instanceof StateNoticeV1) {
                this.notice(entry, message);
                return;
            }
            const session = entry.session;
            if (
                isAnswer(message) &&
                session !== undefined &&
                message.sessionId instanceof Uint8Array &&
                sameBytes(message.sessionId, session.sessionId)
            ) {
                // The session's own input: it advances (or drops) it, and is
                // never a re-ask trigger (a `BUSY` answer would loop).
                session.onMessage(message, from, bytes);
                return;
            }
            if (isAnswer(message)) this.dropped++;
            this.lifeSigned(entry);
        } finally {
            this.settle();
        }
    }

    /** A `StateNoticeV1` (routed by `onMessage`). */
    onNotice(notice: StateNoticeV1, from: string, key?: PublicSignKey): void {
        if (!this.running || from === this.self) return;
        try {
            const entry = this.entryOf(from, "message", key);
            if (!entry) {
                this.dropped++;
                return;
            }
            this.markLive(entry, "message", key);
            this.notice(entry, notice);
        } finally {
            this.settle();
        }
    }

    /**
     * The contained set grew: every live session classifies its
     * trust-pending and logged hashes again (design 4.9).
     */
    reclassify(): void {
        if (!this.running) return;
        this.trustTriggers.grew++;
        this.reclassifySessions();
    }

    /**
     * J's trust graph changed (any `change` event, added-only and empty ones
     * included; design 4.9): the trust epoch moves, so a check in flight is
     * stale; every live session classifies its parked hashes again (2.5);
     * every contained record's trust is checked again (4.2). The event's
     * content is never read: a revocation may never arrive as a delete (M0
     * P3). After `finish` it is ignored: readiness is never withdrawn.
     */
    trustChanged(): void {
        if (!this.running) return;
        this.trustEpoch++;
        this.trustTriggers.change++;
        try {
            this.reclassifySessions();
            if (this.ports.trust) {
                for (const entry of [...this.entries.values()]) {
                    if (entry.state !== "contained") continue;
                    entry.identity = "checking";
                    this.checkRecordTrust(entry);
                }
            }
        } finally {
            this.settle();
        }
    }

    private reclassifySessions() {
        for (const session of [...this.owners.keys()]) session.reclassify();
    }

    /** Coalesced: one evaluation per microtask, then `ports.onEvaluate`. */
    evaluate(): void {
        if (!this.running || this.evaluationPending) return;
        this.evaluationPending = true;
        void resolved.then(() => {
            this.evaluationPending = false;
            if (!this.running) return;
            const satisfied = this.satisfied();
            const changed = satisfied !== this.lastSatisfied;
            this.lastSatisfied = satisfied;
            this.evaluations++;
            try {
                this.ports.onEvaluate?.({ satisfied, changed });
            } catch {
                // The host's error is the host's.
            }
        });
    }

    /**
     * The predicate, synchronous: running, the first discovery read
     * succeeded, no local fault, every record in a non-blocking state, and
     * some contained record qualified. The phase clause stays the tracker's
     * until commit 4.
     *
     * In an access-controlled store (design 4.8, 2.2(3), 2.2(4)) every
     * contained record also holds both scopes, its trust result from a
     * session no earlier than its namespace result (G3-12), and a trust
     * check completed at the current trust epoch (a microtask starts a
     * missing one); and a record counts as qualified only with an identity
     * J trusts at that epoch (design 2.1).
     *
     * Required is read at the moment of evaluation (design 2.1): a `left`
     * peer, or a subscriber that was unreachable when J saw it, that reads
     * reachable now makes the answer false, and a microtask asks it (D4).
     * The reads are the same route-table reads as a departure's, failing
     * closed to reachable, so this can only gate.
     */
    satisfied(): boolean {
        if (!this.running || !this.discovered || this.fault !== undefined) {
            return false;
        }
        const acl = this.ports.trust !== undefined;
        let qualified = false;
        let unchecked = false;
        for (const entry of this.entries.values()) {
            if (BLOCKING_STATES.has(entry.state)) return false;
            if (entry.state !== "contained") continue;
            if (acl) {
                if (!this.trustFirst(entry)) return false;
                if (!this.trustChecked(entry)) {
                    unchecked = true;
                    continue;
                }
            }
            if (this.qualifiedNow(entry)) qualified = true;
        }
        if (unchecked) {
            this.recheckTrust();
            return false;
        }
        if (!qualified) return false;
        if (this.reachableAgain()) {
            this.refresh();
            return false;
        }
        return true;
    }

    /**
     * Trust first (design 4.8): both scopes contained, the trust result
     * from a session no earlier than the namespace one. It holds by
     * construction (one freeze puts trust after namespace, and a namespace
     * renewal reopens trust); this fails closed if a path ever breaks it.
     */
    private trustFirst(entry: Entry): boolean {
        const namespace = entry.ordinals.get(SCOPE_NAMESPACE_V1);
        const trust = entry.ordinals.get(SCOPE_TRUST_V1);
        return (
            entry.results.has(SCOPE_NAMESPACE_V1) &&
            entry.results.has(SCOPE_TRUST_V1) &&
            namespace !== undefined &&
            trust !== undefined &&
            trust >= namespace
        );
    }

    /** The record trust check of `entry` completed at the current epoch. */
    private trustChecked(entry: Entry): boolean {
        return !entry.trustChecking && entry.trustCheckedAt === this.trustEpoch;
    }

    /** Qualified for the predicate: its header and, in ACL stores, its identity. */
    private qualifiedNow(entry: Entry): boolean {
        if (!entry.qualified) return false;
        if (!this.ports.trust) return true;
        return this.trustChecked(entry) && entry.identity === "trusted";
    }

    /** A peer counted as gone or invisible reads reachable now. */
    private reachableAgain(): boolean {
        for (const entry of this.entries.values()) {
            if (
                entry.state === "left" &&
                !entry.storeClosed &&
                this.readReachable(entry.hash)
            ) {
                return true;
            }
        }
        for (const hash of this.unreachableVisible.keys()) {
            if (this.readReachable(hash)) return true;
        }
        return false;
    }

    /** Re-reads `left` and unreachable visible peers once, on a microtask. */
    private refresh() {
        if (this.refreshPending) return;
        this.refreshPending = true;
        void resolved.then(() => {
            this.refreshPending = false;
            if (!this.running) return;
            this.rereadAll();
            this.settle();
        });
    }

    /** D1, D2 (G2-7): every record, then the unreachable visible peers. */
    private rereadAll() {
        for (const entry of [...this.entries.values()]) this.reread(entry);
        for (const [hash, seen] of [...this.unreachableVisible]) {
            if (this.readReachable(hash)) this.connected(hash, seen);
        }
    }

    /**
     * A subscriber (or sender) that was unreachable reads reachable: it is
     * connected now, so Required with full attempts, also when a replicator
     * row of it was asked once already (`unconfirmed`).
     */
    private connected(hash: string, seen: { via: Via; key?: PublicSignKey }) {
        this.unreachableVisible.delete(hash);
        const entry = this.entries.get(hash);
        if (!entry) {
            this.createEntry(hash, seen.via, {
                key: seen.key,
                live: seen.via === "message",
            });
            return;
        }
        entry.via.add(seen.via);
        entry.key ??= seen.key;
        entry.confirmOnly = false;
        if (entry.state === "unconfirmed") this.renewChain(entry);
    }

    /** A status snapshot (plain data). */
    status(context: StatusContext): ReadinessStatus {
        const entries = [...this.entries.values()];
        const blocking = entries.filter((entry) =>
            BLOCKING_STATES.has(entry.state)
        );
        const status: ReadinessStatus = {
            state: "reconciling",
            satisfied: this.running ? this.satisfied() : this.finalSatisfied,
            required: blocking.map(({ hash }) => hash),
            contained: [],
            excluded: [],
            silent: [],
            inFlight: [],
            busy: [],
            fetchPending: [],
            gaps: [],
            unconfirmed: [],
        };
        if (this.fault !== undefined) status.fault = this.fault;
        const acl = this.ports.trust !== undefined;
        const trustPending: Array<{ peer: string; hashes: number }> = [];
        const trustChecking: string[] = [];
        for (const entry of entries) {
            const { hash: peer, state, session } = entry;
            if (state === "contained") {
                const results = [...entry.results.values()];
                const source =
                    entry.results.get(this.ports.scopes[0])?.source ??
                    results[0]?.source ??
                    "none";
                const checked = this.trustChecked(entry);
                if (acl && !checked) trustChecking.push(peer);
                status.contained.push({
                    peer,
                    qualified: this.qualifiedNow(entry),
                    source,
                    scopes: results.map(
                        (result) => scopeDescriptor(result.scope).name
                    ),
                    departed: entry.departed,
                    ...(acl
                        ? {
                              identity: checked
                                  ? (entry.identity ?? "checking")
                                  : "checking",
                          }
                        : {}),
                });
            } else if (entry.excluded && state.startsWith("excluded-")) {
                status.excluded.push({
                    peer,
                    reason: entry.excluded.reason,
                    detail: entry.excluded.detail,
                });
            } else if (
                state === "silent" ||
                state === "refused" ||
                (state === "reconciling" && entry.parked)
            ) {
                status.silent.push({
                    peer,
                    reachable: entry.reachable,
                    ...(entry.refused ? { refused: entry.refused } : {}),
                    ...(entry.parked ? { parked: true } : {}),
                });
            } else if (
                state === "asking" ||
                state === "reconciling" ||
                state === "left-unanswered"
            ) {
                status.inFlight.push({
                    peer,
                    state,
                    scopes: session ? this.scopeStates(session) : {},
                });
            } else if (state === "busy") {
                status.busy.push(peer);
            } else if (state === "unconfirmed") {
                status.unconfirmed.push(peer);
            }
            if (entry.gap)
                status.gaps.push({ peer, missing: entry.gap.missing });
            if (session && BLOCKING_STATES.has(state)) {
                let failed = 0;
                let parked = 0;
                for (const scope of Object.values(session.debug().scopes)) {
                    failed += scope?.failed ?? 0;
                    parked += scope?.trustPending ?? 0;
                }
                if (failed > 0)
                    status.fetchPending.push({ peer, hashes: failed });
                if (parked > 0) trustPending.push({ peer, hashes: parked });
            }
        }
        if (acl || trustPending.length > 0) {
            status.trustPending = trustPending;
            status.trustChecking = trustChecking;
        }
        status.state = this.stateOf(context, status, blocking);
        return status;
    }

    /** Design 7's state, first match (SPEC2 2.5). */
    private stateOf(
        context: StatusContext,
        status: ReadinessStatus,
        blocking: Entry[]
    ): ReadinessState {
        if (context.writeReady) return "ready";
        if (this.fault !== undefined) return "reconciling";
        if (
            blocking.length === 0 &&
            status.contained.length === 0 &&
            status.excluded.length === 0
        ) {
            return "no-peer";
        }
        if (blocking.some(({ state }) => state === "left-unanswered")) {
            return "waiting-left";
        }
        if (status.silent.length > 0) return "waiting-silent";
        if (blocking.length > 0) {
            if (blocking.every((entry) => entry.fetchWaiting)) {
                return "waiting-fetch";
            }
            if (
                blocking.some((entry) => this.trustStalled(entry)) &&
                blocking.every(
                    (entry) => entry.fetchWaiting || this.trustStalled(entry)
                )
            ) {
                return "waiting-trust";
            }
            return "reconciling";
        }
        // A contained peer's trust check at this epoch is still running.
        if ((status.trustChecking ?? []).length > 0) return "waiting-trust";
        if (!status.contained.some(({ qualified }) => qualified)) {
            return "no-qualified-donor";
        }
        if (!context.phaseSettled) return "waiting-phase";
        // Prerequisite mode: satisfied, and today's tracker still waits for
        // its own conditions (G2-19; commit 4 removes this case).
        return "reconciling";
    }

    /**
     * The entry's namespace run waits only for J's trust graph (or a
     * fetch): parked hashes, nothing to classify, nothing logged. Its trust
     * run may still pull: the namespace waits for trust either way (M2).
     */
    private trustStalled(entry: Entry): boolean {
        const scope = entry.session?.debug().scopes[SCOPE_NAMESPACE_V1];
        if (!scope) return false;
        if (scope.state !== "draining" && scope.state !== "failed-fetch-wait") {
            return false;
        }
        const moving =
            scope.pending - scope.trustPending - scope.failed - scope.retry;
        return moving === 0 && scope.trustPending > 0;
    }

    /**
     * The proof of the current records (`buildProof`); commit 4 persists it.
     * A record's `qualified` is the predicate's view, as in `status()`: in
     * access-controlled stores also an identity J trusts at this epoch
     * (design 2.1), so the cut keeps the donor the predicate counted.
     */
    proof(): Proof {
        const entries = [...this.entries.values()];
        return buildProof({
            scopes: this.ports.scopes,
            contained: entries
                .filter(({ state }) => state === "contained")
                .flatMap((entry) => {
                    const results = [...entry.results.values()];
                    if (!this.ports.trust) return results;
                    const qualified = this.qualifiedNow(entry);
                    return results.map((result) => ({ ...result, qualified }));
                }),
            excluded: entries.flatMap((entry) =>
                entry.excluded && entry.state.startsWith("excluded-")
                    ? [{ peer: entry.hash, reason: entry.excluded.reason }]
                    : []
            ),
            gaps: entries.flatMap((entry) =>
                entry.gap
                    ? [{ peer: entry.hash, missing: entry.gap.missing }]
                    : []
            ),
        });
    }

    record(peer: string): PeerRecord | undefined {
        return this.entries.get(peer);
    }

    records(): readonly PeerRecord[] {
        return [...this.entries.values()];
    }

    /**
     * Peers J had a session or a `BUSY` with (the joiner side of design 4.8
     * step 3's READY notices; the responder holds the other side).
     */
    noticeTargets(): string[] {
        const out: string[] = [];
        for (const entry of this.entries.values()) {
            if (entry.sessionsOpened > 0) out.push(entry.hash);
        }
        return out;
    }

    /**
     * J turned ready (or the operator assumed completeness): closes every
     * session, detaches the transport, keeps the records for `status`.
     */
    finish(): void {
        this.end("finished");
    }

    /** Close or reopen began: as `finish`, synchronously; idempotent. */
    dispose(): void {
        this.end("disposed");
    }

    debug(): CoordinatorDebug {
        let armedTimers = 0;
        for (const session of this.owners.keys()) {
            armedTimers += session.debug().armedTimers;
        }
        let queued = 0;
        for (const entry of this.entries.values()) if (entry.queued) queued++;
        return {
            armedTimers,
            sessions: this.owners.size,
            inFlight: this.inFlightCount(),
            queued,
            records: this.entries.size,
            evaluations: this.evaluations,
            evaluationPending: this.evaluationPending,
            dropped: this.dropped,
            discovered: this.discovered,
            discoveryFailures: this.discoveryFailures,
            phase: this.phaseValue,
            trustEpoch: this.trustEpoch,
            trustChecks: this.trustChecks,
            trustTriggers: { ...this.trustTriggers },
        };
    }

    // ------------------------------------------------------------ handlers

    /** A transport event (V2-V5, D1, D2). */
    protected onTransport(event: TransportEvent): void {
        if (!this.running) return;
        try {
            // G2-12: a failed discovery is retried on the next event.
            if (!this.discovered) this.discover();
            switch (event.kind) {
                case "subscribe": {
                    if (event.peer === this.self) return;
                    // V2: a new record only for a reachable peer.
                    const entry = this.entryOf(
                        event.peer,
                        "subscriber",
                        event.key
                    );
                    if (!entry) return;
                    this.markLive(entry, "subscriber", event.key);
                    return this.lifeSigned(entry);
                }
                case "unsubscribe": {
                    this.unreachableVisible.delete(event.peer);
                    const entry = this.entries.get(event.peer);
                    if (!entry) return;
                    entry.via.delete("subscriber");
                    if (event.reason === "remote-unsubscribe") {
                        // D6: R closed the store, unless it still replicates.
                        entry.unsubscribed = true;
                        return this.checkVisibility(entry);
                    }
                    // A session reset or pubsub's own unreachability: A'
                    // decides (D1).
                    return this.reread(entry);
                }
                case "replicator": {
                    if (event.peer === this.self) return;
                    if (event.type === "leave") {
                        const entry = this.entries.get(event.peer);
                        if (!entry) return;
                        entry.via.delete("replicator");
                        return this.checkVisibility(entry);
                    }
                    // V3: a replication announcement is a sign of life, so the
                    // peer gets full attempts whatever its reachability.
                    this.unreachableVisible.delete(event.peer);
                    const entry =
                        this.entries.get(event.peer) ??
                        this.createEntry(event.peer, "replicator", {
                            key: event.key,
                            live: true,
                        });
                    this.markLive(entry, "replicator", event.key);
                    return this.lifeSigned(entry);
                }
                case "reachability":
                    // D1 and D2 (G2-7): every record, so a relayed peer whose
                    // relay went away is re-read too.
                    return this.rereadAll();
            }
        } finally {
            this.settle();
        }
    }

    /** A session's terminal outcome (O- transitions). */
    protected onOutcome(session: JoinerSession, outcome: SessionOutcome): void {
        if (!this.running) return;
        const entry = this.owners.get(session);
        // O7: the coordinator detaches a session before it closes it.
        if (!entry || entry.session !== session) return;
        this.owners.delete(session);
        entry.session = undefined;
        entry.fetchWaiting = false;
        const qualifying = entry.qualifying;
        try {
            switch (outcome.kind) {
                case "contained":
                    return this.onContainedOutcome(entry, outcome.results);
                case "excluded":
                    // O2: sticky; an exclusion wins over an earlier containment.
                    entry.qualifying = false;
                    entry.qualifyAfter = undefined;
                    entry.state = `excluded-${outcome.reason}`;
                    entry.excluded = {
                        reason: outcome.reason,
                        scope: outcome.scope,
                        detail: outcome.detail,
                    };
                    this.clearResults(entry);
                    entry.parked = false;
                    entry.gap = undefined;
                    return this.reaskBusy();
                case "local-unavailable":
                    // O6: nothing can be contained this open.
                    return this.setFault(outcome.detail);
                case "closed":
                    // Not closed by the coordinator: fail closed, re-asked on
                    // R's notice.
                    if (qualifying) {
                        entry.qualifying = false;
                    } else if (BLOCKING_STATES.has(entry.state)) {
                        entry.state = "reconciling";
                        entry.parked = true;
                    }
                    return;
            }
            if (qualifying) {
                // G2-20: anything but a qualified containment or an exclusion
                // leaves the earlier containment in place.
                if (outcome.kind === "renew") {
                    const next = nextSessionInit(session.init, outcome);
                    if (next) return this.openSession(entry, next);
                }
                entry.qualifying = false;
                return;
            }
            if (entry.departed) return this.departedOutcome(entry);
            switch (outcome.kind) {
                case "busy":
                    // O3.
                    entry.state = "busy";
                    entry.reaskOnCompletion = true;
                    return;
                case "renew": {
                    // O4: a new session at once, in the same slot.
                    for (const result of outcome.results) {
                        this.setResult(entry, result);
                    }
                    const next = nextSessionInit(session.init, outcome);
                    if (next) return this.openSession(entry, next);
                    entry.state = "reconciling";
                    entry.parked = true;
                    return;
                }
                case "refused":
                    // O5 (G2-5).
                    entry.state = "refused";
                    entry.refused = outcome.code;
                    return;
            }
        } finally {
            this.settle();
        }
    }

    /** A session scope's state change (S- transitions). */
    protected onSessionState(
        session: JoinerSession,
        _scope: ScopeId,
        state: SessionState
    ): void {
        if (!this.running) return;
        const entry = this.owners.get(session);
        // The outcome follows the states `finish` sets.
        if (!entry || entry.session !== session || session.outcome) return;
        if (HEADER_SCOPE.has(state)) entry.headerHeld = true;
        try {
            if (entry.qualifying) return;
            if (entry.departed) {
                if (entry.state === "left-unanswered" && entry.headerHeld) {
                    // R's answer ended the attempt in flight (A1).
                    this.attemptEnded(entry);
                }
                return;
            }
            this.fromSession(entry, session);
        } finally {
            this.settle();
        }
    }

    /**
     * A session's run started or stopped waiting only for trust
     * (`SessionEvents.onParked`): the record's fetch-waiting flag and the
     * slot count read it (G2-4). A namespace run parked while not every
     * counted trust scope is contained is also B3's trigger: the trust scope
     * it waits for may be a busy peer's, and no session of J completes
     * before that peer is asked again.
     */
    protected onSessionParked(
        session: JoinerSession,
        scope: ScopeId,
        parked: boolean
    ): void {
        if (!this.running) return;
        const entry = this.owners.get(session);
        if (!entry || entry.session !== session || session.outcome) return;
        try {
            if (!entry.qualifying && !entry.departed) {
                this.fromSession(entry, session);
            }
            if (
                parked &&
                scope === SCOPE_NAMESPACE_V1 &&
                !this.trustScopesContained()
            ) {
                this.reaskBusy();
            }
        } finally {
            this.settle();
        }
    }

    /**
     * An OPEN attempt of `session` ended with a scope still without a
     * header (`SessionEvents.onAttempt`, added in commit 2): ends a
     * `left-unanswered` block or a confirm-only peer's single attempt,
     * whichever attempt it was (`_last` is for diagnostics).
     */
    protected onAttempt(session: JoinerSession, _last: boolean): void {
        if (!this.running) return;
        const entry = this.owners.get(session);
        if (!entry || entry.session !== session || entry.qualifying) return;
        try {
            if (entry.confirmOnly && !entry.live) {
                // A2: a replicator row with no sign of life is asked once.
                this.closeSession(entry);
                entry.state = "unconfirmed";
                return;
            }
            if (entry.state === "left-unanswered") this.attemptEnded(entry);
        } finally {
            this.settle();
        }
    }

    // ------------------------------------------------------------ transitions

    /** O1. */
    private onContainedOutcome(entry: Entry, results: SessionResult[]) {
        if (entry.qualifying) {
            entry.qualifying = false;
            // G2-20: only a qualified containment upgrades the record.
            if (results.length > 0 && results.every((r) => r.qualified)) {
                this.mergeResults(entry, results);
            }
        } else {
            this.mergeResults(entry, results);
            entry.state = "contained";
            entry.gap = undefined;
            entry.parked = false;
            entry.refused = undefined;
            entry.reaskOnCompletion = false;
            const after = entry.qualifyAfter;
            entry.qualifyAfter = undefined;
            if (
                !entry.qualified &&
                after !== undefined &&
                entry.openNonce !== undefined &&
                sameBytes(after, entry.openNonce)
            ) {
                // R noticed J it turned ready while this session ran; its
                // header came from the same open, frozen while R was gated.
                this.qualify(entry);
            }
        }
        this.reaskBusy();
        // C grew (design 4.9): parked trust-pending and logged hashes again.
        this.reclassify();
        // R's identity and its provisional rows, now that R's trust scope
        // is contained (4.2): "checked after the trust scope is contained".
        if (entry.state === "contained" && !this.trustChecked(entry)) {
            this.checkRecordTrust(entry);
        }
        try {
            this.ports.onContained?.(entry.hash, results);
        } catch {
            // Test mode only; failures are recorded by the hook.
        }
    }

    private mergeResults(entry: Entry, results: readonly SessionResult[]) {
        for (const result of results) {
            this.setResult(entry, result);
            entry.openNonce = Uint8Array.from(result.openNonce);
        }
        const held = [...entry.results.values()];
        entry.qualified = held.length > 0 && held.every((r) => r.qualified);
    }

    /**
     * Holds a contained scope's result, stamped with the ordinal of the
     * session that contained it (the record's newest, G3-12). A record
     * check of the earlier results is stale from now on.
     */
    private setResult(entry: Entry, result: SessionResult) {
        entry.results.set(result.scope, result);
        entry.ordinals.set(result.scope, entry.sessionsOpened);
        entry.trustToken++;
        entry.trustCheckedAt = undefined;
        if (this.ports.trust) entry.identity = "checking";
    }

    /** The record holds no containment (an exclusion, a trust reopen). */
    private clearResults(entry: Entry) {
        entry.results.clear();
        entry.ordinals.clear();
        entry.qualified = false;
        entry.identity = undefined;
        entry.trustCheckedAt = undefined;
        entry.trustToken++;
    }

    /**
     * A departed peer's session ended without containing or excluding it:
     * the peer stays `left` (an attempt it never answered leaves a gap), and
     * a re-read finds it back or not.
     */
    private departedOutcome(entry: Entry) {
        if (entry.state === "left-unanswered") {
            entry.state = "left";
            entry.gap ??= { missing: "unknown" };
        }
        this.reread(entry);
    }

    /** S1-S5: the record's state from its session's scopes. */
    private fromSession(entry: Entry, session: JoinerSession) {
        const states = Object.values(this.scopeStates(session));
        let state: PeerState;
        let fetchWaiting = false;
        if (states.some((s) => RECONCILING_SCOPE.has(s))) {
            state = "reconciling";
            // S4 beside runs parked for trust: the fetch is what R can
            // help, so R's sign of life retries it (design 4.5 step 8).
            fetchWaiting =
                states.includes("failed-fetch-wait") &&
                !this.holdsWork(session);
        } else if (states.includes("silent")) {
            state = "silent";
        } else if (states.includes("busy")) {
            state = "busy";
        } else if (states.includes("failed-fetch-wait")) {
            state = "reconciling";
            fetchWaiting = true;
        } else if (states.includes("asking")) {
            state = "asking";
        } else {
            state = "reconciling";
        }
        // B1: a list page refused with `BUSY` (C1 T7).
        if (state === "busy" && entry.state !== "busy") {
            entry.reaskOnCompletion = true;
        }
        entry.state = state;
        entry.fetchWaiting = fetchWaiting;
    }

    /**
     * A sign of life (V2, V3, V6 not consumed by R's session): `silent`
     * resumes, `busy` is re-asked, `unconfirmed` gets full attempts, a
     * fetch-waiting session retries R's failed pulls, a qualification
     * session resumes, a departed peer is re-read. `refused`, parked and
     * excluded peers wait for R's notice.
     */
    private lifeSigned(entry: Entry) {
        if (entry.departed) {
            const before = entry.state;
            this.reread(entry);
            // Still gone, or back and `arrive` asked it again.
            if (
                entry.departed ||
                before === "left" ||
                before === "left-unanswered" ||
                before === "contained"
            ) {
                return;
            }
        }
        switch (entry.state) {
            case "silent":
                return entry.session?.resume();
            case "busy":
                return this.reask(entry);
            case "unconfirmed":
                return this.renewChain(entry);
            case "reconciling":
                if (entry.fetchWaiting) entry.session?.resume();
                return;
            case "contained":
                // Its attempts or a request may have gone unanswered
                // (silent, no timer armed); a queued one has no session yet.
                if (entry.qualifying) entry.session?.resume();
                return;
        }
    }

    /** N1-N3: a notice is a trigger, never evidence (design 4.3). */
    private notice(entry: Entry, notice: StateNoticeV1) {
        if (classifyNotice(notice, entry.openNonce) === "stale") {
            this.dropped++;
            return;
        }
        if (entry.state === "contained") {
            if (entry.qualified || !qualifies(notice.provenance)) return;
            // Only the header of a fresh session can qualify R.
            if (entry.qualifying) return entry.session?.resume();
            return this.qualify(entry);
        }
        if (entry.state.startsWith("excluded-")) return;
        if (qualifies(notice.provenance)) {
            // R turned ready, but the session in flight answers from the
            // snapshot R froze before (gated): the containment it ends in
            // opens a fresh session (`onContainedOutcome`).
            entry.qualifyAfter = Uint8Array.from(notice.provenance.openNonce);
        }
        if (entry.departed) {
            // A notice can arrive relayed while J's route table has no route
            // to R: as for any sign of life, re-read first (D1), and a peer
            // still gone is not asked.
            const before = entry.state;
            this.reread(entry);
            if (
                entry.departed ||
                before === "left" ||
                before === "left-unanswered"
            ) {
                return;
            }
        }
        switch (entry.state) {
            case "busy":
                return this.reask(entry);
            case "silent":
            case "asking":
                return entry.session?.resume();
            case "reconciling":
                if (entry.parked) return this.renewChain(entry);
                return entry.session?.resume();
            case "refused":
            case "unconfirmed":
                return this.renewChain(entry);
            case "left":
            case "left-unanswered":
                return this.reread(entry);
        }
    }

    /** N2: a qualification session for a contained, unqualified R (Q3). */
    private qualify(entry: Entry) {
        entry.qualifyAfter = undefined;
        entry.qualifying = true;
        this.enqueue(entry, this.freshInit(entry.hash), true);
    }

    /** B2 (G2-25): the chain's ladder with a fresh `sessionId`. */
    private reask(entry: Entry) {
        entry.reaskOnCompletion = false;
        if (entry.session) return entry.session.resume();
        const chain = entry.chain ?? this.freshInit(entry.hash);
        const fresh = newSessionInit(entry.hash, chain.scopes, chain.hlcProved);
        entry.state = "asking";
        this.enqueue(entry, {
            ...fresh,
            list: chain.list,
            ladder: { ...chain.ladder },
        });
    }

    /** B3: another session of J completed; each `busy` peer once. */
    private reaskBusy() {
        for (const entry of [...this.entries.values()]) {
            if (
                entry.state === "busy" &&
                entry.reaskOnCompletion &&
                !entry.departed
            ) {
                this.reask(entry);
            }
        }
    }

    /** A new chain from the first rung, queued (a refusal, a parked chain, unconfirmed). */
    private renewChain(entry: Entry) {
        this.closeSession(entry);
        entry.state = "asking";
        entry.parked = false;
        entry.refused = undefined;
        this.enqueue(entry, this.freshInit(entry.hash));
    }

    /** D1: re-read one peer's reachability and apply D3 or D4. */
    private reread(entry: Entry) {
        entry.reachable = this.readReachable(entry.hash);
        if (!entry.reachable || entry.storeClosed) this.depart(entry);
        else if (entry.departed) this.arrive(entry);
    }

    /** D3 (and D6): the peer is gone. */
    private depart(entry: Entry) {
        if (entry.departed) return;
        entry.departed = true;
        switch (entry.state) {
            case "contained":
            case "unconfirmed":
            case "excluded-inconsistent":
            case "excluded-unsubstantiated":
            case "left":
            case "left-unanswered":
                return;
        }
        this.dequeue(entry);
        entry.parked = false;
        if (entry.session && entry.headerHeld) {
            // Its pulls can still contain R (design 4.7): the session stays.
            entry.state = "left";
            entry.gap = { missing: this.pendingOf(entry.session) };
            return;
        }
        if (entry.session && entry.state === "asking") {
            // Blocks until the attempt in flight ends (A1).
            entry.state = "left-unanswered";
            return;
        }
        entry.state = "left";
        entry.gap = { missing: "unknown" };
    }

    /** D4: reachable again. */
    private arrive(entry: Entry) {
        if (!entry.departed) return;
        entry.departed = false;
        if (entry.state === "contained") {
            // A qualification session that went silent while R was away.
            if (entry.qualifying) entry.session?.resume();
            return;
        }
        if (entry.state !== "left" && entry.state !== "left-unanswered") return;
        // Blocking again: the gap goes.
        entry.gap = undefined;
        const session = entry.session;
        if (session) {
            const left = entry.state === "left";
            this.fromSession(entry, session);
            if (left) session.resume();
            return;
        }
        entry.state = "asking";
        entry.refused = undefined;
        this.enqueue(entry, this.freshInit(entry.hash));
    }

    /** A1: the attempt in flight of a `left-unanswered` peer ended. */
    private attemptEnded(entry: Entry) {
        entry.reachable = this.readReachable(entry.hash);
        if (entry.reachable && !entry.storeClosed) return this.arrive(entry);
        if (entry.headerHeld && entry.session) {
            // R answered after all; the session stays and can still pull.
            entry.state = "left";
            entry.gap = { missing: this.pendingOf(entry.session) };
            return;
        }
        this.closeSession(entry);
        entry.state = "left";
        entry.gap = { missing: "unknown" };
    }

    /**
     * D6: an explicit unsubscribe of a peer that does not replicate (any
     * more) means it closed the store; a `replicators()` re-read confirms.
     * A read that fails leaves the peer as it is.
     */
    private checkVisibility(entry: Entry) {
        // A peer already gone by reachability is checked too: once it closed
        // the store, a route that comes back must not bring it back (D4).
        if (
            !entry.unsubscribed ||
            entry.storeClosed ||
            entry.via.has("replicator") ||
            entry.visibilityRead
        ) {
            return;
        }
        entry.visibilityRead = true;
        let read: Promise<string[]>;
        try {
            read = Promise.resolve(this.ports.transport.replicators());
        } catch (error) {
            read = Promise.reject(error);
        }
        read.then(
            (replicators) => {
                entry.visibilityRead = false;
                if (!this.running || this.entries.get(entry.hash) !== entry) {
                    return;
                }
                if (replicators.includes(entry.hash)) {
                    entry.via.add("replicator");
                    return;
                }
                if (!entry.unsubscribed || entry.via.has("replicator")) return;
                entry.storeClosed = true;
                this.depart(entry);
                this.settle();
            },
            () => {
                entry.visibilityRead = false;
            }
        );
    }

    /**
     * R\J hashes the session still lacks when every unfinished scope holds a
     * decoded set (draining or waiting for a fetch); otherwise unknown.
     */
    private pendingOf(session: JoinerSession): number | "unknown" {
        let missing = 0;
        for (const scope of Object.values(session.debug().scopes)) {
            if (!scope || scope.state === "contained") continue;
            if (
                scope.state !== "draining" &&
                scope.state !== "failed-fetch-wait"
            ) {
                return "unknown";
            }
            missing += scope.pending;
        }
        return missing;
    }

    // ------------------------------------------------------------ plumbing

    /** The record of `peer`, or a new one when the peer is reachable (V2, V6). */
    private entryOf(
        peer: string,
        via: Via,
        key?: PublicSignKey
    ): Entry | undefined {
        const entry = this.entries.get(peer);
        if (entry) return entry;
        if (!this.readReachable(peer)) {
            this.unreachableVisible.set(peer, { via, key });
            return undefined;
        }
        this.unreachableVisible.delete(peer);
        return this.createEntry(peer, via, { key, live: true });
    }

    private createEntry(
        hash: string,
        via: Via,
        options: { key?: PublicSignKey; live: boolean; confirmOnly?: boolean }
    ): Entry {
        const entry: Entry = {
            hash,
            key: options.key,
            state: "asking",
            live: options.live,
            via: new Set([via]),
            reachable: this.readReachable(hash),
            confirmOnly: options.confirmOnly === true && !options.live,
            queued: false,
            sessionsOpened: 0,
            parked: false,
            results: new Map(),
            qualified: false,
            departed: false,
            reaskOnCompletion: false,
            headerHeld: false,
            qualifying: false,
            fetchWaiting: false,
            unsubscribed: false,
            storeClosed: false,
            ticket: 0,
            visibilityRead: false,
            ordinals: new Map(),
            trustToken: 0,
            trustChecking: false,
            trustAgain: false,
        };
        this.entries.set(hash, entry);
        this.enqueue(entry, this.freshInit(hash));
        return entry;
    }

    /** A sign of life: live, full attempts, visible again (D6 cleared). */
    private markLive(entry: Entry, via: Via, key?: PublicSignKey) {
        entry.via.add(via);
        entry.key ??= key;
        entry.live = true;
        entry.confirmOnly = false;
        entry.unsubscribed = false;
        entry.storeClosed = false;
    }

    private freshInit(peer: string): SessionInit {
        return newSessionInit(peer, this.ports.scopes, this.ports.hlcProved);
    }

    private readReachable(peer: string): boolean {
        try {
            return this.ports.transport.isReachable(peer) !== false;
        } catch {
            // Fail closed: the peer keeps blocking.
            return true;
        }
    }

    /** V1 (G2-12): one read in flight; a failure is retried on the next event. */
    private discover() {
        if (this.discovering || this.discovered || !this.running) return;
        this.discovering = true;
        const { transport } = this.ports;
        let read: Promise<
            [Array<{ hash: string; key: PublicSignKey }>, string[]]
        >;
        try {
            read = Promise.all([
                transport.subscribers(),
                transport.replicators(),
            ]);
        } catch (error) {
            read = Promise.reject(error);
        }
        read.then(
            ([subscribers, replicators]) => {
                this.discovering = false;
                if (!this.running) return;
                this.discovered = true;
                for (const { hash, key } of subscribers) {
                    if (hash === this.self) continue;
                    const entry = this.entries.get(hash);
                    if (entry) {
                        entry.via.add("subscriber");
                        entry.key ??= key;
                    } else if (this.readReachable(hash)) {
                        this.createEntry(hash, "subscriber", {
                            key,
                            live: this.earlyLife.has(hash),
                        });
                    } else {
                        // An unreachable subscriber may be a dead peer
                        // relayed to J (design 4.7): no record until a read
                        // finds it reachable.
                        this.unreachableVisible.set(hash, {
                            via: "subscriber",
                            key,
                        });
                    }
                }
                for (const hash of replicators) {
                    if (hash === this.self) continue;
                    const entry = this.entries.get(hash);
                    if (entry) entry.via.add("replicator");
                    else {
                        // A row with a sign of life since J opened gets full
                        // attempts; one with none is asked once (A2).
                        this.createEntry(hash, "replicator", {
                            live: this.everyRowLive || this.earlyLife.has(hash),
                            confirmOnly: true,
                        });
                    }
                }
                this.settle();
            },
            () => {
                this.discovering = false;
                this.discoveryFailures++;
                this.evaluate();
            }
        );
    }

    private enqueue(entry: Entry, init: SessionInit, qualification = false) {
        entry.chain = init;
        entry.queued = true;
        entry.ticket = ++this.tickets;
        (qualification ? this.qualifyQueue : this.queue).push({
            entry,
            ticket: entry.ticket,
        });
    }

    private dequeue(entry: Entry) {
        entry.queued = false;
    }

    private nextQueued(): Entry | undefined {
        for (const queue of [this.queue, this.qualifyQueue]) {
            while (queue.length > 0) {
                const { entry, ticket } = queue.shift()!;
                if (entry.queued && entry.ticket === ticket && !entry.session) {
                    entry.queued = false;
                    return entry;
                }
            }
        }
        return undefined;
    }

    /**
     * Q1: a session holds a request or local work for a peer that blocks. A
     * run parked for trust holds neither (G2-4): it waits for other peers'
     * trust scopes, so counting it could keep the peer it waits for queued.
     */
    private inFlight(entry: Entry): boolean {
        const session = entry.session;
        if (!session || session.outcome) return false;
        if (
            !entry.qualifying &&
            !(entry.state === "asking" || entry.state === "reconciling")
        ) {
            return false;
        }
        return this.holdsWork(session);
    }

    /** Some run of `session` asks or works, and is not parked for trust. */
    private holdsWork(session: JoinerSession): boolean {
        return session.init.scopes.some((id) => {
            const state = session.state(id);
            return (
                state !== undefined &&
                IN_FLIGHT_SCOPE.has(state) &&
                !session.parked(id)
            );
        });
    }

    private inFlightCount(): number {
        let n = 0;
        for (const entry of this.entries.values()) {
            if (this.inFlight(entry)) n++;
        }
        return n;
    }

    /** Q2: start queued sessions while a slot is free. Re-entrant safe. */
    private pump() {
        if (this.pumping) {
            this.pumpAgain = true;
            return;
        }
        this.pumping = true;
        try {
            do {
                this.pumpAgain = false;
                while (
                    this.running &&
                    this.fault === undefined &&
                    this.startedSettled &&
                    this.inFlightCount() < SESSIONS_IN_FLIGHT
                ) {
                    const entry = this.nextQueued();
                    if (!entry) break;
                    this.openSession(entry, entry.chain!);
                }
            } while (this.pumpAgain);
        } finally {
            this.pumping = false;
        }
    }

    /**
     * Runs after every handler: queued sessions, then one evaluation. In an
     * access-controlled store, every counted trust scope turning contained
     * classifies the sessions' parked hashes again (design 4.5 step 8, test
     * 37): no trust change may follow when the last trust scope adds
     * nothing, and a Required peer's departure counts too.
     */
    private settle() {
        this.pump();
        if (this.ports.trust && this.running) {
            const contained = this.trustScopesContained();
            if (contained && !this.trustScopesWere) {
                this.trustTriggers.scopesContained++;
                this.reclassifySessions();
            }
            this.trustScopesWere = contained;
        }
        this.evaluate();
    }

    /**
     * Every peer that is Required or contained has its trust scope
     * contained: a trust result the record holds, or the trust run of its
     * live session contained when that session reopened trust. `left`,
     * excluded and unconfirmed peers do not count. True in open mode. The
     * namespace runs' promotion clause (design 4.5 step 8, G3-1).
     */
    private trustScopesContained(): boolean {
        if (!this.ports.trust) return true;
        for (const entry of this.entries.values()) {
            if (
                entry.state !== "contained" &&
                !BLOCKING_STATES.has(entry.state)
            ) {
                continue;
            }
            const session = entry.session;
            if (
                session &&
                !session.outcome &&
                !entry.qualifying &&
                session.init.scopes.includes(SCOPE_TRUST_V1)
            ) {
                if (session.state(SCOPE_TRUST_V1) !== "contained") return false;
            } else if (!entry.results.has(SCOPE_TRUST_V1)) {
                return false;
            }
        }
        return true;
    }

    /**
     * The record trust check (4.2), one in flight per record (a request
     * meanwhile runs it once more), at one trust epoch: R's identity
     * (`isTrusted` of the record's key, the readiness signer, which must
     * hash to R; none, or a throw, is untrusted), and the re-check of every
     * held result's `rejected-untrusted` signers (a signer trusted, or a
     * throw, may reverse them). It applies only while the coordinator runs,
     * the record is contained with the same results, and the epoch is
     * unchanged; otherwise it runs again. A possible reversal reopens the
     * record (G3-6). No timer: local reads of J's trust graph.
     */
    private checkRecordTrust(entry: Entry) {
        const trust = this.ports.trust;
        if (!trust || !this.running || entry.state !== "contained") return;
        if (entry.trustChecking) {
            entry.trustAgain = true;
            return;
        }
        entry.trustChecking = true;
        this.trustChecks++;
        const run = async () => {
            do {
                entry.trustAgain = false;
                const e0 = this.trustEpoch;
                const token = entry.trustToken;
                const key = entry.key;
                const signers = new Map<string, PublicSignKey>();
                for (const result of entry.results.values()) {
                    for (const signer of result.untrusted?.signers ?? []) {
                        signers.set(signer.hashcode(), signer);
                    }
                }
                const [identity, reversible] = await Promise.all([
                    key !== undefined && key.hashcode() === entry.hash
                        ? askTrust(trust, key).catch(() => false)
                        : Promise.resolve(false),
                    Promise.all(
                        [...signers.values()].map((signer) =>
                            askTrust(trust, signer).catch(() => true)
                        )
                    ),
                ]);
                if (
                    !this.running ||
                    this.entries.get(entry.hash) !== entry ||
                    entry.state !== "contained"
                ) {
                    return;
                }
                if (entry.trustToken !== token || this.trustEpoch !== e0) {
                    entry.trustAgain = true;
                    continue;
                }
                entry.trustCheckedAt = e0;
                entry.identity = identity ? "trusted" : "untrusted";
                if (reversible.some(Boolean)) return this.reopenForTrust(entry);
            } while (entry.trustAgain);
        };
        void run()
            .catch(() => {
                // Unreachable (every read is caught); the record stays
                // unchecked, which gates.
            })
            .finally(() => {
                entry.trustChecking = false;
                this.trustChecks--;
                if (this.running) this.settle();
            });
    }

    /** `satisfied()` found a contained record unchecked at this epoch (3.2). */
    private recheckTrust() {
        if (this.trustRecheckPending) return;
        this.trustRecheckPending = true;
        void resolved.then(() => {
            this.trustRecheckPending = false;
            if (!this.running) return;
            for (const entry of [...this.entries.values()]) {
                if (
                    entry.state === "contained" &&
                    !entry.trustChecking &&
                    entry.trustCheckedAt !== this.trustEpoch
                ) {
                    this.checkRecordTrust(entry);
                }
            }
        });
    }

    /**
     * A contained record whose provisional `rejected-untrusted` rows a
     * signer trusted now may reverse (2.6, G3-6): its results go, its
     * qualification with them. Reachable: asked again on both scopes with a
     * fresh chain. Departed: `left`, with the heads it explained by trust as
     * its gap (D4): J keeps whatever sync delivers, and the gap is named.
     */
    private reopenForTrust(entry: Entry) {
        let heads = 0;
        for (const result of entry.results.values()) {
            heads += result.untrusted?.heads ?? 0;
        }
        this.clearResults(entry);
        entry.qualifying = false;
        entry.qualifyAfter = undefined;
        if (entry.departed) {
            this.closeSession(entry);
            entry.state = "left";
            entry.gap = { missing: heads };
            return;
        }
        this.renewChain(entry);
    }

    private openSession(entry: Entry, init: SessionInit) {
        entry.chain = init;
        entry.queued = false;
        entry.headerHeld = false;
        entry.fetchWaiting = false;
        entry.sessionsOpened++;
        if (!entry.qualifying) entry.state = "asking";
        const peer = init.peer;
        const events: SessionEvents = {
            onOutcome: (session, outcome) => this.onOutcome(session, outcome),
            onState: (session, scope, state) =>
                this.onSessionState(session, scope, state),
            onAttempt: (session, info) => this.onAttempt(session, info.last),
            onParked: (session, scope, parked) =>
                this.onSessionParked(session, scope, parked),
        };
        const ports: SessionPorts = {
            send: (message) => {
                try {
                    this.ports.send(message, peer);
                } catch {
                    // The port never throws; a failed send is a lost message.
                }
            },
            timers: this.timers,
            now: this.clock,
            syncDelivering: (scope) => this.ports.syncDelivering(scope),
            scope: (id) => this.ports.scope(id),
            events,
            ...(this.sessionTrust ? { trust: this.sessionTrust } : {}),
        };
        let session: JoinerSession;
        try {
            session = this.ports.createSession
                ? this.ports.createSession(init, ports)
                : new JoinerSession(init, ports);
        } catch (error: any) {
            return this.setFault(
                `readiness session: ${error?.message ?? String(error)}`
            );
        }
        entry.session = session;
        this.owners.set(session, entry);
        session.start();
    }

    /** Detaches the entry's session, then closes it (`CloseV1` when R may hold it). */
    private closeSession(entry: Entry) {
        const session = entry.session;
        if (!session) return;
        entry.session = undefined;
        entry.fetchWaiting = false;
        this.owners.delete(session);
        session.close();
    }

    /** O6: J's own state failed; every session closes and none starts. */
    private setFault(detail: string) {
        if (this.fault !== undefined) return;
        this.fault = detail;
        for (const entry of this.entries.values()) {
            this.closeSession(entry);
            entry.queued = false;
        }
        this.queue.length = 0;
        this.qualifyQueue.length = 0;
    }

    private end(phase: "finished" | "disposed") {
        if (this.phaseValue === "disposed") return;
        if (this.phaseValue === "finished") {
            this.phaseValue = phase;
            return;
        }
        this.finalSatisfied = this.satisfied();
        // First: every handler, the evaluation job and the continuations
        // return from now on.
        this.phaseValue = phase;
        this.listener = undefined;
        try {
            this.detach?.();
        } catch {
            // Detaching never throws; nothing to undo if it did.
        }
        this.detach = undefined;
        try {
            this.ports.transport.dispose();
        } catch {
            // As above.
        }
        for (const entry of this.entries.values()) {
            this.closeSession(entry);
            entry.queued = false;
        }
        this.queue.length = 0;
        this.qualifyQueue.length = 0;
    }

    /** Each scope of a session with its state. */
    private scopeStates(
        session: JoinerSession
    ): Partial<Record<ProofScope, SessionState>> {
        const out: Partial<Record<ProofScope, SessionState>> = {};
        for (const id of session.init.scopes) {
            const state = session.state(id);
            if (state !== undefined) out[scopeDescriptor(id).name] = state;
        }
        return out;
    }
}
