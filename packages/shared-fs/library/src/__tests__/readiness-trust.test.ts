import { deserialize, serialize } from "@dao-xyz/borsh";
import { Ed25519Keypair, type PublicSignKey } from "@peerbit/crypto";
import {
    ExchangeHeadsMessage,
    RawExchangeHeadsMessage,
    SharedLog,
    StashBackedRawExchangeHeadsMessage,
} from "@peerbit/shared-log";
import { IdentityRelation, TrustedNetwork } from "@peerbit/trusted-network";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    SharedFsWriteReadyTimeoutError,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";
import {
    Coordinator,
    SESSIONS_IN_FLIGHT,
    describeReadiness,
} from "../readiness/coordinator.js";
import { headDigest } from "../readiness/digest.js";
import { ReadinessRuntime, logIdOf } from "../readiness/runtime.js";
import {
    NAMESPACE_V1,
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    TRUST_V1,
    type ScopeId,
} from "../readiness/scopes.js";
import { JoinerSession, type SessionResult } from "../readiness/session.js";
import { documentsIndexPort } from "../readiness/tap.js";
import { HeaderV1, OpenV1, type ReadinessMessage } from "../readiness/wire.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * The joiner's trust-scope design tests on in-process Peerbit peers, real
 * filesystems and access-controlled (ACL) stores, in the prerequisite mode
 * of PR-3 commit 3 (M1 plan 7.3 item 3, SPEC3 9.6; WRITE_READINESS_V2.md
 * section 8): tests 34, 35, 36 (split as 36a and 36b, G3-17), 37, 42 and 55
 * (55a and 55b, G3-16), the S8 attach rule, the M1 ACL gap and the M2 trust
 * reclassify of the commit 3 handoff, R's identity turning trusted by a
 * trust change (I1), the scopes an ACL join opens (R1) and its fault
 * without J's trust view (R2).
 *
 * In prerequisite mode today's tracker still decides when a fresh full
 * address-open turns ready, and `markWriteReady` additionally requires the
 * coordinator's `satisfied()`. So ready implies containment: the tests read
 * J's maintained set inside the `write:ready` dispatch and containment from
 * `bootstrapStatus().readiness`, the coordinator's records and its proof.
 * They assert readiness only where the tracker's own conditions hold (a
 * live qualified donor with rows of its own, and no row J refuses for
 * good); everywhere else they assert the coordinator's half. A donor that
 * holds a revoked writer's rows (tests 35, 37) is the case that matters
 * here: sync keeps re-requesting the rows J refuses, so the tracker's
 * `synchronizerIdle()` stays false for a minute or more after the
 * coordinator is satisfied. Those tests read the coordinator's half at its
 * first satisfied evaluation, with a quiet window the test outlives.
 *
 * Fault injection stays in the test, patched by name, filtered by node and
 * log id, and undone after each test:
 * - `withholdTrustSync`: J's trust `SharedLog.onMessage` drops exchange
 *   heads (plain, raw and stash-backed), so the readiness pull is the only
 *   way a trust row reaches J. The shared-log `responseHandler` calls
 *   `this.onMessage` late (`@peerbit/shared-log` 16.0.40
 *   `dist/src/index.js:12324`), so a prototype patch installed before J
 *   opens holds sync back from the first message on;
 * - `gateTrustPulls`: J's trust `SharedLog.join` (the readiness pull's only
 *   call into the log, `ports.ts` `sharedLogPullPorts`) waits for the test.
 *   The pull queue arms no timer of its own (its timeout is the join's), so
 *   the gate never fails a pull;
 * - `disableTrustWarmup`: `TrustedNetwork.isTrusted`'s remote warmup
 *   (`controller.js:286-294`) is a second delivery path. A decoded instance
 *   never fires it (`_lastWarmupAt` undefined, G3-14); J's is disabled
 *   explicitly all the same;
 * - `holdOpens`: a donor's responder holds OPENs (as `readiness-join`);
 * - `holdTrustStart`: a donor's trust `ScopeState.started` becomes a getter
 *   the test holds; the responder reads it inside one freeze, after the
 *   namespace snapshot (`responder.ts` `freezeOnce`);
 * - partitions by a connection gater, as `readiness-join` test 5;
 * - S8: J's runtime first attaches its trust tap to a decoded copy of the
 *   trust store, so the instance `TrustedNetwork.open` returns differs from
 *   the one the tap attached to (a swap inside open deadlocks on Peerbit's
 *   opening reservation of the parent's child addresses).
 */

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime | undefined =>
    (fs.program as any).readinessRuntime;
const programOf = (fs: SharedFsHandle): any => fs.program;
const entriesOf = (fs: SharedFsHandle): any => programOf(fs).entries;
const trustStoreOf = (fs: SharedFsHandle): any =>
    programOf(fs).trustGraph.trustGraph;
const hashOf = (peer: Peerbit) => peer.identity.publicKey.hashcode();
const keyOf = (peer: Peerbit) => peer.identity.publicKey;
const readinessOf = (fs: SharedFsHandle) => fs.bootstrapStatus().readiness;
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;
/** Keys by hashcode, for comparing decoded and original instances. */
const hashesOf = (keys: readonly PublicSignKey[] | undefined) =>
    keys?.map((key) => key.hashcode());

const coordinatorOf = (fs: SharedFsHandle): Coordinator => {
    const coordinator = runtimeOf(fs)?.coordinator;
    if (!coordinator) throw new Error("no coordinator runs for this open");
    return coordinator;
};

/** The result of `scope` of the session that contained `peer`, if any. */
const resultOf = (
    fs: SharedFsHandle,
    peer: Peerbit,
    scope: ScopeId = SCOPE_NAMESPACE_V1
): SessionResult | undefined =>
    coordinatorOf(fs).record(hashOf(peer))?.results.get(scope);

/** A scope's debug in `peer`'s live session (the namespace scope by default). */
const liveScopeOf = (
    fs: SharedFsHandle,
    peer: Peerbit,
    scope: ScopeId = SCOPE_NAMESPACE_V1
) => coordinatorOf(fs).record(hashOf(peer))?.session?.debug().scopes[scope];

const waitUntil = async (
    assertion: () => Promise<void> | void,
    timeoutMs = process.env.CI ? 60_000 : 30_000
) => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    throw lastError;
};

/** `awaitWriteReady` with `timeout`, which must time out. */
const timeoutOf = async (fs: SharedFsHandle, timeout: number) => {
    const error = await fs.awaitWriteReady({ timeout }).then(
        () => {
            throw new Error("awaitWriteReady resolved");
        },
        (error: unknown) => error
    );
    expect(error).toBeInstanceOf(SharedFsWriteReadyTimeoutError);
    return error as SharedFsWriteReadyTimeoutError;
};

/**
 * The rows of `scope` in `fs`'s index (id to head), read through the tap's
 * own index port, so the ids are the ones containment compares; trust ids
 * (bytes) as hex.
 */
const rowsOf = async (
    fs: SharedFsHandle,
    scope: typeof NAMESPACE_V1 | typeof TRUST_V1 = NAMESPACE_V1
) => {
    const store = scope === NAMESPACE_V1 ? entriesOf(fs) : trustStoreOf(fs);
    const port = documentsIndexPort(store, scope);
    const rows = new Map<string, string>();
    for await (const page of port.scan()) {
        for (const row of page) {
            rows.set(
                typeof row.key === "string"
                    ? row.key
                    : Buffer.from(row.key).toString("hex"),
                row.head
            );
        }
    }
    return rows;
};
const namespaceRows = (fs: SharedFsHandle) => rowsOf(fs, NAMESPACE_V1);
const trustRows = (fs: SharedFsHandle) => rowsOf(fs, TRUST_V1);

/** The ids of `rows` whose entry in `fs`'s namespace log `key` signed. */
const rowsSignedBy = async (
    fs: SharedFsHandle,
    rows: ReadonlyMap<string, string>,
    key: PublicSignKey
) => {
    const log = entriesOf(fs).log.log;
    const signed = new Set<string>();
    for (const [id, head] of rows) {
        const entry = await log.get(head);
        if (!entry) throw new Error(`no entry for the row ${id}`);
        const keys: PublicSignKey[] = await entry.getPublicKeys();
        if (keys.some((signer) => signer.equals(key))) signed.add(id);
    }
    return signed;
};

/**
 * The ids of `rows` whose head `fs`'s namespace tap does not hold, read
 * synchronously. The tap adds a head only from the index's change event,
 * so a head it holds is one J's index held.
 */
const missingFromTap = (
    fs: SharedFsHandle,
    rows: ReadonlyMap<string, string>
): string[] => {
    const tap = runtimeOf(fs)?.namespace;
    if (!tap) return [...rows.keys()];
    const missing: string[] = [];
    for (const [key, head] of rows) {
        const slot = tap.map.get(key);
        if (!(slot >= 0 && tap.map.headEquals(slot, headDigest(head)))) {
            missing.push(key);
        }
    }
    return missing.sort();
};

/**
 * Runs `capture` inside `fs`'s `write:ready` dispatch: the flip is visible
 * and nothing else has run since the decision's sidecar write.
 */
const atReady = <T>(fs: SharedFsHandle, capture: () => T): Promise<T> =>
    new Promise((resolve, reject) => {
        programOf(fs).events.addEventListener(
            "write:ready",
            () => {
                try {
                    resolve(capture());
                } catch (error) {
                    reject(error);
                }
            },
            { once: true }
        );
    });

/**
 * Runs `capture` in the coordinator's first evaluation that finds it
 * satisfied (the host's decision point; `ports.onEvaluate`), or at once if
 * it already is.
 */
const atSatisfied = <T>(fs: SharedFsHandle, capture: () => T): Promise<T> => {
    const coordinator = coordinatorOf(fs);
    if (coordinator.satisfied()) return Promise.resolve().then(capture);
    const ports = coordinator.ports as any;
    const onEvaluate = ports.onEvaluate;
    return new Promise((resolve, reject) => {
        ports.onEvaluate = (evaluation: { satisfied: boolean }) => {
            if (evaluation.satisfied) {
                ports.onEvaluate = onEvaluate;
                try {
                    resolve(capture());
                } catch (error) {
                    reject(error);
                }
            }
            return onEvaluate?.(evaluation);
        };
    });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `promise`, or a rejection naming `what` after `ms`. */
const within = <T>(promise: Promise<T>, ms: number, what: string) =>
    Promise.race([
        promise,
        sleep(ms).then(() => {
            throw new Error(`${what} within ${ms} ms`);
        }),
    ]);

/** A promise and its resolve. */
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
};

/** The object on `target`'s prototype chain that defines `name`. */
const ownerOf = (target: object, name: string): any => {
    for (let owner: any = target; owner; owner = Object.getPrototypeOf(owner)) {
        if (Object.hasOwn(owner, name)) return owner;
    }
    throw new Error(`no ${name} on the prototype chain`);
};

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array) =>
    a instanceof Uint8Array &&
    a.length === b.length &&
    a.every((byte, i) => byte === b[i]);

/** `log` is `peer`'s shared log of the store whose log id is `logId`. */
const isLogOf = (log: any, peer: Peerbit, logId: Uint8Array) =>
    log?.node?.identity?.publicKey?.hashcode?.() === hashOf(peer) &&
    sameBytes(log?.log?.id, logId);

/**
 * Holds every OPEN `donor`'s responder receives (a busy peer that holds the
 * store and stays reachable) until `release`, which delivers them in order.
 */
const holdOpens = (donor: SharedFsHandle) => {
    const responder = runtimeOf(donor)!.responder!;
    const onMessage = responder.onMessage;
    const held: Array<[ReadinessMessage, PublicSignKey | undefined]> = [];
    let holding = true;
    responder.onMessage = (message, from) => {
        if (holding && message instanceof OpenV1) {
            held.push([message, from]);
            return;
        }
        onMessage.call(responder, message, from);
    };
    return {
        get held() {
            return held.length;
        },
        release: () => {
            if (!holding) return;
            holding = false;
            responder.onMessage = onMessage;
            for (const [message, from] of held.splice(0)) {
                onMessage.call(responder, message, from);
            }
        },
    };
};

/** Every `HeaderV1` `donor`'s responder sends, with its recipient. */
const recordHeaders = (donor: SharedFsHandle) => {
    const ports = (runtimeOf(donor)!.responder as any).ports;
    const send = ports.send;
    const headers: Array<{ header: HeaderV1; to: string }> = [];
    ports.send = (message: ReadinessMessage, to: PublicSignKey | string) => {
        if (message instanceof HeaderV1) {
            headers.push({
                header: message,
                to: typeof to === "string" ? to : to.hashcode(),
            });
        }
        return send(message, to);
    };
    return { headers, restore: () => (ports.send = send) };
};

describe("readiness trust scope (in-process, prerequisite mode)", () => {
    const peers: Peerbit[] = [];
    /** Undone first in afterEach: held gates, patched prototypes, hooks. */
    const restores: Array<() => void> = [];

    afterEach(async () => {
        for (const restore of restores.splice(0).reverse()) {
            try {
                restore();
            } catch {
                // Best effort; the peers stop next either way.
            }
        }
        await stopTestPeers(peers);
    });

    type Node = { peer: Peerbit; fs: SharedFsHandle };

    const createPeer = async (options: { connectionGater?: object } = {}) => {
        const peer = await Peerbit.create(
            options.connectionGater
                ? ({
                      libp2p: { connectionGater: options.connectionGater },
                  } as any)
                : undefined
        );
        peers.push(peer);
        return peer;
    };

    /**
     * A peer that refuses connections to and from the peers in `refused`
     * once they are added (a partition, as in multi-peer.test.ts).
     */
    const partitionablePeer = async () => {
        const refused = new Set<string>();
        const deny = (peerId: unknown) => refused.has(String(peerId));
        const peer = await createPeer({
            connectionGater: {
                denyDialPeer: deny,
                denyOutboundConnection: deny,
                denyInboundEncryptedConnection: deny,
                denyOutboundEncryptedConnection: deny,
                denyInboundUpgradedConnection: deny,
                denyOutboundUpgradedConnection: deny,
            },
        });
        return { peer, refused };
    };

    /**
     * Cuts `node` off from `others`. A block put announces its provider to
     * the dialed bootstraps and would dial again (readiness-join test 5), so
     * nobody involved announces to any.
     */
    const partition = async (
        node: { peer: Peerbit; refused: Set<string> },
        others: Peerbit[]
    ) => {
        for (const peer of [node.peer, ...others]) {
            peer.services.fanout.setBootstraps([]);
        }
        for (const other of others) node.refused.add(other.peerId.toString());
        for (const other of others) {
            await node.peer.hangUp(other.identity.publicKey).catch(() => {});
            await other.hangUp(node.peer.identity.publicKey).catch(() => {});
        }
        await waitUntil(() => {
            for (const other of others) {
                expect(
                    node.peer.libp2p.getConnections(other.peerId)
                ).toHaveLength(0);
            }
        });
    };

    const stopPeer = async (peer: Peerbit) => {
        const index = peers.indexOf(peer);
        if (index >= 0) peers.splice(index, 1);
        await peer.stop();
    };

    const OWNER_FILE = { path: "/owner.txt", content: "from the owner" };
    const WRITER_FILES = [
        { path: "/writer-a.txt", content: "first from the writer" },
        { path: "/writer-b.txt", content: "second from the writer" },
    ];

    /**
     * The root owner O of an access-controlled store, with a file of its own
     * (a joiner's remote evidence for today's tracker).
     */
    const createOwner = async (label = "trust-owner"): Promise<Node> => {
        const peer = await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: label,
            rootKey: peer.identity.publicKey,
            gc: false,
        });
        await fs.writeFile(OWNER_FILE.path, OWNER_FILE.content);
        return { peer, fs };
    };

    /** A writer W dialed to `owner`, authorized by it (a partial writer). */
    const createWriter = async (
        owner: Node,
        label = "trust-writer"
    ): Promise<Node> => {
        const peer = await createPeer();
        await peer.dial(owner.peer);
        const fs = await openSharedFs({
            peerbit: peer,
            address: owner.fs.address,
            machineLabel: label,
            allowPartialWrites: true,
            gc: false,
        });
        await owner.fs.authorizeWriter(peer.identity.publicKey);
        return { peer, fs };
    };

    /** W writes `files` once its own graph trusts it; `owner` indexes them. */
    const writeAsWriter = async (
        writer: Node,
        owner: Node,
        files = WRITER_FILES
    ) => {
        await waitUntil(async () =>
            expect(await writer.fs.isTrustedWriter(keyOf(writer.peer))).toBe(
                true
            )
        );
        for (const { path, content } of files) {
            await writer.fs.writeFile(path, content);
        }
        await expectFiles(owner.fs, files);
    };

    /** `fs` reads every file of `files` with its content. */
    const expectFiles = async (
        fs: SharedFsHandle,
        files: Array<{ path: string; content: string }>
    ) =>
        waitUntil(async () => {
            for (const { path, content } of files) {
                expect(decode(await fs.readFile(path))).toBe(content);
            }
        });

    /**
     * A fresh full address-open of `donors[0]`'s filesystem, dialed to each
     * donor (none: the caller dials). `settleMs` is today's quiet window,
     * which the tracker keeps in prerequisite mode.
     */
    const joinOf = async (
        donors: Node[],
        options: { settleMs?: number; label?: string; peer?: Peerbit } = {}
    ): Promise<Node> => {
        const peer = options.peer ?? (await createPeer());
        for (const donor of donors) await peer.dial(donor.peer);
        const fs = await openSharedFs({
            peerbit: peer,
            address: donors[0].fs.address,
            machineLabel: options.label ?? "trust-joiner",
            bootstrap: false,
            gc: false,
            writeReadinessSettleMs: options.settleMs ?? 100,
        } as any);
        return { peer, fs };
    };

    /** A full replica of `donor` that joined it and turned ready (reconciled). */
    const readyReplica = async (donor: Node, label: string, peer?: Peerbit) => {
        const replica = await joinOf([donor], { label, peer });
        await replica.fs.awaitWriteReady({ timeout: 60_000 });
        expect(programOf(replica.fs).readinessProvenance()).toMatchObject({
            writeReady: true,
            source: "reconciled",
        });
        return replica;
    };

    /**
     * Drops the exchange heads `peer`'s shared log of `logId` receives, from
     * before it opens (see the file comment).
     */
    const withholdTrustSync = (peer: Peerbit, logId: Uint8Array) => {
        const owner = ownerOf(SharedLog.prototype, "onMessage");
        const onMessage = owner.onMessage;
        owner.onMessage = function (
            this: unknown,
            message: unknown,
            context: unknown
        ) {
            if (
                (message instanceof ExchangeHeadsMessage ||
                    message instanceof RawExchangeHeadsMessage ||
                    message instanceof StashBackedRawExchangeHeadsMessage) &&
                isLogOf(this, peer, logId)
            ) {
                return Promise.resolve();
            }
            return onMessage.call(this, message, context);
        };
        restores.push(() => (owner.onMessage = onMessage));
    };

    /**
     * Holds the joins `peer`'s shared log of `logId` starts (the readiness
     * pulls) until `release`.
     */
    const gateTrustPulls = (peer: Peerbit, logId: Uint8Array) => {
        const owner = ownerOf(SharedLog.prototype, "join");
        const join = owner.join;
        const gate = deferred();
        const reached = deferred();
        let held = 0;
        owner.join = async function (this: unknown, ...args: unknown[]) {
            if (isLogOf(this, peer, logId)) {
                held++;
                reached.resolve();
                await gate.promise;
            }
            return join.apply(this, args);
        };
        const release = () => gate.resolve();
        restores.push(() => {
            release();
            owner.join = join;
        });
        return {
            get held() {
                return held;
            },
            reached: reached.promise,
            release,
        };
    };

    /**
     * Every `TrustedNetwork` `peer` opens gets no remote warmup in
     * `isTrusted` (G3-14), so sync and the readiness pull are the only
     * deliveries of a trust row.
     */
    const disableTrustWarmup = (peer: Peerbit) => {
        const open = TrustedNetwork.prototype.open;
        TrustedNetwork.prototype.open = async function (
            this: any,
            ...args: any[]
        ) {
            if (this.node?.identity?.publicKey?.hashcode?.() === hashOf(peer)) {
                this._lastWarmupAt = Number.POSITIVE_INFINITY;
            }
            return open.apply(this, args as any);
        };
        restores.push(() => (TrustedNetwork.prototype.open = open));
    };

    /**
     * Records, at every call, the parked trust hashes of each session's
     * namespace run that `JoinerSession.prototype.reclassify` sees (the
     * spy point of M2 and test 34).
     */
    const spyReclassify = () => {
        const reclassify = JoinerSession.prototype.reclassify;
        const calls: Array<{ peer: string; trustPending: number }> = [];
        JoinerSession.prototype.reclassify = function (this: JoinerSession) {
            calls.push({
                peer: this.peer,
                trustPending:
                    this.debug().scopes[SCOPE_NAMESPACE_V1]?.trustPending ?? 0,
            });
            return reclassify.call(this);
        };
        restores.push(() => (JoinerSession.prototype.reclassify = reclassify));
        return calls;
    };

    /**
     * Trust first (SPEC3 2.4): at every session state change the
     * coordinator sees, a namespace run that holds `rejected-untrusted`
     * entries must belong to a session whose trust run is contained.
     * `promoted` counts the changes that showed such entries, so a test can
     * tell the check was not vacuous.
     */
    const watchPromotions = () => {
        const owner = ownerOf(Coordinator.prototype, "onSessionState");
        const onSessionState = owner.onSessionState;
        const seen = { promoted: 0, early: [] as string[] };
        owner.onSessionState = function (
            this: unknown,
            session: JoinerSession,
            ...rest: unknown[]
        ) {
            const namespace = session.debug().scopes[SCOPE_NAMESPACE_V1];
            if ((namespace?.untrusted ?? 0) > 0) {
                seen.promoted++;
                const trust = session.state(SCOPE_TRUST_V1);
                if (trust !== "contained") {
                    seen.early.push(`${session.peer}: trust run ${trust}`);
                }
            }
            return onSessionState.call(this, session, ...rest);
        };
        restores.push(() => (owner.onSessionState = onSessionState));
        return seen;
    };

    /**
     * Holds `donor`'s trust scope start, as its responder reads it inside a
     * freeze: the namespace scope is frozen first, so the getter's first
     * read comes after the namespace snapshot. Records that snapshot's count
     * at that read.
     */
    const holdTrustStart = (donor: SharedFsHandle) => {
        const runtime = runtimeOf(donor)!;
        const state = runtime.scope(SCOPE_TRUST_V1)! as any;
        const started: Promise<void> = state.started;
        const gate = deferred();
        const read = deferred();
        let reads = 0;
        let namespaceCount: number | undefined;
        Object.defineProperty(state, "started", {
            configurable: true,
            enumerable: true,
            get() {
                if (reads++ === 0) {
                    namespaceCount = (runtime.responder as any).snapshots.get(
                        SCOPE_NAMESPACE_V1
                    )?.count;
                    read.resolve();
                }
                return gate.promise.then(() => started);
            },
        });
        restores.push(() => {
            gate.resolve();
            Object.defineProperty(state, "started", {
                configurable: true,
                enumerable: true,
                writable: true,
                value: started,
            });
        });
        return {
            read: read.promise,
            get namespaceCount() {
                return namespaceCount;
            },
            release: gate.resolve,
        };
    };

    it("34 + M2: trust lag: W's rows wait as trust-pending (waiting-trust, no timer) until J's trust graph gains W's edge, then are pulled again and indexed, never rejected-untrusted", async () => {
        const owner = await createOwner();
        const writer = await createWriter(owner);
        await writeAsWriter(writer, owner);
        const writerKey = keyOf(writer.peer);
        await stopPeer(writer.peer);
        const ownerRows = await namespaceRows(owner.fs);
        const writerRows = await rowsSignedBy(owner.fs, ownerRows, writerKey);
        expect(writerRows.size).toBeGreaterThan(0);
        // The owner's trust scope holds W's edge, and only it.
        expect((await trustRows(owner.fs)).size).toBe(1);

        // J lacks the edge: no sync, no warmup, and its pull waits.
        const trustLogId = logIdOf(trustStoreOf(owner.fs));
        const joinerPeer = await createPeer();
        withholdTrustSync(joinerPeer, trustLogId);
        const pulls = gateTrustPulls(joinerPeer, trustLogId);
        disableTrustWarmup(joinerPeer);
        const reclassified = spyReclassify();
        const joiner = await joinOf([owner], { peer: joinerPeer });
        expect(programOf(joiner.fs).trustGraph._lastWarmupAt).toBe(
            Number.POSITIVE_INFINITY
        );
        const coordinator = coordinatorOf(joiner.fs);
        const ownerHash = hashOf(owner.peer);
        await pulls.reached;

        // W's rows are refused for trust and parked: not explained while
        // the owner's trust scope (which holds W's edge) is not contained.
        await waitUntil(() => {
            const namespace = liveScopeOf(joiner.fs, owner.peer);
            expect(namespace).toMatchObject({
                trustPending: writerRows.size,
                untrusted: 0,
            });
            expect(readinessOf(joiner.fs)).toMatchObject({
                state: "waiting-trust",
                satisfied: false,
                required: [ownerHash],
                trustPending: [{ peer: ownerHash, hashes: writerRows.size }],
                trustChecking: [],
            });
        });
        expect(coordinator.record(ownerHash)!.state).toBe("reconciling");
        expect(
            liveScopeOf(joiner.fs, owner.peer, SCOPE_TRUST_V1)?.state
        ).not.toBe("contained");
        expect(describeReadiness(readinessOf(joiner.fs)!)).toBe(
            `waiting-trust: ${writerRows.size} hashes wait for J's trust graph, named by 1 of 1 required peer: ${ownerHash}`
        );
        expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);
        // Waiting for trust arms nothing (G3-20).
        expect(runtimeOf(joiner.fs)!.debug().armedTimers).toBe(0);
        expect(await joiner.fs.isTrustedWriter(writerKey)).toBe(false);

        const triggers = coordinator.debug().trustTriggers;
        const callsBefore = reclassified.length;
        const flip = atReady(joiner.fs, () => ({
            missing: missingFromTap(joiner.fs, ownerRows),
            status: readinessOf(joiner.fs)!,
        }));
        pulls.release();
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });
        const atFlip = await flip;
        expect(atFlip.missing).toEqual([]);
        expect(atFlip.status).toMatchObject({
            state: "ready",
            satisfied: true,
            required: [],
            gaps: [],
            trustPending: [],
            trustChecking: [],
            contained: [
                {
                    peer: ownerHash,
                    qualified: true,
                    source: "creator",
                    scopes: ["namespace-v1", "trust-v1"],
                    departed: false,
                    identity: "trusted",
                },
            ],
        });
        // The edge's arrival was a trust change, and the owner's session
        // classified its parked hashes again while W's rows were parked.
        expect(coordinator.debug().trustTriggers.change).toBeGreaterThan(
            triggers.change
        );
        expect(
            reclassified
                .slice(callsBefore)
                .some(
                    ({ peer, trustPending }) =>
                        peer === ownerHash && trustPending > 0
                )
        ).toBe(true);
        // Whichever delivery won after the edge (G3-19), nothing was
        // explained by trust.
        const namespace = resultOf(joiner.fs, owner.peer)!;
        expect(namespace.explainedBy["rejected-untrusted"]).toBeUndefined();
        expect(namespace.untrusted).toBeUndefined();
        const trust = resultOf(joiner.fs, owner.peer, SCOPE_TRUST_V1)!;
        expect(trust).toMatchObject({ count: 1 });
        expect(trust.pulled).toBeGreaterThanOrEqual(1);
        expect(pulls.held).toBeGreaterThanOrEqual(1);
        expect(await joiner.fs.isTrustedWriter(writerKey)).toBe(true);
        await expectFiles(joiner.fs, WRITER_FILES);
    }, 180_000);

    it("35 + M1: a revoked writer's live rows at the donor are explained rejected-untrusted once every counted trust scope is contained; the coordinator no longer gates a fresh full joiner", async () => {
        const owner = await createOwner();
        const writer = await createWriter(owner);
        await writeAsWriter(writer, owner);
        const writerKey = keyOf(writer.peer);
        await owner.fs.revokeWriter(writerKey);
        expect(await owner.fs.isTrustedWriter(writerKey)).toBe(false);
        await stopPeer(writer.peer);
        // Revocation is not retroactive: the owner still indexes W's rows.
        await expectFiles(owner.fs, WRITER_FILES);
        const ownerRows = await namespaceRows(owner.fs);
        const revoked = await rowsSignedBy(owner.fs, ownerRows, writerKey);
        expect(revoked.size).toBeGreaterThan(0);
        const ownerTrust = await trustRows(owner.fs);

        // A quiet window the test outlives: today's tracker never
        // decides here, so the coordinator's half is read without a race.
        // J's release then waits for the tracker alone (its
        // `synchronizerIdle()` stays false while sync re-requests W's
        // rows, which J refuses); commit 4 removes it.
        const promotions = watchPromotions();
        const joiner = await joinOf([owner], { settleMs: 600_000 });
        const coordinator = coordinatorOf(joiner.fs);
        const ownerHash = hashOf(owner.peer);
        // M1: commit 2 kept J gated here until the caller's timeout or
        // `assumeComplete()` (plan, commit 3 handoff).
        const atFlip = await within(
            atSatisfied(joiner.fs, () => ({
                missing: missingFromTap(joiner.fs, ownerRows),
                status: readinessOf(joiner.fs)!,
            })),
            60_000,
            "the coordinator satisfied"
        );
        // Every row the owner holds that J lacks when the coordinator is
        // satisfied is one W signed, and J lacks each of them.
        expect(atFlip.missing).toEqual([...revoked].sort());
        expect(atFlip.status).toMatchObject({
            state: "reconciling",
            satisfied: true,
            required: [],
            excluded: [],
            gaps: [],
            trustPending: [],
            trustChecking: [],
        });
        expect(describeReadiness(atFlip.status)).toBe(
            "reconciling: every required peer is accounted for; the write-readiness tracker decides"
        );
        expect(atFlip.status.contained).toEqual([
            {
                peer: ownerHash,
                qualified: true,
                source: "creator",
                scopes: ["namespace-v1", "trust-v1"],
                departed: false,
                identity: "trusted",
            },
        ]);
        expect(coordinator.record(ownerHash)).toMatchObject({
            state: "contained",
            qualified: true,
            identity: "trusted",
        });
        // Nothing armed while J waits for the tracker alone.
        expect(runtimeOf(joiner.fs)!.debug().armedTimers).toBe(0);

        // Test 35: explained only once the trust scope was contained, and
        // provisionally, with W as the signer the coordinator re-checks on
        // every trust change.
        expect(promotions.promoted).toBeGreaterThan(0);
        expect(promotions.early).toEqual([]);
        const namespace = resultOf(joiner.fs, owner.peer)!;
        expect(namespace).toMatchObject({
            count: ownerRows.size,
            qualified: true,
        });
        expect(namespace.explainedBy["rejected-untrusted"]).toBe(revoked.size);
        expect(namespace.untrusted).toMatchObject({ heads: revoked.size });
        expect(hashesOf(namespace.untrusted!.signers)).toEqual([
            writerKey.hashcode(),
        ]);
        expect(resultOf(joiner.fs, owner.peer, SCOPE_TRUST_V1)).toMatchObject({
            count: ownerTrust.size,
            qualified: true,
        });
        expect(coordinator.proof()).toMatchObject({
            scopes: ["namespace-v1", "trust-v1"],
            excluded: [],
            gaps: [],
        });
        expect(coordinator.proof().contained).toEqual([
            expect.objectContaining({
                peer: ownerHash,
                scope: "namespace-v1",
                count: ownerRows.size,
                qualified: true,
            }),
            expect.objectContaining({
                peer: ownerHash,
                scope: "trust-v1",
                count: ownerTrust.size,
                qualified: true,
            }),
        ]);
        // J never indexed a revoked row and does not trust W.
        expect(await joiner.fs.isTrustedWriter(writerKey)).toBe(false);
        expect(decode(await joiner.fs.readFile(OWNER_FILE.path))).toBe(
            OWNER_FILE.content
        );
        expect(missingFromTap(joiner.fs, ownerRows)).toEqual(
            [...revoked].sort()
        );
        expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);
    }, 180_000);

    it("M1 with more donors than session slots: every donor holds the revoked writer's rows; sessions parked for trust free their slots, and the coordinator is satisfied", async () => {
        const owner = await createOwner();
        const writer = await createWriter(owner);
        await writeAsWriter(writer, owner);
        const replicas: Node[] = [];
        for (let i = 0; i < SESSIONS_IN_FLIGHT; i++) {
            const peer = await createPeer();
            await owner.fs.authorizeWriter(keyOf(peer));
            const replica = await readyReplica(
                owner,
                `trust-replica-${i}`,
                peer
            );
            await expectFiles(replica.fs, WRITER_FILES);
            replicas.push(replica);
        }
        const writerKey = keyOf(writer.peer);
        await owner.fs.revokeWriter(writerKey);
        for (const replica of replicas) {
            await waitUntil(async () =>
                expect(await replica.fs.isTrustedWriter(writerKey)).toBe(false)
            );
        }
        await stopPeer(writer.peer);
        const ownerRows = await namespaceRows(owner.fs);
        const revoked = await rowsSignedBy(owner.fs, ownerRows, writerKey);
        expect(revoked.size).toBeGreaterThan(0);
        const donors = [owner, ...replicas];
        expect(donors.length).toBeGreaterThan(SESSIONS_IN_FLIGHT);

        // As in 35: a quiet window the test outlives.
        const joiner = await joinOf(donors, { settleMs: 600_000 });
        const coordinator = coordinatorOf(joiner.fs);
        await within(
            atSatisfied(joiner.fs, () => undefined),
            60_000,
            "the coordinator satisfied"
        );
        for (const donor of donors) {
            expect(coordinator.record(hashOf(donor.peer))).toMatchObject({
                state: "contained",
                identity: "trusted",
            });
            expect(
                resultOf(joiner.fs, donor.peer)!.explainedBy[
                    "rejected-untrusted"
                ]
            ).toBe(revoked.size);
        }
        expect(runtimeOf(joiner.fs)!.debug().armedTimers).toBe(0);
        expect(await joiner.fs.isTrustedWriter(writerKey)).toBe(false);
    }, 240_000);

    describe("36: trust frozen after namespace; a rejection re-checked", () => {
        const BETWEEN = {
            path: "/between.txt",
            content: "between the freezes",
        };

        it("36a: a grant and a write that land at R between its namespace and trust freezes: one freeze, trust after namespace, so R's namespace view never holds a row whose grant its trust view lacks", async () => {
            const owner = await createOwner();
            // W is open and dialed, not yet authorized.
            const writerPeer = await createPeer();
            await writerPeer.dial(owner.peer);
            const writer = await openSharedFs({
                peerbit: writerPeer,
                address: owner.fs.address,
                machineLabel: "trust-writer",
                allowPartialWrites: true,
                gc: false,
            });
            const writerKey = keyOf(writerPeer);
            const before = await namespaceRows(owner.fs);
            expect((await trustRows(owner.fs)).size).toBe(0);
            await runtimeOf(owner.fs)!.whenStarted();
            const start = holdTrustStart(owner.fs);
            const sent = recordHeaders(owner.fs);
            restores.push(sent.restore);

            const joiner = await joinOf([owner]);
            const joinerHash = hashOf(joiner.peer);
            await within(start.read, 30_000, "the owner's trust freeze");
            // Inside the one freeze: namespace frozen, trust not yet.
            expect(start.namespaceCount).toBe(before.size);
            expect(sent.headers).toEqual([]);

            // The grant and W's write land at R now. J holds the grant
            // first, so sync never offers it W's rows before it trusts W.
            await owner.fs.authorizeWriter(writerKey);
            await waitUntil(async () => {
                expect(await writer.isTrustedWriter(writerKey)).toBe(true);
                expect(await joiner.fs.isTrustedWriter(writerKey)).toBe(true);
            });
            await writer.writeFile(BETWEEN.path, BETWEEN.content);
            await expectFiles(owner.fs, [BETWEEN]);
            const after = await namespaceRows(owner.fs);
            const written = await rowsSignedBy(owner.fs, after, writerKey);
            expect(written.size).toBeGreaterThan(0);
            for (const id of written) expect(before.has(id)).toBe(false);

            start.release();
            await joiner.fs.awaitWriteReady({ timeout: 60_000 });
            const headers = sent.headers
                .filter(({ to }) => to === joinerHash)
                .map(({ header }) => header);
            const namespace = headers.find(
                ({ scope }) => scope === SCOPE_NAMESPACE_V1
            )!;
            const trust = headers.find(
                ({ scope }) => scope === SCOPE_TRUST_V1
            )!;
            expect(namespace).toBeDefined();
            expect(trust).toBeDefined();
            // One freeze: every header of the session carries its id.
            expect(
                new Set(
                    headers.map(({ freezeId }) =>
                        Buffer.from(freezeId).toString("hex")
                    )
                ).size
            ).toBe(1);
            expect(sameBytes(namespace.freezeId, trust.freezeId)).toBe(true);
            // The namespace view is the owner's before W's write; the
            // trust view, frozen after it, holds the grant.
            expect(namespace.count).toBe(before.size);
            expect(trust.count).toBe(1);
            expect(resultOf(joiner.fs, owner.peer)).toMatchObject({
                count: before.size,
            });
            expect(
                resultOf(joiner.fs, owner.peer, SCOPE_TRUST_V1)
            ).toMatchObject({ count: 1 });
            for (const scope of [SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1] as const) {
                const result = resultOf(joiner.fs, owner.peer, scope)!;
                expect(
                    result.explainedBy["rejected-untrusted"]
                ).toBeUndefined();
                expect(result.untrusted).toBeUndefined();
            }
            // W's rows reach J by sync after the decision.
            await expectFiles(joiner.fs, [BETWEEN]);
        }, 180_000);

        it("36b: a second peer holding the grant joins C after a rejection: the trust change reverses the first peer's rejected-untrusted rows, it is asked again, and J turns ready with the edge and the rows", async () => {
            const owner = await createOwner();
            const writer = await createWriter(owner);
            const cut = await partitionablePeer();
            const holderPeer = await createPeer();
            await owner.fs.authorizeWriter(keyOf(holderPeer));
            await writeAsWriter(writer, owner);
            const writerKey = keyOf(writer.peer);
            // R1: a full replica the owner never authorized. R2: an
            // authorized one.
            const first = await readyReplica(owner, "trust-r1", cut.peer);
            const second = await readyReplica(owner, "trust-r2", holderPeer);
            await expectFiles(first.fs, WRITER_FILES);
            await expectFiles(second.fs, WRITER_FILES);
            // W's grant (h1) is revoked; both replicas hold the CUT.
            await owner.fs.revokeWriter(writerKey);
            await waitUntil(async () => {
                expect(await first.fs.isTrustedWriter(writerKey)).toBe(false);
                expect(await second.fs.isTrustedWriter(writerKey)).toBe(false);
            });
            // R1 is cut off; the owner grants W again (h2), which only R2
            // receives. A re-grant, so the outcome never depends on which
            // CUT J holds (G3-17).
            await partition(cut, [owner.peer, writer.peer, holderPeer]);
            await owner.fs.authorizeWriter(writerKey);
            await waitUntil(async () =>
                expect(await second.fs.isTrustedWriter(writerKey)).toBe(true)
            );
            expect(await first.fs.isTrustedWriter(writerKey)).toBe(false);
            const regranted = await trustRows(second.fs);
            await stopPeer(owner.peer);
            await stopPeer(writer.peer);
            const firstRows = await namespaceRows(first.fs);
            const revoked = await rowsSignedBy(first.fs, firstRows, writerKey);
            expect(revoked.size).toBeGreaterThan(0);

            // J sees R1 only.
            const promotions = watchPromotions();
            const joiner = await joinOf([first]);
            const coordinator = coordinatorOf(joiner.fs);
            const firstHash = hashOf(cut.peer);
            const secondHash = hashOf(holderPeer);
            await waitUntil(() => {
                const status = readinessOf(joiner.fs)!;
                expect(status).toMatchObject({
                    state: "no-qualified-donor",
                    satisfied: false,
                    required: [],
                    trustChecking: [],
                });
                expect(status.contained).toEqual([
                    {
                        peer: firstHash,
                        qualified: false,
                        source: "reconciled",
                        scopes: ["namespace-v1", "trust-v1"],
                        departed: false,
                        identity: "untrusted",
                    },
                ]);
            });
            expect(describeReadiness(readinessOf(joiner.fs)!)).toBe(
                `no-qualified-donor: 1 peer contained, none qualified: ${firstHash} (reconciled, untrusted identity)`
            );
            const rejected = resultOf(joiner.fs, cut.peer)!;
            expect(rejected.explainedBy["rejected-untrusted"]).toBe(
                revoked.size
            );
            expect(hashesOf(rejected.untrusted?.signers)).toEqual([
                writerKey.hashcode(),
            ]);
            expect(promotions.promoted).toBeGreaterThan(0);
            expect(promotions.early).toEqual([]);
            // R1's header qualifies it; its identity does not.
            const record = coordinator.record(firstHash)!;
            expect(record.qualified).toBe(true);
            const sessionsBefore = record.sessionsOpened;
            const epochBefore = coordinator.debug().trustEpoch;
            expect(await joiner.fs.isTrustedWriter(writerKey)).toBe(false);

            // R2 joins J's view with h2 in its trust snapshot.
            const flip = atReady(joiner.fs, () => ({
                missing: missingFromTap(joiner.fs, firstRows),
                status: readinessOf(joiner.fs)!,
            }));
            await joiner.peer.dial(holderPeer);
            await joiner.fs.awaitWriteReady({ timeout: 60_000 });
            const atFlip = await flip;
            expect(atFlip.missing).toEqual([]);
            // The edge moved the epoch; R1's rows were explained by a
            // signer J now trusts, so R1 was asked again (a new session)
            // and contained without any.
            expect(coordinator.debug().trustEpoch).toBeGreaterThan(epochBefore);
            expect(coordinator.record(firstHash)).toMatchObject({
                state: "contained",
                identity: "untrusted",
            });
            expect(
                coordinator.record(firstHash)!.sessionsOpened
            ).toBeGreaterThan(sessionsBefore);
            const again = resultOf(joiner.fs, cut.peer)!;
            expect(again.explainedBy["rejected-untrusted"]).toBeUndefined();
            expect(again.untrusted).toBeUndefined();
            expect(atFlip.status).toMatchObject({
                state: "ready",
                satisfied: true,
                required: [],
                gaps: [],
            });
            expect(atFlip.status.contained).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        peer: firstHash,
                        qualified: false,
                        identity: "untrusted",
                    }),
                    expect.objectContaining({
                        peer: secondHash,
                        qualified: true,
                        source: "reconciled",
                        scopes: ["namespace-v1", "trust-v1"],
                        identity: "trusted",
                    }),
                ])
            );
            expect(atFlip.status.contained).toHaveLength(2);
            expect(
                resultOf(joiner.fs, holderPeer, SCOPE_TRUST_V1)
            ).toMatchObject({ count: regranted.size });
            // J holds h2 and W's rows.
            expect(await trustRows(joiner.fs)).toEqual(regranted);
            expect(await joiner.fs.isTrustedWriter(writerKey)).toBe(true);
            await expectFiles(joiner.fs, WRITER_FILES);
        }, 240_000);
    });

    it("37: a trust-pending head whose last trust session completes with an empty D is classified again without a trust-graph change: no hang, no timer", async () => {
        const owner = await createOwner();
        const writer = await createWriter(owner);
        const replicaPeer = await createPeer();
        await owner.fs.authorizeWriter(keyOf(replicaPeer));
        await writeAsWriter(writer, owner);
        const writerKey = keyOf(writer.peer);
        // R2: authorized, up to date with the owner, revocation included.
        const replica = await readyReplica(owner, "trust-replica", replicaPeer);
        await expectFiles(replica.fs, WRITER_FILES);
        await owner.fs.revokeWriter(writerKey);
        await waitUntil(async () =>
            expect(await replica.fs.isTrustedWriter(writerKey)).toBe(false)
        );
        await stopPeer(writer.peer);
        const ownerRows = await namespaceRows(owner.fs);
        const revoked = await rowsSignedBy(owner.fs, ownerRows, writerKey);
        expect(revoked.size).toBeGreaterThan(0);
        const replicaRows = await namespaceRows(replica.fs);
        expect(await rowsSignedBy(replica.fs, replicaRows, writerKey)).toEqual(
            revoked
        );
        const replicaTrust = await trustRows(replica.fs);

        // R2's OPENs wait. A quiet window the test outlives: W's rows are
        // refused for good, so today's tracker never decides here (see
        // 35); the coordinator's half is read at its first satisfied
        // evaluation.
        const busy = holdOpens(replica.fs);
        restores.push(busy.release);
        const promotions = watchPromotions();
        const joiner = await joinOf([owner, replica], { settleMs: 600_000 });
        const coordinator = coordinatorOf(joiner.fs);
        const ownerHash = hashOf(owner.peer);
        const replicaHash = hashOf(replicaPeer);
        await waitUntil(async () => {
            expect(busy.held).toBeGreaterThan(0);
            const session = coordinator.record(ownerHash)?.session;
            expect(session?.state(SCOPE_TRUST_V1)).toBe("contained");
            expect(session?.debug().scopes[SCOPE_NAMESPACE_V1]).toMatchObject({
                trustPending: revoked.size,
                untrusted: 0,
            });
            // J's trust graph is R2's: R2's trust session adds nothing.
            expect(await trustRows(joiner.fs)).toEqual(replicaTrust);
        });
        // R2 is Required and its trust scope is not contained, so the
        // owner's parked hashes stay parked; that session arms nothing.
        expect(coordinator.record(replicaHash)!.results.size).toBe(0);
        expect(coordinator.satisfied()).toBe(false);
        const ownerSession = coordinator.record(ownerHash)!.session!;
        expect(ownerSession.debug().armedTimers).toBe(0);
        expect(readinessOf(joiner.fs)!.trustPending).toEqual([
            { peer: ownerHash, hashes: revoked.size },
        ]);

        const triggers = coordinator.debug().trustTriggers;
        const satisfied = atSatisfied(joiner.fs, () => ({
            triggers: coordinator.debug().trustTriggers,
            missing: missingFromTap(joiner.fs, ownerRows),
            status: readinessOf(joiner.fs)!,
            armedTimers: runtimeOf(joiner.fs)!.debug().armedTimers,
        }));
        busy.release();
        const atFlip = await within(
            satisfied,
            60_000,
            "the coordinator satisfied"
        );
        // No trust change; the last counted trust scope turning
        // contained classified the parked hashes again, once.
        expect(atFlip.triggers.change).toBe(triggers.change);
        expect(atFlip.triggers.scopesContained).toBe(
            triggers.scopesContained + 1
        );
        expect(atFlip.armedTimers).toBe(0);
        expect(atFlip.missing).toEqual([...revoked].sort());
        expect(atFlip.status).toMatchObject({
            state: "reconciling",
            satisfied: true,
            required: [],
            trustPending: [],
            trustChecking: [],
        });
        expect(
            coordinator.record(replicaHash)!.results.get(SCOPE_TRUST_V1)
        ).toMatchObject({
            count: replicaTrust.size,
            missingAtStart: 0,
            pulled: 0,
        });
        for (const peer of [owner.peer, replicaPeer]) {
            expect(
                resultOf(joiner.fs, peer)!.explainedBy["rejected-untrusted"]
            ).toBe(revoked.size);
        }
        expect(promotions.promoted).toBeGreaterThan(0);
        expect(promotions.early).toEqual([]);
    }, 240_000);

    it("42: revoke then re-grant of a writer during a join: the re-grant is required and pulled; the writer's rows are held", async () => {
        const owner = await createOwner();
        const writer = await createWriter(owner);
        await writeAsWriter(writer, owner);
        const writerKey = keyOf(writer.peer);
        await stopPeer(writer.peer);
        const granted = await trustRows(owner.fs);
        expect(granted.size).toBe(1);
        const [[relationId, h1]] = [...granted];
        const ownerRows = await namespaceRows(owner.fs);

        // J holds none of the owner's trust rows by sync.
        const trustLogId = logIdOf(trustStoreOf(owner.fs));
        const joinerPeer = await createPeer();
        withholdTrustSync(joinerPeer, trustLogId);
        disableTrustWarmup(joinerPeer);
        const busy = holdOpens(owner.fs);
        restores.push(busy.release);
        const joiner = await joinOf([owner], { peer: joinerPeer });
        await waitUntil(() => expect(busy.held).toBeGreaterThan(0));

        // The revoke (a CUT of h1) and the re-grant (h2, the same
        // relation id) land while J's OPEN waits.
        await owner.fs.revokeWriter(writerKey);
        await owner.fs.authorizeWriter(writerKey);
        const regranted = await trustRows(owner.fs);
        expect([...regranted.keys()]).toEqual([relationId]);
        const h2 = regranted.get(relationId)!;
        expect(h2).not.toBe(h1);

        const flip = atReady(joiner.fs, () =>
            missingFromTap(joiner.fs, ownerRows)
        );
        busy.release();
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });
        expect(await flip).toEqual([]);
        // h2 has no child at J: required, pulled, and J's row for the id.
        const trust = resultOf(joiner.fs, owner.peer, SCOPE_TRUST_V1)!;
        expect(trust).toMatchObject({ count: 1 });
        expect(trust.pulled).toBeGreaterThanOrEqual(1);
        expect(trust.missingAtStart).toBeGreaterThanOrEqual(1);
        expect((await trustRows(joiner.fs)).get(relationId)).toBe(h2);
        const namespace = resultOf(joiner.fs, owner.peer)!;
        expect(namespace.explainedBy["rejected-untrusted"]).toBeUndefined();
        expect(namespace.untrusted).toBeUndefined();
        expect(await joiner.fs.isTrustedWriter(writerKey)).toBe(true);
        await expectFiles(joiner.fs, WRITER_FILES);
    }, 180_000);

    describe("55: a stale peer re-pushes a revoked grant (the stated non-guarantee)", () => {
        /**
         * The owner grants an authorized replica S and W; W writes; S syncs
         * and is cut off; the owner revokes W, so only S still holds W's
         * grant (h1), and only the owner its CUT. W stops.
         */
        const staleSetup = async () => {
            const owner = await createOwner();
            const writer = await createWriter(owner);
            const stale = await partitionablePeer();
            await owner.fs.authorizeWriter(keyOf(stale.peer));
            await writeAsWriter(writer, owner);
            const writerKey = keyOf(writer.peer);
            const replica = await readyReplica(
                owner,
                "trust-stale",
                stale.peer
            );
            await expectFiles(replica.fs, WRITER_FILES);
            await partition(stale, [owner.peer, writer.peer]);
            await owner.fs.revokeWriter(writerKey);
            expect(await owner.fs.isTrustedWriter(writerKey)).toBe(false);
            await stopPeer(writer.peer);
            expect(await replica.fs.isTrustedWriter(writerKey)).toBe(true);
            return { owner, stale: replica, writerKey };
        };

        it("55a: J sees the stale peer only: ready trusting the writer; once the CUT holder is visible J stops trusting it and stays ready", async () => {
            const { owner, stale, writerKey } = await staleSetup();
            const staleRows = await namespaceRows(stale.fs);
            const joiner = await joinOf([stale]);
            const flip = atReady(joiner.fs, () => ({
                missing: missingFromTap(joiner.fs, staleRows),
                status: readinessOf(joiner.fs)!,
                // Read now: nothing else J could hear of runs before it.
                trusted: joiner.fs.isTrustedWriter(writerKey),
            }));
            await joiner.fs.awaitWriteReady({ timeout: 60_000 });
            const atFlip = await flip;
            // A fresh J holds no CUT for a grant it never held (M0 P3):
            // it trusts W at the decision (design 5, "Revoked writers").
            expect(await atFlip.trusted).toBe(true);
            expect(atFlip.missing).toEqual([]);
            expect(atFlip.status.contained).toEqual([
                {
                    peer: hashOf(stale.peer),
                    qualified: true,
                    source: "reconciled",
                    scopes: ["namespace-v1", "trust-v1"],
                    departed: false,
                    identity: "trusted",
                },
            ]);
            expect(
                resultOf(joiner.fs, stale.peer)!.explainedBy[
                    "rejected-untrusted"
                ]
            ).toBeUndefined();

            // The CUT holder becomes visible and re-offers the CUT.
            await joiner.peer.dial(owner.peer);
            await waitUntil(
                async () =>
                    expect(await joiner.fs.isTrustedWriter(writerKey)).toBe(
                        false
                    ),
                30_000
            );
            // Readiness is never withdrawn (design 2.3).
            expect(joiner.fs.bootstrapStatus().writeReady).toBe(true);
            expect(readinessOf(joiner.fs)!.state).toBe("ready");
        }, 240_000);

        it("55b: J sees the stale peer and the CUT holder at once: the coordinator is satisfied and J eventually stops trusting the writer; whether the decision fell inside the window is recorded, not asserted (G3-16)", async () => {
            const { owner, stale, writerKey } = await staleSetup();
            const joiner = await joinOf([stale, owner]);
            const satisfied = await within(
                atSatisfied(joiner.fs, () => ({
                    status: readinessOf(joiner.fs)!,
                    trusted: joiner.fs.isTrustedWriter(writerKey),
                })),
                60_000,
                "the coordinator satisfied"
            );
            const contained = satisfied.status.contained.map(
                ({ peer }) => peer
            );
            expect(contained.sort()).toEqual(
                [hashOf(stale.peer), hashOf(owner.peer)].sort()
            );
            await waitUntil(
                async () =>
                    expect(await joiner.fs.isTrustedWriter(writerKey)).toBe(
                        false
                    ),
                30_000
            );
            // Recorded, not asserted: the CUT's re-offer races the
            // decision (design 4.12 #43).
            console.info(
                `readiness-trust 55b: W trusted when the coordinator was satisfied: ${await satisfied.trusted}; write-ready now: ${joiner.fs.bootstrapStatus().writeReady}`
            );
        }, 240_000);
    });

    it("S8: the trust tap, the trust session's bundle, the trust listener and the trust notes follow the instance TrustedNetwork.open returns, not the one the tap first attached to", async () => {
        const owner = await createOwner();
        const granted = await Ed25519Keypair.create();
        await owner.fs.authorizeWriter(granted.publicKey);
        // The owner also keeps a relation J's graph refuses: owned and
        // signed by a stranger (its own check bypassed for the test).
        const ownerTrust = trustStoreOf(owner.fs);
        ownerTrust._optionCanPerform = async () => true;
        const [stranger, x] = await Promise.all([
            Ed25519Keypair.create(),
            Ed25519Keypair.create(),
        ]);
        const refused = await ownerTrust.put(
            new IdentityRelation({
                from: stranger.publicKey,
                to: x.publicKey,
            }),
            { signers: [stranger.sign.bind(stranger)] }
        );
        expect((await trustRows(owner.fs)).size).toBe(2);

        // Both trust rows reach J by the trust session's pulls only.
        const trustLogId = logIdOf(ownerTrust);
        const joinerPeer = await createPeer();
        withholdTrustSync(joinerPeer, trustLogId);
        disableTrustWarmup(joinerPeer);
        // The tap attaches before the trust graph opens, to an instance
        // open does not return. A swap inside \`TrustedNetwork.open\`
        // cannot do it: Peerbit 5.4.10 reserves the parent's child
        // addresses while it opens, and another instance at that address
        // waits for the reservation (a deadlock). So the first attach of
        // J's runtime gets a decoded copy of the store, and open returns
        // the original, as \`existing: "reuse"\` returns an instance
        // already open (\`controller.js:43-56\`).
        const decoys: any[] = [];
        const attachTrust = ReadinessRuntime.prototype.attachTrust;
        ReadinessRuntime.prototype.attachTrust = function (
            this: ReadinessRuntime,
            documents: any
        ) {
            if (decoys.length === 0) {
                const decoy: any = deserialize(
                    serialize(documents),
                    documents.constructor
                );
                decoys.push(decoy);
                return attachTrust.call(this, decoy);
            }
            return attachTrust.call(this, documents);
        };
        restores.push(
            () => (ReadinessRuntime.prototype.attachTrust = attachTrust)
        );
        const joins = ownerOf(SharedLog.prototype, "join");
        const join = joins.join;
        const joinedBy = new Set<unknown>();
        joins.join = function (this: unknown, ...args: unknown[]) {
            if (isLogOf(this, joinerPeer, trustLogId)) joinedBy.add(this);
            return join.apply(this, args);
        };
        restores.push(() => (joins.join = join));
        const noteRejection = ReadinessRuntime.prototype.noteRejection;
        const noted: Array<{
            runtime: ReadinessRuntime;
            head: unknown;
            reason: string;
            signers?: readonly PublicSignKey[];
        }> = [];
        ReadinessRuntime.prototype.noteRejection = function (
            this: ReadinessRuntime,
            scope,
            head,
            reason,
            signers
        ) {
            if (scope === SCOPE_TRUST_V1) {
                noted.push({ runtime: this, head, reason, signers });
            }
            return noteRejection.call(this, scope, head, reason, signers);
        };
        restores.push(
            () => (ReadinessRuntime.prototype.noteRejection = noteRejection)
        );

        const joiner = await joinOf([owner], { peer: joinerPeer });
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });
        const runtime = runtimeOf(joiner.fs)!;
        const returned = programOf(joiner.fs).trustGraph.trustGraph;
        expect(decoys).toHaveLength(1);
        expect(returned).not.toBe(decoys[0]);
        // The tap, the session ports' store and the pulls.
        expect((runtime as any).trustDocuments).toBe(returned);
        expect((runtime as any).stores.get(SCOPE_TRUST_V1)).toBe(returned);
        const bundle = runtime.sessionScope(SCOPE_TRUST_V1)!;
        expect(sameBytes(bundle.ports.logId, logIdOf(returned))).toBe(true);
        expect([...joinedBy]).toEqual([returned.log]);
        expect(bundle.pulls.stats.joined).toBeGreaterThanOrEqual(2);
        // The trust listener: the pulled grant's index change moved the
        // epoch (only the returned instance ever opened).
        const coordinator = coordinatorOf(joiner.fs);
        expect(coordinator.debug().trustTriggers.change).toBeGreaterThan(0);
        expect(await joiner.fs.isTrustedWriter(granted.publicKey)).toBe(true);
        // The notes: the bound canPerform is the wrapper.
        const strangerNotes = noted.filter(
            (note) => note.head === refused.entry.hash
        );
        expect(strangerNotes.length).toBeGreaterThan(0);
        for (const note of strangerNotes) {
            expect(note.runtime).toBe(runtime);
            expect(note.reason).toBe("untrusted");
            expect(hashesOf(note.signers)).toEqual([
                stranger.publicKey.hashcode(),
            ]);
        }
        // J contains the owner's trust scope, the refused relation
        // explained by trust.
        const trust = resultOf(joiner.fs, owner.peer, SCOPE_TRUST_V1)!;
        expect(trust).toMatchObject({ count: 2 });
        expect(trust.explainedBy["rejected-untrusted"]).toBe(1);
        expect(hashesOf(trust.untrusted?.signers)).toEqual([
            stranger.publicKey.hashcode(),
        ]);
        expect(await returned.log.log.has(refused.entry.hash)).toBe(false);
        expect(readinessOf(joiner.fs)!.contained).toEqual([
            expect.objectContaining({
                peer: hashOf(owner.peer),
                scopes: ["namespace-v1", "trust-v1"],
                identity: "trusted",
            }),
        ]);
    }, 180_000);

    it("I1: a contained donor J's graph does not trust qualifies by the trust change that grants it: no-qualified-donor until then, then ready by that event", async () => {
        const owner = await createOwner();
        const cut = await partitionablePeer();
        const replica = await readyReplica(owner, "trust-i1", cut.peer);
        await expectFiles(replica.fs, [OWNER_FILE]);
        await partition(cut, [owner.peer]);
        // The owner grants R1 while cut off from it: the grant is the
        // owner's alone.
        const replicaKey = keyOf(cut.peer);
        await owner.fs.authorizeWriter(replicaKey);
        const [grantHead] = [...(await trustRows(owner.fs)).values()];
        const grant = await trustStoreOf(owner.fs).log.log.get(grantHead);
        expect(grant).toBeDefined();
        expect(await replica.fs.isTrustedWriter(replicaKey)).toBe(false);

        const joiner = await joinOf([replica]);
        const coordinator = coordinatorOf(joiner.fs);
        const replicaHash = hashOf(cut.peer);
        await waitUntil(() => {
            const status = readinessOf(joiner.fs)!;
            expect(status).toMatchObject({
                state: "no-qualified-donor",
                satisfied: false,
                required: [],
                trustChecking: [],
            });
            expect(status.contained).toEqual([
                {
                    peer: replicaHash,
                    qualified: false,
                    source: "reconciled",
                    scopes: ["namespace-v1", "trust-v1"],
                    departed: false,
                    identity: "untrusted",
                },
            ]);
        });
        expect(coordinator.record(replicaHash)!.qualified).toBe(true);
        expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);
        const epoch = coordinator.debug().trustEpoch;
        const sessions = coordinator.record(replicaHash)!.sessionsOpened;

        // The grant reaches R1 (as sync from the owner would deliver
        // it), and J by sync from R1.
        const flip = atReady(joiner.fs, () => readinessOf(joiner.fs)!);
        await trustStoreOf(replica.fs).log.join([grant]);
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });
        const atFlip = await flip;
        expect(atFlip.contained).toEqual([
            {
                peer: replicaHash,
                qualified: true,
                source: "reconciled",
                scopes: ["namespace-v1", "trust-v1"],
                departed: false,
                identity: "trusted",
            },
        ]);
        expect(coordinator.debug().trustEpoch).toBeGreaterThan(epoch);
        // Qualified by the event; nothing asked again.
        expect(coordinator.record(replicaHash)!.sessionsOpened).toBe(sessions);
        expect(await joiner.fs.isTrustedWriter(replicaKey)).toBe(true);
    }, 180_000);

    describe("R: the scopes of a join", () => {
        it("R1: an access-controlled join's sessions open the namespace and trust scopes; an open-mode join's the namespace scope only", async () => {
            const opened: Array<{ peer: string; scopes: ScopeId[] }> = [];
            const start = JoinerSession.prototype.start;
            JoinerSession.prototype.start = function (this: JoinerSession) {
                opened.push({ peer: this.peer, scopes: [...this.init.scopes] });
                return start.call(this);
            };
            restores.push(() => (JoinerSession.prototype.start = start));

            const acl = await createOwner("trust-acl-owner");
            const aclJoiner = await joinOf([acl]);
            const openPeer = await createPeer();
            const open = await openSharedFs({
                peerbit: openPeer,
                machineLabel: "trust-open-owner",
                gc: false,
            });
            await open.writeFile(OWNER_FILE.path, OWNER_FILE.content);
            const openJoiner = await joinOf([{ peer: openPeer, fs: open }]);
            await aclJoiner.fs.awaitWriteReady({ timeout: 60_000 });
            await openJoiner.fs.awaitWriteReady({ timeout: 60_000 });

            expect(runtimeOf(aclJoiner.fs)!.accessControlled).toBe(true);
            expect(runtimeOf(openJoiner.fs)!.accessControlled).toBe(false);
            expect(coordinatorOf(aclJoiner.fs).ports.scopes).toEqual([
                SCOPE_NAMESPACE_V1,
                SCOPE_TRUST_V1,
            ]);
            expect(coordinatorOf(openJoiner.fs).ports.scopes).toEqual([
                SCOPE_NAMESPACE_V1,
            ]);
            const sessionsWith = (peer: Peerbit) =>
                opened.filter((session) => session.peer === hashOf(peer));
            expect(sessionsWith(acl.peer).length).toBeGreaterThan(0);
            for (const { scopes } of sessionsWith(acl.peer)) {
                expect(scopes).toEqual([SCOPE_NAMESPACE_V1, SCOPE_TRUST_V1]);
            }
            expect(sessionsWith(openPeer).length).toBeGreaterThan(0);
            for (const { scopes } of sessionsWith(openPeer)) {
                expect(scopes).toEqual([SCOPE_NAMESPACE_V1]);
            }
            expect(readinessOf(aclJoiner.fs)!.contained).toEqual([
                expect.objectContaining({
                    peer: hashOf(acl.peer),
                    scopes: ["namespace-v1", "trust-v1"],
                    identity: "trusted",
                }),
            ]);
            // Open mode: no trust fields at all (D7).
            const openStatus = readinessOf(openJoiner.fs)!;
            expect(openStatus.contained).toEqual([
                {
                    peer: hashOf(openPeer),
                    qualified: true,
                    source: "creator",
                    scopes: ["namespace-v1"],
                    departed: false,
                },
            ]);
            expect(openStatus).not.toHaveProperty("trustPending");
            expect(openStatus).not.toHaveProperty("trustChecking");
        });

        it("R2: an access-controlled join without J's trust view faults (gated, never a failed open); assumeComplete releases it", async () => {
            const owner = await createOwner();
            // The host's trust view is lost on the way to the runtime.
            const startJoin = ReadinessRuntime.prototype.startJoin;
            ReadinessRuntime.prototype.startJoin = function (
                this: ReadinessRuntime,
                options
            ) {
                const { trust: _trust, ...rest } = options;
                return startJoin.call(this, rest);
            };
            restores.push(
                () => (ReadinessRuntime.prototype.startJoin = startJoin)
            );
            const joiner = await joinOf([owner]);
            const runtime = runtimeOf(joiner.fs)!;
            expect(runtime.accessControlled).toBe(true);
            expect(runtime.debug().joinFault).toBe("no trust view");
            expect(runtime.coordinator).toBeUndefined();
            expect(runtime.satisfied()).toBe(false);
            const error = await timeoutOf(joiner.fs, 1_500);
            expect(error.readiness).toMatchObject({
                state: "reconciling",
                satisfied: false,
                fault: "no trust view",
            });
            expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);

            await joiner.fs.assumeComplete();
            expect(joiner.fs.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "operator",
            });
        });
    });
});
