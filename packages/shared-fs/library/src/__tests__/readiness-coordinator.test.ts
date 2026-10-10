import { fileURLToPath } from "node:url";
import { Ed25519Keypair, type PublicSignKey } from "@peerbit/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedFileSystem } from "../index.js";
import { AnchorHost } from "../readiness/anchor-host.js";
import { cellKey } from "../readiness/cells.js";
import { PULL_TIMEOUT_MS } from "../readiness/constants.js";
import {
    BLOCKING_STATES,
    Coordinator,
    SESSIONS_IN_FLIGHT,
    describeReadiness,
    type CoordinatorPorts,
    type CoordinatorTransport,
    type Evaluation,
    type PeerRecord,
    type ReadinessStatus,
    type StatusContext,
    type TransportEvent,
} from "../readiness/coordinator.js";
import {
    Explainer,
    RejectionRecord,
    type Rejection,
} from "../readiness/explain.js";
import {
    PROOF_MAX_RECORDS,
    hlcProvedOf,
    type Proof,
} from "../readiness/proof.js";
import { PullQueue } from "../readiness/pull-queue.js";
import { Responder, type ProvenanceState } from "../readiness/responder.js";
import {
    ReadinessRuntime,
    type JoinOptions,
    type ReadinessSessionRecord,
} from "../readiness/runtime.js";
import {
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    type ScopeId,
} from "../readiness/scopes.js";
import {
    JoinerSession,
    MAX_RENEWALS,
    type SessionInit,
    type SessionOutcome,
    type SessionPorts,
    type SessionResult,
    type SessionScopePorts,
    type SessionState,
} from "../readiness/session.js";
import {
    CloseV1,
    ERROR_CODE,
    ErrorV1,
    HeaderV1,
    NOTICE_REASON,
    OpenScopeV1,
    OpenV1,
    ProvenanceV1,
    StateNoticeV1,
    decodeReadinessMessage,
    encodeReadinessMessage,
    type ErrorCode,
    type ReadinessMessage,
} from "../readiness/wire.js";
import {
    FakePeer,
    FakeScope,
    FakeTimers,
    FakeTrust,
    bytesOf,
    checkExplainedAtContainment,
    copyMessage,
    headOf,
    hex,
    settle,
    type Entry,
} from "./readiness-joiner-harness.js";

/**
 * The joiner's coordinator (PR-3 commit 2, SPEC2 section 7.1), in memory:
 * J's real coordinator and real sessions against N peers, each with PR-2's
 * real responder on a real tap and lane set (the harness's `FakeScope` on a
 * fake index), every message through the wire codec, J's real pull queue on
 * a fake join that copies entries from any peer that is up and holds them
 * in its log, J's real explainer, a fake transport (subscribers,
 * replicators, a reachability table and its events), and a fake clock that
 * fires one timer at a time and lets its effects settle before the next.
 *
 * Every contained session is checked by an oracle against the fake stores
 * (R's snapshot within J's index plus E at the certificate's sequence
 * point), and every finished session must hold no armed timer.
 *
 * An access-controlled world (PR-3 commit 3, SPEC3 9.5) adds the trust scope
 * to J and every peer, a `canPerform` hook on J's join, and J's trust graph
 * as a `FakeTrust`.
 *
 * PR-3 commit 4 (SPEC4 9.3) adds the host's phase clause and the decision
 * loop (M8, M9), and the host's half of the decision in index.ts ("host
 * decision", the cases of the deleted write-readiness-scheduler test).
 */

const NS = SCOPE_NAMESPACE_V1;
const TRUST = SCOPE_TRUST_V1;

const CREATOR: ProvenanceState = {
    writeReady: true,
    source: "creator",
    fullReplica: true,
    phase: "off",
};
const WARM: ProvenanceState = { ...CREATOR, source: "warm" };
const RECONCILED: ProvenanceState = { ...CREATOR, source: "reconciled" };
const GATED: ProvenanceState = {
    writeReady: false,
    source: "none",
    fullReplica: true,
    phase: "off",
};
const PARTIAL: ProvenanceState = { ...CREATOR, fullReplica: false };

const WAITING: StatusContext = { writeReady: false, phaseSettled: true };

const HOUR = 3_600_000;

/** The network as J's coordinator sees it. */
class FakeTransport implements CoordinatorTransport {
    self = "";
    /** Unlisted peers are reachable. */
    readonly reachable = new Map<string, boolean>();
    readonly subscribed = new Map<string, PublicSignKey>();
    readonly replicating = new Set<string>();
    readonly listeners = new Set<(event: TransportEvent) => void>();
    /** Discovery reads that fail before one succeeds (a cold index). */
    failDiscovery = 0;
    disposed = 0;
    readonly reads = { subscribers: 0, replicators: 0 };

    isReachable(peer: string) {
        return this.reachable.get(peer) ?? true;
    }

    async subscribers() {
        this.reads.subscribers++;
        await Promise.resolve();
        if (this.failDiscovery > 0) {
            this.failDiscovery--;
            throw new Error("subscribers unavailable");
        }
        return [...this.subscribed].map(([hash, key]) => ({ hash, key }));
    }

    async replicators() {
        this.reads.replicators++;
        await Promise.resolve();
        return [...this.replicating];
    }

    listen(listener: (event: TransportEvent) => void) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    dispose() {
        this.disposed++;
        this.listeners.clear();
    }

    emit(event: TransportEvent) {
        for (const listener of [...this.listeners]) listener(event);
    }
}

interface PeerHooks {
    /** J to this peer: null drops, or a replacement. */
    toPeer?: (message: ReadinessMessage) => ReadinessMessage | null | undefined;
    /** This peer to J: null drops, or a replacement. */
    toJ?: (message: ReadinessMessage) => ReadinessMessage | null | undefined;
    /** Fake-clock delay of a message to J (0: next microtask). */
    delayToJ?: (message: ReadinessMessage) => number;
}

/** A remote peer: its stores, its real responder, its network behaviour. */
class Peer extends FakePeer {
    responder!: Responder;
    hooks: PeerHooks = {};
    /** Down: it answers and sends nothing, and serves no block. */
    up = true;
    /** OPENs answered with `code` instead of the responder, `times` times. */
    refuse?: { code: ErrorCode; times: number };
    readonly openNonce: Uint8Array;

    constructor(
        name: string,
        key: PublicSignKey,
        public provenance: ProvenanceState
    ) {
        super(name, key);
        this.openNonce = bytesOf(`open-nonce-${name}`).slice(0, 16);
    }
}

interface PeerOptions {
    provenance?: ProvenanceState;
    /** Subscribed to the readiness topic (default true). */
    subscriber?: boolean;
    /** Listed by `replicators()` (default false). */
    replicator?: boolean;
    reachable?: boolean;
}

/** J or a remote peer: whoever holds a store rows are written to. */
type Holder = FakePeer;

class World {
    static readonly created: World[] = [];
    /** The scopes of J and every peer: the trust scope in an ACL world. */
    scopeIds: ScopeId[] = [NS];
    /** J's trust graph (an ACL world); the coordinator's `trust` port. */
    trust?: FakeTrust;
    /** canPerform on J's join: heads it refuses, and why. */
    readonly rejected = new Map<string, Rejection>();
    /** A join of one scope waits for this too (or its timeout). */
    readonly scopeGates = new Map<ScopeId, Promise<void>>();
    readonly clock = new FakeTimers();
    readonly blocks = new Map<string, Entry>();
    readonly cellKey = cellKey("readiness-coordinator-test");
    readonly transport = new FakeTransport();
    readonly peers: Peer[] = [];
    readonly pulls = new Map<ScopeId, PullQueue>();
    readonly explainers = new Map<ScopeId, Explainer>();
    /** Heads the fake join never serves. */
    readonly unserved = new Set<string>();
    /** The fake join waits for this (or its timeout) before it copies. */
    joinGate?: Promise<void>;
    readonly joins: string[][] = [];
    readonly sessions: JoinerSession[] = [];
    readonly evaluations: Evaluation[] = [];
    readonly containedCalls: Array<{ peer: string; results: SessionResult[] }> =
        [];
    readonly failures: string[] = [];
    /** Peers with a contained scope the oracle checked. */
    readonly checked = new Set<string>();
    /** Every message J sent, before the hooks. */
    readonly sent: Array<{ to: string; message: ReadinessMessage }> = [];
    readonly syncDelivering = new Set<ScopeId>();
    host!: AnchorHost;
    j!: FakePeer;
    coordinator?: Coordinator;
    /** `ports.started()`. */
    started: Promise<void> = Promise.resolve();
    private labels = 0;

    static async create(options: { trust?: boolean } = {}): Promise<World> {
        const world = new World();
        World.created.push(world);
        if (options.trust) {
            world.scopeIds = [NS, TRUST];
            world.trust = new FakeTrust();
        }
        world.host = await AnchorHost.create({ mode: "inline" });
        world.j = new FakePeer("J", (await Ed25519Keypair.create()).publicKey);
        world.transport.self = world.j.hash;
        for (const id of world.scopeIds) {
            const scope = world.addScope(world.j, id);
            world.pulls.set(
                id,
                new PullQueue(
                    {
                        join: (heads, options) =>
                            world.join(id, heads, options),
                        subscribe: (listener) =>
                            scope.tap.addSink({ apply: () => listener() }),
                    },
                    new RejectionRecord()
                )
            );
            world.explainers.set(id, new Explainer(scope.explainPorts()));
        }
        return world;
    }

    private addScope(peer: FakePeer, id: ScopeId = NS): FakeScope {
        const scope = new FakeScope(this, id, bytesOf(`log-${id}`), this.host);
        peer.scopes.set(id, scope);
        return scope;
    }

    async peer(name: string, options: PeerOptions = {}): Promise<Peer> {
        const key = (await Ed25519Keypair.create()).publicKey;
        const peer = new Peer(name, key, options.provenance ?? CREATOR);
        for (const id of this.scopeIds) this.addScope(peer, id);
        peer.responder = new Responder(
            {
                openNonce: peer.openNonce,
                scope: (id) => {
                    const scope = peer.scopes.get(id);
                    return scope
                        ? {
                              descriptor: scope.descriptor,
                              tap: scope.tap,
                              laneSet: scope.laneSet,
                              logId: scope.logId,
                              started: Promise.resolve(),
                          }
                        : undefined;
                },
                answering: () => peer.up,
            },
            {
                send: async (message) => this.fromPeer(peer, message),
                provenance: () => ({ ...peer.provenance }),
                timers: this.clock,
            }
        );
        if (options.subscriber ?? true)
            this.transport.subscribed.set(peer.hash, key);
        if (options.replicator) this.transport.replicating.add(peer.hash);
        if (options.reachable === false)
            this.transport.reachable.set(peer.hash, false);
        this.peers.push(peer);
        return peer;
    }

    // ---------------------------------------------------------------- rows

    row(id: string, modified: bigint, scope: ScopeId = NS): Entry {
        const entry: Entry = {
            head: headOf(
                `row:${scope === NS ? "" : `${scope}:`}${id}:${modified}:${this.labels++}`
            ),
            scope,
            kind: "row",
            id,
            modified,
            next: [],
        };
        this.blocks.set(entry.head, entry);
        return entry;
    }

    /** `n` rows of `scope` on every holder (ids `${prefix}${i}`). */
    rows(
        holders: Holder[],
        n: number,
        prefix: string,
        base = 1000,
        scope: ScopeId = NS
    ): Entry[] {
        const out: Entry[] = [];
        for (let i = 0; i < n; i++) {
            const entry = this.row(`${prefix}${i}`, BigInt(base + i), scope);
            for (const holder of holders) holder.scope(scope).receive(entry);
            out.push(entry);
        }
        return out;
    }

    /** Seeds every tap and verifies its count. */
    async start() {
        for (const holder of [this.j, ...this.peers]) {
            for (const scope of holder.scopes.values()) await scope.start();
        }
    }

    // ---------------------------------------------------------------- join

    /**
     * The fake `SharedLog.join` on J: each head some peer that is up holds
     * in its log is copied into J's log and indexed, unless `unserved`
     * withholds it. A `joinGate` holds the copy; the join then rejects at
     * its timeout, as `SharedLog.join` does.
     */
    private async join(
        scope: ScopeId,
        heads: string[],
        options: { timeout: number }
    ) {
        this.joins.push([...heads]);
        await Promise.resolve();
        const gate = this.scopeGates.get(scope) ?? this.joinGate;
        if (gate) {
            let handle: unknown;
            const timedOut = new Promise<void>((_, reject) => {
                handle = this.clock.set(
                    () => reject(new Error("join timed out")),
                    options.timeout
                );
            });
            try {
                await Promise.race([gate, timedOut]);
            } finally {
                this.clock.clear(handle);
            }
        }
        const target = this.j.scope(scope);
        for (const head of heads) {
            const entry = this.blocks.get(head);
            if (!entry || this.unserved.has(head)) continue;
            if (
                !this.peers.some(
                    (peer) => peer.up && peer.scopes.get(scope)?.log.has(head)
                )
            ) {
                continue;
            }
            const rejection = this.rejected.get(head);
            if (rejection) {
                this.pulls.get(scope)!.rejections.note(head, rejection);
                continue;
            }
            target.receive(entry);
        }
    }

    // ---------------------------------------------------------------- network

    peerOf(hash: string) {
        return this.peers.find((peer) => peer.hash === hash);
    }

    /** J's send port. */
    toPeer(to: string, message: ReadinessMessage) {
        this.sent.push({ to, message });
        const peer = this.peerOf(to);
        if (!peer || !peer.up) return;
        let out: ReadinessMessage = message;
        if (peer.hooks.toPeer) {
            const hooked = peer.hooks.toPeer(message);
            if (hooked === null) return;
            out = hooked ?? message;
        }
        const copy = decodeReadinessMessage(encodeReadinessMessage(out));
        if (copy instanceof OpenV1 && peer.refuse && peer.refuse.times > 0) {
            peer.refuse.times--;
            return this.fromPeer(
                peer,
                new ErrorV1({
                    sessionId: copy.sessionId,
                    code: peer.refuse.code,
                })
            );
        }
        queueMicrotask(() => {
            if (peer.up) peer.responder.onMessage(copy, this.j.key);
        });
    }

    /** A peer's send port: to J's coordinator, with the signer and size. */
    fromPeer(peer: Peer, message: ReadinessMessage) {
        if (!peer.up) return;
        let out: ReadinessMessage = message;
        if (peer.hooks.toJ) {
            const hooked = peer.hooks.toJ(copyMessage(message));
            if (hooked === null) return;
            out = hooked ?? message;
        }
        const bytes = encodeReadinessMessage(out);
        const copy = decodeReadinessMessage(bytes);
        const deliver = () =>
            this.coordinator?.onMessage(
                copy,
                peer.hash,
                bytes.length,
                peer.key
            );
        const delay = peer.hooks.delayToJ?.(copy) ?? 0;
        if (delay > 0) this.clock.set(deliver, delay);
        else queueMicrotask(deliver);
    }

    /** Messages J sent to `peer` of one type. */
    sentTo<T extends ReadinessMessage>(
        peer: FakePeer,
        type: abstract new (...args: any[]) => T
    ): T[] {
        return this.sent
            .filter(
                ({ to, message }) => to === peer.hash && message instanceof type
            )
            .map(({ message }) => message as T);
    }

    /** A notice from `peer` with its provenance now. */
    notice(
        peer: Peer,
        options: { openNonce?: Uint8Array; provenance?: ProvenanceState } = {}
    ) {
        return new StateNoticeV1({
            provenance: new ProvenanceV1({
                ...(options.provenance ?? peer.provenance),
                openNonce: options.openNonce ?? peer.openNonce,
            }),
            reason: NOTICE_REASON.READY,
        });
    }

    /** A request from `peer` to J (R joining J): a message, a sign of life. */
    request(peer: Peer) {
        return new OpenV1({
            sessionId: bytesOf(`request-${this.labels++}`).slice(0, 16),
            attempt: 1,
            hlcProved: 0n,
            scopes: [
                new OpenScopeV1({
                    scope: NS,
                    logId: peer.scope(NS).logId,
                    count: 0,
                    above: 0,
                }),
            ],
        });
    }

    // ---------------------------------------------------------------- J

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

    /** Creates and starts J's coordinator. */
    run(overrides: Partial<CoordinatorPorts> = {}): Coordinator {
        const coordinator = new Coordinator({
            transport: this.transport,
            send: (message, to) => this.toPeer(to, message),
            scopes: this.scopeIds,
            ...(this.trust ? { trust: this.trust } : {}),
            scope: (id) => this.scopePorts(id),
            started: () => this.started,
            hlcProved: 0n,
            syncDelivering: (scope) => this.syncDelivering.has(scope),
            timers: this.clock,
            now: () => this.clock.now,
            onEvaluate: (evaluation) => this.evaluations.push(evaluation),
            onContained: (peer, results) =>
                this.containedCalls.push({ peer, results: [...results] }),
            createSession: (init, ports) => this.session(init, ports),
            ...overrides,
        });
        this.coordinator = coordinator;
        coordinator.start();
        return coordinator;
    }

    /** A session whose outcomes the oracle checks (the default `createSession`). */
    session(init: SessionInit, ports: SessionPorts): JoinerSession {
        const session = new JoinerSession(init, {
            ...ports,
            events: {
                ...ports.events,
                onOutcome: (done, outcome) => {
                    this.check(done, outcome);
                    ports.events.onOutcome(done, outcome);
                },
            },
        });
        this.sessions.push(session);
        return session;
    }

    record(peer: FakePeer): PeerRecord {
        const record = this.coordinator!.record(peer.hash);
        if (!record) throw new Error(`no record of ${peer.name}`);
        return record;
    }

    stateOf(peer: FakePeer) {
        return this.coordinator!.record(peer.hash)?.state;
    }

    status(context: StatusContext = WAITING): ReadinessStatus {
        return this.coordinator!.status(context);
    }

    sessionsOf(peer: FakePeer) {
        return this.sessions.filter((session) => session.peer === peer.hash);
    }

    /** J's index heads by id. */
    jIndex() {
        return new Map(
            [...this.j.scope(NS).index].map(([id, row]) => [id, row.head])
        );
    }

    /**
     * Runs queued work until `done()` holds (no fake time passes); a
     * condition that throws (a record not created yet) does not hold.
     */
    async until(done: () => boolean, what = "condition", rounds = 20_000) {
        const holds = () => {
            try {
                return done();
            } catch {
                return false;
            }
        };
        for (let i = 0; i < rounds; i++) {
            if (holds()) return;
            await new Promise((resolve) => setImmediate(resolve));
        }
        throw new Error(
            `${what} not reached; records: ${JSON.stringify(
                this.coordinator?.records().map((record) => ({
                    peer: this.peerOf(record.hash)?.name,
                    state: record.state,
                    session: record.session?.debug(),
                })),
                (_, value) => (typeof value === "bigint" ? `${value}` : value)
            )}`
        );
    }

    // ---------------------------------------------------------------- oracle

    /** Every finished session: no armed timer; every contained scope true. */
    private check(session: JoinerSession, outcome: SessionOutcome) {
        try {
            if (session.debug().armedTimers !== 0) {
                this.failures.push(`${outcome.kind} with timers armed`);
            }
            if (outcome.kind === "contained" || outcome.kind === "renew") {
                for (const result of outcome.results) {
                    this.oracle(result);
                    this.checked.add(result.peer);
                }
            }
        } catch (error: any) {
            this.failures.push(error?.message ?? String(error));
        }
    }

    /**
     * S_R is a subset of J's index plus E at the certificate's seq, E
     * holds nothing J indexed then, and E at containment still explains
     * every row of it J does not index (read from the fake stores).
     */
    private oracle(result: SessionResult) {
        const peer = this.peerOf(result.peer);
        if (!peer) throw new Error(`oracle: unknown peer ${result.peer}`);
        const r = peer.scope(result.scope);
        const j = this.j.scope(result.scope);
        const snapshot = r.snapshots.get(hex(result.anchor));
        if (!snapshot) {
            throw new Error(
                `oracle: ${peer.name} has no snapshot with that anchor`
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
                    `oracle: a row of ${peer.name} is neither indexed nor explained`
                );
            }
        }
        for (const digest of certificate.add) {
            if (certificate.index.has(digest)) {
                throw new Error("oracle: E holds a row J indexed");
            }
        }
        checkExplainedAtContainment(result, certificate, j);
    }

    /** A peer's session's debug of `scope` (its live session). */
    scopeDebug(peer: FakePeer, scope: ScopeId = NS) {
        return this.record(peer).session?.debug().scopes[scope];
    }

    dispose() {
        this.coordinator?.dispose();
        for (const peer of this.peers) peer.responder.dispose();
        for (const queue of this.pulls.values()) queue.dispose();
        for (const holder of [this.j, ...this.peers]) {
            for (const scope of holder.scopes.values()) scope.laneSet.close();
        }
    }
}

afterEach(() => {
    for (const w of World.created.splice(0)) {
        // Every contained record came from a session the oracle checked.
        for (const record of w.coordinator?.records() ?? []) {
            if (record.state === "contained") {
                expect(w.checked.has(record.hash)).toBe(true);
            }
        }
        w.dispose();
        expect(w.host.stats.failures).toBe(0);
        expect(w.failures).toEqual([]);
    }
});

/** A world with J and `peers`, `common` rows on everyone, seeded. */
const worldWith = async (peers: Array<[string, PeerOptions?]>, common = 12) => {
    const w = await World.create();
    const out: Peer[] = [];
    for (const [name, options] of peers) out.push(await w.peer(name, options));
    w.rows([w.j, ...out], common, "c");
    return { w, peers: out };
};

const opensTo = (w: World, peer: FakePeer) => w.sentTo(peer, OpenV1).length;

describe("readiness coordinator: Required peers (design 4.7)", () => {
    it("15: a busy creator answering after 6 s gates J although a stale warm replica answered in 20 ms", async () => {
        const { w, peers } = await worldWith([
            ["C", { provenance: CREATOR }],
            ["W", { provenance: WARM }],
        ]);
        const [c, warm] = peers;
        const newest = w.rows([c], 5, "new", 5000);
        await w.start();
        c.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 6000 : 0);
        warm.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 20 : 0);
        const coordinator = w.run();
        await settle();
        expect(w.stateOf(c)).toBe("asking");
        expect(w.stateOf(warm)).toBe("asking");

        await w.clock.advanceSettled(20);
        await w.until(() => w.stateOf(warm) === "contained", "W contained");
        const wRecord = w.record(warm);
        expect(wRecord.qualified).toBe(true);
        expect(wRecord.results.get(NS)?.source).toBe("warm");
        expect(coordinator.satisfied()).toBe(false);
        expect(w.status().required).toEqual([c.hash]);

        // Attempt 2 goes out at 5 s; C is still Required.
        await w.clock.advanceSettled(5000 - 20);
        expect(opensTo(w, c)).toBe(2);
        expect(w.stateOf(c)).toBe("asking");
        expect(coordinator.satisfied()).toBe(false);

        await w.clock.advanceSettled(1000);
        await w.until(() => w.stateOf(c) === "contained", "C contained");
        expect(w.record(c).qualified).toBe(true);
        for (const entry of newest) {
            expect(w.jIndex().get(entry.id!)).toBe(entry.head);
        }
        await w.until(() => coordinator.satisfied(), "satisfied");
        await settle();
        expect(w.evaluations.at(-1)).toEqual({
            satisfied: true,
            changed: true,
        });
        expect(w.evaluations.filter((e) => e.satisfied)).toHaveLength(1);
    });

    it("16: a creator visible only through replication.change is live and Required with full attempts", async () => {
        const { w, peers } = await worldWith([
            ["C", { provenance: CREATOR, subscriber: false }],
            ["W", { provenance: WARM }],
        ]);
        const [c, warm] = peers;
        w.rows([c], 4, "new", 5000);
        await w.start();
        c.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 6000 : 0);
        const coordinator = w.run();
        await w.until(() => w.stateOf(warm) === "contained", "W contained");
        // W alone, before C shows itself.
        await w.until(() => coordinator.satisfied(), "satisfied by W");
        expect(coordinator.record(c.hash)).toBeUndefined();

        w.transport.emit({ kind: "replicator", type: "change", peer: c.hash });
        await settle();
        const record = w.record(c);
        expect(record.confirmOnly).toBe(false);
        expect(record.live).toBe(true);
        expect([...record.via]).toEqual(["replicator"]);
        expect(record.state).toBe("asking");
        expect(coordinator.satisfied()).toBe(false);
        expect(w.status().required).toEqual([c.hash]);

        // Not confirm-only: the first attempt ends and a second goes out.
        await w.clock.advanceSettled(5000);
        expect(w.stateOf(c)).toBe("asking");
        expect(opensTo(w, c)).toBe(2);
        expect(coordinator.satisfied()).toBe(false);

        await w.clock.advanceSettled(1000);
        await w.until(() => w.stateOf(c) === "contained", "C contained");
        await w.until(() => coordinator.satisfied(), "satisfied");
    });

    it("16: a replicator that announced itself before start (J's open) is live and Required with full attempts", async () => {
        const { w, peers } = await worldWith([
            ["C", { provenance: CREATOR, subscriber: false, replicator: true }],
            ["W", { provenance: WARM }],
        ]);
        const [c, warm] = peers;
        w.rows([c], 4, "new", 5000);
        await w.start();
        // A busy creator: its first header comes after its first attempt.
        c.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 6000 : 0);
        // shared-log announced C once, while J's open ran; nothing follows.
        const coordinator = w.run({ signsOfLife: () => [c.hash] });
        await w.until(() => w.stateOf(warm) === "contained", "W contained");
        const record = w.record(c);
        expect(record).toMatchObject({
            live: true,
            confirmOnly: false,
            state: "asking",
        });
        expect([...record.via]).toEqual(["replicator"]);
        expect(w.status().required).toEqual([c.hash]);

        // Not confirm-only: the first attempt ends and a second goes out.
        await w.clock.advanceSettled(5000);
        expect(w.stateOf(c)).toBe("asking");
        expect(opensTo(w, c)).toBe(2);
        expect(coordinator.satisfied()).toBe(false);
        await w.clock.advanceSettled(1000);
        await w.until(() => w.stateOf(c) === "contained", "C contained");
        await w.until(() => coordinator.satisfied(), "satisfied");
        expect(w.evaluations.filter((e) => e.satisfied)).toHaveLength(1);
    });

    it("a sign of life from before start makes a listed peer live; an unlisted one is no record; an unreadable record fails closed", async () => {
        const { w, peers } = await worldWith([
            // Announced, then left before start: no longer listed.
            ["L", { subscriber: false }],
            // A readiness message before start; a subscriber.
            ["M"],
            // Listed with no sign of life: asked once.
            ["X", { subscriber: false, replicator: true }],
            ["D"],
        ]);
        const [l, m, x, d] = peers;
        await w.start();
        for (const peer of [l, m, x]) peer.hooks.toPeer = () => null;
        const coordinator = w.run({
            signsOfLife: () => [l.hash, m.hash, w.j.hash],
        });
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        expect(coordinator.record(w.j.hash)).toBeUndefined();
        expect(coordinator.record(l.hash)).toBeUndefined();
        expect(w.record(m)).toMatchObject({ live: true, confirmOnly: false });
        expect(w.record(x)).toMatchObject({ live: false, confirmOnly: true });
        await w.clock.advanceSettled(5000);
        expect(w.stateOf(x)).toBe("unconfirmed");
        expect(w.stateOf(m)).toBe("asking");
        expect(coordinator.satisfied()).toBe(false);

        // Not recorded (undefined, or a throw): every row counts as live.
        for (const signsOfLife of [
            () => undefined,
            () => {
                throw new Error("no recorder");
            },
        ]) {
            const other = await worldWith([
                ["X", { subscriber: false, replicator: true }],
                ["D"],
            ]);
            const [ox, od] = other.peers;
            await other.w.start();
            ox.hooks.toPeer = () => null;
            const c = other.w.run({ signsOfLife });
            await other.w.until(
                () => other.w.stateOf(od) === "contained",
                "D contained"
            );
            expect(other.w.record(ox)).toMatchObject({
                live: true,
                confirmOnly: false,
            });
            await other.w.clock.advanceSettled(5000);
            expect(other.w.stateOf(ox)).toBe("asking");
            expect(c.satisfied()).toBe(false);
        }
    });

    it("17: an answer at 40 s counts with no caller retry; nothing armed while silent", async () => {
        const { w, peers } = await worldWith([
            ["C", { provenance: CREATOR }],
            ["W", { provenance: WARM }],
        ]);
        const [c, warm] = peers;
        w.rows([c], 3, "new", 5000);
        await w.start();
        c.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 40_000 : 0);
        const coordinator = w.run();
        await w.until(() => w.stateOf(warm) === "contained", "W contained");
        const [session] = w.sessionsOf(c);
        const resume = vi.spyOn(session, "resume");

        await w.clock.advanceSettled(35_000);
        expect(w.stateOf(c)).toBe("silent");
        expect(opensTo(w, c)).toBe(3);
        expect(coordinator.debug().armedTimers).toBe(0);
        const status = w.status();
        expect(status.state).toBe("waiting-silent");
        expect(status.silent).toEqual([{ peer: c.hash, reachable: true }]);
        expect(status.required).toEqual([c.hash]);
        expect(coordinator.satisfied()).toBe(false);

        await w.clock.advanceSettled(5_000);
        await w.until(() => w.stateOf(c) === "contained", "C contained");
        expect(resume).not.toHaveBeenCalled();
        await w.until(() => coordinator.satisfied(), "satisfied");
        // The duplicates of attempts 2 and 3 arrive later and change nothing.
        await w.clock.advanceSettled(20_000);
        expect(w.stateOf(c)).toBe("contained");
        expect(coordinator.satisfied()).toBe(true);
    });

    it("18: a reachable subscriber that never answers is named reachable and silent; unreachable, it is left", async () => {
        const { w, peers } = await worldWith([["S"], ["D"]]);
        const [s, d] = peers;
        await w.start();
        s.hooks.toPeer = () => null;
        const coordinator = w.run();
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        expect(coordinator.satisfied()).toBe(false);

        await w.clock.advanceSettled(35_000);
        expect(w.stateOf(s)).toBe("silent");
        const status = w.status();
        expect(status.state).toBe("waiting-silent");
        expect(status.silent).toEqual([{ peer: s.hash, reachable: true }]);
        const line = describeReadiness(status);
        expect(line).toContain(s.hash);
        expect(line).toBe(
            `waiting-silent: 1 of 1 required peer reachable and silent: ${s.hash}`
        );
        expect(coordinator.satisfied()).toBe(false);

        w.transport.reachable.set(s.hash, false);
        w.transport.emit({
            kind: "reachability",
            source: "unreachable",
            peer: s.hash,
        });
        await settle();
        const record = w.record(s);
        expect(record.state).toBe("left");
        expect(record.gap).toEqual({ missing: "unknown" });
        expect(record.departed).toBe(true);
        expect(coordinator.satisfied()).toBe(true);
        expect(w.status().gaps).toEqual([{ peer: s.hash, missing: "unknown" }]);
        expect(coordinator.proof().gaps).toEqual([
            { peer: s.hash, missing: "unknown" },
        ]);
    });

    it("19: a session reset keeps the peer asking; left-unanswered until the attempt ends, resumed when back", async () => {
        const { w, peers } = await worldWith([["S"], ["D"]]);
        const [s, d] = peers;
        await w.start();
        s.hooks.toPeer = () => null;
        const coordinator = w.run();
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        const record = w.record(s);
        const session = record.session!;
        expect(session).toBeDefined();

        // A pubsub session reset with S still reachable: A' says it stays.
        w.transport.emit({
            kind: "unsubscribe",
            peer: s.hash,
            reason: "peer-session-reset",
        });
        await settle();
        expect(record.state).toBe("asking");
        expect(record.departed).toBe(false);

        // Unreachable before J held a header: blocks while the attempt runs.
        w.transport.reachable.set(s.hash, false);
        w.transport.emit({
            kind: "reachability",
            source: "disconnect",
            peer: s.hash,
        });
        await settle();
        expect(record.state).toBe("left-unanswered");
        expect(record.session).toBe(session);
        expect(coordinator.satisfied()).toBe(false);
        expect(w.status().state).toBe("waiting-left");
        expect(describeReadiness(w.status())).toContain(s.hash);

        // Back before the attempt ended: the same session asks on.
        w.transport.reachable.set(s.hash, true);
        w.transport.emit({
            kind: "reachability",
            source: "connect",
            peer: s.hash,
        });
        await settle();
        expect(record.state).toBe("asking");
        expect(record.departed).toBe(false);
        expect(record.session).toBe(session);
        expect(coordinator.satisfied()).toBe(false);

        // Gone again, and it stays away: the attempt's end makes it left.
        w.transport.reachable.set(s.hash, false);
        w.transport.emit({ kind: "reachability", source: "disconnect" });
        await settle();
        expect(record.state).toBe("left-unanswered");
        await w.clock.advanceSettled(5000);
        expect(record.state).toBe("left");
        expect(record.gap).toEqual({ missing: "unknown" });
        expect(record.session).toBeUndefined();
        expect(session.outcome?.kind).toBe("closed");
        expect(w.sentTo(s, CloseV1)).toHaveLength(1);
        // One attempt only: nothing went out after the close.
        expect(opensTo(w, s)).toBe(1);
        expect(coordinator.debug().armedTimers).toBe(0);
        await w.until(() => coordinator.satisfied(), "satisfied");

        // Reachable again later: a new session (D4).
        w.transport.reachable.set(s.hash, true);
        w.transport.emit({
            kind: "reachability",
            source: "connect",
            peer: s.hash,
        });
        await settle();
        expect(record.state).toBe("asking");
        expect(record.gap).toBeUndefined();
        expect(record.session).not.toBe(session);
        expect(opensTo(w, s)).toBe(2);
        expect(coordinator.satisfied()).toBe(false);
    });

    it("21: a replicator row with no sign of life gets one attempt, then is unconfirmed and does not block", async () => {
        const { w, peers } = await worldWith([
            ["X", { subscriber: false, replicator: true }],
            ["D"],
        ]);
        const [x, d] = peers;
        await w.start();
        x.hooks.toPeer = () => null;
        const coordinator = w.run();
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        const record = w.record(x);
        expect(record.confirmOnly).toBe(true);
        expect(record.live).toBe(false);
        // Asked once, Required while that attempt runs (G2-26).
        expect(record.state).toBe("asking");
        expect(coordinator.satisfied()).toBe(false);

        await w.clock.advanceSettled(5000);
        expect(record.state).toBe("unconfirmed");
        expect(opensTo(w, x)).toBe(1);
        expect(w.sentTo(x, CloseV1)).toHaveLength(1);
        expect(coordinator.debug().armedTimers).toBe(0);
        await w.until(() => coordinator.satisfied(), "satisfied with D alone");
        const status = w.status();
        expect(status.unconfirmed).toEqual([x.hash]);
        expect(status.required).toEqual([]);

        // A sign of life: live, full attempts.
        w.transport.emit({ kind: "replicator", type: "change", peer: x.hash });
        await settle();
        expect(record.state).toBe("asking");
        expect(record.confirmOnly).toBe(false);
        expect(opensTo(w, x)).toBe(2);
        expect(coordinator.satisfied()).toBe(false);
        await w.clock.advanceSettled(5000);
        expect(record.state).toBe("asking");
        expect(opensTo(w, x)).toBe(3);
        await w.clock.advanceSettled(30_000);
        expect(record.state).toBe("silent");
        expect(coordinator.satisfied()).toBe(false);
    });

    it("33: no peer for hours stays gated with nothing armed; a later subscribe makes it satisfied by event", async () => {
        const { w, peers } = await worldWith([["D", { subscriber: false }]]);
        const [d] = peers;
        await w.start();
        const coordinator = w.run();
        await settle();
        expect(w.status().state).toBe("no-peer");
        expect(describeReadiness(w.status())).toContain("no-peer");
        expect(coordinator.debug().armedTimers).toBe(0);
        expect(coordinator.debug().evaluationPending).toBe(false);
        const evaluations = w.evaluations.length;

        await w.clock.advanceSettled(6 * HOUR);
        expect(coordinator.satisfied()).toBe(false);
        expect(w.status().state).toBe("no-peer");
        expect(coordinator.debug().armedTimers).toBe(0);
        expect(w.clock.armed()).toBe(0);
        expect(w.evaluations).toHaveLength(evaluations);
        expect(w.evaluations.every((e) => !e.satisfied)).toBe(true);
        expect(w.sent).toEqual([]);

        const at = w.clock.now;
        w.transport.subscribed.set(d.hash, d.key);
        w.transport.emit({ kind: "subscribe", peer: d.hash, key: d.key });
        await w.until(() => coordinator.satisfied(), "satisfied");
        expect(w.clock.now).toBe(at);
        expect(w.stateOf(d)).toBe("contained");
        await settle();
        expect(w.evaluations.at(-1)).toEqual({
            satisfied: true,
            changed: true,
        });
    });
});

describe("readiness coordinator: BUSY, refusals and parked chains", () => {
    it("20: a BUSY whose notice is lost is re-asked when another session of J contains its peer", async () => {
        const { w, peers } = await worldWith([["R"], ["D"]]);
        const [r, d] = peers;
        await w.start();
        // R answers BUSY and its capacity notice never comes.
        r.refuse = { code: ERROR_CODE.BUSY, times: 1 };
        d.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 1000 : 0);
        const coordinator = w.run();
        await w.until(() => w.stateOf(r) === "busy", "R busy");
        const record = w.record(r);
        expect(record.reaskOnCompletion).toBe(true);
        expect(record.session).toBeUndefined();
        expect(opensTo(w, r)).toBe(1);
        expect(w.status().busy).toEqual([r.hash]);
        // Only D's attempt is armed; R holds none.
        expect(coordinator.debug().armedTimers).toBe(1);

        await w.clock.advanceSettled(1000);
        await w.until(() => w.stateOf(r) === "contained", "R contained");
        const [first, second] = w.sentTo(r, OpenV1);
        expect(second).toBeDefined();
        expect(hex(second.sessionId)).not.toBe(hex(first.sessionId));
        expect(w.stateOf(d)).toBe("contained");
        await w.until(() => coordinator.satisfied(), "satisfied");
    });

    it("20: a busy peer is re-asked on its next message, never by a timer", async () => {
        const { w, peers } = await worldWith([["R"]]);
        const [r] = peers;
        await w.start();
        r.refuse = { code: ERROR_CODE.BUSY, times: 1 };
        const coordinator = w.run();
        await w.until(() => w.stateOf(r) === "busy", "R busy");
        expect(coordinator.debug().armedTimers).toBe(0);
        expect(w.status().state).toBe("reconciling");
        expect(describeReadiness(w.status())).toContain("busy");

        await w.clock.advanceSettled(3 * HOUR);
        expect(w.stateOf(r)).toBe("busy");
        expect(opensTo(w, r)).toBe(1);
        expect(coordinator.debug().armedTimers).toBe(0);

        // R's next message (a request of its own) is a re-ask trigger.
        w.fromPeer(r, w.request(r));
        await w.until(() => w.stateOf(r) === "contained", "R contained");
        expect(opensTo(w, r)).toBe(2);
        await w.until(() => coordinator.satisfied(), "satisfied");
    });

    it("an R that answers every OPEN with BUSY never makes J loop", async () => {
        const { w, peers } = await worldWith([["R"], ["D"]]);
        const [r] = peers;
        await w.start();
        r.refuse = { code: ERROR_CODE.BUSY, times: Number.POSITIVE_INFINITY };
        const coordinator = w.run();
        await w.until(() => w.stateOf(r) === "busy", "R busy");
        await settle(200);
        // One re-ask when D's session completed, then nothing.
        expect(opensTo(w, r)).toBeLessThanOrEqual(2);
        expect(w.stateOf(r)).toBe("busy");
        expect(coordinator.satisfied()).toBe(false);
        await w.clock.advanceSettled(HOUR);
        expect(opensTo(w, r)).toBeLessThanOrEqual(2);
        expect(coordinator.debug().armedTimers).toBe(0);
        // A notice re-asks once more.
        w.fromPeer(r, w.notice(r));
        await settle();
        expect(opensTo(w, r)).toBeLessThanOrEqual(3);
        expect(w.stateOf(r)).toBe("busy");
    });

    it("UNSUPPORTED keeps R Required as refused; re-asked only on its notice (G2-5)", async () => {
        const { w, peers } = await worldWith([["R"], ["D"]]);
        const [r] = peers;
        await w.start();
        r.refuse = { code: ERROR_CODE.UNSUPPORTED, times: 1 };
        const coordinator = w.run();
        await w.until(() => w.stateOf(r) === "refused", "R refused");
        const record = w.record(r);
        expect(record.refused).toBe("UNSUPPORTED");
        await settle();
        expect(coordinator.satisfied()).toBe(false);
        const status = w.status();
        expect(status.state).toBe("waiting-silent");
        expect(status.silent).toEqual([
            { peer: r.hash, reachable: true, refused: "UNSUPPORTED" },
        ]);
        expect(describeReadiness(status)).toContain("refused UNSUPPORTED");

        // Signs of life do not re-ask a refusal (no loop).
        w.transport.emit({ kind: "subscribe", peer: r.hash, key: r.key });
        w.fromPeer(r, w.request(r));
        await settle();
        expect(opensTo(w, r)).toBe(1);
        expect(record.state).toBe("refused");

        w.fromPeer(r, w.notice(r));
        await w.until(() => record.state === "contained", "R contained");
        expect(opensTo(w, r)).toBe(2);
        await w.until(() => coordinator.satisfied(), "satisfied");
    });

    it("a chain renewed MAX_RENEWALS times parks, blocks, and is re-asked on R's notice", async () => {
        const { w, peers } = await worldWith([["R"]]);
        const [r] = peers;
        await w.start();
        r.refuse = { code: ERROR_CODE.EXPIRED, times: MAX_RENEWALS + 1 };
        const coordinator = w.run();
        await w.until(() => w.record(r).parked, "R parked");
        const record = w.record(r);
        expect(record.state).toBe("reconciling");
        expect(record.session).toBeUndefined();
        expect(record.sessionsOpened).toBe(MAX_RENEWALS + 1);
        expect(coordinator.debug().armedTimers).toBe(0);
        const status = w.status();
        expect(status.state).toBe("waiting-silent");
        expect(status.silent).toEqual([
            { peer: r.hash, reachable: true, parked: true },
        ]);
        // A sign of life does not restart a parked chain.
        w.transport.emit({ kind: "subscribe", peer: r.hash, key: r.key });
        await settle();
        expect(record.sessionsOpened).toBe(MAX_RENEWALS + 1);

        w.fromPeer(r, w.notice(r));
        await w.until(() => record.state === "contained", "R contained");
        expect(record.parked).toBe(false);
        await w.until(() => coordinator.satisfied(), "satisfied");
    });
});

describe("readiness coordinator: containment and donors", () => {
    it("23: an under-reporting peer is contained, but J waits for the honest peer", async () => {
        const { w, peers } = await worldWith([["R1"], ["R2"]]);
        const [r1, r2] = peers;
        const x = w.row("x", 7000n);
        // R1 logged x and does not index it; R2 indexes it.
        r1.scope(NS).log.add(x.head);
        r2.scope(NS).receive(x);
        await w.start();
        r2.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 1000 : 0);
        const coordinator = w.run();
        await w.until(() => w.stateOf(r1) === "contained", "R1 contained");
        expect(w.record(r1).results.get(NS)?.mode).toBe("fast");
        expect(coordinator.satisfied()).toBe(false);
        expect(w.jIndex().has("x")).toBe(false);

        await w.clock.advanceSettled(1000);
        await w.until(() => w.stateOf(r2) === "contained", "R2 contained");
        expect(w.jIndex().get("x")).toBe(x.head);
        await w.until(() => coordinator.satisfied(), "satisfied");
    });

    it("24: an under-reporting peer alone satisfies J, and the proof names it", async () => {
        const { w, peers } = await worldWith([["R1"]]);
        const [r1] = peers;
        const x = w.row("x", 7000n);
        r1.scope(NS).log.add(x.head);
        await w.start();
        const coordinator = w.run();
        await w.until(() => coordinator.satisfied(), "satisfied");
        // The non-guarantee (design 2.3): J lacks the row R1 did not report.
        expect(w.jIndex().has("x")).toBe(false);
        const proof = coordinator.proof();
        expect(proof.scopes).toEqual(["namespace-v1"]);
        expect(proof.contained).toHaveLength(1);
        expect(proof.contained[0]).toMatchObject({
            peer: r1.hash,
            scope: "namespace-v1",
            source: "creator",
            qualified: true,
            count: 12,
        });
        expect(proof.excluded).toEqual([]);
        expect(proof.gaps).toEqual([]);
        expect(w.containedCalls.map(({ peer }) => peer)).toEqual([r1.hash]);
    });

    it("26: an honest donor whose blocks come late past two pull timeouts is never excluded", async () => {
        const { w, peers } = await worldWith([["D"]]);
        const [d] = peers;
        const extra = w.rows([d], 3, "d", 5000);
        await w.start();
        let release!: () => void;
        w.joinGate = new Promise<void>((resolve) => (release = resolve));
        const coordinator = w.run();
        await w.until(() => w.joins.length === 1, "first pull");
        expect(w.stateOf(d)).toBe("reconciling");

        await w.clock.advanceSettled(PULL_TIMEOUT_MS);
        // The first fetch failure renews once (design 4.5 D5).
        await w.until(() => w.joins.length === 2, "second pull");
        expect(w.record(d).sessionsOpened).toBe(2);
        expect(w.stateOf(d)).toBe("reconciling");

        await w.clock.advanceSettled(PULL_TIMEOUT_MS);
        await w.until(() => w.record(d).fetchWaiting, "D fetch-waiting");
        const record = w.record(d);
        expect(record.state).toBe("reconciling");
        expect(record.excluded).toBeUndefined();
        expect(w.status().state).toBe("waiting-fetch");
        expect(coordinator.debug().armedTimers).toBe(0);
        expect(coordinator.debug().inFlight).toBe(0);
        expect(coordinator.satisfied()).toBe(false);

        // Served now; D's next sign of life retries the pull.
        w.joinGate = undefined;
        release();
        w.transport.emit({ kind: "subscribe", peer: d.hash, key: d.key });
        await w.until(() => record.state === "contained", "D contained");
        for (const entry of extra) {
            expect(w.jIndex().get(entry.id!)).toBe(entry.head);
        }
        await w.until(() => coordinator.satisfied(), "satisfied");
    });

    it("27: a head nobody serves gives waiting-fetch naming the peer, nothing armed, never excluded", async () => {
        const { w, peers } = await worldWith([["D"]]);
        const [d] = peers;
        const [lost] = w.rows([d], 1, "lost", 5000);
        w.unserved.add(lost.head);
        await w.start();
        const coordinator = w.run();
        await w.until(() => w.record(d).fetchWaiting, "D fetch-waiting");
        const status = w.status();
        expect(status.state).toBe("waiting-fetch");
        expect(status.fetchPending).toEqual([{ peer: d.hash, hashes: 1 }]);
        expect(describeReadiness(status)).toBe(
            `waiting-fetch: 1 hash no peer served, named by 1 of 1 required peer: ${d.hash}`
        );
        expect(coordinator.debug().armedTimers).toBe(0);

        await w.clock.advanceSettled(2 * HOUR);
        expect(w.stateOf(d)).toBe("reconciling");
        expect(w.record(d).excluded).toBeUndefined();
        expect(coordinator.satisfied()).toBe(false);
        expect(coordinator.debug().armedTimers).toBe(0);
    });

    it("32: only a gated peer, or only a partial replica, gives no-qualified-donor", async () => {
        for (const provenance of [GATED, PARTIAL]) {
            const { w, peers } = await worldWith([["P", { provenance }]]);
            const [p] = peers;
            await w.start();
            const coordinator = w.run();
            await w.until(() => w.stateOf(p) === "contained", "P contained");
            await settle();
            const record = w.record(p);
            expect(record.qualified).toBe(false);
            expect(coordinator.satisfied()).toBe(false);
            const status = w.status();
            expect(status.state).toBe("no-qualified-donor");
            expect(status.contained).toEqual([
                {
                    peer: p.hash,
                    qualified: false,
                    source: provenance.source,
                    scopes: ["namespace-v1"],
                    departed: false,
                },
            ]);
            expect(describeReadiness(status)).toContain("none qualified");
            expect(coordinator.debug().armedTimers).toBe(0);
        }
    });

    it("45: a donor departing mid-pull leaves a gap of its pending rows and stops blocking", async () => {
        const { w, peers } = await worldWith([
            ["D"],
            ["E", { provenance: WARM }],
        ]);
        const [d, e] = peers;
        const unique = w.rows([d], 3, "u", 5000);
        await w.start();
        let release!: () => void;
        w.joinGate = new Promise<void>((resolve) => (release = resolve));
        e.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 2000 : 0);
        const coordinator = w.run();
        await w.until(() => w.joins.length === 1, "D's pull");
        expect(w.stateOf(d)).toBe("reconciling");

        d.up = false;
        w.transport.reachable.set(d.hash, false);
        w.transport.emit({
            kind: "reachability",
            source: "disconnect",
            peer: d.hash,
        });
        await settle();
        const record = w.record(d);
        expect(record.state).toBe("left");
        expect(record.gap).toEqual({ missing: 3 });
        // The session stays: its pulls can still contain D.
        expect(record.session).toBeDefined();
        expect(w.status().required).toEqual([e.hash]);
        expect(coordinator.satisfied()).toBe(false);

        await w.clock.advanceSettled(2000);
        await w.until(() => w.stateOf(e) === "contained", "E contained");
        await w.until(() => coordinator.satisfied(), "satisfied");
        expect(w.status().gaps).toEqual([{ peer: d.hash, missing: 3 }]);
        expect(coordinator.proof().gaps).toEqual([
            { peer: d.hash, missing: 3 },
        ]);
        for (const entry of unique)
            expect(w.jIndex().has(entry.id!)).toBe(false);

        // The held pull times out: D stays left, J stays satisfied.
        await w.clock.advanceSettled(PULL_TIMEOUT_MS);
        await settle();
        expect(record.state).toBe("left");
        expect(record.session).toBeUndefined();
        expect(coordinator.satisfied()).toBe(true);
        release();
    });

    it("a qualification session upgrades a contained peer only on a qualified header (G2-20, design test 8's core)", async () => {
        const { w, peers } = await worldWith([["G", { provenance: GATED }]]);
        const [g] = peers;
        await w.start();
        const coordinator = w.run();
        await w.until(() => w.stateOf(g) === "contained", "G contained");
        const record = w.record(g);
        expect(record.qualified).toBe(false);

        // A stale openNonce: G restarted; the notice is dropped.
        const dropped = coordinator.debug().dropped;
        w.fromPeer(
            g,
            w.notice(g, {
                provenance: RECONCILED,
                openNonce: bytesOf("restarted").slice(0, 16),
            })
        );
        await settle();
        expect(coordinator.debug().dropped).toBe(dropped + 1);
        expect(record.sessionsOpened).toBe(1);

        // A notice whose provenance does not qualify changes nothing.
        w.fromPeer(g, w.notice(g));
        await settle();
        expect(record.sessionsOpened).toBe(1);

        // G turns ready and notices J; only the fresh session's header counts.
        g.provenance = RECONCILED;
        g.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 1000 : 0);
        g.responder.sendNotice([w.j.key], NOTICE_REASON.READY);
        await w.until(
            () => record.sessionsOpened === 2,
            "qualification session"
        );
        expect(record.state).toBe("contained");
        expect(record.qualifying).toBe(true);
        expect(record.qualified).toBe(false);
        await settle();
        expect(coordinator.satisfied()).toBe(false);
        expect(w.status().state).toBe("no-qualified-donor");

        await w.clock.advanceSettled(1000);
        await w.until(() => record.qualified, "G qualified");
        expect(record.qualifying).toBe(false);
        expect(record.results.get(NS)?.source).toBe("reconciled");
        await w.until(() => coordinator.satisfied(), "satisfied");
        expect(w.containedCalls.map(({ peer }) => peer)).toEqual([
            g.hash,
            g.hash,
        ]);
    });

    it("a qualification session that does not qualify leaves the earlier containment", async () => {
        const { w, peers } = await worldWith([["G", { provenance: GATED }]]);
        const [g] = peers;
        await w.start();
        const coordinator = w.run();
        await w.until(() => w.stateOf(g) === "contained", "G contained");
        const record = w.record(g);
        const earlier = record.results.get(NS);
        // The notice claims ready; G's next header does not (it went back).
        w.fromPeer(g, w.notice(g, { provenance: RECONCILED }));
        await w.until(
            () => record.sessionsOpened === 2,
            "qualification session"
        );
        await w.until(() => !record.qualifying, "qualification ended");
        expect(record.state).toBe("contained");
        expect(record.qualified).toBe(false);
        expect(record.results.get(NS)).toBe(earlier);
        expect(coordinator.satisfied()).toBe(false);
        // A BUSY to a qualification session leaves it contained too.
        g.refuse = { code: ERROR_CODE.BUSY, times: 1 };
        w.fromPeer(g, w.notice(g, { provenance: RECONCILED }));
        await w.until(
            () => record.sessionsOpened === 3,
            "second qualification"
        );
        await w.until(() => !record.qualifying, "second qualification ended");
        expect(record.state).toBe("contained");
        expect(record.qualified).toBe(false);
    });

    it("8 (in flight): a READY notice before G's gated header arrives opens a fresh session once G is contained", async () => {
        const { w, peers } = await worldWith([["G", { provenance: GATED }]]);
        const [g] = peers;
        await w.start();
        // G's header, frozen while G is gated, takes 1 s to reach J.
        g.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 1000 : 0);
        const coordinator = w.run();
        await w.until(() => g.responder.stats.headers >= 1, "G answered");
        const record = w.record(g);
        expect(record.state).toBe("asking");
        // G turns ready and notices J while J's session waits for it.
        g.provenance = RECONCILED;
        g.responder.sendNotice([w.j.key], NOTICE_REASON.READY);
        await settle();
        expect(record.sessionsOpened).toBe(1);
        expect(record.qualifyAfter).toBeDefined();

        // The gated header contains G unqualified; the notice that came
        // first opens the fresh session (design 4.7).
        await w.clock.advanceSettled(1000);
        await w.until(
            () => record.sessionsOpened === 2,
            "qualification session"
        );
        expect(record).toMatchObject({
            state: "contained",
            qualified: false,
            qualifying: true,
        });
        expect(record.qualifyAfter).toBeUndefined();
        expect(coordinator.satisfied()).toBe(false);
        await w.clock.advanceSettled(1000);
        await w.until(() => record.qualified, "G qualified");
        expect(record.results.get(NS)?.source).toBe("reconciled");
        await w.until(() => coordinator.satisfied(), "satisfied");
    });

    it("8 (reconciling): a READY notice while J pulls G's rows qualifies G through a fresh session", async () => {
        const { w, peers } = await worldWith([["G", { provenance: GATED }]]);
        const [g] = peers;
        // G holds rows J lacks, so J pulls them; the pull waits for the test.
        w.rows([g], 5, "g", 5000);
        await w.start();
        let release!: () => void;
        w.joinGate = new Promise<void>((resolve) => (release = resolve));
        const coordinator = w.run();
        await w.until(() => w.joins.length > 0, "a pull started");
        const record = w.record(g);
        expect(record.state).toBe("reconciling");
        g.provenance = RECONCILED;
        g.responder.sendNotice([w.j.key], NOTICE_REASON.READY);
        await settle();
        expect(record.sessionsOpened).toBe(1);
        release();
        w.joinGate = undefined;
        await w.until(() => record.qualified, "G qualified");
        expect(record.sessionsOpened).toBe(2);
        expect(record.results.get(NS)?.source).toBe("reconciled");
        await w.until(() => coordinator.satisfied(), "satisfied");
    });

    it("a ready notice of another open of G, before containment, asks nothing once G is contained", async () => {
        const { w, peers } = await worldWith([["G", { provenance: GATED }]]);
        const [g] = peers;
        await w.start();
        g.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 1000 : 0);
        const coordinator = w.run();
        await w.until(() => g.responder.stats.headers >= 1, "G answered");
        const record = w.record(g);
        w.fromPeer(
            g,
            w.notice(g, {
                provenance: RECONCILED,
                openNonce: bytesOf("another-open").slice(0, 16),
            })
        );
        await settle();
        await w.clock.advanceSettled(1000);
        await w.until(() => w.stateOf(g) === "contained", "G contained");
        await settle();
        expect(record).toMatchObject({
            qualified: false,
            qualifying: false,
            sessionsOpened: 1,
        });
        expect(record.qualifyAfter).toBeUndefined();
        expect(coordinator.satisfied()).toBe(false);
        expect(w.status().state).toBe("no-qualified-donor");
    });

    it.each(["reachable again", "a sign of life"] as const)(
        "a qualification session that went silent resumes when G is %s",
        async (how) => {
            const { w, peers } = await worldWith([
                ["G", { provenance: GATED }],
            ]);
            const [g] = peers;
            await w.start();
            const coordinator = w.run();
            await w.until(() => w.stateOf(g) === "contained", "G contained");
            const record = w.record(g);
            // G turns ready and notices J; then every OPEN of the
            // qualification session is lost.
            g.provenance = RECONCILED;
            g.responder.sendNotice([w.j.key], NOTICE_REASON.READY);
            if (how === "reachable again") {
                g.up = false;
                w.transport.reachable.set(g.hash, false);
                w.transport.emit({
                    kind: "reachability",
                    source: "disconnect",
                    peer: g.hash,
                });
            } else {
                g.hooks.toPeer = (m) => (m instanceof OpenV1 ? null : m);
            }
            await w.until(
                () => record.sessionsOpened === 2,
                "qualification session"
            );
            await w.clock.advanceSettled(40_000);
            const [, qualification] = w.sessionsOf(g);
            expect(qualification.state(NS)).toBe("silent");
            expect(record).toMatchObject({
                state: "contained",
                qualifying: true,
                qualified: false,
            });
            expect(coordinator.debug().armedTimers).toBe(0);
            const opens = opensTo(w, g);

            if (how === "reachable again") {
                expect(record.departed).toBe(true);
                g.up = true;
                w.transport.reachable.delete(g.hash);
                w.transport.emit({
                    kind: "reachability",
                    source: "connect",
                    peer: g.hash,
                });
            } else {
                g.hooks.toPeer = undefined;
                w.transport.emit({
                    kind: "replicator",
                    type: "change",
                    peer: g.hash,
                    key: g.key,
                });
            }
            await settle();
            expect(opensTo(w, g)).toBe(opens + 1);
            await w.until(() => record.qualified, "G qualified");
            expect(record.sessionsOpened).toBe(2);
            await w.until(() => coordinator.satisfied(), "satisfied");
        }
    );

    it("a notice from an unknown reachable peer creates a record; an unreachable one is dropped (G2-8)", async () => {
        const { w, peers } = await worldWith([
            ["U", { subscriber: false }],
            ["V", { subscriber: false, reachable: false }],
        ]);
        const [u, v] = peers;
        await w.start();
        const coordinator = w.run();
        await settle();
        expect(coordinator.records()).toEqual([]);
        w.fromPeer(v, w.notice(v));
        await settle();
        expect(coordinator.record(v.hash)).toBeUndefined();
        expect(coordinator.debug().dropped).toBe(1);

        w.fromPeer(u, w.notice(u));
        await w.until(() => w.stateOf(u) === "contained", "U contained");
        const record = w.record(u);
        expect([...record.via]).toEqual(["message"]);
        expect(record.live).toBe(true);
        await w.until(() => coordinator.satisfied(), "satisfied");
    });
});

describe("readiness coordinator: departure (D3 = A')", () => {
    it("an explicit unsubscribe of a peer that does not replicate is departure; a replicator stays until it leaves (G2-6)", async () => {
        const { w, peers } = await worldWith([
            ["S"],
            ["T", { replicator: true }],
            ["D"],
        ]);
        const [s, t, d] = peers;
        await w.start();
        s.hooks.toPeer = () => null;
        t.hooks.toPeer = () => null;
        const coordinator = w.run();
        await w.until(() => w.stateOf(d) === "contained", "D contained");

        // S closed its store: unsubscribed and no replicator, still reachable.
        w.transport.subscribed.delete(s.hash);
        w.transport.emit({
            kind: "unsubscribe",
            peer: s.hash,
            reason: "remote-unsubscribe",
        });
        await settle();
        const sRecord = w.record(s);
        expect(sRecord.storeClosed).toBe(true);
        expect(sRecord.departed).toBe(true);
        // Before J held a header: until the attempt in flight ends.
        expect(sRecord.state).toBe("left-unanswered");
        // A reachability event does not bring it back: it closed the store.
        w.transport.emit({
            kind: "reachability",
            source: "connect",
            peer: s.hash,
        });
        await settle();
        expect(sRecord.state).toBe("left-unanswered");

        // T unsubscribed but still replicates: it stays Required.
        w.transport.subscribed.delete(t.hash);
        w.transport.emit({
            kind: "unsubscribe",
            peer: t.hash,
            reason: "remote-unsubscribe",
        });
        await settle();
        const tRecord = w.record(t);
        expect(tRecord.departed).toBe(false);
        expect(tRecord.state).toBe("asking");

        await w.clock.advanceSettled(5000);
        expect(sRecord.state).toBe("left");
        expect(sRecord.gap).toEqual({ missing: "unknown" });
        expect(coordinator.satisfied()).toBe(false);

        // T stops replicating too: gone.
        w.transport.replicating.delete(t.hash);
        w.transport.emit({ kind: "replicator", type: "leave", peer: t.hash });
        await w.until(() => tRecord.departed, "T departed");
        expect(tRecord.state).toBe("left-unanswered");
        await w.clock.advanceSettled(10_000);
        expect(tRecord.state).toBe("left");
        await w.until(() => coordinator.satisfied(), "satisfied");

        // S opens the store again: a subscribe brings it back.
        w.transport.subscribed.set(s.hash, s.key);
        s.hooks.toPeer = undefined;
        w.transport.emit({ kind: "subscribe", peer: s.hash, key: s.key });
        await settle();
        expect(sRecord.storeClosed).toBe(false);
        await w.until(() => sRecord.state === "contained", "S contained");
        await w.until(() => coordinator.satisfied(), "satisfied again");
    });

    it("an explicit unsubscribe of a peer replicators() still lists keeps it Required, with no replicator event (D6)", async () => {
        const { w, peers } = await worldWith([["T"], ["D"]]);
        const [t, d] = peers;
        await w.start();
        t.hooks.toPeer = () => null;
        const coordinator = w.run();
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        const record = w.record(t);
        expect(record.via.has("replicator")).toBe(false);
        // T replicates by J's read only: no replicator event names it.
        w.transport.replicating.add(t.hash);
        w.transport.subscribed.delete(t.hash);
        w.transport.emit({
            kind: "unsubscribe",
            peer: t.hash,
            reason: "remote-unsubscribe",
        });
        await w.until(() => record.via.has("replicator"), "re-read");
        expect(record).toMatchObject({ storeClosed: false, departed: false });
        await w.clock.advanceSettled(40_000);
        expect(record).toMatchObject({
            state: "silent",
            storeClosed: false,
            departed: false,
        });
        expect(coordinator.satisfied()).toBe(false);
        expect(w.status().required).toEqual([t.hash]);
    });

    it("a notice from a departed, unconfirmed row re-reads it first: still gone, it is not asked", async () => {
        const { w, peers } = await worldWith([
            ["D", { provenance: CREATOR }],
            ["X", { provenance: CREATOR, subscriber: false, replicator: true }],
        ]);
        const [d, x] = peers;
        await w.start();
        x.hooks.toPeer = () => null;
        const coordinator = w.run();
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        await w.clock.advanceSettled(5000);
        const record = w.record(x);
        expect(record.state).toBe("unconfirmed");
        // X's route goes away: departed, and unconfirmed still.
        w.transport.reachable.set(x.hash, false);
        w.transport.emit({
            kind: "reachability",
            source: "disconnect",
            peer: x.hash,
        });
        await settle();
        expect(record).toMatchObject({ state: "unconfirmed", departed: true });
        // X's notice reaches J relayed, with no route to X; X is then gone
        // for good.
        const opens = opensTo(w, x);
        w.fromPeer(x, w.notice(x));
        x.up = false;
        await settle();
        expect(record).toMatchObject({
            state: "unconfirmed",
            departed: true,
            reachable: false,
        });
        expect(opensTo(w, x)).toBe(opens);
        await w.until(() => coordinator.satisfied(), "satisfied");
        await w.clock.advanceSettled(6 * HOUR);
        expect(coordinator.satisfied()).toBe(true);
        expect(coordinator.debug().armedTimers).toBe(0);

        // Reachable at its next notice: asked with full attempts.
        x.up = true;
        x.hooks.toPeer = undefined;
        w.transport.reachable.delete(x.hash);
        w.fromPeer(x, w.notice(x));
        await settle();
        expect(record).toMatchObject({ departed: false, confirmOnly: false });
        await w.until(() => w.stateOf(x) === "contained", "X contained");
        await w.until(() => coordinator.satisfied(), "satisfied again");
    });

    it("a peer gone by reachability that then closes its store does not come back with its route", async () => {
        const { w, peers } = await worldWith([["S"], ["D"]]);
        const [s, d] = peers;
        await w.start();
        s.hooks.toPeer = () => null;
        const coordinator = w.run();
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        w.transport.reachable.set(s.hash, false);
        w.transport.emit({
            kind: "reachability",
            source: "disconnect",
            peer: s.hash,
        });
        await w.clock.advanceSettled(5000);
        const record = w.record(s);
        expect(record.state).toBe("left");

        w.transport.subscribed.delete(s.hash);
        w.transport.emit({
            kind: "unsubscribe",
            peer: s.hash,
            reason: "remote-unsubscribe",
        });
        await w.until(() => record.storeClosed, "S's store closed");
        w.transport.reachable.set(s.hash, true);
        w.transport.emit({
            kind: "reachability",
            source: "connect",
            peer: s.hash,
        });
        await settle();
        expect(record.state).toBe("left");
        expect(coordinator.satisfied()).toBe(true);
        expect(opensTo(w, s)).toBe(1);
    });

    it("a disconnect naming no peer re-reads every record (a relay went away, G2-7)", async () => {
        const { w, peers } = await worldWith([["S"], ["D"]]);
        const [s, d] = peers;
        await w.start();
        s.hooks.toPeer = () => null;
        const coordinator = w.run();
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        await w.clock.advanceSettled(35_000);
        expect(w.stateOf(s)).toBe("silent");
        w.transport.reachable.set(s.hash, false);
        w.transport.emit({ kind: "reachability", source: "disconnect" });
        await settle();
        expect(w.stateOf(s)).toBe("left");
        expect(w.record(d).departed).toBe(false);
        await w.until(() => coordinator.satisfied(), "satisfied");

        // A contained donor that goes away stays contained, departed.
        w.transport.reachable.set(d.hash, false);
        w.transport.emit({
            kind: "reachability",
            source: "unreachable",
            peer: d.hash,
        });
        await settle();
        expect(w.stateOf(d)).toBe("contained");
        expect(w.record(d).departed).toBe(true);
        expect(w.status().contained[0].departed).toBe(true);
        expect(coordinator.satisfied()).toBe(true);
    });

    it("a left peer that reads reachable at the decision is asked again, with no event (design 2.1)", async () => {
        const { w, peers } = await worldWith([["S"], ["D"]]);
        const [s, d] = peers;
        await w.start();
        let drop = true;
        s.hooks.toPeer = () => (drop ? null : undefined);
        const coordinator = w.run();
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        w.transport.reachable.set(s.hash, false);
        w.transport.emit({
            kind: "reachability",
            source: "disconnect",
            peer: s.hash,
        });
        await w.clock.advanceSettled(5000);
        const record = w.record(s);
        expect(record.state).toBe("left");
        expect(record.session).toBeUndefined();
        await w.until(() => coordinator.satisfied(), "satisfied");

        // The route came back and no event said so.
        drop = false;
        w.transport.reachable.set(s.hash, true);
        expect(coordinator.satisfied()).toBe(false);
        await w.until(() => record.state === "contained", "S contained");
        expect(record.gap).toBeUndefined();
        expect(record.sessionsOpened).toBe(2);
        await w.until(() => coordinator.satisfied(), "satisfied again");
    });

    it("a subscriber unreachable when J saw it is Required once it reads reachable", async () => {
        const { w, peers } = await worldWith([
            ["U", { reachable: false }],
            ["D"],
        ]);
        const [u, d] = peers;
        w.rows([u], 2, "u", 5000);
        await w.start();
        const coordinator = w.run();
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        expect(coordinator.record(u.hash)).toBeUndefined();
        await w.until(() => coordinator.satisfied(), "satisfied without U");

        // No event: the decision's own read finds it.
        w.transport.reachable.set(u.hash, true);
        expect(coordinator.satisfied()).toBe(false);
        await w.until(() => w.stateOf(u) === "contained", "U contained");
        // Created as a subscriber; its answers added `message` (V6).
        expect([...w.record(u).via]).toEqual(["subscriber", "message"]);
        expect(w.jIndex().has("u0")).toBe(true);
        await w.until(() => coordinator.satisfied(), "satisfied with U");

        // An unsubscribe forgets an unreachable subscriber.
        const {
            w: w2,
            peers: [v, e],
        } = await worldWith([["V", { reachable: false }], ["E"]]);
        await w2.start();
        const second = w2.run();
        await w2.until(() => second.satisfied(), "satisfied without V");
        w2.transport.emit({ kind: "unsubscribe", peer: v.hash });
        w2.transport.reachable.set(v.hash, true);
        expect(second.satisfied()).toBe(true);
        expect(w2.stateOf(e)).toBe("contained");
    });

    it("an unreachable subscriber that is also a replicator row is Required with full attempts once reachable", async () => {
        const { w, peers } = await worldWith([
            ["X", { reachable: false, replicator: true }],
            ["D"],
        ]);
        const [x, d] = peers;
        await w.start();
        x.hooks.toPeer = () => null;
        const coordinator = w.run();
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        const record = w.record(x);
        expect(record.confirmOnly).toBe(true);
        await w.clock.advanceSettled(5000);
        expect(record.state).toBe("unconfirmed");
        await w.until(() => coordinator.satisfied(), "satisfied");

        // Connected now (no event): a subscriber, so asked in full.
        w.transport.reachable.set(x.hash, true);
        expect(coordinator.satisfied()).toBe(false);
        await settle();
        expect(record.state).toBe("asking");
        expect(record.confirmOnly).toBe(false);
        expect(record.via.has("subscriber")).toBe(true);
        await w.clock.advanceSettled(5000);
        expect(record.state).toBe("asking");
        expect(opensTo(w, x)).toBe(3);
        await w.clock.advanceSettled(30_000);
        expect(record.state).toBe("silent");
        expect(coordinator.satisfied()).toBe(false);
    });

    it("a left peer with a session resumes it when reachable again (D4)", async () => {
        const { w, peers } = await worldWith([["S"], ["D"]]);
        const [s, d] = peers;
        await w.start();
        let drop = true;
        s.hooks.toPeer = () => (drop ? null : undefined);
        const coordinator = w.run();
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        await w.clock.advanceSettled(35_000);
        const record = w.record(s);
        const session = record.session!;
        expect(record.state).toBe("silent");
        w.transport.reachable.set(s.hash, false);
        w.transport.emit({
            kind: "reachability",
            source: "disconnect",
            peer: s.hash,
        });
        await settle();
        expect(record.state).toBe("left");
        // Silent without a header: the session is kept, with nothing armed.
        expect(record.session).toBe(session);
        expect(coordinator.debug().armedTimers).toBe(0);

        drop = false;
        w.transport.reachable.set(s.hash, true);
        w.transport.emit({
            kind: "reachability",
            source: "connect",
            peer: s.hash,
        });
        await w.until(() => record.state === "contained", "S contained");
        expect(w.sessionsOf(s)).toEqual([session]);
        expect(opensTo(w, s)).toBe(4);
        await w.until(() => coordinator.satisfied(), "satisfied");
    });
});

describe("readiness coordinator: sessions, queue and timers", () => {
    it("runs at most 4 sessions in flight; a silent session frees its slot (G2-4)", async () => {
        const names: Array<[string]> = [];
        for (let i = 0; i < 6; i++) names.push([`P${i}`]);
        const { w, peers } = await worldWith(names);
        await w.start();
        for (const peer of peers.slice(0, 4)) peer.hooks.toPeer = () => null;
        let max = 0;
        const coordinator = w.run({
            onEvaluate: (evaluation) => {
                w.evaluations.push(evaluation);
                max = Math.max(max, coordinator.debug().inFlight);
            },
        });
        await settle();
        expect(SESSIONS_IN_FLIGHT).toBe(4);
        let debug = coordinator.debug();
        expect(debug.inFlight).toBe(4);
        expect(debug.sessions).toBe(4);
        expect(debug.queued).toBe(2);
        expect(
            peers.slice(4).map((peer) => w.record(peer).sessionsOpened)
        ).toEqual([0, 0]);
        // Queued peers are Required (asking).
        expect(w.status().required).toHaveLength(6);

        await w.clock.advanceSettled(35_000);
        await w.until(
            () =>
                peers.slice(4).every((peer) => w.stateOf(peer) === "contained"),
            "P4 and P5 contained"
        );
        debug = coordinator.debug();
        expect(debug.inFlight).toBe(0);
        expect(debug.queued).toBe(0);
        expect(debug.sessions).toBe(4);
        expect(debug.armedTimers).toBe(0);
        expect(max).toBeLessThanOrEqual(SESSIONS_IN_FLIGHT);
        expect(peers.slice(0, 4).map((peer) => w.stateOf(peer))).toEqual([
            "silent",
            "silent",
            "silent",
            "silent",
        ]);
        expect(w.status().silent).toHaveLength(4);
        expect(describeReadiness(w.status())).toMatch(
            /^waiting-silent: 4 of 4 required peers reachable and silent: .+ and 1 more$/
        );
        expect(coordinator.satisfied()).toBe(false);
    });

    it("a renewal keeps its slot while others are queued", async () => {
        const names: Array<[string]> = [];
        for (let i = 0; i < 5; i++) names.push([`Q${i}`]);
        const { w, peers } = await worldWith(names);
        await w.start();
        const [q0, , , , q4] = peers;
        for (const peer of peers.slice(1, 4)) peer.hooks.toPeer = () => null;
        q0.refuse = { code: ERROR_CODE.EXPIRED, times: 1 };
        let atRenewal: { q4Opened: number; q4Queued: boolean } | undefined;
        const coordinator = w.run({
            createSession: (init, ports) => {
                const session = w.session(init, ports);
                if (init.peer === q0.hash && w.sessionsOf(q0).length === 2) {
                    const record = coordinator.record(q4.hash)!;
                    atRenewal = {
                        q4Opened: record.sessionsOpened,
                        q4Queued: record.queued,
                    };
                }
                return session;
            },
        });
        await w.until(() => w.stateOf(q0) === "contained", "Q0 contained");
        expect(atRenewal).toEqual({ q4Opened: 0, q4Queued: true });
        expect(w.record(q0).sessionsOpened).toBe(2);
        // Q0's slot is free now: Q4 runs.
        await w.until(() => w.stateOf(q4) === "contained", "Q4 contained");
    });

    it("arms no timer while gated with nothing in flight (no peer, silent only, busy only)", async () => {
        const check = async (w: World, coordinator: Coordinator) => {
            await settle();
            expect(coordinator.debug().armedTimers).toBe(0);
            expect(coordinator.debug().evaluationPending).toBe(false);
            const evaluations = w.evaluations.length;
            const sent = w.sent.length;
            const states = coordinator.records().map(({ state }) => state);
            await w.clock.advanceSettled(5 * HOUR);
            expect(coordinator.debug().armedTimers).toBe(0);
            expect(w.evaluations).toHaveLength(evaluations);
            expect(w.sent).toHaveLength(sent);
            expect(coordinator.records().map(({ state }) => state)).toEqual(
                states
            );
            expect(coordinator.satisfied()).toBe(false);
        };
        {
            const { w } = await worldWith([]);
            await w.start();
            await check(w, w.run());
        }
        {
            const { w, peers } = await worldWith([["S"]]);
            await w.start();
            peers[0].hooks.toPeer = () => null;
            const coordinator = w.run();
            await settle();
            await w.clock.advanceSettled(35_000);
            expect(w.stateOf(peers[0])).toBe("silent");
            await check(w, coordinator);
        }
        {
            const { w, peers } = await worldWith([["B1"], ["B2"]]);
            await w.start();
            for (const peer of peers) {
                peer.refuse = { code: ERROR_CODE.BUSY, times: 1 };
            }
            const coordinator = w.run();
            await w.until(
                () => peers.every((peer) => w.stateOf(peer) === "busy"),
                "both busy"
            );
            await check(w, coordinator);
        }
    });

    it("a session that contains a peer reclassifies every live session (C grew)", async () => {
        const { w, peers } = await worldWith([["S"], ["D"]]);
        const [s, d] = peers;
        await w.start();
        s.hooks.toPeer = () => null;
        d.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 1000 : 0);
        const coordinator = w.run();
        await settle();
        const [session] = w.sessionsOf(s);
        const reclassify = vi.spyOn(session, "reclassify");
        await w.clock.advanceSettled(1000);
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        expect(reclassify).toHaveBeenCalledTimes(1);
        // The host's trust change hook (G2-10) does the same.
        coordinator.reclassify();
        expect(reclassify).toHaveBeenCalledTimes(2);
    });

    it("discovery must succeed once before J can be satisfied (G2-12)", async () => {
        const { w, peers } = await worldWith([["D", { subscriber: false }]]);
        const [d] = peers;
        await w.start();
        w.transport.failDiscovery = 2;
        const coordinator = w.run();
        await settle();
        expect(coordinator.debug().discovered).toBe(false);
        expect(coordinator.debug().discoveryFailures).toBe(1);

        // An event retries it (and fails once more); D is contained anyway.
        w.transport.emit({ kind: "replicator", type: "join", peer: d.hash });
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        await settle();
        expect(coordinator.debug().discoveryFailures).toBe(2);
        expect(coordinator.satisfied()).toBe(false);

        w.transport.emit({ kind: "reachability", source: "connect" });
        await w.until(() => coordinator.debug().discovered, "discovered");
        await w.until(() => coordinator.satisfied(), "satisfied");
        // Events about J itself are dropped.
        w.transport.emit({ kind: "subscribe", peer: w.j.hash });
        w.transport.emit({ kind: "replicator", type: "join", peer: w.j.hash });
        await settle();
        expect(coordinator.record(w.j.hash)).toBeUndefined();
    });

    it("finish keeps the records for status; dispose closes every session and detaches", async () => {
        {
            const { w, peers } = await worldWith([["D"]]);
            const [d] = peers;
            await w.start();
            const coordinator = w.run();
            await w.until(() => coordinator.satisfied(), "satisfied");
            expect(coordinator.noticeTargets()).toEqual([d.hash]);
            coordinator.finish();
            expect(coordinator.phase).toBe("finished");
            expect(w.transport.disposed).toBe(1);
            expect(w.transport.listeners.size).toBe(0);
            expect(
                w.status({ writeReady: true, phaseSettled: true }).state
            ).toBe("ready");
            const status = w.status();
            expect(status.satisfied).toBe(true);
            expect(status.contained.map(({ peer }) => peer)).toEqual([d.hash]);
            expect(coordinator.satisfied()).toBe(false);
            coordinator.dispose();
            expect(coordinator.phase).toBe("disposed");
            expect(w.transport.disposed).toBe(1);
        }
        {
            const { w, peers } = await worldWith([
                ["D"],
                ["E", { subscriber: false }],
            ]);
            const [d, e] = peers;
            await w.start();
            d.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 1000 : 0);
            const coordinator = w.run();
            await settle();
            const session = w.record(d).session!;
            expect(coordinator.debug().armedTimers).toBe(1);
            const evaluations = w.evaluations.length;

            coordinator.dispose();
            coordinator.dispose();
            expect(coordinator.phase).toBe("disposed");
            expect(session.outcome?.kind).toBe("closed");
            expect(w.sentTo(d, CloseV1)).toHaveLength(1);
            expect(w.transport.listeners.size).toBe(0);
            expect(w.transport.disposed).toBe(1);
            expect(coordinator.debug()).toMatchObject({
                sessions: 0,
                armedTimers: 0,
                queued: 0,
            });

            // Nothing acts afterwards: the late header, events, notices.
            await w.clock.advanceSettled(HOUR);
            expect(w.stateOf(d)).toBe("asking");
            coordinator.onMessage(w.notice(e), e.hash, 1, e.key);
            coordinator.onNotice(w.notice(e), e.hash, e.key);
            coordinator.evaluate();
            coordinator.reclassify();
            await settle();
            expect(coordinator.record(e.hash)).toBeUndefined();
            expect(w.evaluations).toHaveLength(evaluations);
            expect(w.sentTo(d, OpenV1)).toHaveLength(1);
            expect(coordinator.satisfied()).toBe(false);
        }
    });

    it("J's own state faulting mid-session is a fault: never satisfied, the status names it", async () => {
        const { w, peers } = await worldWith([["D"], ["E"]]);
        const [d, e] = peers;
        const [lost] = w.rows([d], 1, "lost", 5000);
        w.unserved.add(lost.head);
        await w.start();
        e.hooks.toPeer = () => null;
        const coordinator = w.run();
        await w.until(() => w.record(d).fetchWaiting, "D fetch-waiting");

        w.j.scope(NS).tap.faulted = new Error("tap boom");
        w.transport.emit({ kind: "subscribe", peer: d.hash, key: d.key });
        await w.until(() => w.status().fault !== undefined, "fault");
        const status = w.status();
        expect(status.fault).toContain("tap boom");
        expect(status.state).toBe("reconciling");
        expect(describeReadiness(status)).toContain("tap boom");
        expect(coordinator.satisfied()).toBe(false);
        // Every session closed, none starts again.
        expect(coordinator.debug()).toMatchObject({
            sessions: 0,
            armedTimers: 0,
        });
        expect(w.record(e).session).toBeUndefined();
        w.transport.emit({ kind: "subscribe", peer: e.hash, key: e.key });
        await settle();
        expect(coordinator.debug().sessions).toBe(0);
    });
});

describe("readiness coordinator: status", () => {
    it("describeReadiness names at most three peers and every state", () => {
        const base: ReadinessStatus = {
            state: "reconciling",
            satisfied: false,
            required: [],
            contained: [],
            excluded: [],
            silent: [],
            inFlight: [],
            busy: [],
            fetchPending: [],
            gaps: [],
            unconfirmed: [],
        };
        expect(describeReadiness({ ...base, state: "ready" })).toBe("ready");
        expect(describeReadiness({ ...base, state: "no-peer" })).toBe(
            "no-peer: no visible peer to reconcile with"
        );
        expect(
            describeReadiness({
                ...base,
                state: "reconciling",
                required: ["a", "b", "c", "d", "e"],
                inFlight: ["a", "b", "c", "d", "e"].map((peer) => ({
                    peer,
                    state: "asking",
                    scopes: {},
                })),
            })
        ).toBe(
            "reconciling: 5 of 5 required peers in flight: a, b, c and 2 more"
        );
        expect(
            describeReadiness({
                ...base,
                state: "waiting-silent",
                required: ["a", "b"],
                silent: [
                    { peer: "a", reachable: true },
                    { peer: "b", reachable: false },
                ],
            })
        ).toBe(
            "waiting-silent: 2 of 2 required peers silent: a (reachable), b (unreachable)"
        );
        expect(
            describeReadiness({
                ...base,
                state: "waiting-left",
                required: ["a"],
                inFlight: [{ peer: "a", state: "left-unanswered", scopes: {} }],
            })
        ).toBe(
            "waiting-left: 1 of 1 required peer left before answering, waiting for the attempt in flight: a"
        );
        expect(
            describeReadiness({ ...base, state: "waiting-phase" })
        ).toContain("bootstrap phase");
        // Since PR-3 commit 4: the predicate holds and the host is
        // persisting its proof (or its write failed and waits for the next
        // trigger, M9); no tracker decides any more.
        expect(
            describeReadiness({
                ...base,
                state: "reconciling",
                satisfied: true,
            })
        ).toBe(
            "reconciling: every required peer is accounted for; the write-readiness proof is being persisted"
        );
        expect(
            describeReadiness({
                ...base,
                state: "waiting-trust",
                required: ["a"],
            })
        ).toBe(
            "waiting-trust: 1 of 1 required peer wait for J's trust graph: a"
        );
        expect(
            describeReadiness({
                ...base,
                state: "waiting-fetch",
                required: ["a", "b"],
                fetchPending: [
                    { peer: "a", hashes: 2 },
                    { peer: "b", hashes: 1 },
                ],
            })
        ).toBe(
            "waiting-fetch: 3 hashes no peer served, named by 2 of 2 required peers: a, b"
        );
    });

    it("waiting-phase, not satisfied, while the phase is unsettled; reconciling and satisfied while the host's decision persists its proof; ready once the host says so (G2-19, G4-5)", async () => {
        const { w, peers } = await worldWith([["D"]]);
        const [d] = peers;
        await w.start();
        let phaseSettled = false;
        let persisted!: () => void;
        const coordinator = w.run({
            phaseSettled: () => phaseSettled,
            decide: () => new Promise<void>((resolve) => (persisted = resolve)),
        });
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        await settle();
        // Every peer is accounted for; the phase clause is the predicate's
        // (design 4.8), so it is not satisfied.
        for (const record of coordinator.records()) {
            expect(BLOCKING_STATES.has(record.state)).toBe(false);
        }
        const phasing = w.status({ writeReady: false, phaseSettled: false });
        expect(phasing).toMatchObject({
            state: "waiting-phase",
            satisfied: false,
            required: [],
        });
        expect(describeReadiness(phasing)).toContain("bootstrap phase");
        expect(coordinator.satisfied()).toBe(false);

        // The phase settles: the host's decision is in flight (its proof
        // being written), and the status says so.
        phaseSettled = true;
        coordinator.evaluate();
        await settle();
        const deciding = w.status();
        expect(deciding).toMatchObject({
            state: "reconciling",
            satisfied: true,
        });
        expect(describeReadiness(deciding)).toBe(
            "reconciling: every required peer is accounted for; the write-readiness proof is being persisted"
        );
        expect(coordinator.debug().decisions).toEqual({
            started: 1,
            failed: 0,
            inFlight: true,
        });
        expect(w.status({ writeReady: true, phaseSettled: true }).state).toBe(
            "ready"
        );
        // Plain data: survives JSON (an error can carry it).
        expect(JSON.parse(JSON.stringify(deciding))).toEqual(deciding);
        persisted();
        await settle();
        expect(coordinator.debug().decisions.inFlight).toBe(false);
    });
});

describe("readiness coordinator: the phase clause and the decision (PR-3 commit 4, M8, M9)", () => {
    it("M8: the host's phase clause is checked last; a phase change re-evaluates and decides once", async () => {
        const { w, peers } = await worldWith([["D"]]);
        const [d] = peers;
        await w.start();
        let phaseSettled = false;
        /** D's state at each read of the phase clause. */
        const phaseReads: Array<string | undefined> = [];
        const decide = vi.fn(async () => {});
        const coordinator = w.run({
            phaseSettled: () => {
                phaseReads.push(w.stateOf(d));
                return phaseSettled;
            },
            decide,
        });
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        await settle();
        // Read last: only once every other clause holds (D contained),
        // and then it gates.
        expect(phaseReads.length).toBeGreaterThan(0);
        expect(phaseReads.every((state) => state === "contained")).toBe(true);
        expect(coordinator.satisfied()).toBe(false);
        expect(w.evaluations.every((e) => !e.satisfied)).toBe(true);
        expect(decide).not.toHaveBeenCalled();
        expect(
            w.status({ writeReady: false, phaseSettled: false })
        ).toMatchObject({ state: "waiting-phase", satisfied: false });
        // Nothing armed and nothing re-evaluates while only the phase waits.
        expect(coordinator.debug().armedTimers).toBe(0);
        const evaluations = w.evaluations.length;
        await w.clock.advanceSettled(HOUR);
        expect(w.evaluations).toHaveLength(evaluations);

        // The host's phase change (setBootstrapPhase) is an evaluation.
        phaseSettled = true;
        coordinator.evaluate();
        await settle();
        expect(w.evaluations.slice(evaluations)).toEqual([
            { satisfied: true, changed: true },
        ]);
        expect(decide).toHaveBeenCalledTimes(1);
        expect(coordinator.debug().decisions).toEqual({
            started: 1,
            failed: 0,
            inFlight: false,
        });
    });

    it("M8: a phase clause that throws reads as unsettled: gated, no decision", async () => {
        const { w, peers } = await worldWith([["D"]]);
        const [d] = peers;
        await w.start();
        const decide = vi.fn(async () => {});
        const coordinator = w.run({
            phaseSettled: () => {
                throw new Error("phase unreadable");
            },
            decide,
        });
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        await settle();
        expect(coordinator.satisfied()).toBe(false);
        expect(w.evaluations.every((e) => !e.satisfied)).toBe(true);
        expect(decide).not.toHaveBeenCalled();
    });

    it("M9: every satisfied evaluation asks the host, not only a change", async () => {
        const { w } = await worldWith([["D"]]);
        await w.start();
        const decide = vi.fn(async () => {});
        const coordinator = w.run({ decide });
        await w.until(() => coordinator.satisfied(), "satisfied");
        await settle();
        expect(decide).toHaveBeenCalledTimes(1);
        // A trigger that changes nothing: the predicate still holds,
        // unchanged, and the host is asked again (a decision that found
        // the predicate false in its slot, or failed, retries this way).
        w.transport.emit({ kind: "reachability", source: "connect" });
        await settle();
        expect(w.evaluations.at(-1)).toEqual({
            satisfied: true,
            changed: false,
        });
        expect(decide).toHaveBeenCalledTimes(2);
        expect(coordinator.debug().decisions).toEqual({
            started: 2,
            failed: 0,
            inFlight: false,
        });
    });

    it("M9: at most one decision in flight; satisfied evaluations meanwhile coalesce into one rerun after it", async () => {
        const { w } = await worldWith([["D"]]);
        await w.start();
        const releases: Array<() => void> = [];
        const decide = vi.fn(
            () => new Promise<void>((resolve) => releases.push(resolve))
        );
        const coordinator = w.run({ decide });
        await w.until(() => decide.mock.calls.length === 1, "deciding");
        expect(coordinator.debug().decisions).toEqual({
            started: 1,
            failed: 0,
            inFlight: true,
        });
        for (let i = 0; i < 3; i++) {
            coordinator.evaluate();
            await settle();
        }
        expect(w.evaluations.filter((e) => e.satisfied)).toHaveLength(4);
        expect(decide).toHaveBeenCalledTimes(1);

        const evaluations = w.evaluations.length;
        releases[0]();
        await settle();
        // One rerun of the evaluation, one more decision.
        expect(w.evaluations.slice(evaluations)).toEqual([
            { satisfied: true, changed: false },
        ]);
        expect(decide).toHaveBeenCalledTimes(2);
        // Nothing landed during the second: no third.
        releases[1]();
        await settle();
        expect(decide).toHaveBeenCalledTimes(2);
        expect(w.evaluations).toHaveLength(evaluations + 1);
        expect(coordinator.debug().decisions).toEqual({
            started: 2,
            failed: 0,
            inFlight: false,
        });
    });

    it("M9: a failed decision is counted and arms nothing; the next trigger retries it", async () => {
        const { w, peers } = await worldWith([["D"]]);
        const [d] = peers;
        await w.start();
        const decide = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error("sidecar unwritable"))
            .mockResolvedValue(undefined);
        const coordinator = w.run({ decide });
        await w.until(
            () => coordinator.debug().decisions.failed === 1,
            "a failed decision"
        );
        await settle();
        expect(coordinator.debug().decisions).toEqual({
            started: 1,
            failed: 1,
            inFlight: false,
            lastError: "sidecar unwritable",
        });
        // Still satisfied, and the status says the proof is being
        // persisted (it waits for the next trigger).
        expect(coordinator.satisfied()).toBe(true);
        expect(w.status()).toMatchObject({
            state: "reconciling",
            satisfied: true,
        });
        // No retry timer: nothing armed, and hours pass with no
        // evaluation and no decision.
        expect(coordinator.debug().armedTimers).toBe(0);
        const evaluations = w.evaluations.length;
        await w.clock.advanceSettled(5 * HOUR);
        expect(w.evaluations).toHaveLength(evaluations);
        expect(decide).toHaveBeenCalledTimes(1);

        // The next trigger (a design 4.9 event) retries.
        w.transport.emit({ kind: "subscribe", peer: d.hash, key: d.key });
        await settle();
        expect(decide).toHaveBeenCalledTimes(2);
        expect(w.evaluations.at(-1)).toEqual({
            satisfied: true,
            changed: false,
        });
        expect(coordinator.debug().decisions).toEqual({
            started: 2,
            failed: 1,
            inFlight: false,
            lastError: "sidecar unwritable",
        });
    });

    it("M9: a decide that throws at once is a failed decision too", async () => {
        const { w } = await worldWith([["D"]]);
        await w.start();
        const coordinator = w.run({
            decide: () => {
                throw new Error("no host");
            },
        });
        await w.until(
            () => coordinator.debug().decisions.failed === 1,
            "a failed decision"
        );
        expect(coordinator.debug().decisions).toMatchObject({
            started: 1,
            inFlight: false,
            lastError: "no host",
        });
        expect(coordinator.satisfied()).toBe(true);
    });

    it("no decision after finish or dispose, not even the rerun of one in flight", async () => {
        for (const end of ["finish", "dispose"] as const) {
            const { w } = await worldWith([["D"]]);
            await w.start();
            const releases: Array<() => void> = [];
            const decide = vi.fn(
                () => new Promise<void>((resolve) => releases.push(resolve))
            );
            const coordinator = w.run({ decide });
            await w.until(() => decide.mock.calls.length === 1, "deciding");
            // A satisfied evaluation lands meanwhile: a rerun is owed.
            coordinator.evaluate();
            await settle();
            if (end === "finish") coordinator.finish();
            else coordinator.dispose();
            releases[0]();
            await settle();
            coordinator.evaluate();
            await settle();
            expect(decide).toHaveBeenCalledTimes(1);
            expect(coordinator.debug().decisions).toMatchObject({
                started: 1,
                inFlight: false,
            });
        }
    });
});

/**
 * A stand-in for `JoinerSession` whose states and outcomes the test sets:
 * the coordinator's mapping of session states (S1-S5), outcomes (O1-O7)
 * and attempts (A1-A2), without a responder in between.
 */
class ScriptedSession {
    readonly peer: string;
    readonly sessionId: Uint8Array;
    outcome?: SessionOutcome;
    state0: SessionState = "asking";
    pending = 0;
    failed = 0;
    started = 0;
    resumed = 0;
    reclassified = 0;
    /** `start` reports this outcome at once (a scope that is not open). */
    failAtStart?: SessionOutcome;

    constructor(
        readonly init: SessionInit,
        readonly ports: SessionPorts
    ) {
        this.peer = init.peer;
        this.sessionId = init.sessionId;
    }

    state(scope: ScopeId) {
        return scope === NS ? this.state0 : undefined;
    }

    /** A scripted run never parks for trust. */
    parked() {
        return false;
    }

    debug() {
        return {
            scopes: {
                [NS]: {
                    state: this.state0,
                    pending: this.pending,
                    logged: 0,
                    failed: this.failed,
                    retry: 0,
                    trustPending: 0,
                    explained: 0,
                    xPeel: 0,
                    have: 0,
                    m: 0,
                    k: 0,
                    repeels: 0,
                    mismatches: 0,
                    certificates: 0,
                },
            },
            armedTimers: 0,
            dropped: 0,
            outcome: this.outcome?.kind,
        };
    }

    start() {
        this.started++;
        if (this.failAtStart) this.finish(this.failAtStart);
    }

    onMessage() {}

    resume() {
        this.resumed++;
    }

    reclassify() {
        this.reclassified++;
    }

    close() {
        if (!this.outcome) this.finish({ kind: "closed" });
    }

    set(state: SessionState) {
        this.state0 = state;
        this.ports.events.onState?.(
            this as unknown as JoinerSession,
            NS,
            state
        );
    }

    attempt(last = false) {
        this.ports.events.onAttempt?.(this as unknown as JoinerSession, {
            attempt: 1,
            last,
        });
    }

    finish(outcome: SessionOutcome) {
        if (this.outcome) return;
        this.outcome = outcome;
        this.ports.events.onOutcome(this as unknown as JoinerSession, outcome);
    }

    /** A contained result of this session. */
    result(
        qualified: boolean,
        source: SessionResult["source"] = "creator",
        scope: ScopeId = NS
    ) {
        const result: SessionResult = {
            peer: this.peer,
            sessionId: this.sessionId,
            openNonce: bytesOf(`scripted-nonce-${this.peer}`).slice(0, 16),
            scope,
            count: 0,
            hlc: 0n,
            anchor: new Uint8Array(32),
            provenance: {
                writeReady: qualified,
                source,
                fullReplica: true,
                phase: "off",
            },
            source,
            qualified,
            mode: "empty",
            seq: 0,
            missingAtStart: 0,
            pulled: 0,
            explained: 0,
            explainedBy: {},
            x: 0,
            gapEst: 0,
            cells: 0,
            recoveries: 0,
            roundTrips: 1,
            certificates: 1,
            ms: 0,
        };
        return result;
    }
}

describe("readiness coordinator: scripted sessions", () => {
    /** A world whose sessions are `ScriptedSession`s. */
    const scripted = async (names: string[]) => {
        const { w, peers } = await worldWith(
            names.map((name) => [name]),
            0
        );
        const made: ScriptedSession[] = [];
        let next: ((session: ScriptedSession) => void) | undefined;
        const coordinator = w.run({
            createSession: (init, ports) => {
                const session = new ScriptedSession(init, ports);
                next?.(session);
                made.push(session);
                return session as unknown as JoinerSession;
            },
        });
        const of = (peer: FakePeer) =>
            made.filter((session) => session.peer === peer.hash);
        const contain = (session: ScriptedSession, qualified = true) =>
            session.finish({
                kind: "contained",
                results: [session.result(qualified)],
            });
        const onCreate = (fn: (session: ScriptedSession) => void) => {
            next = fn;
        };
        await settle();
        return { w, peers, coordinator, made, of, contain, onCreate };
    };

    afterEach(() => {
        // Scripted containment has no oracle record.
        for (const w of World.created) {
            for (const record of w.coordinator?.records() ?? []) {
                w.checked.add(record.hash);
            }
        }
    });

    it("S1-S3: a list page refused with BUSY keeps the session busy; a sign of life resumes it", async () => {
        const { w, peers, coordinator, of } = await scripted(["R"]);
        const [r] = peers;
        const [session] = of(r);
        expect(session.started).toBe(1);
        expect(coordinator.debug().inFlight).toBe(1);
        session.set("certifying");
        expect(w.stateOf(r)).toBe("reconciling");
        expect(w.record(r).headerHeld).toBe(true);
        session.set("busy");
        const record = w.record(r);
        expect(record.state).toBe("busy");
        expect(record.reaskOnCompletion).toBe(true);
        expect(record.session).toBe(session);
        expect(coordinator.debug().inFlight).toBe(0);
        expect(w.status().busy).toEqual([r.hash]);

        w.transport.emit({ kind: "subscribe", peer: r.hash, key: r.key });
        await settle();
        expect(session.resumed).toBe(1);
        expect(of(r)).toHaveLength(1);
        expect(record.reaskOnCompletion).toBe(false);
        session.set("recovering");
        expect(record.state).toBe("reconciling");
    });

    it("S2 and S4 free the slot; a parked session active again counts again", async () => {
        const { w, peers, coordinator, of } = await scripted([
            "P0",
            "P1",
            "P2",
            "P3",
            "P4",
            "P5",
        ]);
        expect(coordinator.debug()).toMatchObject({ inFlight: 4, queued: 2 });
        const [p0, p1, , , p4, p5] = peers;
        const [s0] = of(p0);
        s0.set("draining");
        s0.failed = 2;
        s0.pending = 2;
        s0.set("failed-fetch-wait");
        const r0 = w.record(p0);
        expect(r0.state).toBe("reconciling");
        expect(r0.fetchWaiting).toBe(true);
        await settle();
        expect(of(p4)).toHaveLength(1);
        expect(coordinator.debug()).toMatchObject({ inFlight: 4, queued: 1 });

        of(p1)[0].set("silent");
        await settle();
        expect(w.stateOf(p1)).toBe("silent");
        expect(of(p5)).toHaveLength(1);
        expect(coordinator.debug()).toMatchObject({ inFlight: 4, queued: 0 });

        // P0's fetch is served after all: active again, over the cap briefly.
        s0.set("draining");
        expect(r0.fetchWaiting).toBe(false);
        expect(coordinator.debug().inFlight).toBe(5);
        const status = w.status();
        expect(status.state).toBe("waiting-silent");
        expect(status.fetchPending).toEqual([{ peer: p0.hash, hashes: 2 }]);
    });

    it("a session that fails at start (a scope not open) is a fault and starts nothing else", async () => {
        const { w } = await worldWith([["A"], ["B"], ["C"], ["D"], ["E"]], 0);
        let first = true;
        const made: ScriptedSession[] = [];
        const coordinator = w.run({
            createSession: (init, ports) => {
                const session = new ScriptedSession(init, ports);
                if (first) {
                    first = false;
                    session.failAtStart = {
                        kind: "local-unavailable",
                        scope: NS,
                        detail: "scope not open",
                    };
                }
                made.push(session);
                return session as unknown as JoinerSession;
            },
        });
        await settle();
        expect(w.status().fault).toBe("scope not open");
        expect(made).toHaveLength(1);
        expect(coordinator.debug()).toMatchObject({ sessions: 0, queued: 0 });
        expect(coordinator.satisfied()).toBe(false);
    });

    it("a createSession that throws is a fault", async () => {
        const { w } = await worldWith([["A"]], 0);
        const coordinator = w.run({
            createSession: () => {
                throw new Error("no scopes");
            },
        });
        await settle();
        expect(w.status().fault).toBe("readiness session: no scopes");
        expect(coordinator.satisfied()).toBe(false);
    });

    it("a session closed by someone else parks its peer; a notice asks again", async () => {
        const { w, peers, of, contain } = await scripted(["R"]);
        const [r] = peers;
        of(r)[0].finish({ kind: "closed" });
        const record = w.record(r);
        expect(record.state).toBe("reconciling");
        expect(record.parked).toBe(true);
        expect(w.status().silent).toEqual([
            { peer: r.hash, reachable: true, parked: true },
        ]);
        w.fromPeer(r, w.notice(r));
        await settle();
        expect(of(r)).toHaveLength(2);
        expect(record.parked).toBe(false);
        contain(of(r)[1]);
        expect(record.state).toBe("contained");
    });

    it("a departure records the pending count of a decoded set, unknown otherwise", async () => {
        const { w, peers, of } = await scripted(["A", "B"]);
        const [a, b] = peers;
        of(a)[0].set("certifying");
        of(a)[0].pending = 7;
        of(a)[0].set("draining");
        of(b)[0].set("peeling");
        for (const peer of [a, b]) w.transport.reachable.set(peer.hash, false);
        w.transport.emit({ kind: "reachability", source: "disconnect" });
        await settle();
        expect(w.record(a)).toMatchObject({
            state: "left",
            gap: { missing: 7 },
        });
        expect(w.record(b)).toMatchObject({
            state: "left",
            gap: { missing: "unknown" },
        });
        // The sessions stay: their pulls can still contain the peers.
        expect(w.record(a).session).toBe(of(a)[0]);
        expect(w.record(b).session).toBe(of(b)[0]);

        // A renewal of a departed peer's session starts nothing.
        of(a)[0].finish({
            kind: "renew",
            reason: "fetch-failed",
            list: false,
            scopes: [NS],
            results: [],
        });
        await settle();
        expect(of(a)).toHaveLength(1);
        expect(w.record(a)).toMatchObject({
            state: "left",
            gap: { missing: 7 },
        });
        expect(w.record(a).session).toBeUndefined();

        // A departed peer's session that contains it after all: contained.
        of(b)[0].finish({
            kind: "contained",
            results: [of(b)[0].result(true)],
        });
        expect(w.record(b)).toMatchObject({
            state: "contained",
            departed: true,
        });
        expect(w.record(b).gap).toBeUndefined();
    });

    it("left-unanswered: a header that arrives while R is still gone makes it left and keeps the session", async () => {
        const { w, peers, of } = await scripted(["A"]);
        const [a] = peers;
        const [session] = of(a);
        w.transport.reachable.set(a.hash, false);
        w.transport.emit({
            kind: "reachability",
            source: "unreachable",
            peer: a.hash,
        });
        await settle();
        expect(w.stateOf(a)).toBe("left-unanswered");
        session.set("waiting-sync");
        expect(w.record(a)).toMatchObject({
            state: "left",
            gap: { missing: "unknown" },
        });
        expect(w.record(a).session).toBe(session);
        expect(session.outcome).toBeUndefined();
    });

    it("A2 applies at the first attempt's end only to a confirm-only peer", async () => {
        const { w, peers, of } = await worldWith(
            [["X", { subscriber: false, replicator: true }], ["S"]],
            0
        ).then(async ({ w, peers }) => {
            const made: ScriptedSession[] = [];
            w.run({
                createSession: (init, ports) => {
                    const session = new ScriptedSession(init, ports);
                    made.push(session);
                    return session as unknown as JoinerSession;
                },
            });
            await settle();
            return {
                w,
                peers,
                of: (peer: FakePeer) =>
                    made.filter((session) => session.peer === peer.hash),
            };
        });
        const [x, sub] = peers;
        of(sub)[0].attempt();
        expect(w.stateOf(sub)).toBe("asking");
        expect(of(sub)[0].outcome).toBeUndefined();
        of(x)[0].attempt();
        expect(w.stateOf(x)).toBe("unconfirmed");
        expect(of(x)[0].outcome?.kind).toBe("closed");
    });

    it("B3: a busy peer is re-asked when another session of J ends in an exclusion", async () => {
        const { w, peers, of } = await scripted(["R", "X"]);
        const [r, x] = peers;
        of(r)[0].finish({ kind: "busy" });
        await settle();
        expect(w.stateOf(r)).toBe("busy");
        expect(w.record(r).reaskOnCompletion).toBe(true);
        of(x)[0].finish({
            kind: "excluded",
            reason: "unsubstantiated",
            scope: NS,
            detail: "a CUT named as a row",
        });
        await settle();
        expect(w.stateOf(x)).toBe("excluded-unsubstantiated");
        expect(of(r)).toHaveLength(2);
        expect(w.record(r)).toMatchObject({
            state: "asking",
            reaskOnCompletion: false,
        });
    });

    it("a qualification session keeps its ladder through a renewal and upgrades on a qualified containment", async () => {
        const { w, peers, coordinator, of, contain } = await scripted(["G"]);
        const [g] = peers;
        contain(of(g)[0], false);
        const record = w.record(g);
        expect(record).toMatchObject({ state: "contained", qualified: false });
        // The notice's openNonce matches the contained result's.
        const notice = w.notice(g, {
            provenance: RECONCILED,
            openNonce: of(g)[0].result(false).openNonce,
        });
        w.fromPeer(g, notice);
        await settle();
        expect(of(g)).toHaveLength(2);
        expect(record.qualifying).toBe(true);
        // A second notice while it runs resumes it; no third session.
        w.fromPeer(g, notice);
        await settle();
        expect(of(g)).toHaveLength(2);
        expect(of(g)[1].resumed).toBe(1);
        of(g)[1].set("busy");
        expect(record.state).toBe("contained");
        of(g)[1].finish({
            kind: "renew",
            reason: "expired",
            list: false,
            scopes: [NS],
            results: [],
        });
        expect(of(g)).toHaveLength(3);
        expect(record.qualifying).toBe(true);
        expect(record.state).toBe("contained");
        await settle();
        expect(coordinator.satisfied()).toBe(false);
        contain(of(g)[2], true);
        expect(record).toMatchObject({
            state: "contained",
            qualified: true,
            qualifying: false,
        });
        await w.until(() => coordinator.satisfied(), "satisfied");
    });

    it("an excluded peer stops blocking; exclusion wins over an earlier containment", async () => {
        const { w, peers, coordinator, of, contain } = await scripted([
            "A",
            "G",
        ]);
        const [a, g] = peers;
        of(a)[0].finish({
            kind: "excluded",
            reason: "unsubstantiated",
            scope: NS,
            detail: "a CUT named as a row",
        });
        contain(of(g)[0], false);
        w.fromPeer(
            g,
            w.notice(g, {
                provenance: RECONCILED,
                openNonce: of(g)[0].result(false).openNonce,
            })
        );
        await settle();
        of(g)[1].finish({
            kind: "excluded",
            reason: "inconsistent",
            scope: NS,
            detail: "the list's set hash differs from the header's",
        });
        await settle();
        expect(w.stateOf(a)).toBe("excluded-unsubstantiated");
        expect(w.stateOf(g)).toBe("excluded-inconsistent");
        expect(w.record(g).results.size).toBe(0);
        const status = w.status();
        expect(status.required).toEqual([]);
        expect(status.state).toBe("no-qualified-donor");
        expect(
            status.excluded.map(({ peer, reason }) => [peer, reason])
        ).toEqual([
            [a.hash, "unsubstantiated"],
            [g.hash, "inconsistent"],
        ]);
        expect(coordinator.proof().excluded).toHaveLength(2);
        expect(coordinator.satisfied()).toBe(false);
        // Excluded is sticky: notices and signs of life do nothing.
        w.fromPeer(a, w.notice(a));
        w.transport.emit({ kind: "subscribe", peer: a.hash, key: a.key });
        await settle();
        expect(of(a)).toHaveLength(1);
    });
});

describe("readiness coordinator: trust (PR-3 commit 3, SPEC3 9.5)", () => {
    const keyOf = async () => (await Ed25519Keypair.create()).publicKey;

    /**
     * An access-controlled world: J and `peers`, `common` rows of both
     * scopes on everyone, every peer's identity trusted by J's graph.
     */
    const aclWorldWith = async (
        peers: Array<[string, PeerOptions?]>,
        common = 8
    ) => {
        const w = await World.create({ trust: true });
        const out: Peer[] = [];
        for (const [name, options] of peers) {
            out.push(await w.peer(name, options));
        }
        w.rows([w.j, ...out], common, "c");
        w.rows([w.j, ...out], common, "tc", 1000, TRUST);
        for (const peer of out) w.trust!.trusted.add(peer.hash);
        return { w, trust: w.trust!, peers: out };
    };

    /** A namespace row only `peer` holds, which J refuses for `writer`. */
    const refusedRow = (w: World, peer: Peer, writer: PublicSignKey) => {
        const [row] = w.rows([peer], 1, `x-${peer.name}-`, 5000);
        w.rejected.set(row.head, {
            permanent: false,
            reason: "untrusted",
            signers: [writer],
        });
        return row;
    };

    /** `peer`'s namespace run holds the parked hash, no pass in flight. */
    const parked = (w: World, peer: Peer) => {
        const debug = w.scopeDebug(peer);
        return debug?.trustPending === 1 && !debug.trustChecking;
    };

    describe("C1: every counted trust scope contained classifies the parked hashes again", () => {
        it("the last trust run contains", async () => {
            const { w, peers } = await aclWorldWith([["A"], ["B"]]);
            const [a, b] = peers;
            refusedRow(w, b, await keyOf());
            await w.start();
            // A's trust header takes a slow route.
            a.hooks.delayToJ = (m) =>
                m instanceof HeaderV1 && m.scope === TRUST ? 1000 : 0;
            const coordinator = w.run();
            await w.until(
                () =>
                    parked(w, b) &&
                    w.record(b).session?.state(TRUST) === "contained",
                "B parked, its own trust contained"
            );
            await settle();
            expect(w.scopeDebug(b)).toMatchObject({
                state: "draining",
                untrusted: 0,
            });
            expect(w.stateOf(a)).toBe("asking");
            const reclassify = vi.spyOn(w.record(b).session!, "reclassify");
            const before = coordinator.debug().trustTriggers;
            await w.clock.advanceSettled(1000);
            await w.until(() => w.stateOf(b) === "contained", "B contained");
            expect(coordinator.debug().trustTriggers).toMatchObject({
                change: 0,
                scopesContained: before.scopesContained + 1,
            });
            expect(reclassify).toHaveBeenCalled();
            expect(w.record(b).results.get(NS)?.explainedBy).toEqual({
                "rejected-untrusted": 1,
            });
            await w.until(() => coordinator.satisfied(), "satisfied");
        });

        it("the last Required peer without a trust scope leaves", async () => {
            const { w, peers } = await aclWorldWith([["A"], ["B"]]);
            const [a, b] = peers;
            refusedRow(w, b, await keyOf());
            await w.start();
            a.hooks.toPeer = () => null;
            const coordinator = w.run();
            await w.until(() => parked(w, b), "B parked");
            const before = coordinator.debug().trustTriggers.scopesContained;
            w.transport.reachable.set(a.hash, false);
            w.transport.emit({
                kind: "reachability",
                source: "disconnect",
                peer: a.hash,
            });
            await settle();
            // Blocking until its attempt ends: it still counts.
            expect(w.stateOf(a)).toBe("left-unanswered");
            expect(w.scopeDebug(b)!.untrusted).toBe(0);
            await w.clock.advanceSettled(5000);
            await w.until(() => w.stateOf(b) === "contained", "B contained");
            expect(w.stateOf(a)).toBe("left");
            expect(coordinator.debug().trustTriggers.scopesContained).toBe(
                before + 1
            );
            await w.until(() => coordinator.satisfied(), "satisfied");
        });

        it("an unconfirmed peer never counts", async () => {
            const { w, peers } = await aclWorldWith([
                ["U", { subscriber: false, replicator: true }],
                ["B"],
            ]);
            const [u, b] = peers;
            refusedRow(w, b, await keyOf());
            await w.start();
            u.hooks.toPeer = () => null;
            const coordinator = w.run();
            await w.until(() => parked(w, b), "B parked");
            expect(w.stateOf(u)).toBe("asking");
            const before = coordinator.debug().trustTriggers.scopesContained;
            await w.clock.advanceSettled(5000);
            await w.until(() => w.stateOf(b) === "contained", "B contained");
            expect(w.stateOf(u)).toBe("unconfirmed");
            expect(coordinator.debug().trustTriggers.scopesContained).toBe(
                before + 1
            );
            await w.until(() => coordinator.satisfied(), "satisfied");
        });

        it("an excluded peer never counts", async () => {
            const { w, peers } = await aclWorldWith([["X"], ["B"]]);
            const [x, b] = peers;
            refusedRow(w, b, await keyOf());
            await w.start();
            // X's headers come late and claim an empty set over a non-empty
            // set hash: excluded-inconsistent, with no trust result.
            x.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 1000 : 0);
            x.hooks.toJ = (m) => {
                if (m instanceof HeaderV1) m.count = 0;
                return m;
            };
            const coordinator = w.run();
            await w.until(
                () =>
                    parked(w, b) &&
                    w.record(b).session?.state(TRUST) === "contained",
                "B parked, its own trust contained"
            );
            await settle();
            expect(w.stateOf(x)).toBe("asking");
            expect(w.scopeDebug(b)!.untrusted).toBe(0);
            const before = coordinator.debug().trustTriggers.scopesContained;
            await w.clock.advanceSettled(1000);
            await w.until(() => w.stateOf(b) === "contained", "B contained");
            expect(w.stateOf(x)).toBe("excluded-inconsistent");
            expect(coordinator.debug().trustTriggers.scopesContained).toBe(
                before + 1
            );
            expect(w.record(b).results.get(NS)?.explainedBy).toEqual({
                "rejected-untrusted": 1,
            });
            await w.until(() => coordinator.satisfied(), "satisfied");
        });
    });

    it("C2: a header-qualified donor qualifies only with an identity J trusts at the current epoch; granted, revoked and unreadable", async () => {
        const { w, trust, peers } = await aclWorldWith([["R"]]);
        const [r] = peers;
        trust.trusted.delete(r.hash);
        await w.start();
        const coordinator = w.run();
        await w.until(() => w.record(r).identity === "untrusted", "checked");
        expect(w.stateOf(r)).toBe("contained");
        // `qualified` keeps its header meaning; the predicate reads both.
        expect(w.record(r).qualified).toBe(true);
        expect(coordinator.satisfied()).toBe(false);
        const status = w.status();
        expect(status.state).toBe("no-qualified-donor");
        expect(status.contained).toEqual([
            expect.objectContaining({
                peer: r.hash,
                qualified: false,
                identity: "untrusted",
            }),
        ]);
        expect(describeReadiness(status)).toBe(
            `no-qualified-donor: 1 peer contained, none qualified: ${r.hash} (creator, untrusted identity)`
        );
        expect(coordinator.debug().armedTimers).toBe(0);

        // Granted: one trust change qualifies it.
        trust.trusted.add(r.hash);
        coordinator.trustChanged();
        expect(w.record(r).identity).toBe("checking");
        expect(coordinator.satisfied()).toBe(false);
        await w.until(() => coordinator.satisfied(), "satisfied");
        expect(w.status().contained[0]).toMatchObject({
            qualified: true,
            identity: "trusted",
        });

        // Revoked again.
        trust.trusted.delete(r.hash);
        coordinator.trustChanged();
        await w.until(() => w.record(r).identity === "untrusted", "revoked");
        expect(coordinator.satisfied()).toBe(false);

        // A read that throws is untrusted.
        trust.trusted.add(r.hash);
        trust.throwing.add(r.hash);
        coordinator.trustChanged();
        await w.until(
            () => w.record(r).trustCheckedAt === coordinator.debug().trustEpoch,
            "checked at epoch 3"
        );
        expect(w.record(r).identity).toBe("untrusted");
        expect(coordinator.satisfied()).toBe(false);
    });

    it("C2: the identity is R's own key: a record whose key hashes to another peer is untrusted whatever J's graph says", async () => {
        const { w, trust, peers } = await aclWorldWith([["R"]]);
        const [r] = peers;
        const other = await keyOf();
        w.transport.subscribed.set(r.hash, other);
        trust.isTrusted = async () => true;
        await w.start();
        const coordinator = w.run();
        await w.until(() => w.record(r).identity === "untrusted", "checked");
        expect(w.record(r).key?.hashcode()).toBe(other.hashcode());
        expect(coordinator.satisfied()).toBe(false);
    });

    it("C2: the proof records the predicate's view: a header-qualified donor J does not trust is not qualified there either", async () => {
        const { w, trust, peers } = await aclWorldWith([["R"]]);
        const [r] = peers;
        trust.trusted.delete(r.hash);
        await w.start();
        const coordinator = w.run();
        await w.until(() => w.record(r).identity === "untrusted", "checked");
        expect(w.record(r).qualified).toBe(true);
        expect(w.status().contained[0].qualified).toBe(false);
        // Each record also carries the identity verdict it was qualified
        // against (G4-2), and no `untrusted` when it explained nothing by
        // trust.
        expect(
            coordinator
                .proof()
                .contained.map(({ scope, qualified, identity }) => ({
                    scope,
                    qualified,
                    identity,
                }))
        ).toEqual([
            { scope: "namespace-v1", qualified: false, identity: "untrusted" },
            { scope: "trust-v1", qualified: false, identity: "untrusted" },
        ]);
        for (const record of coordinator.proof().contained) {
            expect(record).not.toHaveProperty("untrusted");
        }
        trust.trusted.add(r.hash);
        coordinator.trustChanged();
        // While the check at the new epoch runs, the proof states no
        // identity: it was not checked at this epoch.
        expect(w.record(r).identity).toBe("checking");
        for (const record of coordinator.proof().contained) {
            expect(record).not.toHaveProperty("identity");
        }
        await w.until(() => coordinator.satisfied(), "satisfied");
        expect(
            coordinator.proof().contained.map(({ qualified, identity }) => ({
                qualified,
                identity,
            }))
        ).toEqual([
            { qualified: true, identity: "trusted" },
            { qualified: true, identity: "trusted" },
        ]);
    });

    it("C2: with more records than the proof holds, the cut keeps the donor the predicate counted, ahead of newer replicas J does not trust", async () => {
        const w = await World.create({ trust: true });
        const untrusted: Peer[] = [];
        for (let i = 0; i < PROOF_MAX_RECORDS; i++) {
            untrusted.push(await w.peer(`U${i}`));
        }
        const donor = await w.peer("D");
        w.rows([w.j, ...untrusted, donor], 4, "c");
        w.rows([w.j, ...untrusted, donor], 2, "tc", 1000, TRUST);
        // Each unauthorized replica holds one newer row J accepts, so its
        // snapshot hlc is above the donor's.
        untrusted.forEach((peer, i) => w.rows([peer], 1, `n${i}-`, 9000 + i));
        w.trust!.trusted.add(donor.hash);
        await w.start();
        const coordinator = w.run();
        await w.until(() => coordinator.satisfied(), "satisfied", 200_000);
        expect(
            w
                .status()
                .contained.filter(({ qualified }) => qualified)
                .map(({ peer }) => peer)
        ).toEqual([donor.hash]);
        const proof = coordinator.proof();
        expect(proof.contained).toHaveLength(PROOF_MAX_RECORDS);
        expect(
            proof.contained
                .filter(({ qualified }) => qualified)
                .map(({ peer, scope }) => ({ peer, scope }))
        ).toEqual([
            { peer: donor.hash, scope: "namespace-v1" },
            { peer: donor.hash, scope: "trust-v1" },
        ]);
    });

    describe("C3: a contained record whose rejected-untrusted signer may be trusted now", () => {
        /** R contained with one row explained by trust; J satisfied. */
        const explained = async () => {
            const { w, trust, peers } = await aclWorldWith([["R"]]);
            const [r] = peers;
            const writer = await keyOf();
            const row = refusedRow(w, r, writer);
            await w.start();
            const coordinator = w.run();
            await w.until(() => coordinator.satisfied(), "satisfied");
            expect(w.record(r).results.get(NS)?.untrusted).toMatchObject({
                heads: 1,
            });
            // The proof states that exposure (design 2.3, G4-2): the
            // namespace record explained one head by trust; the trust
            // record explained none.
            const proof = coordinator.proof();
            expect(
                proof.contained.find(({ scope }) => scope === "namespace-v1")
            ).toMatchObject({
                peer: r.hash,
                identity: "trusted",
                untrusted: 1,
            });
            expect(
                proof.contained.find(({ scope }) => scope === "trust-v1")
            ).not.toHaveProperty("untrusted");
            return { w, trust, r, writer, row, coordinator };
        };

        it("reachable: its results go and it is asked again on both scopes with a fresh chain", async () => {
            const { w, trust, r, writer, row, coordinator } = await explained();
            trust.trusted.add(writer.hashcode());
            w.rejected.delete(row.head);
            // The new session's pull is held, so the reopened record shows.
            let open!: () => void;
            w.joinGate = new Promise<void>((resolve) => (open = resolve));
            coordinator.trustChanged();
            await w.until(
                () =>
                    w.sessionsOf(r).length === 2 &&
                    w.stateOf(r) === "reconciling",
                "asked again"
            );
            const record = w.record(r);
            expect(record.results.size).toBe(0);
            expect(record.qualified).toBe(false);
            expect(record.identity).toBeUndefined();
            const second = w.sessionsOf(r)[1];
            expect(second.init.scopes).toEqual([NS, TRUST]);
            expect(second.init.ladder).toEqual({
                stage: "first",
                fetchRenewed: false,
                renewals: 0,
            });
            expect(coordinator.satisfied()).toBe(false);
            open();
            await w.until(() => coordinator.satisfied(), "satisfied again");
            expect(w.record(r).results.get(NS)?.explainedBy).toEqual({});
            expect(w.record(r).results.get(NS)?.untrusted).toBeUndefined();
            expect(w.jIndex().get(row.id!)).toBe(row.head);
        });

        it("departed: left, with the rows it explained by trust as its gap", async () => {
            const { w, trust, r, writer, coordinator } = await explained();
            w.transport.reachable.set(r.hash, false);
            w.transport.emit({
                kind: "reachability",
                source: "disconnect",
                peer: r.hash,
            });
            await settle();
            expect(w.stateOf(r)).toBe("contained");
            expect(w.record(r).departed).toBe(true);
            trust.trusted.add(writer.hashcode());
            coordinator.trustChanged();
            await w.until(() => w.stateOf(r) === "left", "left");
            expect(w.record(r).gap).toEqual({ missing: 1 });
            expect(w.record(r).results.size).toBe(0);
            expect(w.status().gaps).toEqual([{ peer: r.hash, missing: 1 }]);
            expect(coordinator.proof().gaps).toEqual([
                { peer: r.hash, missing: 1 },
            ]);
            expect(coordinator.satisfied()).toBe(false);
            expect(w.sessionsOf(r)).toHaveLength(1);
        });

        it("a re-check that throws reopens it too", async () => {
            const { w, trust, r, writer, coordinator } = await explained();
            trust.throwing.add(writer.hashcode());
            coordinator.trustChanged();
            await w.until(() => w.sessionsOf(r).length === 2, "asked again");
            await settle(100);
            // The new session cannot read the writer either: the row is
            // pulled again once, then waits (never explained on a throw).
            expect(w.stateOf(r)).toBe("reconciling");
            expect(w.scopeDebug(r)).toMatchObject({
                trustPending: 1,
                untrusted: 0,
            });
            expect(coordinator.satisfied()).toBe(false);
        });

        it("a trust change between R's C2 and the digest's match: R is contained only once J indexes the row, never satisfied without it", async () => {
            const { w, trust, peers } = await aclWorldWith([["R"]]);
            const [r] = peers;
            const writer = await keyOf();
            const row = refusedRow(w, r, writer);
            await w.start();
            // R's namespace C2 with the provisional row in E: its digest
            // waits (in production a worker round trip).
            const lanes = w.j.scope(NS).laneSet;
            const digestNow = lanes.digestNow.bind(lanes);
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            let held = false;
            lanes.digestNow = (sub, add) => {
                const answer = digestNow(sub, add);
                if (held || (add?.length ?? 0) === 0) return answer;
                held = true;
                return {
                    seq: answer.seq,
                    digest: answer.digest.then(async (digest) => {
                        await gate;
                        return digest;
                    }),
                };
            };
            const coordinator = w.run();
            await w.until(() => held, "R's C2 with the row in E");
            expect(w.scopeDebug(r)!.untrusted).toBe(1);
            // The writer's grant reaches J's graph while the digest is out.
            trust.trusted.add(writer.hashcode());
            w.rejected.delete(row.head);
            coordinator.trustChanged();
            await w.until(() => {
                const debug = w.scopeDebug(r);
                return debug?.untrusted === 0 && !debug.trustChecking;
            }, "the pass moved the row back to D");
            release();
            await w.until(() => coordinator.satisfied(), "satisfied");
            expect(w.jIndex().get(row.id!)).toBe(row.head);
            const result = w.record(r).results.get(NS)!;
            expect(result.explainedBy).toEqual({});
            expect(result.untrusted).toBeUndefined();
            expect(result.certificates).toBe(2);
        });

        it("a reopen while R's qualification session runs: the record leaves the qualification, and is contained and qualified again", async () => {
            const { w, trust, peers } = await aclWorldWith([
                ["G", { provenance: GATED }],
            ]);
            const [g] = peers;
            const writer = await keyOf();
            const row = refusedRow(w, g, writer);
            await w.start();
            const coordinator = w.run();
            await w.until(
                () =>
                    w.stateOf(g) === "contained" &&
                    w.record(g).identity === "trusted",
                "G contained and checked"
            );
            const record = w.record(g);
            expect(record.qualified).toBe(false);
            expect(record.results.get(NS)?.untrusted).toMatchObject({
                heads: 1,
            });
            // G turns ready; its qualification session's headers come late.
            g.provenance = RECONCILED;
            g.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 1000 : 0);
            g.responder.sendNotice([w.j.key], NOTICE_REASON.READY);
            await w.until(
                () => record.sessionsOpened === 2 && record.qualifying,
                "qualification session"
            );
            // The writer is trusted now: the record reopens mid-qualification.
            trust.trusted.add(writer.hashcode());
            w.rejected.delete(row.head);
            coordinator.trustChanged();
            await w.until(() => record.sessionsOpened === 3, "reopened");
            expect(record.qualifying).toBe(false);
            expect(record.results.size).toBe(0);
            expect(record.state).toBe("asking");
            await w.clock.advanceSettled(1000);
            await w.until(() => coordinator.satisfied(), "satisfied");
            expect(record).toMatchObject({
                state: "contained",
                qualified: true,
                identity: "trusted",
            });
            expect(w.jIndex().get(row.id!)).toBe(row.head);
            expect(coordinator.debug().armedTimers).toBe(0);
        });
    });

    it("C5: a record check in flight is waiting-trust with nothing armed; it completes and J is satisfied", async () => {
        const { w, trust, peers } = await aclWorldWith([["R"]]);
        const [r] = peers;
        await w.start();
        const release = trust.hold();
        const coordinator = w.run();
        await w.until(() => w.stateOf(r) === "contained", "R contained");
        await settle();
        expect(coordinator.satisfied()).toBe(false);
        const status = w.status();
        expect(status.state).toBe("waiting-trust");
        expect(status.trustChecking).toEqual([r.hash]);
        expect(status.trustPending).toEqual([]);
        expect(status.contained[0]).toMatchObject({
            qualified: false,
            identity: "checking",
        });
        expect(describeReadiness(status)).toBe(
            `waiting-trust: checking J's trust graph for 1 contained peer: ${r.hash}`
        );
        expect(coordinator.debug()).toMatchObject({
            armedTimers: 0,
            trustChecks: 1,
        });
        release();
        await w.until(() => coordinator.satisfied(), "satisfied");
        expect(coordinator.debug().trustChecks).toBe(0);
        expect(w.status().trustChecking).toEqual([]);
    });

    it("C6: a trust change moves the epoch and re-checks; a check overtaken by another change runs again; after finish nothing", async () => {
        const { w, trust, peers } = await aclWorldWith([["R"]]);
        const [r] = peers;
        await w.start();
        const coordinator = w.run();
        await w.until(() => coordinator.satisfied(), "satisfied");
        expect(coordinator.debug().trustEpoch).toBe(0);
        const asked = () => trust.calls.filter((hash) => hash === r.hash);
        const before = asked().length;
        const release = trust.hold();
        coordinator.trustChanged();
        expect(coordinator.debug()).toMatchObject({
            trustEpoch: 1,
            trustChecks: 1,
        });
        expect(w.record(r).identity).toBe("checking");
        expect(coordinator.satisfied()).toBe(false);
        await settle();
        // Another change while the read of epoch 1 is held.
        coordinator.trustChanged();
        release();
        await w.until(() => coordinator.satisfied(), "satisfied at epoch 2");
        expect(w.record(r).trustCheckedAt).toBe(2);
        // The read of epoch 1 was discarded, one more ran at epoch 2.
        expect(asked().length - before).toBe(2);
        expect(coordinator.debug().trustTriggers.change).toBe(2);
        // Ready: trust changes are ignored, readiness is never withdrawn.
        coordinator.finish();
        trust.trusted.delete(r.hash);
        coordinator.trustChanged();
        await settle();
        expect(coordinator.debug().trustEpoch).toBe(2);
        expect(w.record(r).identity).toBe("trusted");
    });

    it("C6: a re-check overtaken by a trust change never acts on the old graph's answer", async () => {
        const { w, trust, peers } = await aclWorldWith([["R"]]);
        const [r] = peers;
        const writer = await keyOf();
        refusedRow(w, r, writer);
        await w.start();
        // Verdicts of the graph each read started on.
        const graph = new Set(trust.trusted);
        let held: Promise<void> | undefined;
        trust.isTrusted = async (key) => {
            const trusted = graph.has(key.hashcode());
            trust.calls.push(key.hashcode());
            await held;
            return trusted;
        };
        const coordinator = w.run();
        await w.until(() => coordinator.satisfied(), "satisfied");
        let release!: () => void;
        held = new Promise<void>((resolve) => (release = resolve));
        // A grant that a second change revokes while the first re-check
        // reads: its "trusted" belongs to a graph that is gone.
        graph.add(writer.hashcode());
        coordinator.trustChanged();
        await settle();
        graph.delete(writer.hashcode());
        coordinator.trustChanged();
        held = undefined;
        release();
        await w.until(() => coordinator.satisfied(), "satisfied at epoch 2");
        expect(w.record(r).trustCheckedAt).toBe(2);
        // Never reopened on the stale reversal.
        expect(w.sessionsOf(r)).toHaveLength(1);
        expect(w.record(r).results.get(NS)?.untrusted?.heads).toBe(1);
    });

    it("C6: a result that lands after dispose is ignored", async () => {
        const { w, trust, peers } = await aclWorldWith([["R"]]);
        const [r] = peers;
        await w.start();
        const coordinator = w.run();
        await w.until(() => coordinator.satisfied(), "satisfied");
        const release = trust.hold();
        coordinator.trustChanged();
        await settle();
        coordinator.dispose();
        release();
        await settle();
        expect(w.record(r).trustCheckedAt).toBe(0);
        expect(w.record(r).identity).toBe("checking");
        expect(coordinator.debug().trustChecks).toBe(0);
    });

    it("C7 (M2): a real session's namespace run parked for trust while its trust run still pulls is waiting-trust, named with its count", async () => {
        const { w, peers } = await aclWorldWith([["R"]]);
        const [r] = peers;
        refusedRow(w, r, await keyOf());
        const [grant] = w.rows([r], 1, "tx", 5000, TRUST);
        await w.start();
        let open!: () => void;
        w.scopeGates.set(
            TRUST,
            new Promise<void>((resolve) => (open = resolve))
        );
        const coordinator = w.run();
        await w.until(
            () => parked(w, r) && w.scopeDebug(r, TRUST)?.state === "draining",
            "namespace parked, trust pulling"
        );
        await settle();
        const status = w.status();
        expect(status.state).toBe("waiting-trust");
        expect(status.trustPending).toEqual([{ peer: r.hash, hashes: 1 }]);
        expect(describeReadiness(status)).toBe(
            `waiting-trust: 1 hash wait for J's trust graph, named by 1 of 1 required peer: ${r.hash}`
        );
        expect(coordinator.debug().armedTimers).toBe(0);
        expect(w.scopeDebug(r)!.untrusted).toBe(0);
        open();
        await w.until(() => coordinator.satisfied(), "satisfied");
        expect(w.record(r).results.get(NS)?.explainedBy).toEqual({
            "rejected-untrusted": 1,
        });
        expect(w.j.scope(TRUST).index.get(grant.id!)?.head).toBe(grant.head);
    });

    it("C7: a namespace run that waits only for a lookup's retry, nothing parked for trust, is reconciling, in an access-controlled store and in open mode", async () => {
        for (const acl of [true, false]) {
            const { w, peers } = acl
                ? await aclWorldWith([["R"]])
                : await worldWith([["R"]]);
            const [r] = peers;
            const [row] = w.rows([r], 1, "lookup-", 5000);
            w.j.scope(NS).throwing.add(row.head);
            await w.start();
            const coordinator = w.run();
            await w.until(
                () =>
                    w.scopeDebug(r)?.retry === 1 &&
                    (!acl || w.record(r).session?.state(TRUST) === "contained"),
                "a retry hash only"
            );
            await settle();
            expect(w.scopeDebug(r)).toMatchObject({
                state: "draining",
                pending: 1,
                retry: 1,
                failed: 0,
                trustPending: 0,
            });
            expect(w.record(r).fetchWaiting).toBe(false);
            expect(w.status().state).toBe("reconciling");
            w.j.scope(NS).throwing.delete(row.head);
            w.record(r).session!.resume();
            await w.until(() => coordinator.satisfied(), "satisfied");
        }
    });

    describe("C9: a session that waits only for trust frees its slot (G2-4)", () => {
        /** One row of a revoked writer on each of `holders`, refused by J. */
        const revokedRow = async (w: World, holders: Peer[]) => {
            const [row] = w.rows(holders, 1, "w-", 5000);
            w.rejected.set(row.head, {
                permanent: false,
                reason: "untrusted",
                signers: [await keyOf()],
            });
            return row;
        };

        it("more Required peers than slots, each holding the row: four parked sessions let the fifth peer in, and every row is explained", async () => {
            const names = ["A", "B", "C", "D", "E"];
            expect(names.length).toBeGreaterThan(SESSIONS_IN_FLIGHT);
            const { w, peers } = await aclWorldWith(
                names.map((name) => [name] as [string])
            );
            await revokedRow(w, peers);
            await w.start();
            const fifth = peers[SESSIONS_IN_FLIGHT];
            // The fifth peer's trust header takes a slow route.
            fifth.hooks.delayToJ = (m) =>
                m instanceof HeaderV1 && m.scope === TRUST ? 1000 : 0;
            const coordinator = w.run();
            await w.until(
                () => peers.every((peer) => parked(w, peer)),
                "every namespace run parked"
            );
            await settle();
            expect(coordinator.debug()).toMatchObject({
                sessions: names.length,
                inFlight: 1,
                queued: 0,
            });
            const status = w.status();
            expect(status.state).toBe("waiting-trust");
            expect(status.trustPending).toHaveLength(names.length);
            expect(describeReadiness(status)).toMatch(
                /^waiting-trust: 5 hashes wait for J's trust graph, named by 5 of 5 required peers: /
            );
            await w.clock.advanceSettled(1000);
            await w.until(() => coordinator.satisfied(), "satisfied");
            for (const peer of peers) {
                expect(w.record(peer).results.get(NS)?.explainedBy).toEqual({
                    "rejected-untrusted": 1,
                });
            }
            expect(coordinator.debug().armedTimers).toBe(0);
        });

        it("four parked sessions and a fifth peer without the row: a clean subscriber, or a replicator row that never answers", async () => {
            for (const fifth of [
                ["E"],
                ["U", { subscriber: false, replicator: true }],
            ] as Array<[string, PeerOptions?]>) {
                const { w, peers } = await aclWorldWith([
                    ["A"],
                    ["B"],
                    ["C"],
                    ["D"],
                    fifth,
                ]);
                const holders = peers.slice(0, SESSIONS_IN_FLIGHT);
                await revokedRow(w, holders);
                await w.start();
                const other = peers[SESSIONS_IN_FLIGHT];
                if (fifth[1]) other.hooks.toPeer = () => null;
                const coordinator = w.run();
                await w.until(
                    () => w.sessionsOf(other).length === 1,
                    "the fifth peer asked"
                );
                // A confirm-only row gets its one attempt.
                await w.clock.advanceSettled(5000);
                await w.until(() => coordinator.satisfied(), "satisfied");
                expect(w.stateOf(other)).toBe(
                    fifth[1] ? "unconfirmed" : "contained"
                );
                for (const peer of holders) {
                    expect(w.record(peer).results.get(NS)?.explainedBy).toEqual(
                        { "rejected-untrusted": 1 }
                    );
                }
            }
        });

        it("a BUSY peer whose notice is lost is re-asked once a session parks for its trust scope (B3)", async () => {
            const { w, peers } = await aclWorldWith([["A"], ["B"]]);
            const [a, b] = peers;
            await revokedRow(w, peers);
            await w.start();
            // B's first OPEN is answered BUSY; its notice never comes.
            b.refuse = { code: ERROR_CODE.BUSY, times: 1 };
            const coordinator = w.run();
            await w.until(() => coordinator.satisfied(), "satisfied");
            expect(w.sessionsOf(b)).toHaveLength(2);
            for (const peer of [a, b]) {
                expect(w.record(peer).results.get(NS)?.explainedBy).toEqual({
                    "rejected-untrusted": 1,
                });
            }
            expect(coordinator.debug().armedTimers).toBe(0);
        });
    });

    it("C10: a trust row nobody served in two sessions while the namespace run waits for trust: waiting-fetch, and R's sign of life retries the pull", async () => {
        const { w, peers } = await aclWorldWith([["D"]]);
        const [d] = peers;
        refusedRow(w, d, await keyOf());
        const [grant] = w.rows([d], 1, "grant-", 5000, TRUST);
        w.unserved.add(grant.head);
        await w.start();
        const coordinator = w.run();
        await w.until(
            () =>
                w.record(d).sessionsOpened === 2 &&
                w.scopeDebug(d, TRUST)?.state === "failed-fetch-wait" &&
                parked(w, d),
            "the trust fetch failed twice, the namespace run parked"
        );
        await settle();
        expect(w.record(d)).toMatchObject({
            state: "reconciling",
            fetchWaiting: true,
        });
        const status = w.status();
        expect(status.state).toBe("waiting-fetch");
        expect(status.fetchPending).toEqual([{ peer: d.hash, hashes: 1 }]);
        expect(coordinator.debug()).toMatchObject({
            armedTimers: 0,
            inFlight: 0,
        });
        const joins = w.joins.length;
        w.unserved.delete(grant.head);
        // D's sign of life retries the failed pull (design 4.5 step 8).
        w.transport.emit({ kind: "subscribe", peer: d.hash, key: d.key });
        await w.until(() => coordinator.satisfied(), "satisfied");
        expect(w.joins.length).toBeGreaterThan(joins);
        expect(w.record(d).sessionsOpened).toBe(2);
        expect(w.j.scope(TRUST).index.get(grant.id!)?.head).toBe(grant.head);
        expect(w.record(d).results.get(NS)?.explainedBy).toEqual({
            "rejected-untrusted": 1,
        });
    });

    it("C8: an open-mode store keeps commit 2: no trust port, no trust fields, and a trust change only reclassifies", async () => {
        const { w, peers } = await worldWith([["S"], ["D"]]);
        const [s, d] = peers;
        await w.start();
        s.hooks.toPeer = () => null;
        const coordinator = w.run();
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        const status = w.status();
        expect(status).not.toHaveProperty("trustPending");
        expect(status).not.toHaveProperty("trustChecking");
        expect(status.contained[0]).not.toHaveProperty("identity");
        expect(w.record(d).identity).toBeUndefined();
        // Nor does its proof carry the access-controlled fields (G4-2).
        for (const record of coordinator.proof().contained) {
            expect(record).not.toHaveProperty("identity");
            expect(record).not.toHaveProperty("untrusted");
        }
        const [session] = w.sessionsOf(s);
        const reclassify = vi.spyOn(session, "reclassify");
        coordinator.trustChanged();
        expect(reclassify).toHaveBeenCalledTimes(1);
        expect(coordinator.debug()).toMatchObject({
            trustEpoch: 1,
            trustChecks: 0,
            trustTriggers: { change: 1, scopesContained: 0 },
        });
        expect(w.record(d).identity).toBeUndefined();
        expect(w.record(d).trustCheckedAt).toBeUndefined();
    });

    it("an ACL join without J's trust view, or a trust view without the trust scope, faults: gated and named", async () => {
        {
            const { w } = await worldWith([["D"]]);
            await w.start();
            const coordinator = w.run({ scopes: [NS, TRUST] });
            await settle();
            expect(coordinator.satisfied()).toBe(false);
            expect(w.status().fault).toBe("no trust view");
            expect(w.sessions).toHaveLength(0);
        }
        {
            const { w } = await worldWith([["D"]]);
            await w.start();
            const coordinator = w.run({ trust: new FakeTrust() });
            await settle();
            expect(coordinator.satisfied()).toBe(false);
            expect(w.status().fault).toBe("no trust scope");
            expect(w.sessions).toHaveLength(0);
        }
    });

    it("describeReadiness names the hashes waiting for trust, the peers being checked, and an untrusted identity", () => {
        const base: ReadinessStatus = {
            state: "waiting-trust",
            satisfied: false,
            required: ["a", "b"],
            contained: [],
            excluded: [],
            silent: [],
            inFlight: [],
            busy: [],
            fetchPending: [],
            gaps: [],
            unconfirmed: [],
        };
        expect(
            describeReadiness({
                ...base,
                trustPending: [
                    { peer: "a", hashes: 10 },
                    { peer: "b", hashes: 2 },
                ],
            })
        ).toBe(
            "waiting-trust: 12 hashes wait for J's trust graph, named by 2 of 2 required peers: a, b"
        );
        expect(
            describeReadiness({
                ...base,
                required: [],
                trustPending: [],
                trustChecking: ["c", "d"],
            })
        ).toBe(
            "waiting-trust: checking J's trust graph for 2 contained peers: c, d"
        );
        expect(
            describeReadiness({
                ...base,
                state: "no-qualified-donor",
                required: [],
                contained: [
                    {
                        peer: "c",
                        qualified: false,
                        source: "reconciled",
                        scopes: ["namespace-v1", "trust-v1"],
                        departed: false,
                        identity: "untrusted",
                    },
                    {
                        peer: "d",
                        qualified: false,
                        source: "none",
                        scopes: ["namespace-v1", "trust-v1"],
                        departed: false,
                        identity: "trusted",
                    },
                ],
            })
        ).toBe(
            "no-qualified-donor: 2 peers contained, none qualified: c (reconciled, untrusted identity), d (none)"
        );
    });

    describe("scripted sessions", () => {
        /** An ACL world whose sessions are `ScriptedSession`s. */
        const scriptedAcl = async (peers: Array<[string, PeerOptions?]>) => {
            const { w, trust, peers: out } = await aclWorldWith(peers, 0);
            const made: ScriptedSession[] = [];
            const coordinator = w.run({
                createSession: (init, ports) => {
                    const session = new ScriptedSession(init, ports);
                    made.push(session);
                    return session as unknown as JoinerSession;
                },
            });
            await settle();
            const of = (peer: FakePeer) =>
                made.filter((session) => session.peer === peer.hash);
            return { w, trust, peers: out, coordinator, of };
        };

        afterEach(() => {
            // Scripted containment has no oracle record.
            for (const w of World.created) {
                for (const record of w.coordinator?.records() ?? []) {
                    w.checked.add(record.hash);
                }
            }
        });

        it("C4: a contained record without a trust result, or whose trust result comes from an earlier session than its namespace result, is never satisfied", async () => {
            {
                const { w, peers, coordinator, of } = await scriptedAcl([
                    ["R"],
                ]);
                const [r] = peers;
                const [session] = of(r);
                expect(session.init.scopes).toEqual([NS, TRUST]);
                session.finish({
                    kind: "contained",
                    results: [session.result(true)],
                });
                await w.until(
                    () => w.record(r).identity === "trusted",
                    "checked"
                );
                expect(coordinator.satisfied()).toBe(false);
            }
            {
                const { w, peers, coordinator, of } = await scriptedAcl([
                    ["R"],
                ]);
                const [r] = peers;
                const [first] = of(r);
                // Trust kept from session 1, namespace from session 2: a
                // path the session never takes (a namespace renewal reopens
                // trust), so the clause fails closed.
                first.finish({
                    kind: "renew",
                    reason: "fetch-failed",
                    list: false,
                    scopes: [NS],
                    results: [first.result(true, "creator", TRUST)],
                });
                await settle();
                const [, second] = of(r);
                second.finish({
                    kind: "contained",
                    results: [second.result(true)],
                });
                await w.until(
                    () => w.record(r).identity === "trusted",
                    "checked"
                );
                expect([...w.record(r).results.keys()].sort()).toEqual([
                    NS,
                    TRUST,
                ]);
                expect(coordinator.satisfied()).toBe(false);
            }
            {
                // The control: both from one session.
                const { w, peers, coordinator, of } = await scriptedAcl([
                    ["R"],
                ]);
                const [r] = peers;
                const [session] = of(r);
                session.finish({
                    kind: "contained",
                    results: [
                        session.result(true),
                        session.result(true, "creator", TRUST),
                    ],
                });
                await w.until(() => coordinator.satisfied(), "satisfied");
            }
        });

        it("C2: a record with no key has an untrusted identity", async () => {
            const { w, peers, coordinator, of } = await scriptedAcl([
                ["N", { subscriber: false, replicator: true }],
            ]);
            const [n] = peers;
            const [session] = of(n);
            session.finish({
                kind: "contained",
                results: [
                    session.result(true),
                    session.result(true, "creator", TRUST),
                ],
            });
            await w.until(
                () => w.record(n).identity === "untrusted",
                "checked"
            );
            expect(w.record(n).key).toBeUndefined();
            expect(coordinator.satisfied()).toBe(false);
            expect(w.status().state).toBe("no-qualified-donor");
        });
    });
});

/** The library's `src/` directory: product frames in a stack. */
const SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * Records every real timer armed from product code (`src/index.ts` and
 * `src/readiness/`) until `restore()`. The world's coordinator, sessions
 * and responders arm on its fake clock, so a real timer here is the host's
 * own.
 */
const watchProductTimers = () => {
    const armed: string[] = [];
    const spies = (["setTimeout", "setInterval"] as const).map((name) => {
        const original = globalThis[name] as (...args: any[]) => any;
        return vi.spyOn(globalThis, name).mockImplementation(((
            ...args: any[]
        ) => {
            const limit = Error.stackTraceLimit;
            Error.stackTraceLimit = 50;
            const stack = new Error().stack ?? "";
            Error.stackTraceLimit = limit;
            if (
                stack.includes(`${SRC}index.ts`) ||
                stack.includes(`${SRC}readiness/`)
            ) {
                armed.push(name);
            }
            return original(...args);
        }) as any);
    });
    return {
        armed,
        restore: () => {
            for (const spy of spies) spy.mockRestore();
        },
    };
};

/**
 * The host's half of the decision (index.ts, PR-3 commit 4): what the
 * deleted write-readiness-scheduler.isolated.test.ts pinned for the
 * tracker, now for `startReadinessJoin`, `markWriteReady` and
 * `commitWriteReady`. A SharedFileSystem holds the fields they read; its
 * sidecar write, Guard D and telemetry are stubs. Its runtime is a stub
 * whose `startJoin` keeps the JoinOptions the host passed and, given a
 * world, starts that world's real coordinator wired as
 * `ReadinessRuntime.startJoin` wires it (the host's phase clause, its
 * decision as `decide`, `markReady` finishing the coordinator). No fake
 * clock: the host decision has no timer, and the cases assert that.
 */
describe("host decision (index.ts)", () => {
    const GENERATION = 7;
    const LIFECYCLE = 3;
    /** The stub runtime's proof when no world runs. */
    const PROOF: Proof = {
        v: 1,
        scopes: ["namespace-v1"],
        contained: [
            {
                peer: "donor",
                scope: "namespace-v1",
                source: "creator",
                qualified: true,
                count: 3,
                hlc: "1002",
                anchor: "ab".repeat(32),
            },
        ],
        excluded: [],
        gaps: [],
    };
    const RECONCILED_PATCH = (proof: Proof) => ({
        writeReady: true,
        writeReadySource: "reconciled",
        bootstrap: null,
        proof,
        hlcProved: hlcProvedOf(proof),
    });

    /**
     * A ReadinessRuntime whose join ran `coordinator`, with `state` over its
     * own fields: what the host's decision reads through the runtime's real
     * `proofIfSatisfied`, not a copy of it.
     */
    const runtimeOver = (
        coordinator: Coordinator,
        state: {
            blockedValue?: boolean;
            disposedValue?: boolean;
            joinFault?: string;
        } = {}
    ): ReadinessRuntime =>
        Object.assign(Object.create(ReadinessRuntime.prototype), {
            coordinatorValue: coordinator,
            blockedValue: false,
            disposedValue: false,
            joinFault: undefined,
            ...state,
        });

    const host = (w?: World) => {
        const program: any = new SharedFileSystem();
        Object.assign(program, {
            openGeneration: GENERATION,
            lifecycleRequestGeneration: LIFECYCLE,
            writeReadinessLifecycleBlocked: false,
            writeReadinessRequired: true,
            writesReady: false,
            viewProven: false,
            writeReadinessDecisionSettled: true,
            writeReadinessTransitionChain: Promise.resolve(),
            dropRequests: 0,
            bootstrapPhase: "off",
            replicate: { factor: 1 },
            clock: vi.fn(() => Date.now()),
        });
        // What the flip had done when the sidecar write began.
        const atWrite: Array<{ writesReady: boolean; guard: number }> = [];
        program.writeBootstrapState = vi.fn(async () => {
            atWrite.push({
                writesReady: program.writesReady,
                guard: program.setGuardArmed.mock.calls.length,
            });
        });
        program.setGuardArmed = vi.fn();
        program.emitWriteReadyOnce = vi.fn();
        program.emitReadinessSession = vi.fn();
        program.bootstrapStatus = vi.fn(() => ({
            writeReady: program.writesReady,
        }));
        const join = {
            /** The stub predicate when no world runs. */
            satisfied: true,
            options: undefined as JoinOptions | undefined,
            coordinator: undefined as Coordinator | undefined,
        };
        program.readinessRuntime = {
            startJoin: vi.fn((options: JoinOptions) => {
                join.options = options;
                if (!w) return;
                join.coordinator = w.run({
                    phaseSettled: () => options.phaseSettled(),
                    decide: () => options.onSatisfied(),
                });
            }),
            proofIfSatisfied: vi.fn((): Proof | undefined => {
                const coordinator = join.coordinator;
                if (!coordinator) return join.satisfied ? PROOF : undefined;
                // The runtime's own read, over the world's coordinator.
                return runtimeOver(coordinator).proofIfSatisfied();
            }),
            evaluate: vi.fn(() => join.coordinator?.evaluate()),
            markReady: vi.fn(() => join.coordinator?.finish()),
            status: vi.fn(() => undefined),
        };
        const waiter = { resolve: vi.fn(), reject: vi.fn() };
        program.writeReadinessWaiters = [waiter];
        const events: unknown[] = [];
        program.events.addEventListener("write:ready", (event: any) =>
            events.push(event.detail)
        );
        /** A transition that holds the serialized slot until released. */
        const holdSlot = () => {
            let release!: () => void;
            program.writeReadinessTransitionChain = new Promise<void>(
                (resolve) => (release = resolve)
            );
            return release;
        };
        return { program, join, waiter, events, atWrite, holdSlot };
    };

    it("a satisfied evaluation decides at once: the proof persisted first, then the flip; no clock read, no timer armed", async () => {
        const { w, peers } = await worldWith([["D"]]);
        const [d] = peers;
        await w.start();
        const { program, join, waiter, events, atWrite } = host(w);
        const timers = watchProductTimers();
        try {
            program.startReadinessJoin(GENERATION, 0n);
            const coordinator = join.coordinator!;
            await w.until(() => program.writesReady, "J ready");
            await settle();

            // One sidecar write, durable (failOnError), with the proof of
            // the records the predicate read, before anything flipped.
            expect(program.writeBootstrapState).toHaveBeenCalledTimes(1);
            const [patch, generation, failOnError] =
                program.writeBootstrapState.mock.calls[0];
            expect(generation).toBe(GENERATION);
            expect(failOnError).toBe(true);
            expect(patch).toEqual(RECONCILED_PATCH(coordinator.proof()));
            expect(patch.proof.contained).toEqual([
                expect.objectContaining({
                    peer: d.hash,
                    scope: "namespace-v1",
                    source: "creator",
                    qualified: true,
                }),
            ]);
            expect(patch.hlcProved).toBeGreaterThan(0n);
            expect(atWrite).toEqual([{ writesReady: false, guard: 0 }]);
            expect(
                program.readinessRuntime.proofIfSatisfied
            ).toHaveBeenCalledTimes(1);
            // Then memory, Guard D, telemetry, the runtime, the event and
            // the waiters.
            expect(program).toMatchObject({
                writesReady: true,
                writeReadinessRequired: false,
                viewProven: true,
                writeReadinessSource: "reconciled",
            });
            expect(program.setGuardArmed).toHaveBeenCalledWith(true);
            expect(program.emitWriteReadyOnce).toHaveBeenCalledWith(
                "reconciled"
            );
            expect(program.readinessRuntime.markReady).toHaveBeenCalledTimes(1);
            expect(coordinator.phase).toBe("finished");
            expect(events).toHaveLength(1);
            expect(waiter.resolve).toHaveBeenCalledTimes(1);
            expect(waiter.reject).not.toHaveBeenCalled();

            // At once: no fake time passed, the host read no clock and
            // armed no timer; one satisfied evaluation, one decision.
            expect(w.clock.now).toBe(0);
            expect(program.clock).not.toHaveBeenCalled();
            expect(timers.armed).toEqual([]);
            expect(w.evaluations.filter((e) => e.satisfied)).toEqual([
                { satisfied: true, changed: true },
            ]);
            expect(coordinator.debug()).toMatchObject({
                armedTimers: 0,
                decisions: { started: 1, failed: 0, inFlight: false },
            });
        } finally {
            timers.restore();
        }
    });

    it("decides only on a satisfied evaluation; then it flips at once", async () => {
        const { w, peers } = await worldWith([["D"]]);
        const [d] = peers;
        await w.start();
        d.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 1000 : 0);
        const { program, join } = host(w);
        program.startReadinessJoin(GENERATION, 0n);
        const coordinator = join.coordinator!;
        await settle();
        // D has not answered: not satisfied, so nothing is decided.
        expect(coordinator.satisfied()).toBe(false);
        expect(coordinator.debug().decisions.started).toBe(0);
        expect(
            program.readinessRuntime.proofIfSatisfied
        ).not.toHaveBeenCalled();
        expect(program.writeBootstrapState).not.toHaveBeenCalled();
        expect(program.writesReady).toBe(false);

        // Its header arrives: the evaluation that holds decides.
        await w.clock.advanceSettled(1000);
        await w.until(() => program.writesReady, "J ready");
        expect(w.clock.now).toBe(1000);
        expect(program.writeBootstrapState).toHaveBeenCalledTimes(1);
        expect(program.readinessRuntime.markReady).toHaveBeenCalledTimes(1);
        expect(coordinator.debug().decisions).toMatchObject({
            started: 1,
            failed: 0,
        });
    });

    it("settling the bootstrap decision re-evaluates; satisfied then, it decides", async () => {
        // Both peers called bootstrap(): discovery waits out its deadline,
        // so the decision settles after D was contained.
        const { w, peers } = await worldWith([["D"]]);
        const [d] = peers;
        await w.start();
        const { program, join } = host(w);
        program.writeReadinessDecisionSettled = false;
        let settleDecision!: () => void;
        program.trackBootstrapDecision(
            new Promise<void>((resolve) => (settleDecision = resolve)),
            GENERATION,
            LIFECYCLE
        );
        program.startReadinessJoin(GENERATION, 0n);
        const coordinator = join.coordinator!;
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        await settle();
        // Everything but the phase clause holds: gated, nothing decided.
        expect(coordinator.satisfied()).toBe(false);
        expect(coordinator.debug().decisions.started).toBe(0);
        expect(
            coordinator.status({
                writeReady: false,
                phaseSettled: program.readinessPhaseSettled(),
            })
        ).toMatchObject({ state: "waiting-phase", satisfied: false });
        expect(program.writeBootstrapState).not.toHaveBeenCalled();

        settleDecision();
        await w.until(() => program.writesReady, "J ready");
        expect(program.writeReadinessDecisionSettled).toBe(true);
        // The #403 hook re-evaluated; nothing else had to happen.
        expect(program.readinessRuntime.evaluate).toHaveBeenCalledTimes(1);
        expect(coordinator.debug().decisions).toMatchObject({
            started: 1,
            failed: 0,
        });
        expect(w.clock.now).toBe(0);
    });

    it("a phase change re-evaluates (M8): satisfied before its overlay retires, J turns ready at the change", async () => {
        const { w, peers } = await worldWith([["D"]]);
        const [d] = peers;
        await w.start();
        const { program, join } = host(w);
        program.bootstrapPhase = "overlay-active";
        program.startReadinessJoin(GENERATION, 0n);
        const coordinator = join.coordinator!;
        await w.until(() => w.stateOf(d) === "contained", "D contained");
        await settle();
        expect(coordinator.satisfied()).toBe(false);
        expect(coordinator.debug().decisions.started).toBe(0);

        program.setBootstrapPhase("converged");
        expect(program.bootstrapPhase).toBe("converged");
        await w.until(() => program.writesReady, "J ready");
        expect(program.readinessRuntime.evaluate).toHaveBeenCalledTimes(1);
        expect(program.writeBootstrapState).toHaveBeenCalledTimes(1);
    });

    it("starts one join per open generation with the sidecar's hlcProved, the host's phase clause and its telemetry", () => {
        const { program, join } = host();
        const startJoin = program.readinessRuntime.startJoin;
        // A start of an older generation, or of an open that needs none.
        program.startReadinessJoin(GENERATION - 1, 5n);
        expect(startJoin).not.toHaveBeenCalled();
        program.startReadinessJoin(GENERATION, 42n);
        expect(startJoin).toHaveBeenCalledTimes(1);
        const options = join.options!;
        expect(options.hlcProved).toBe(42n);
        // An open-mode store: no trust view.
        expect(options).not.toHaveProperty("trust");

        // The phase clause (design 4.8): decision settled, phase off or
        // converged.
        for (const [phase, settled] of [
            ["off", true],
            ["converged", true],
            ["fetching", false],
            ["overlay-active", false],
            ["unverified", false],
        ] as const) {
            program.bootstrapPhase = phase;
            expect(options.phaseSettled(), phase).toBe(settled);
        }
        program.bootstrapPhase = "off";
        program.writeReadinessDecisionSettled = false;
        expect(options.phaseSettled()).toBe(false);
        program.writeReadinessDecisionSettled = true;

        // Every phase change after open's reset is a trigger (M8).
        program.setBootstrapPhase("unverified");
        expect(program.bootstrapPhase).toBe("unverified");
        expect(program.readinessRuntime.evaluate).toHaveBeenCalledTimes(1);

        // A session's record goes to telemetry, for this generation only.
        const record: ReadinessSessionRecord = {
            peer: "donor",
            scope: "namespace-v1",
            mode: "fast",
            count: 3,
            gapEst: 0,
            cells: 0,
            missingAtStart: 0,
            pulled: 0,
            explained: 0,
            explainedBy: {},
            recoveries: 0,
            roundTrips: 1,
            durationMs: 2.5,
            qualified: true,
            source: "creator",
        };
        options.onSession!(record);
        expect(program.emitReadinessSession).toHaveBeenCalledWith(record);
        program.openGeneration = GENERATION + 1;
        options.onSession!(record);
        expect(program.emitReadinessSession).toHaveBeenCalledTimes(1);

        program.writeReadinessRequired = false;
        program.startReadinessJoin(GENERATION + 1, 0n);
        expect(startJoin).toHaveBeenCalledTimes(1);
    });

    it("ignores a decision settled for an older lifecycle or open", () => {
        const { program } = host();
        program.writeReadinessDecisionSettled = false;
        program.startReadinessJoin(GENERATION, 0n);
        program.settleWriteReadinessDecision(GENERATION, LIFECYCLE - 1);
        program.settleWriteReadinessDecision(GENERATION - 1, LIFECYCLE);
        expect(program.writeReadinessDecisionSettled).toBe(false);
        expect(program.readinessRuntime.evaluate).not.toHaveBeenCalled();
        program.settleWriteReadinessDecision(GENERATION, LIFECYCLE);
        expect(program.writeReadinessDecisionSettled).toBe(true);
        expect(program.readinessRuntime.evaluate).toHaveBeenCalledTimes(1);
    });

    it("a decision of an older generation never flips the reopened one; a decision once ready writes nothing", async () => {
        const { program, join } = host();
        program.startReadinessJoin(GENERATION, 0n);
        const old = join.options!;
        // A reopen: the next generation's join.
        program.openGeneration = GENERATION + 1;
        program.lifecycleRequestGeneration = LIFECYCLE + 1;
        program.startReadinessJoin(GENERATION + 1, 0n);
        const current = join.options!;
        expect(current).not.toBe(old);

        await old.onSatisfied();
        expect(
            program.readinessRuntime.proofIfSatisfied
        ).not.toHaveBeenCalled();
        expect(program.writeBootstrapState).not.toHaveBeenCalled();
        expect(program.writesReady).toBe(false);
        await program.markWriteReady(GENERATION);
        expect(program.writeBootstrapState).not.toHaveBeenCalled();

        await current.onSatisfied();
        expect(program.writesReady).toBe(true);
        expect(program.writeBootstrapState).toHaveBeenCalledTimes(1);
        expect(program.writeBootstrapState).toHaveBeenCalledWith(
            RECONCILED_PATCH(PROOF),
            GENERATION + 1,
            true
        );

        // Ready already: a later satisfied evaluation decides nothing.
        await current.onSatisfied();
        expect(program.writeBootstrapState).toHaveBeenCalledTimes(1);
        expect(program.readinessRuntime.markReady).toHaveBeenCalledTimes(1);
    });

    it("a failed sidecar write leaves J gated with Guard D disarmed and nothing armed; the next satisfied evaluation writes again and flips (M9)", async () => {
        const { w, peers } = await worldWith([["D"]]);
        const [d] = peers;
        await w.start();
        const { program, join } = host(w);
        const write = program.writeBootstrapState;
        program.writeBootstrapState = vi
            .fn()
            .mockRejectedValueOnce(new Error("simulated marker failure"))
            .mockImplementation(write);
        const timers = watchProductTimers();
        try {
            program.startReadinessJoin(GENERATION, 0n);
            const coordinator = join.coordinator!;
            await w.until(
                () => coordinator.debug().decisions.failed === 1,
                "the write failed"
            );
            await settle();
            expect(program.writeBootstrapState).toHaveBeenCalledTimes(1);
            expect(program.writeBootstrapState.mock.calls[0][0]).toMatchObject({
                writeReady: true,
                writeReadySource: "reconciled",
            });
            // Gated, Guard D disarmed, the runtime not told, the waiter
            // still waiting.
            expect(program.writesReady).toBe(false);
            expect(program.writeReadinessSource).toBeUndefined();
            expect(program.setGuardArmed).not.toHaveBeenCalled();
            expect(program.readinessRuntime.markReady).not.toHaveBeenCalled();
            expect(program.writeReadinessWaiters).toHaveLength(1);
            // Nothing armed to retry it: no host timer, no clock read, and
            // the coordinator holds none.
            expect(timers.armed).toEqual([]);
            expect(program.clock).not.toHaveBeenCalled();
            expect(coordinator.debug()).toMatchObject({
                armedTimers: 0,
                decisions: {
                    started: 1,
                    failed: 1,
                    inFlight: false,
                    lastError: "simulated marker failure",
                },
            });
            expect(coordinator.satisfied()).toBe(true);

            // The next trigger: the evaluation holds unchanged and the
            // decision runs again, writes and flips.
            w.transport.emit({ kind: "subscribe", peer: d.hash, key: d.key });
            await w.until(() => program.writesReady, "J ready");
            expect(w.evaluations.filter((e) => e.satisfied)).toEqual([
                { satisfied: true, changed: true },
                { satisfied: true, changed: false },
            ]);
            expect(program.writeBootstrapState).toHaveBeenCalledTimes(2);
            expect(program.writeBootstrapState.mock.calls[1][0]).toEqual(
                RECONCILED_PATCH(coordinator.proof())
            );
            expect(program.setGuardArmed).toHaveBeenCalledWith(true);
            expect(program.readinessRuntime.markReady).toHaveBeenCalledTimes(1);
            expect(coordinator.debug().decisions).toMatchObject({
                started: 2,
                failed: 1,
            });
            expect(timers.armed).toEqual([]);
            expect(w.clock.now).toBe(0);
        } finally {
            timers.restore();
        }
    });

    it("decides in its serialized slot: a predicate lost before the slot writes and flips nothing", async () => {
        const { program, join, holdSlot } = host();
        program.startReadinessJoin(GENERATION, 0n);
        const release = holdSlot();
        const deciding = join.options!.onSatisfied();
        // A new Required peer appears after the evaluation, before the
        // slot runs: the slot reads the predicate again.
        join.satisfied = false;
        release();
        await deciding;
        expect(program.readinessRuntime.proofIfSatisfied).toHaveBeenCalledTimes(
            1
        );
        expect(program.writeBootstrapState).not.toHaveBeenCalled();
        expect(program.writesReady).toBe(false);
        expect(program.setGuardArmed).not.toHaveBeenCalled();
        expect(program.readinessRuntime.markReady).not.toHaveBeenCalled();
    });

    it("the runtime's decision read: the predicate and its proof at one point; nothing while it fails, or when blocked, disposed or faulted", async () => {
        const { w, peers } = await worldWith([["D"]]);
        const [d] = peers;
        await w.start();
        d.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 1000 : 0);
        const coordinator = w.run();
        const runtime = runtimeOver(coordinator);
        await settle();
        expect(w.stateOf(d)).toBe("asking");
        expect(coordinator.satisfied()).toBe(false);
        expect(runtime.proofIfSatisfied()).toBeUndefined();

        await w.clock.advanceSettled(1000);
        await w.until(() => coordinator.satisfied(), "satisfied");
        const proof = runtime.proofIfSatisfied();
        expect(proof).toEqual(coordinator.proof());
        expect(proof!.contained).toEqual([
            expect.objectContaining({ peer: d.hash, qualified: true }),
        ]);
        for (const state of [
            { blockedValue: true },
            { disposedValue: true },
            { joinFault: "coordinator: test" },
        ]) {
            expect(
                runtimeOver(coordinator, state).proofIfSatisfied()
            ).toBeUndefined();
        }
    });

    it("decides in its serialized slot over the runtime's read: a peer Required before the slot runs flips nothing, and its answer then decides", async () => {
        const { w, peers } = await worldWith([
            ["D"],
            ["R", { subscriber: false }],
        ]);
        const [d, r] = peers;
        await w.start();
        // Once visible, R stays asking until its header lands.
        r.hooks.delayToJ = (m) => (m instanceof HeaderV1 ? 1000 : 0);
        const { program, join, holdSlot } = host(w);
        const release = holdSlot();
        program.startReadinessJoin(GENERATION, 0n);
        const coordinator = join.coordinator!;
        await w.until(
            () => coordinator.debug().decisions.inFlight,
            "a decision waiting for the slot"
        );
        expect(coordinator.satisfied()).toBe(true);

        // R appears after the satisfied evaluation, before the slot runs.
        w.transport.subscribed.set(r.hash, r.key);
        w.transport.emit({ kind: "subscribe", peer: r.hash, key: r.key });
        await w.until(() => w.stateOf(r) === "asking", "R asking");
        expect(coordinator.satisfied()).toBe(false);
        expect(w.status().required).toEqual([r.hash]);
        release();
        await w.until(
            () => !coordinator.debug().decisions.inFlight,
            "the decision settled"
        );
        await settle();
        // Design 2.2(2): read at the moment of the decision, the predicate
        // fails, so nothing is persisted and nothing flips.
        expect(program.readinessRuntime.proofIfSatisfied).toHaveBeenCalledTimes(
            1
        );
        expect(program.writeBootstrapState).not.toHaveBeenCalled();
        expect(program.writesReady).toBe(false);
        expect(program.setGuardArmed).not.toHaveBeenCalled();
        expect(program.readinessRuntime.markReady).not.toHaveBeenCalled();
        expect(coordinator.debug().decisions).toMatchObject({
            started: 1,
            failed: 0,
            inFlight: false,
        });

        // R's answer is the next trigger: J contains it and decides, with a
        // proof of both peers.
        await w.clock.advanceSettled(1000);
        await w.until(() => program.writesReady, "J ready");
        expect(w.stateOf(r)).toBe("contained");
        expect(program.writeBootstrapState).toHaveBeenCalledTimes(1);
        const [patch] = program.writeBootstrapState.mock.calls[0];
        expect(patch).toEqual(RECONCILED_PATCH(coordinator.proof()));
        expect(
            patch.proof.contained
                .map((record: { peer: string }) => record.peer)
                .sort()
        ).toEqual([d.hash, r.hash].sort());
        expect(coordinator.debug().decisions).toMatchObject({
            started: 2,
            failed: 0,
        });
    });

    it("a lifecycle block between the evaluation and the slot: no write, no flip, the predicate not even read", async () => {
        const { program, join, holdSlot } = host();
        program.startReadinessJoin(GENERATION, 0n);
        const release = holdSlot();
        const deciding = join.options!.onSatisfied();
        program.writeReadinessLifecycleBlocked = true;
        release();
        await deciding;
        expect(
            program.readinessRuntime.proofIfSatisfied
        ).not.toHaveBeenCalled();
        expect(program.writeBootstrapState).not.toHaveBeenCalled();
        expect(program.writesReady).toBe(false);
        expect(program.readinessRuntime.markReady).not.toHaveBeenCalled();
    });
});
