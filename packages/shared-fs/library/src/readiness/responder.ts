import type { PublicSignKey } from "@peerbit/crypto";
import { toHexString } from "@peerbit/crypto";
import { AnchorUnavailableError, type LaneSet } from "./anchor-host.js";
import { encodeCells, type Cells } from "./cells.js";
import {
    DIGEST_BYTES,
    LIST_PAGE_HASHES,
    M,
    NOTICE_TARGETS,
    PUSH_MAX,
    SESSIONS_PER_PEER,
    SESSIONS_TOTAL,
    SESSION_IDLE_MS,
    T_SYNC,
} from "./constants.js";
import type { ScopeDescriptor, ScopeId } from "./scopes.js";
import type { ScopeTap } from "./tap.js";
import {
    CellsReqV1,
    CellsV1,
    CloseV1,
    ERROR_CODE,
    ErrorV1,
    HeaderV1,
    ListPageV1,
    ListV1,
    NOTICE_REASON,
    OPEN_FLAG_LIST,
    OpenV1,
    ProvenanceV1,
    READINESS_CAPS,
    StateNoticeV1,
    checkReadinessMessage,
    type ErrorCode,
    type ProvenancePhase,
    type ProvenanceSource,
    type ReadinessMessage,
} from "./wire.js";

/**
 * The responder (WRITE_READINESS_V2.md section 4.4 "Responder rules", M1
 * plan sections 4, 5 and 7.2). Every open replica answers, gated or not,
 * full or partial, and reports its provenance honestly.
 *
 * - **Snapshots.** One per scope and epoch, shared by every session opened
 *   at that epoch: a cells copy, the count, `hlc`, and D_R from the lane
 *   set's `digestNow()`, all taken in one synchronous step at a point where
 *   the scope's replace-verify queue is empty (S10, deviation k). The trust
 *   scope is frozen after the namespace scope.
 * - **Sessions** are keyed by (peer, sessionId). Every attempt of a session
 *   gets the same snapshot. First-flight cells go with the header when
 *   0 < gapEst <= 256. A session expires after 30 s without a request.
 * - **Caps.** 4 sessions per peer and 16 in total, and one list-mode
 *   session (deviation c). Beyond a cap the answer is `BUSY`, and the
 *   requester gets a directed `StateNoticeV1{CAPACITY}` when a session that
 *   was answered ends. A session costs the responder one freeze per epoch
 *   (the list copy and `above` are shared by the sessions at that epoch) and
 *   at most M requested cells.
 * - **Failures.** A worker restart during a freeze is retried at once (the
 *   lane sets are rebuilt before the requests reject). A scope that cannot
 *   be answered (a faulted or stopped tap) gets `BUSY`, and its session ends
 *   without a capacity notice: a notice would make every waiter re-ask a
 *   responder that fails each time, so waiters are noticed only when an
 *   answered session ends.
 * - **Late requests** for a live session are answered however late; an
 *   unknown session gets `EXPIRED`.
 * - **Re-entrancy (S15).** The RPC awaits decryption before each handler and
 *   directed messages take different routes, so no handler assumes order: a
 *   request awaits its session's freeze, and every await re-checks that the
 *   runtime still answers. Handlers never throw.
 */

/** One scope as the responder sees it. */
export interface ResponderScope {
    readonly descriptor: ScopeDescriptor;
    readonly tap: ScopeTap;
    readonly cells: Cells;
    readonly laneSet: LaneSet;
    /** The 32-byte id of the scope's log. */
    readonly logId: Uint8Array;
    /** Settles when the scope's restore or seed scan finished (or failed). */
    readonly started: Promise<void>;
}

export interface ProvenanceState {
    writeReady: boolean;
    source: ProvenanceSource;
    fullReplica: boolean;
    phase: ProvenancePhase;
}

/** Bounded in-flight timers only (the 30 s session idle). */
export interface Timers {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

export const systemTimers: Timers = {
    set: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
    },
    clear: (handle) => clearTimeout(handle as any),
};

export interface ResponderPorts {
    send(message: ReadinessMessage, to: PublicSignKey): Promise<void>;
    provenance(): ProvenanceState;
    timers?: Timers;
}

export interface ResponderHost {
    readonly openNonce: Uint8Array;
    scope(id: ScopeId): ResponderScope | undefined;
    /** False once the close began or the generation was disposed. */
    answering(): boolean;
}

interface Snapshot {
    /** The tap's map at the freeze: a restore or reseed replaces it. */
    readonly map: object;
    readonly epoch: number;
    readonly cells: Cells;
    readonly count: number;
    readonly hlc: bigint;
    readonly anchor: Promise<Uint8Array>;
    /** The hash list, copied once at this epoch by the first list session. */
    list?: Uint8Array;
    /** `above` per `hlcProved`, counted once at this epoch (O(n) each). */
    readonly above: Map<bigint, number>;
}

interface FrozenScope {
    readonly scope: ResponderScope;
    readonly snapshot: Snapshot;
    readonly anchor: Uint8Array;
    /** Rows newer than the session's `hlcProved` (0 when it is 0). */
    readonly above: number;
    /** The snapshot's hash list (list-mode sessions only). */
    list?: Uint8Array;
}

interface Session {
    readonly key: string;
    readonly peer: PublicSignKey;
    readonly peerHash: string;
    readonly sessionId: Uint8Array;
    readonly hlcProved: bigint;
    list: boolean;
    /** Resolves to the frozen scopes, or to an error code to answer. */
    frozen: Promise<FrozenScope[] | ErrorCode>;
    timer?: unknown;
    /** Cells served by `CellsReqV1` per scope (at most M each). */
    readonly cellsServed: Map<number, number>;
}

export interface ResponderStats {
    opens: number;
    headers: number;
    pushedCells: number;
    cellsSent: number;
    listPages: number;
    /** Hash lists copied (once per snapshot epoch at most). */
    listCopies: number;
    freezes: number;
    busy: number;
    expired: number;
    errors: number;
    notices: number;
    sendFailures: number;
    /** Answers to joiners (PR-3) and malformed messages, dropped. */
    ignored: number;
}

class Refused {
    constructor(readonly code: ErrorCode) {}
}

/** Freeze attempts after a worker restart (a second one goes inline). */
const FREEZE_RETRIES = 2;
/** `above` counts kept per snapshot. */
const ABOVE_CACHE = 8;
const RETRY = Symbol("retry");

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
};

/** First-flight prefix for a gap estimate (design 4.5 step 6). */
const firstCells = (gap: number) =>
    Math.min(M, Math.max(64, Math.ceil((1.8 * gap) / 32) * 32));

/** Rows above `hlc` at the snapshot's epoch, counted once per value. */
const aboveOf = (snapshot: Snapshot, tap: ScopeTap, hlc: bigint) => {
    let n = snapshot.above.get(hlc);
    if (n === undefined) {
        n = tap.above(hlc);
        if (snapshot.above.size < ABOVE_CACHE) snapshot.above.set(hlc, n);
    }
    return n;
};

/** A copy of a tap's live heads (n x 32 B), in slab order. */
const copyList = (tap: ScopeTap) => {
    const out = new Uint8Array(tap.count * DIGEST_BYTES);
    let o = 0;
    tap.map.forEach((digest) => {
        out.set(digest, o);
        o += DIGEST_BYTES;
    });
    return out;
};

export class Responder {
    readonly stats: ResponderStats = {
        opens: 0,
        headers: 0,
        pushedCells: 0,
        cellsSent: 0,
        listPages: 0,
        listCopies: 0,
        freezes: 0,
        busy: 0,
        expired: 0,
        errors: 0,
        notices: 0,
        sendFailures: 0,
        ignored: 0,
    };
    private readonly sessions = new Map<string, Session>();
    private readonly perPeer = new Map<string, number>();
    private listSession?: string;
    /** Peers answered `BUSY` since the last capacity notice. */
    private readonly busyWaiters = new Map<string, PublicSignKey>();
    /** Peers that had a session or a `BUSY` in this open (READY notices, PR-3). */
    readonly noticeTargets = new Map<string, PublicSignKey>();
    private readonly snapshots = new Map<ScopeId, Snapshot>();
    private readonly timers: Timers;
    private disposed = false;

    constructor(
        private readonly host: ResponderHost,
        private readonly ports: ResponderPorts
    ) {
        this.timers = ports.timers ?? systemTimers;
    }

    private answering() {
        return !this.disposed && this.host.answering();
    }

    /** Sessions, armed idle timers and waiters (tests and diagnostics). */
    debug() {
        let armedTimers = 0;
        for (const session of this.sessions.values()) {
            if (session.timer !== undefined) armedTimers++;
        }
        return {
            sessions: this.sessions.size,
            armedTimers,
            busyWaiters: this.busyWaiters.size,
            listSession: this.listSession !== undefined,
        };
    }

    /** The RPC handler's entry. Never throws, never awaits the caller. */
    onMessage(message: ReadinessMessage, from: PublicSignKey | undefined) {
        if (!from || !this.answering()) return;
        void this.handle(message, from).catch((error) => {
            // A handler bug must not surface as an RPC handler error.
            this.stats.errors++;
            console.warn(
                "shared-fs: readiness responder error:",
                error?.message ?? error
            );
        });
    }

    private async handle(message: ReadinessMessage, from: PublicSignKey) {
        const isRequest =
            message instanceof OpenV1 ||
            message instanceof CellsReqV1 ||
            message instanceof ListPageV1 ||
            message instanceof CloseV1;
        if (!isRequest) {
            // Headers, cells, lists, errors and notices are for a joiner
            // (PR-3); nothing reads them yet.
            this.stats.ignored++;
            return;
        }
        const guard = checkReadinessMessage(message);
        if (guard === "drop") {
            this.stats.ignored++;
            return;
        }
        if (guard !== undefined) {
            if (!(message instanceof CloseV1)) {
                this.error(from, message.sessionId, guard);
            }
            return;
        }
        if (message instanceof OpenV1) return this.onOpen(message, from);
        if (message instanceof CellsReqV1)
            return this.onCellsReq(message, from);
        if (message instanceof ListPageV1)
            return this.onListPage(message, from);
        this.endSession(this.keyOf(from.hashcode(), message.sessionId));
    }

    private keyOf(peerHash: string, sessionId: Uint8Array) {
        return peerHash + "/" + toHexString(sessionId);
    }

    private send(message: ReadinessMessage, to: PublicSignKey) {
        if (!this.answering()) return;
        void this.ports.send(message, to).catch(() => {
            this.stats.sendFailures++;
        });
    }

    private error(to: PublicSignKey, sessionId: Uint8Array, code: ErrorCode) {
        if (code === ERROR_CODE.BUSY) {
            this.stats.busy++;
            const hash = to.hashcode();
            if (this.busyWaiters.size < NOTICE_TARGETS) {
                this.busyWaiters.set(hash, to);
            }
            this.remember(hash, to);
        } else if (code === ERROR_CODE.EXPIRED) {
            this.stats.expired++;
        } else {
            this.stats.errors++;
        }
        this.send(new ErrorV1({ sessionId, code }), to);
    }

    private remember(hash: string, peer: PublicSignKey) {
        if (
            this.noticeTargets.size < NOTICE_TARGETS ||
            this.noticeTargets.has(hash)
        ) {
            this.noticeTargets.set(hash, peer);
        }
    }

    private provenance() {
        return new ProvenanceV1({
            ...this.ports.provenance(),
            openNonce: this.host.openNonce,
            caps: READINESS_CAPS,
        });
    }

    /**
     * The requested scopes with their logs checked, in freeze order
     * (namespace first). An unknown scope or a log id that does not match
     * gets `SCOPE`.
     */
    private resolveScopes(open: OpenV1): ResponderScope[] | undefined {
        const out: ResponderScope[] = [];
        for (const requested of open.scopes) {
            const scope = this.host.scope(requested.scope as ScopeId);
            if (!scope || !sameBytes(scope.logId, requested.logId)) {
                return undefined;
            }
            out.push(scope);
        }
        return out.sort((a, b) => a.descriptor.id - b.descriptor.id);
    }

    private async onOpen(open: OpenV1, from: PublicSignKey) {
        this.stats.opens++;
        const peerHash = from.hashcode();
        const key = this.keyOf(peerHash, open.sessionId);
        let session = this.sessions.get(key);
        if (!session) {
            const scopes = this.resolveScopes(open);
            if (!scopes) {
                return this.error(from, open.sessionId, ERROR_CODE.SCOPE);
            }
            const list = (open.flags & OPEN_FLAG_LIST) !== 0;
            if (
                this.sessions.size >= SESSIONS_TOTAL ||
                (this.perPeer.get(peerHash) ?? 0) >= SESSIONS_PER_PEER ||
                (list && this.listSession !== undefined)
            ) {
                return this.error(from, open.sessionId, ERROR_CODE.BUSY);
            }
            const created: Session = {
                key,
                peer: from,
                peerHash,
                sessionId: Uint8Array.from(open.sessionId),
                hlcProved: open.hlcProved,
                list,
                frozen: undefined as any,
                cellsServed: new Map(),
            };
            this.sessions.set(key, created);
            this.perPeer.set(peerHash, (this.perPeer.get(peerHash) ?? 0) + 1);
            if (list) this.listSession = key;
            this.remember(peerHash, from);
            created.frozen = this.freeze(created, scopes);
            session = created;
        }
        this.touch(session);
        const frozen = await session.frozen;
        if (!this.answering()) return;
        if (typeof frozen === "number") {
            // Nothing was answered, so no capacity notice (see the class
            // comment); BUSY registers this peer for the next real one.
            this.endSession(key, false);
            return this.error(from, open.sessionId, frozen);
        }
        // Every attempt of a session gets the same snapshot.
        for (const scope of frozen) {
            const requested = open.scopes.find(
                (candidate) => candidate.scope === scope.scope.descriptor.id
            );
            this.sendHeader(
                session,
                scope,
                requested?.count ?? 0,
                requested?.above ?? 0
            );
        }
    }

    private sendHeader(
        session: Session,
        frozen: FrozenScope,
        joinerCount: number,
        joinerAbove: number
    ) {
        const { snapshot } = frozen;
        // The gap estimate the joiner will compute (design 4.5 step 4); R
        // cannot know J's k, so it uses the count difference. The second
        // term is off while hlcProved = 0.
        const gapEst = Math.max(
            Math.abs(snapshot.count - joinerCount),
            session.hlcProved > 0n ? frozen.above + joinerAbove : 0
        );
        let cells: Uint8Array | undefined;
        if (gapEst > 0 && gapEst <= T_SYNC) {
            const n = Math.min(PUSH_MAX, firstCells(gapEst));
            cells = encodeCells(snapshot.cells, 0, n);
            this.stats.pushedCells += n;
        }
        this.stats.headers++;
        this.send(
            new HeaderV1({
                sessionId: session.sessionId,
                scope: frozen.scope.descriptor.id,
                logId: frozen.scope.logId,
                provenance: this.provenance(),
                count: snapshot.count,
                anchor: frozen.anchor,
                hlc: snapshot.hlc,
                above: frozen.above,
                cellsFrom: 0,
                cells,
            }),
            session.peer
        );
    }

    /**
     * Freezes every scope of a session in order. Each freeze waits for its
     * scope's start and for an empty replace-verify queue, then takes the
     * snapshot in one synchronous step (S10). A worker restart (EAGAIN) is
     * retried at once: the lane sets were rebuilt before it rejected.
     */
    private async freeze(
        session: Session,
        scopes: ResponderScope[]
    ): Promise<FrozenScope[] | ErrorCode> {
        for (let tries = 0; ; tries++) {
            const result = await this.freezeOnce(session, scopes);
            if (result !== RETRY) return result;
            if (tries >= FREEZE_RETRIES) return ERROR_CODE.BUSY;
        }
    }

    private async freezeOnce(
        session: Session,
        scopes: ResponderScope[]
    ): Promise<FrozenScope[] | ErrorCode | typeof RETRY> {
        const out: Array<
            Omit<FrozenScope, "anchor"> & { anchor?: Uint8Array }
        > = [];
        try {
            for (const scope of scopes) {
                await scope.started;
                const { tap } = scope;
                for (;;) {
                    if (!this.answering()) return ERROR_CODE.BUSY;
                    if (tap.faulted !== undefined || tap.state !== "live") {
                        throw new Refused(ERROR_CODE.BUSY);
                    }
                    if (tap.pendingVerify === 0) break;
                    await tap.verifyIdle();
                }
                const snapshot = this.snapshotOf(scope);
                out.push({
                    scope,
                    snapshot,
                    above:
                        session.hlcProved > 0n
                            ? aboveOf(snapshot, tap, session.hlcProved)
                            : 0,
                    list: session.list ? this.listOf(snapshot, tap) : undefined,
                });
            }
            for (const frozen of out) {
                frozen.anchor = await frozen.snapshot.anchor;
            }
        } catch (error) {
            for (const frozen of out) {
                if (
                    this.snapshots.get(frozen.scope.descriptor.id) ===
                    frozen.snapshot
                ) {
                    this.snapshots.delete(frozen.scope.descriptor.id);
                }
            }
            if (error instanceof Refused) return error.code;
            if (
                error instanceof AnchorUnavailableError &&
                scopes.every(({ laneSet }) => !laneSet.faulted)
            ) {
                // EAGAIN from a failed worker; the lane sets are rebuilt.
                return RETRY;
            }
            return ERROR_CODE.BUSY;
        }
        return out as FrozenScope[];
    }

    /** The snapshot's hash list; call only while the tap is at its epoch. */
    private listOf(snapshot: Snapshot, tap: ScopeTap): Uint8Array {
        if (!snapshot.list) {
            this.stats.listCopies++;
            snapshot.list = copyList(tap);
        }
        return snapshot.list;
    }

    /** The scope's snapshot at its current epoch (shared, or taken now). */
    private snapshotOf(scope: ResponderScope): Snapshot {
        const { tap, laneSet } = scope;
        const cached = this.snapshots.get(scope.descriptor.id);
        if (cached && cached.epoch === tap.epoch && cached.map === tap.map) {
            return cached;
        }
        if (laneSet.seq !== tap.epoch) {
            // The plan's invariant (section 4); a break is a bug, and an
            // answer from it would describe the wrong set.
            tap.faulted ??= new Error(
                `lane set at ${laneSet.seq}, tap at epoch ${tap.epoch}`
            );
            throw new Refused(ERROR_CODE.BUSY);
        }
        const { digest } = laneSet.digestNow();
        // Never unhandled: the freeze awaits it.
        digest.catch(() => {});
        const snapshot: Snapshot = {
            map: tap.map,
            epoch: tap.epoch,
            cells: scope.cells.copy(),
            count: tap.count,
            hlc: tap.hlc,
            anchor: digest,
            above: new Map(),
        };
        this.stats.freezes++;
        this.snapshots.set(scope.descriptor.id, snapshot);
        return snapshot;
    }

    /** The session a scoped request names, its scope checked; or answers. */
    private async sessionFor(
        message: CellsReqV1 | ListPageV1,
        from: PublicSignKey
    ): Promise<{ session: Session; frozen: FrozenScope } | undefined> {
        const session = this.sessions.get(
            this.keyOf(from.hashcode(), message.sessionId)
        );
        if (!session) {
            this.error(from, message.sessionId, ERROR_CODE.EXPIRED);
            return undefined;
        }
        this.touch(session);
        const frozen = await session.frozen;
        if (!this.answering()) return undefined;
        if (typeof frozen === "number") {
            this.error(from, message.sessionId, ERROR_CODE.EXPIRED);
            return undefined;
        }
        const scope = frozen.find(
            (candidate) => candidate.scope.descriptor.id === message.scope
        );
        if (!scope || !sameBytes(scope.scope.logId, message.logId)) {
            this.error(from, message.sessionId, ERROR_CODE.SCOPE);
            return undefined;
        }
        return { session, frozen: scope };
    }

    private async onCellsReq(request: CellsReqV1, from: PublicSignKey) {
        const found = await this.sessionFor(request, from);
        if (!found) return;
        const { session, frozen } = found;
        // Design 4.4: at most M cells per session and scope, however asked.
        const served =
            (session.cellsServed.get(request.scope) ?? 0) +
            (request.to - request.from);
        if (served > M) {
            return this.error(from, request.sessionId, ERROR_CODE.EXPIRED);
        }
        session.cellsServed.set(request.scope, served);
        this.stats.cellsSent += request.to - request.from;
        this.send(
            new CellsV1({
                sessionId: session.sessionId,
                scope: request.scope,
                logId: frozen.scope.logId,
                from: request.from,
                cells: encodeCells(
                    frozen.snapshot.cells,
                    request.from,
                    request.to
                ),
            }),
            from
        );
    }

    private async onListPage(request: ListPageV1, from: PublicSignKey) {
        const found = await this.sessionFor(request, from);
        if (!found) return;
        const { session, frozen } = found;
        if (!frozen.list) {
            // Deviation c: the list must be the snapshot's set. A session
            // that did not ask for list mode gets one only while its scope
            // is still at the snapshot's epoch; otherwise the joiner opens
            // a fresh list-mode session.
            const { tap } = frozen.scope;
            if (
                tap.state !== "live" ||
                tap.faulted !== undefined ||
                tap.map !== frozen.snapshot.map ||
                tap.epoch !== frozen.snapshot.epoch ||
                tap.pendingVerify !== 0
            ) {
                return this.error(from, request.sessionId, ERROR_CODE.EXPIRED);
            }
            if (
                !session.list &&
                this.listSession !== undefined &&
                this.listSession !== session.key
            ) {
                return this.error(from, request.sessionId, ERROR_CODE.BUSY);
            }
            frozen.list = this.listOf(frozen.snapshot, tap);
            session.list = true;
            this.listSession = session.key;
        }
        const total = frozen.list.length / DIGEST_BYTES;
        const offset = Math.min(request.offset, total);
        const n = Math.min(LIST_PAGE_HASHES, total - offset);
        this.stats.listPages++;
        this.send(
            new ListV1({
                sessionId: session.sessionId,
                scope: request.scope,
                logId: frozen.scope.logId,
                offset,
                hashes: frozen.list.slice(
                    offset * DIGEST_BYTES,
                    (offset + n) * DIGEST_BYTES
                ),
                done: offset + n >= total,
            }),
            from
        );
    }

    /** Restarts a session's 30 s idle timer (memory bound, never evidence). */
    private touch(session: Session) {
        if (session.timer !== undefined) this.timers.clear(session.timer);
        session.timer = this.timers.set(() => {
            session.timer = undefined;
            this.endSession(session.key);
        }, SESSION_IDLE_MS);
    }

    /** Ends a session; `notify` false for one that was never answered. */
    private endSession(key: string, notify = true) {
        const session = this.sessions.get(key);
        if (!session) return;
        this.sessions.delete(key);
        if (session.timer !== undefined) {
            this.timers.clear(session.timer);
            session.timer = undefined;
        }
        const left = (this.perPeer.get(session.peerHash) ?? 1) - 1;
        if (left > 0) this.perPeer.set(session.peerHash, left);
        else this.perPeer.delete(session.peerHash);
        if (this.listSession === key) this.listSession = undefined;
        if (notify) this.noticeCapacity();
    }

    /** `BUSY` promised a notice: capacity just freed, tell every waiter. */
    private noticeCapacity() {
        if (
            this.busyWaiters.size === 0 ||
            this.sessions.size >= SESSIONS_TOTAL ||
            !this.answering()
        ) {
            return;
        }
        const waiters = [...this.busyWaiters.values()];
        this.busyWaiters.clear();
        this.sendNotice(waiters, NOTICE_REASON.CAPACITY);
    }

    /** Directed `StateNoticeV1` to each peer (a trigger, never evidence). */
    sendNotice(peers: Iterable<PublicSignKey>, reason: number) {
        if (!this.answering()) return;
        const notice = new StateNoticeV1({
            provenance: this.provenance(),
            reason,
        });
        for (const peer of peers) {
            this.stats.notices++;
            this.send(notice, peer);
        }
    }

    /** Ends every session and timer; answers nothing from now on. */
    dispose() {
        this.disposed = true;
        for (const session of this.sessions.values()) {
            if (session.timer !== undefined) this.timers.clear(session.timer);
            session.timer = undefined;
        }
        this.sessions.clear();
        this.perPeer.clear();
        this.busyWaiters.clear();
        this.snapshots.clear();
        this.listSession = undefined;
    }
}
