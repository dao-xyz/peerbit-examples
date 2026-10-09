// Test-only harness for the joiner session (PR-3 commit 1): two fake peers
// on real taps and lane sets of a real anchor host (inline by default),
// PR-2's real responder on R's side, an in-memory network that sends every
// message through the wire codec, with fault hooks, J's real pull queue (a
// fake join that copies entries from R's log) and real explainer (on J's
// fake log and index), a driver that runs the recovery ladder, and an oracle
// that checks every contained session against the fake stores directly. Not
// a test file (no `.test.ts`).
import {
    Ed25519Keypair,
    sha256Sync,
    type PublicSignKey,
} from "@peerbit/crypto";
import { IdentityRelation } from "@peerbit/trusted-network";
import { NamingEvent } from "../model.js";
import {
    AnchorHost,
    type AnchorHostMode,
    type LaneSet,
} from "../readiness/anchor-host.js";
import { Cells, cellKey } from "../readiness/cells.js";
import { CELL_BYTES, DIGEST_BYTES, M } from "../readiness/constants.js";
import { digestToHead, headDigest } from "../readiness/digest.js";
import {
    Explainer,
    RejectionRecord,
    type EntryFacts,
    type ExplainPorts,
    type Rejection,
} from "../readiness/explain.js";
import type { IdKey } from "../readiness/id-map.js";
import { PullQueue, type PullPorts } from "../readiness/pull-queue.js";
import {
    Responder,
    type ProvenanceState,
    type Timers,
} from "../readiness/responder.js";
import {
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    scopeDescriptor,
    type ScopeDescriptor,
    type ScopeId,
} from "../readiness/scopes.js";
import {
    JoinerSession,
    localScopeOf,
    newSessionInit,
    nextSessionInit,
    type LocalScope,
    type SessionEvents,
    type SessionInit,
    type SessionOutcome,
    type SessionPorts,
    type SessionResult,
    type SessionScopePorts,
} from "../readiness/session.js";
import {
    ScopeTap,
    type IndexedHead,
    type ScopeIndexPort,
} from "../readiness/tap.js";
import {
    CellsV1,
    HeaderV1,
    StateNoticeV1,
    decodeReadinessMessage,
    encodeReadinessMessage,
    type ReadinessMessage,
} from "../readiness/wire.js";

export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A deterministic standard head for a label. */
export const headOf = (label: string) =>
    digestToHead(sha256Sync(encoder.encode(label)));

/** A deterministic 32-byte value for a label. */
export const bytesOf = (label: string) => sha256Sync(encoder.encode(label));

/** Lets queued handlers and their sends run. */
export const settle = async (rounds = 50) => {
    for (let i = 0; i < rounds; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

/** A shared fake clock for the session's and the responder's timers. */
export class FakeTimers implements Timers {
    now = 0;
    private nextId = 1;
    private readonly due = new Map<number, { at: number; fn: () => void }>();
    set(fn: () => void, ms: number) {
        // A real clock fires a missing delay at once; never hide it here.
        if (!Number.isFinite(ms) || ms < 0) {
            throw new Error(`readiness harness: timer delay ${ms}`);
        }
        const id = this.nextId++;
        this.due.set(id, { at: this.now + ms, fn });
        return id;
    }
    clear(handle: unknown) {
        this.due.delete(handle as number);
    }
    armed() {
        return this.due.size;
    }
    /** Moves the clock, firing every timer due on the way, in order. */
    advance(ms: number) {
        const end = this.now + ms;
        for (;;) {
            let next: [number, { at: number; fn: () => void }] | undefined;
            for (const entry of this.due) {
                if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) {
                    next = entry;
                }
            }
            if (!next) break;
            this.due.delete(next[0]);
            this.now = Math.max(this.now, next[1].at);
            next[1].fn();
        }
        this.now = end;
    }
}

/**
 * An entry of the shared block store: a row of a scope, a delete (CUT) whose
 * `next` names the removed head, a value of another class (a `FileChunk`),
 * or an entry that cannot be decoded.
 */
export interface Entry {
    readonly head: string;
    readonly scope: ScopeId;
    readonly kind: "row" | "cut" | "chunk" | "garbled";
    /** The document id (rows and CUTs). */
    readonly id?: string;
    /** The entry's wall time (`__context.modified` of a row). */
    readonly modified: bigint;
    readonly next: readonly string[];
}

const idKey = (scope: ScopeId, id: string): IdKey =>
    scope === SCOPE_TRUST_V1 ? encoder.encode(id) : id;
const idString = (key: IdKey) =>
    typeof key === "string" ? key : decoder.decode(key);

/** A change-event value as Documents dispatches it. */
const eventValue = (
    entry: Entry,
    head = entry.head,
    modified = entry.modified
) => {
    const value = Object.create(
        entry.scope === SCOPE_TRUST_V1
            ? IdentityRelation.prototype
            : NamingEvent.prototype
    );
    value.id = idKey(entry.scope, entry.id!);
    value.__context = { head, modified };
    return value;
};

/** A certificate J posted: its seq, J's index heads then, and E. */
interface CertificateRecord {
    seq: number;
    index: Set<string>;
    add: Set<string>;
}

/**
 * One peer's store of one scope: a fake index behind a real `ScopeTap`, a
 * lane set of the world's anchor host with the cells (as `runtime.ts`
 * builds a scope), and a log with its `next` index.
 */
export class FakeScope {
    readonly index = new Map<string, IndexedHead>();
    readonly log = new Set<string>();
    /** Heads some logged entry's `next` names (`getHasNext`). */
    readonly nexts = new Set<string>();
    /** Rows logged whose index write is held (`releaseIndex`). */
    readonly held = new Map<string, Entry>();
    readonly tap: ScopeTap;
    readonly laneSet: LaneSet;
    readonly descriptor: ScopeDescriptor;
    /** `readHead` waits for this (a replace verify held open). */
    readHeadGate?: Promise<void>;
    /** `count` waits for this (a count check held open). */
    countGate?: Promise<void>;
    /** Certificates posted (J side, the oracle). */
    readonly certificates: CertificateRecord[] = [];
    /** Snapshot heads by D_R (R side, the oracle). */
    readonly snapshots = new Map<string, Set<string>>();
    digestNowCalls = 0;
    /** The fake index behind the tap; the explainer reads J's rows from it. */
    readonly indexPort: ScopeIndexPort;
    /** Heads whose explainer lookups throw. */
    readonly throwing = new Set<string>();
    /** Heads the explainer inspected, in order. */
    readonly inspected: string[] = [];

    constructor(
        readonly world: JoinerWorld,
        readonly scope: ScopeId,
        readonly logId: Uint8Array,
        host: AnchorHost
    ) {
        this.descriptor = scopeDescriptor(scope);
        const port: ScopeIndexPort = {
            readHead: async (key: IdKey) => {
                await Promise.resolve();
                if (this.readHeadGate) await this.readHeadGate;
                return this.index.get(idString(key));
            },
            scan: async function* (this: FakeScope) {
                await Promise.resolve();
                yield [...this.index].map(([id, row]) => ({
                    key: idKey(scope, id),
                    ...row,
                }));
            }.bind(this),
            count: async () => {
                if (this.countGate) await this.countGate;
                const n = this.index.size;
                await Promise.resolve();
                return n;
            },
        };
        this.indexPort = port;
        this.tap = new ScopeTap(this.descriptor, port);
        const tap = this.tap;
        this.laneSet = host.open(this.descriptor.ivTag, {
            slab: () => tap.map,
            cells: { m: M, k0: world.cellKey[0], k1: world.cellKey[1] },
        });
        const laneSet = this.laneSet;
        tap.addSink({
            apply: (digest, sign) => laneSet.apply(digest, sign),
            reset: () => laneSet.reset(tap.epoch),
        });
        // The oracle's records: J's index at each certificate, R's
        // snapshot heads by anchor.
        const digestNow = laneSet.digestNow.bind(laneSet);
        laneSet.digestNow = (sub, add) => {
            this.digestNowCalls++;
            this.certificates.push({
                seq: tap.epoch,
                index: this.indexDigests(),
                add: new Set((add ?? []).map(hex)),
            });
            return digestNow(sub, add);
        };
        const stateNow = laneSet.stateNow.bind(laneSet);
        laneSet.stateNow = ((part: "lanes" | "digest") => {
            const heads = this.indexDigests();
            const answer = stateNow(part);
            answer.state.then(
                (state: any) => {
                    if (state.digest) {
                        this.snapshots.set(hex(state.digest), heads);
                    }
                },
                () => {}
            );
            return answer;
        }) as typeof laneSet.stateNow;
    }

    /** The index's heads as hex digests (independent of the tap). */
    indexDigests() {
        return new Set(
            [...this.index.values()].map(({ head }) => hex(headDigest(head)))
        );
    }

    /** Seeds the tap from the index and verifies its count. */
    async start() {
        await this.tap.seedFromScan();
        await this.tap.checkCount();
    }

    /**
     * An entry arrives (a local write, sync or a pull): logged, then indexed
     * under Documents' newest-wins rule for a mutable store, and its change
     * event dispatched. `holdIndex` logs it and holds the index write.
     */
    receive(entry: Entry, options: { holdIndex?: boolean } = {}) {
        if (this.log.has(entry.head)) return;
        this.log.add(entry.head);
        for (const next of entry.next) this.nexts.add(next);
        if (entry.kind === "row") {
            if (options.holdIndex) {
                this.held.set(entry.head, entry);
                return;
            }
            this.indexRow(entry);
        } else if (entry.kind === "cut") {
            const target = entry.next[0];
            const row = this.index.get(entry.id!);
            if (row?.head === target) {
                this.index.delete(entry.id!);
                this.tap.onChange({
                    detail: {
                        added: [],
                        removed: [eventValue(entry, row.head, row.modified)],
                    },
                });
            }
        }
    }

    /** Documents' indexing of a row (`program.js:3814-3832`). */
    private indexRow(entry: Entry) {
        // A logged CUT of exactly this head keeps it out.
        if (this.nexts.has(entry.head)) return;
        const existing = this.index.get(entry.id!);
        if (existing && existing.modified > entry.modified) return;
        this.index.set(entry.id!, {
            head: entry.head,
            modified: entry.modified,
        });
        this.tap.onChange({
            detail: { added: [eventValue(entry)], removed: [] },
        });
    }

    /**
     * Dispatches `entry`'s change event without touching the index: an
     * older entry's event Documents dispatches after the newer one it kept.
     */
    dispatchOnly(entry: Entry) {
        this.tap.onChange({
            detail: { added: [eventValue(entry)], removed: [] },
        });
    }

    /** The held index write of `head` lands now. */
    releaseIndex(head: string) {
        const entry = this.held.get(head);
        if (!entry) return;
        this.held.delete(head);
        this.indexRow(entry);
    }

    /** The scope's `LocalScope` (the production binding). */
    local(): LocalScope {
        return localScopeOf(
            {
                descriptor: this.descriptor,
                tap: this.tap,
                laneSet: this.laneSet,
                logId: this.logId,
                started: Promise.resolve(),
            },
            this.world.cellKey
        );
    }

    /**
     * What this peer's log holds for `head`: a row of this scope, an entry
     * that is not one (a CUT, another class or another scope's row), or one
     * that cannot be decoded; undefined when the log lacks it.
     */
    facts(head: string): EntryFacts | undefined {
        if (!this.log.has(head)) return undefined;
        const entry = this.world.blocks.get(head)!;
        if (entry.kind === "garbled") {
            return { kind: "unknown", detail: "undecodable" };
        }
        if (entry.kind === "row" && entry.scope === this.scope) {
            return {
                kind: "row",
                key: idKey(entry.scope, entry.id!),
                wallTime: entry.modified,
            };
        }
        return { kind: "not-row", detail: `a ${entry.kind}` };
    }

    /**
     * The explainer's ports on this peer's log and index (commit 2 binds
     * `getHasNext`, the log's entries and `ScopeIndexPort.readHead`).
     */
    explainPorts(): ExplainPorts {
        const lookup = async (head: string) => {
            await Promise.resolve();
            if (this.throwing.has(head)) throw new Error("lookup failed");
        };
        return {
            hasNext: async (head) => {
                await lookup(head);
                return this.nexts.has(head);
            },
            inspect: async (head) => {
                this.inspected.push(head);
                await lookup(head);
                return this.facts(head);
            },
            readHead: (key) => this.indexPort.readHead(key),
        };
    }

    /** J's cells now (m x 44 B). */
    async cellsBytes(): Promise<Uint8Array> {
        return Uint8Array.from(await this.laneSet.cellsNow().cells);
    }
}

export class FakePeer {
    readonly scopes = new Map<ScopeId, FakeScope>();
    constructor(
        readonly name: string,
        readonly key: PublicSignKey
    ) {}
    get hash() {
        return this.key.hashcode();
    }
    scope(id: ScopeId = SCOPE_NAMESPACE_V1): FakeScope {
        return this.scopes.get(id)!;
    }
}

export interface NetworkHooks {
    /** J to R: return null to drop, or a replacement. */
    toR?: (message: ReadinessMessage) => ReadinessMessage | null | undefined;
    /** R to J: null drops; an array delivers each (duplicates). */
    toJ?: (
        message: ReadinessMessage
    ) => ReadinessMessage | ReadinessMessage[] | null | undefined;
    /** Fake-clock delay of an R to J message (0: next microtask). */
    delayToJ?: (message: ReadinessMessage) => number;
    /** Fake-clock delay of a J to R message. */
    delayToR?: (message: ReadinessMessage) => number;
}

export interface DriveResult {
    sessions: JoinerSession[];
    inits: SessionInit[];
    outcomes: SessionOutcome[];
    final: SessionOutcome;
}

/** A deep copy of a message through the wire codec. */
export const copyMessage = <T extends ReadinessMessage>(message: T): T =>
    decodeReadinessMessage(encodeReadinessMessage(message)) as T;

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

export class JoinerWorld {
    readonly timers = new FakeTimers();
    readonly blocks = new Map<string, Entry>();
    readonly cellKey = cellKey("readiness-joiner-harness");
    readonly hooks: NetworkHooks = {};
    /** Every message J sent (before the hooks). */
    readonly sentToR: ReadinessMessage[] = [];
    /** Every message R sent (before the hooks). */
    readonly sentToJ: ReadinessMessage[] = [];
    readonly notices: StateNoticeV1[] = [];
    onNotice?: (notice: StateNoticeV1) => void;
    /** Live sessions R's answers are routed to. */
    readonly sessions = new Set<JoinerSession>();
    readonly syncDelivering = new Set<ScopeId>();
    /** Heads the fake join never serves. */
    readonly unserved = new Set<string>();
    /** Heads whose index write the fake join holds on J. */
    readonly holdIndex = new Set<string>();
    /** canPerform: heads the join rejects, and why. */
    readonly rejected = new Map<string, Rejection>();
    readonly joins: Array<{ heads: string[]; timeout: number }> = [];
    /** Runs as a join starts, before it copies anything (a write mid-pull). */
    onJoin?: (scope: ScopeId, heads: readonly string[]) => void;
    /** A join waits for this before it copies anything (a slow donor). */
    joinGate?: Promise<void>;
    /** J's pull queue per scope (the real one, on the fake join). */
    readonly pulls = new Map<ScopeId, PullQueue>();
    /** J's explainer per scope (the real one, on J's fake log and index). */
    readonly explainers = new Map<ScopeId, Explainer>();
    /** Messages and bytes that crossed the wire, by message class. */
    readonly wire = {
        toR: new Map<string, number>(),
        toJ: new Map<string, number>(),
        bytes: 0,
    };
    provenance: ProvenanceState = {
        writeReady: true,
        source: "creator",
        fullReplica: true,
        phase: "off",
    };
    readonly openNonce = bytesOf("r-open-nonce").slice(0, 16);
    responder!: Responder;
    r!: FakePeer;
    j!: FakePeer;
    host!: AnchorHost;
    private labels = 0;

    /** Every world created (a test file checks each one after its test). */
    static readonly created: JoinerWorld[] = [];

    private constructor(readonly scopeIds: ScopeId[]) {}

    static async create(
        options: { scopes?: ScopeId[]; mode?: AnchorHostMode } = {}
    ): Promise<JoinerWorld> {
        const world = new JoinerWorld(options.scopes ?? [SCOPE_NAMESPACE_V1]);
        JoinerWorld.created.push(world);
        world.host = await AnchorHost.create({
            mode: options.mode ?? "inline",
        });
        const [rKey, jKey] = await Promise.all([
            Ed25519Keypair.create(),
            Ed25519Keypair.create(),
        ]);
        world.r = new FakePeer("R", rKey.publicKey);
        world.j = new FakePeer("J", jKey.publicKey);
        for (const id of world.scopeIds) {
            const logId = bytesOf(`log-${id}`);
            for (const peer of [world.r, world.j]) {
                peer.scopes.set(
                    id,
                    new FakeScope(world, id, logId, world.host)
                );
            }
            const j = world.j.scope(id);
            world.pulls.set(
                id,
                new PullQueue(
                    {
                        ...world.joinPorts(id),
                        // Commit 2's binding: a second sink on the tap.
                        subscribe: (listener) =>
                            j.tap.addSink({ apply: () => listener() }),
                    },
                    new RejectionRecord()
                )
            );
            world.explainers.set(id, new Explainer(j.explainPorts()));
        }
        world.responder = new Responder(
            {
                openNonce: world.openNonce,
                scope: (id) => {
                    const scope = world.r.scopes.get(id);
                    return (
                        scope && {
                            descriptor: scope.descriptor,
                            tap: scope.tap,
                            laneSet: scope.laneSet,
                            logId: scope.logId,
                            started: Promise.resolve(),
                        }
                    );
                },
                answering: () => true,
            },
            {
                send: async (message) => world.toJ(message),
                provenance: () => ({ ...world.provenance }),
                timers: world.timers,
            }
        );
        return world;
    }

    /** Seeds every scope's tap on both peers. */
    async start() {
        for (const peer of [this.r, this.j]) {
            for (const scope of peer.scopes.values()) await scope.start();
        }
    }

    // ---------------------------------------------------------------- rows

    /** A new row entry in the block store. */
    row(
        id: string,
        modified: bigint,
        scope: ScopeId = SCOPE_NAMESPACE_V1,
        next: string[] = []
    ): Entry {
        const entry: Entry = {
            head: headOf(`row:${scope}:${id}:${modified}:${this.labels++}`),
            scope,
            kind: "row",
            id,
            modified,
            next,
        };
        this.blocks.set(entry.head, entry);
        return entry;
    }

    /** A CUT of `head` (the id's row) in the block store. */
    cut(target: Entry, modified: bigint): Entry {
        const entry: Entry = {
            head: headOf(`cut:${target.head}:${this.labels++}`),
            scope: target.scope,
            kind: "cut",
            id: target.id,
            modified,
            next: [target.head],
        };
        this.blocks.set(entry.head, entry);
        return entry;
    }

    /** A non-row entry of the scope's log (a FileChunk put, or garbled). */
    other(kind: "chunk" | "garbled", scope: ScopeId = SCOPE_NAMESPACE_V1) {
        const entry: Entry = {
            head: headOf(`${kind}:${this.labels++}`),
            scope,
            kind,
            modified: 1n,
            next: [],
        };
        this.blocks.set(entry.head, entry);
        return entry;
    }

    /** `n` rows on every given peer (ids `${prefix}${i}`). */
    rows(
        peers: FakePeer[],
        n: number,
        options: {
            prefix?: string;
            modified?: (i: number) => bigint;
            scope?: ScopeId;
        } = {}
    ): Entry[] {
        const out: Entry[] = [];
        for (let i = 0; i < n; i++) {
            const entry = this.row(
                `${options.prefix ?? "n"}${i}`,
                options.modified?.(i) ?? BigInt(1000 + i),
                options.scope
            );
            for (const peer of peers) peer.scope(entry.scope).receive(entry);
            out.push(entry);
        }
        return out;
    }

    /**
     * Writes R's index directly, as a lying or corrupt responder's state:
     * R's tap gets a row `id` whose head is `entry`'s. R's log holds the
     * entry unless `logged` is false (a row nobody can serve).
     */
    plantInR(
        entry: Entry,
        id: string,
        modified = 1n,
        options: { logged?: boolean } = {}
    ) {
        const scope = this.r.scope(entry.scope);
        if (options.logged !== false) scope.log.add(entry.head);
        scope.index.set(id, { head: entry.head, modified });
        scope.tap.onChange({
            detail: {
                added: [
                    eventValue(
                        { ...entry, id, kind: "row" },
                        entry.head,
                        modified
                    ),
                ],
                removed: [],
            },
        });
    }

    // ---------------------------------------------------------------- join

    /** The fake join of one scope, without the index subscription. */
    joinPorts(scope: ScopeId): PullPorts {
        return {
            join: (heads, options) => this.join(scope, heads, options),
        };
    }

    /**
     * The fake `SharedLog.join` on J: each head R's log holds (the donor
     * side) is copied into J's log, unless `unserved` withholds it; the
     * canPerform hook may reject it (recorded while the queue tracks the
     * head); rows are indexed under newest-wins and dispatched (or held).
     * Like the real join it reports nothing per head.
     */
    private async join(
        scope: ScopeId,
        heads: string[],
        options: { timeout: number }
    ) {
        this.joins.push({ heads: [...heads], timeout: options.timeout });
        await Promise.resolve();
        if (this.joinGate) await this.joinGate;
        this.onJoin?.(scope, heads);
        const donor = this.r.scope(scope);
        const target = this.j.scope(scope);
        for (const head of heads) {
            const entry = this.blocks.get(head);
            if (!entry || !donor.log.has(head) || this.unserved.has(head)) {
                continue;
            }
            const rejection = this.rejected.get(head);
            if (rejection) {
                this.pulls.get(scope)!.rejections.note(head, rejection);
                continue;
            }
            target.receive(entry, { holdIndex: this.holdIndex.has(head) });
        }
    }

    // ---------------------------------------------------------------- network

    private deliver(delay: number, fn: () => void) {
        if (delay > 0) this.timers.set(fn, delay);
        else queueMicrotask(fn);
    }

    /**
     * One message over the wire: encoded, decoded on the other side, and
     * the decoded copy encoded again, which must give the same bytes (every
     * layout is exercised both ways). Returns the copy and its size.
     */
    private transmit(message: ReadinessMessage, to: "toR" | "toJ") {
        const bytes = encodeReadinessMessage(message);
        const copy = decodeReadinessMessage(bytes);
        if (!sameBytes(encodeReadinessMessage(copy), bytes)) {
            this.failures.push(
                `${message.constructor.name} does not round-trip its layout`
            );
        }
        const tally = this.wire[to];
        const name = copy.constructor.name;
        tally.set(name, (tally.get(name) ?? 0) + 1);
        this.wire.bytes += bytes.length;
        return { copy, bytes: bytes.length };
    }

    /** J's send port. */
    toR(message: ReadinessMessage) {
        this.sentToR.push(message);
        const hooked = this.hooks.toR ? this.hooks.toR(message) : message;
        if (hooked === null) return;
        const { copy } = this.transmit(hooked ?? message, "toR");
        this.deliver(this.hooks.delayToR?.(copy) ?? 0, () =>
            this.responder.onMessage(copy, this.j.key)
        );
    }

    /** R's send port: to every live session of J, with the signer and size. */
    toJ(message: ReadinessMessage) {
        this.sentToJ.push(message);
        const hooked = this.hooks.toJ
            ? this.hooks.toJ(copyMessage(message))
            : message;
        if (hooked === null) return;
        const list = Array.isArray(hooked) ? hooked : [hooked ?? message];
        for (const item of list) {
            const { copy, bytes } = this.transmit(item, "toJ");
            this.deliver(this.hooks.delayToJ?.(copy) ?? 0, () => {
                if (copy instanceof StateNoticeV1) {
                    this.notices.push(copy);
                    this.onNotice?.(copy);
                }
                for (const session of [...this.sessions]) {
                    session.onMessage(copy, this.r.hash, bytes);
                }
            });
        }
    }

    /** Messages J sent of one type. */
    sent<T extends ReadinessMessage>(
        type: abstract new (...args: any[]) => T,
        from = 0
    ): T[] {
        return this.sentToR
            .slice(from)
            .filter((message): message is T => message instanceof type);
    }

    // ---------------------------------------------------------------- sessions

    scopePorts(id: ScopeId): SessionScopePorts | undefined {
        const scope = this.j.scopes.get(id);
        if (!scope) return undefined;
        return {
            id,
            logId: scope.logId,
            local: scope.local(),
            pulls: this.pulls.get(id)!,
            explain: this.explainers.get(id)!,
        };
    }

    ports(
        events: SessionEvents,
        overrides: Partial<SessionPorts> = {}
    ): SessionPorts {
        return {
            send: (message) => this.toR(message),
            timers: this.timers,
            now: () => this.timers.now,
            syncDelivering: (scope) => this.syncDelivering.has(scope),
            scope: (id) => this.scopePorts(id),
            events,
            ...overrides,
        };
    }

    /** A routed session; its outcome is checked by the oracle. */
    session(
        init: SessionInit,
        options: {
            events?: Partial<SessionEvents>;
            ports?: Partial<SessionPorts>;
        } = {}
    ): JoinerSession {
        const session = new JoinerSession(
            init,
            this.ports(
                {
                    onOutcome: (done, outcome) => {
                        this.sessions.delete(done);
                        // The session swallows a listener's error, so the
                        // checks record theirs (`failures`, `assertClean`).
                        try {
                            this.checkOutcome(outcome);
                        } catch (error: any) {
                            this.failures.push(error?.message ?? String(error));
                        }
                        if (done.debug().armedTimers !== 0) {
                            this.failures.push(
                                `${outcome.kind} with timers armed`
                            );
                        }
                        options.events?.onOutcome?.(done, outcome);
                    },
                    onState: options.events?.onState,
                },
                options.ports
            )
        );
        this.sessions.add(session);
        return session;
    }

    init(
        options: {
            scopes?: ScopeId[];
            hlcProved?: bigint;
            list?: boolean;
        } = {}
    ): SessionInit {
        const init = newSessionInit(
            this.r.hash,
            options.scopes ?? this.scopeIds,
            options.hlcProved ?? 0n
        );
        if (options.list) {
            init.list = true;
            init.ladder = { ...init.ladder, stage: "list" };
        }
        return init;
    }

    /** Runs queued work until `done()` holds (no fake time passes). */
    async until(done: () => boolean, what = "condition", rounds = 100_000) {
        for (let i = 0; i < rounds; i++) {
            if (done()) return;
            await new Promise((resolve) => setImmediate(resolve));
        }
        throw new Error(
            `${what} not reached; sessions: ${JSON.stringify(
                [...this.sessions].map((session) => session.debug())
            )}`
        );
    }

    /**
     * The coordinator's stand-in: runs sessions through the recovery ladder
     * until an outcome is not a renewal.
     */
    async drive(
        options: {
            init?: SessionInit;
            hlcProved?: bigint;
            list?: boolean;
            maxSessions?: number;
            onSession?: (session: JoinerSession) => void | Promise<void>;
            /** Every session's state changes. */
            onState?: SessionEvents["onState"];
        } = {}
    ): Promise<DriveResult> {
        let init =
            options.init ??
            this.init({ hlcProved: options.hlcProved, list: options.list });
        const result: DriveResult = {
            sessions: [],
            inits: [],
            outcomes: [],
            final: { kind: "closed" },
        };
        for (let i = 0; i < (options.maxSessions ?? 8); i++) {
            const session = this.session(init, {
                events: { onState: options.onState },
            });
            result.sessions.push(session);
            result.inits.push(init);
            session.start();
            await options.onSession?.(session);
            await this.until(
                () => session.outcome !== undefined,
                `outcome of session ${i + 1}`
            );
            this.assertClean();
            const outcome = session.outcome!;
            result.outcomes.push(outcome);
            result.final = outcome;
            const next = nextSessionInit(init, outcome);
            if (!next) return result;
            init = next;
        }
        return result;
    }

    // ---------------------------------------------------------------- oracle

    /** Every contained result must hold against the fake stores. */
    checkOutcome(outcome: SessionOutcome) {
        if (outcome.kind === "contained" || outcome.kind === "renew") {
            for (const result of outcome.results) this.oracle(result);
        }
    }

    /**
     * S_R is a subset of J's index plus E at the certificate's seq, and E
     * holds nothing J indexed then. Read from the fake stores, independent
     * of cells and anchors.
     */
    oracle(result: SessionResult) {
        const r = this.r.scope(result.scope);
        const j = this.j.scope(result.scope);
        const snapshot = r.snapshots.get(hex(result.anchor));
        if (!snapshot) {
            throw new Error(
                `oracle: no snapshot of R has anchor ${hex(result.anchor)}`
            );
        }
        if (result.mode === "empty") {
            if (snapshot.size !== 0) throw new Error("oracle: R was not empty");
            return;
        }
        const certificate = [...j.certificates]
            .reverse()
            .find(({ seq }) => seq === result.seq);
        if (!certificate) {
            throw new Error(`oracle: no certificate at seq ${result.seq}`);
        }
        for (const digest of snapshot) {
            if (
                !certificate.index.has(digest) &&
                !certificate.add.has(digest)
            ) {
                throw new Error(
                    `oracle: R's ${digestToHead(Buffer.from(digest, "hex"))} is neither indexed nor explained`
                );
            }
        }
        for (const digest of certificate.add) {
            if (certificate.index.has(digest)) {
                throw new Error("oracle: E holds a row J indexed");
            }
        }
        this.contained.push(result);
    }

    /** Results the oracle accepted. */
    readonly contained: SessionResult[] = [];
    /**
     * Oracle and idle-timer failures of finished sessions, and messages
     * whose layout did not round-trip.
     */
    readonly failures: string[] = [];

    /**
     * Closes every live session, the responder, J's pull queues and every
     * lane set (a worker host stops with its last set).
     */
    dispose() {
        for (const session of [...this.sessions]) session.close();
        this.responder.dispose();
        for (const queue of this.pulls.values()) queue.dispose();
        for (const peer of [this.r, this.j]) {
            for (const scope of peer.scopes.values()) scope.laneSet.close();
        }
    }

    /** Throws if any finished session failed the oracle or kept a timer. */
    assertClean() {
        if (this.failures.length > 0) {
            throw new Error(
                `harness checks failed: ${this.failures.join("; ")}`
            );
        }
    }

    // ---------------------------------------------------------------- faults

    /**
     * R's cells with a fault: `plant` adds an element only the cells hold
     * (sign -1 reads as J\R: a false decode), `hide` removes one of R's rows
     * from them (a lying cell), `as` replaces them by another peer's cells
     * (a forced collision: the peel finds no difference).
     */
    async faultyCells(
        fault:
            | { plant: Uint8Array; sign: 1 | -1 }
            | { hide: Entry }
            | { as: FakeScope },
        scope: ScopeId = SCOPE_NAMESPACE_V1
    ): Promise<Uint8Array> {
        if ("as" in fault) return fault.as.cellsBytes();
        const bytes = await this.r.scope(scope).cellsBytes();
        const cells = new Cells(M, this.cellKey[0], this.cellKey[1]);
        cells.restore(bytes);
        if ("plant" in fault) cells.apply(fault.plant, fault.sign);
        else cells.apply(headDigest(fault.hide.head), -1);
        return cells.toBytes();
    }

    /** A `toJ` hook that serves `bytes` in place of R's cells. */
    static cellsHook(bytes: Uint8Array) {
        return (message: ReadinessMessage) => {
            if (message instanceof CellsV1) {
                message.cells = bytes.slice(
                    message.from * CELL_BYTES,
                    message.from * CELL_BYTES + message.cells.length
                );
            } else if (message instanceof HeaderV1 && message.cells.length) {
                message.cells = bytes.slice(0, message.cells.length);
            }
            return message;
        };
    }
}

/** n x 32 B of digests (list pages in tests). */
export const packDigests = (digests: Uint8Array[]) => {
    const out = new Uint8Array(digests.length * DIGEST_BYTES);
    digests.forEach((digest, i) => out.set(digest, i * DIGEST_BYTES));
    return out;
};
