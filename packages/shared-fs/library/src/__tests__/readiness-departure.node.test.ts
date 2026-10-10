import {
    ExchangeHeadsMessage,
    RawExchangeHeadsMessage,
    SharedLog,
    StashBackedRawExchangeHeadsMessage,
} from "@peerbit/shared-log";
import { TrustedNetwork } from "@peerbit/trusted-network";
import { fork, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    SharedFsWriteReadyTimeoutError,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";
import {
    Coordinator,
    type CoordinatorDebug,
    type PeerRecord,
    type PeerState,
    type ReadinessStatus,
    type TransportEvent,
} from "../readiness/coordinator.js";
import { headDigest } from "../readiness/digest.js";
import type { IdKey } from "../readiness/id-map.js";
import type { PullQueueStats } from "../readiness/pull-queue.js";
import { ReadinessRuntime } from "../readiness/runtime.js";
import {
    NAMESPACE_V1,
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    TRUST_V1,
    type ScopeDescriptor,
} from "../readiness/scopes.js";
import type { SessionResult } from "../readiness/session.js";
import { documentsIndexPort, type ScopeTap } from "../readiness/tap.js";
import type {
    DepartureCommand,
    DepartureReport,
    DepartureRow,
} from "./readiness-departure.protocol.js";
import { holdFlips } from "./readiness-flip-hold.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Departure of a visible peer R across processes (WRITE_READINESS_V2.md
 * section 4.7 "Departure", D3 = A'; design tests 53 and 54; M1 plan 7.3
 * "Relayed peers"). R runs in a forked `--import tsx` child whose responder
 * drops every OPEN, so R is Required at the joiner J and never answers. J
 * and the donor D (the creator, one file) run in this process, so the test
 * reads J's coordinator directly: every transport event it handles and
 * every OPEN attempt of R's session that ends, with R's record and J's
 * readiness status right after it.
 *
 * - **53, J is R's fanout parent / R has no fanout parent.** `kill -9`
 *   before R answers. Pubsub never removes a dead subscriber on its fanout
 *   parent, nor anywhere when it had no parent (M0 P1, U-35), so J must
 *   not wait for an `unsubscribe`: the first re-read trigger J's
 *   coordinator handles once J's route table no longer reaches R (libp2p
 *   `peer:disconnect`, fanout or pubsub `peer:unreachable`) makes R
 *   `left-unanswered`. R keeps J gated until the OPEN attempt in flight
 *   ends; then it is `left` with a gap of unknown rows, and J turns ready
 *   with D.
 * - **53, relayed.** J reaches R only through D, which is R's fanout
 *   parent; libp2p never names R at J. The re-read comes from the pubsub
 *   `unsubscribe` D's shard announces, or from J's own route pruning. If
 *   no trigger arrives within the bound, R stays Required until the
 *   caller's timeout (the documented liveness limit): the test then fails
 *   only on a wrong `left` or a wrong ready.
 * - **54, SIGSTOP** (POSIX only). A frozen R keeps its sockets open, so it
 *   stays reachable and J stays gated: `ETIMEDOUT` names R in flight while
 *   its attempts run, then "reachable and silent", with no timer armed.
 *   SIGCONT, then `kill -9`: R leaves and J turns ready.
 *
 * Topologies are pinned with explicit pubsub topic-root candidates (the
 * same set on every peer) and connection gaters, and each test asserts its
 * topology before the fault, so a Peerbit change that moves the fanout
 * parent fails loudly instead of testing something else.
 *
 * - **38, an access-controlled store across processes** (PR-3 commit 3,
 *   SPEC3 9.7). R, in the child, owns the store and answers; it granted one
 *   writer W, which wrote a file and stopped, so R's trust graph holds one
 *   edge and its namespace rows of W's are admitted only by a peer holding
 *   that edge. J withholds sync of its trust log (exchange heads dropped)
 *   and `isTrusted`'s remote warmup, so the readiness `TRUST_V1` pull from
 *   `trustGraph.log` is the only way the edge reaches J. J lacks exactly the
 *   edge when R's trust run starts, pulls it, and contains R's namespace
 *   scope only after the edge landed; J turns ready holding the edge and
 *   W's rows, none explained `rejected-untrusted`.
 */

// Fixed on every OS: a slow departure is evidence, not a reason to wait
// longer. The OPEN attempts alone take 5 + 10 + 20 s.
const TEST_TIMEOUT_MS = 180_000;
const WAIT_TIMEOUT_MS = 90_000;
/**
 * The relayed variant's bound for a departure trigger after the kill: the
 * relay's unsubscribe takes milliseconds (M0 P1), J's own route pruning
 * after an unacknowledged probe the stream's 10 s seek timeout. It ends
 * well before R's third attempt (35 s after J's first OPEN), so a late
 * departure is still `left-unanswered` when the liveness branch reads it.
 */
const RELAYED_DEPARTURE_BOUND_MS = 20_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const workerPath = fileURLToPath(
    new URL("./readiness-departure.worker.ts", import.meta.url)
);

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime | undefined =>
    (fs.program as any).readinessRuntime;
const hashOf = (peer: Peerbit) => peer.identity.publicKey.hashcode();
const tcpAddrs = (peer: Peerbit) =>
    peer
        .getMultiaddrs()
        .map((address) => address.toString())
        .filter(
            (address) =>
                address.startsWith("/ip4/127.0.0.1/tcp/") &&
                !address.includes("/ws") &&
                !address.includes("p2p-circuit")
        );

const withTimeout = <T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
) =>
    new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });

const waitUntil = async (
    assertion: () => Promise<void> | void,
    timeoutMs = WAIT_TIMEOUT_MS
) => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
    throw lastError ?? new Error("timed out");
};

const timeoutOf = async (fs: SharedFsHandle, timeout: number) => {
    const error = await fs.awaitWriteReady({ timeout }).then(
        () => {
            throw new Error("awaitWriteReady resolved");
        },
        (error: unknown) => error
    );
    expect(error).toBeInstanceOf(SharedFsWriteReadyTimeoutError);
    const timedOut = error as SharedFsWriteReadyTimeoutError;
    expect(timedOut.code).toBe("ETIMEDOUT");
    expect(timedOut.readiness).toBeDefined();
    return timedOut as SharedFsWriteReadyTimeoutError & {
        readiness: ReadinessStatus;
    };
};

type RunningChild = {
    child: ChildProcess;
    closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    reports: DepartureReport[];
    diagnostics(): string;
};

const startChild = (): RunningChild => {
    const child = fork(workerPath, [], {
        execArgv: ["--enable-source-maps", "--import", "tsx"],
        env: { ...process.env, NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        // @ts-expect-error fork forwards it to spawn; @types/node omits it
        windowsHide: true,
    });
    let output = "";
    const append = (chunk: unknown) => {
        output += Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : String(chunk);
        if (output.length > MAX_DIAGNOSTIC_BYTES) {
            output = output.slice(-MAX_DIAGNOSTIC_BYTES);
        }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const reports: DepartureReport[] = [];
    child.on("message", (message) => reports.push(message as DepartureReport));
    return {
        child,
        reports,
        // Registered at spawn, so cleanup can always wait for the close.
        closed: new Promise((resolve) =>
            child.once("close", (code, signal) => resolve({ code, signal }))
        ),
        diagnostics: () => output.trim(),
    };
};

/** The first report of `type` matching `match`, buffered or future. */
const reportOf = <T extends DepartureReport["type"]>(
    running: RunningChild,
    type: T,
    match: (report: Extract<DepartureReport, { type: T }>) => boolean = () =>
        true
): Promise<Extract<DepartureReport, { type: T }>> => {
    const find = () =>
        running.reports.find(
            (report): report is Extract<DepartureReport, { type: T }> =>
                report.type === type &&
                match(report as Extract<DepartureReport, { type: T }>)
        );
    const fatal = () =>
        running.reports.find(
            (report): report is Extract<DepartureReport, { type: "fatal" }> =>
                report.type === "fatal"
        );
    const pending = new Promise<Extract<DepartureReport, { type: T }>>(
        (resolve, reject) => {
            const { child } = running;
            const cleanup = () => {
                child.off("message", onMessage);
                child.off("close", onClose);
            };
            const failWith = (message: string) => {
                cleanup();
                const output = running.diagnostics();
                reject(
                    new Error(
                        output
                            ? `${message}\nChild output:\n${output}`
                            : message
                    )
                );
            };
            const onMessage = () => {
                const error = fatal();
                if (error) {
                    return failWith(
                        `departure child failed: ${error.message}\n${error.stack ?? ""}`
                    );
                }
                const report = find();
                if (report) {
                    cleanup();
                    resolve(report);
                }
            };
            const onClose = (code: number | null, signal: string | null) =>
                failWith(
                    `departure child exited before "${type}" (code=${String(code)}, signal=${String(signal)})`
                );
            // Runs after the buffering listener registered at spawn.
            child.on("message", onMessage);
            child.once("close", onClose);
            onMessage();
        }
    );
    return withTimeout(
        pending,
        WAIT_TIMEOUT_MS,
        `timed out waiting for the departure child's "${type}"`
    );
};

const killAbruptly = async (running: RunningChild) => {
    expect(running.child.kill("SIGKILL")).toBe(true);
    const result = await withTimeout(
        running.closed,
        30_000,
        "departure child did not close after SIGKILL"
    );
    if (process.platform !== "win32") {
        expect(result.signal).toBe("SIGKILL");
    }
};

/** One transport event J's coordinator handled, with R's record after it. */
type Delivered = {
    at: number;
    event: TransportEvent;
    /** J's A' read of R when the event arrived. */
    reachable: boolean;
    state?: PeerState;
    departed?: boolean;
    /** J's readiness status right after R departed at this event. */
    status?: ReadinessStatus;
};

/** An OPEN attempt of R's session that ended, with R's record after it. */
type AttemptEnd = {
    at: number;
    state?: PeerState;
    gap?: PeerRecord["gap"];
    status?: ReadinessStatus;
};

/** What J's coordinator did about R, recorded from before J opened. */
type Probe = {
    r: string;
    fs?: SharedFsHandle;
    coordinators: Set<Coordinator>;
    transport: Delivered[];
    attempts: AttemptEnd[];
    /** R's record whenever J's `write:ready` fired. */
    ready: Array<{ at: number; state?: PeerState; gap?: PeerRecord["gap"] }>;
    restore(): void;
};

const statusOf = (probe: Probe) => {
    try {
        return probe.fs?.bootstrapStatus().readiness;
    } catch {
        return undefined;
    }
};

/**
 * Wraps the coordinator's transport and attempt handlers on the prototype,
 * so the events of J's open are recorded too (only J joins in this
 * process; the tests check that). `restore()` puts them back.
 */
const installProbe = (r: string): Probe => {
    const proto = Coordinator.prototype as any;
    const onTransport = proto.onTransport;
    const onAttempt = proto.onAttempt;
    const probe: Probe = {
        r,
        coordinators: new Set(),
        transport: [],
        attempts: [],
        ready: [],
        restore: () => {
            proto.onTransport = onTransport;
            proto.onAttempt = onAttempt;
        },
    };
    proto.onTransport = function (this: Coordinator, event: TransportEvent) {
        probe.coordinators.add(this);
        const reachable = this.ports.transport.isReachable(r);
        const departedBefore = this.record(r)?.departed === true;
        onTransport.call(this, event);
        const record = this.record(r);
        const { key: _key, ...plain } = event as TransportEvent & {
            key?: unknown;
        };
        probe.transport.push({
            at: performance.now(),
            event: plain as TransportEvent,
            reachable,
            state: record?.state,
            departed: record?.departed,
            ...(record?.departed && !departedBefore
                ? { status: statusOf(probe) }
                : {}),
        });
    };
    proto.onAttempt = function (this: Coordinator, ...args: unknown[]) {
        const ofR = this.record(r)?.session === args[0];
        onAttempt.apply(this, args);
        if (!ofR) return;
        const record = this.record(r);
        probe.attempts.push({
            at: performance.now(),
            state: record?.state,
            gap: record?.gap && { ...record.gap },
            ...(record?.state === "left" ? { status: statusOf(probe) } : {}),
        });
    };
    return probe;
};

/** The fanout channels of `peer` holding `child` as a child (5.4.10). */
const fanoutParentChannels = (peer: Peerbit, child: string): any[] => {
    const channels: Map<string, any> | undefined = (peer.services as any).fanout
        ?.channelsBySuffixKey;
    return [...(channels?.values() ?? [])].filter(
        (channel) => !channel.closed && channel.children?.has?.(child)
    );
};

/** The shard topic of a user topic and its root as `peer` resolved it (5.4.10). */
const shardOf = (peer: Peerbit, topic: string) => {
    const pubsub: any = peer.services.pubsub;
    const shard: string = pubsub.getShardTopicForUserTopic(topic);
    return { shard, root: pubsub.fanoutChannels?.get(shard)?.root };
};

const connectedTo = (peer: Peerbit, peerId: string) =>
    peer.libp2p
        .getConnections()
        .some((connection) => connection.remotePeer.toString() === peerId);

/** Re-read triggers for R (coordinator D1/D2), not signs of life. */
const isTrigger = (event: TransportEvent, r: string) =>
    event.kind === "reachability" ||
    (event.kind === "unsubscribe" && event.peer === r);

/** Every pubsub `unsubscribe` naming `r` at `peer`, by time. */
const unsubscribesOf = (peer: Peerbit, r: string) => {
    const seen: number[] = [];
    peer.services.pubsub.addEventListener("unsubscribe", (event: any) => {
        if (event.detail?.from?.hashcode?.() === r) {
            seen.push(performance.now());
        }
    });
    return seen;
};

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** A row of the child's report as the tap keys it (trust keys are bytes). */
const tapRow = (
    row: DepartureRow,
    scope: ScopeDescriptor
): { key: IdKey; head: string; label: string } => ({
    key:
        scope === TRUST_V1
            ? Uint8Array.from(Buffer.from(row.key, "hex"))
            : row.key,
    head: row.head,
    label: row.key,
});

/** The rows of `rows` whose head `tap` does not hold, read synchronously. */
const missingFromTap = (
    tap: ScopeTap | undefined,
    rows: ReadonlyArray<ReturnType<typeof tapRow>>
) =>
    rows
        .filter(({ key, head }) => {
            const slot = tap ? tap.map.get(key) : -1;
            return !(slot >= 0 && tap!.map.headEquals(slot, headDigest(head)));
        })
        .map(({ label }) => label);

/** A scope's index rows (id to head; trust ids in hex), as R reports them. */
const indexRows = async (documents: any, scope: ScopeDescriptor) => {
    const rows = new Map<string, string>();
    for await (const page of documentsIndexPort(documents, scope).scan()) {
        for (const { key, head } of page) {
            rows.set(typeof key === "string" ? key : hexOf(key), head);
        }
    }
    return rows;
};

/** J's view when it turned ready (`ReadinessRuntime.markReady`). */
type Decision = {
    at: number;
    satisfied: boolean;
    /** R's namespace rows J's tap did not hold (W's included). */
    missingNamespace: string[];
    /** R's trust rows J's tap did not hold (the edge). */
    missingTrust: string[];
    /** J's trust pull queue (the `TRUST_V1` bundle). */
    trustPulls?: PullQueueStats;
    debug: CoordinatorDebug;
};

/** What J did about R's one trust edge, recorded from before J opened. */
type TrustProbe = {
    /** Exchange-heads messages of J's trust log dropped (sync withheld). */
    withheld: number[];
    /** Joins into J's trust log naming the edge: held before and after. */
    joins: Array<{ at: number; before: boolean; after: boolean }>;
    /** J's trust graph `change` events that added a row. */
    trustAdded: number[];
    /** Every scope result J's coordinator held, in order. */
    results: Array<{ at: number; peer: string; result: SessionResult }>;
    /** J's namespace refusals for trust (the trust lag, logged only). */
    trustRefusals: Array<{ at: number; signers: string[] }>;
    decision?: Decision;
    restore(): void;
};

/**
 * Test 38's hooks, on prototypes so J's open is covered too (only J runs
 * shared-fs in this process; R and W are in the child):
 *
 * - sync of J's trust log is withheld: `SharedLog.onMessage` drops exchange
 *   heads (raw and stash-backed ones too) for J's node and R's trust log id.
 *   The shared-log `responseHandler` calls `this.onMessage` late, so the
 *   prototype patch sees them (SPEC3 G3-18). Block fetches still pass, and
 *   with them the readiness pull (`SharedLog.join` of a hash);
 * - `isTrusted`'s remote warmup searches R's graph with `replicate: true`,
 *   a second delivery path, so J's `TrustedNetwork` opens with it off
 *   (G3-14: a decoded instance never warms up anyway);
 * - records: joins naming the edge, J's trust graph additions, every
 *   coordinator result, trust refusals, and J's view at its decision.
 */
const installTrustProbe = (options: {
    joiner: string;
    trustLogId: string;
    edge: string;
    namespace: ReadonlyArray<ReturnType<typeof tapRow>>;
    trust: ReadonlyArray<ReturnType<typeof tapRow>>;
}): TrustProbe => {
    const logProto = SharedLog.prototype as any;
    const trustProto = TrustedNetwork.prototype as any;
    const runtimeProto = ReadinessRuntime.prototype as any;
    const coordinatorProto = Coordinator.prototype as any;
    const onMessage = logProto.onMessage;
    const join = logProto.join;
    const open = trustProto.open;
    const noteRejection = runtimeProto.noteRejection;
    const markReady = runtimeProto.markReady;
    const setResult = coordinatorProto.setResult;
    const probe: TrustProbe = {
        withheld: [],
        joins: [],
        trustAdded: [],
        results: [],
        trustRefusals: [],
        restore: () => {
            logProto.onMessage = onMessage;
            logProto.join = join;
            trustProto.open = open;
            runtimeProto.noteRejection = noteRejection;
            runtimeProto.markReady = markReady;
            coordinatorProto.setResult = setResult;
        },
    };
    const isJoinersTrustLog = (log: any) => {
        try {
            return (
                log.node?.identity?.publicKey?.hashcode() === options.joiner &&
                log.log?.id instanceof Uint8Array &&
                hexOf(log.log.id) === options.trustLogId
            );
        } catch {
            return false;
        }
    };
    logProto.onMessage = function (this: any, message: unknown, context: any) {
        if (
            (message instanceof ExchangeHeadsMessage ||
                message instanceof RawExchangeHeadsMessage) &&
            isJoinersTrustLog(this)
        ) {
            probe.withheld.push(performance.now());
            // A stash-backed message holds its bytes until released.
            if (message instanceof StashBackedRawExchangeHeadsMessage) {
                message.release();
            }
            return Promise.resolve();
        }
        return onMessage.call(this, message, context);
    };
    logProto.join = function (this: any, entries: unknown[], ...rest: any[]) {
        const namesEdge =
            Array.isArray(entries) &&
            entries.some(
                (entry) =>
                    (typeof entry === "string"
                        ? entry
                        : (entry as any)?.hash) === options.edge
            );
        if (!namesEdge || !isJoinersTrustLog(this)) {
            return join.call(this, entries, ...rest);
        }
        return (async () => {
            const before = await this.log.has(options.edge);
            try {
                return await join.call(this, entries, ...rest);
            } finally {
                probe.joins.push({
                    at: performance.now(),
                    before,
                    after: await this.log.has(options.edge).catch(() => false),
                });
            }
        })();
    };
    trustProto.open = async function (this: any, ...args: any[]) {
        this._lastWarmupAt = Number.POSITIVE_INFINITY;
        await open.apply(this, args);
        // Attached before shared-fs's own trust listener, so it fires
        // before the coordinator's `trustChanged`.
        this.trustGraph.events.addEventListener("change", (event: any) => {
            if ((event.detail?.added?.length ?? 0) > 0) {
                probe.trustAdded.push(performance.now());
            }
        });
    };
    runtimeProto.noteRejection = function (
        this: ReadinessRuntime,
        scope: number,
        head: unknown,
        reason: string,
        signers?: readonly { hashcode(): string }[]
    ) {
        if (
            scope === SCOPE_NAMESPACE_V1 &&
            (reason === "untrusted" || reason === "trust-cache")
        ) {
            probe.trustRefusals.push({
                at: performance.now(),
                signers: (signers ?? []).map((key) => key.hashcode()),
            });
        }
        return noteRejection.call(this, scope, head, reason, signers);
    };
    runtimeProto.markReady = function (this: ReadinessRuntime) {
        const coordinator = this.coordinator;
        if (!probe.decision && coordinator) {
            const pulls = this.sessionScope(SCOPE_TRUST_V1)?.pulls.stats;
            probe.decision = {
                at: performance.now(),
                satisfied: this.satisfied(),
                missingNamespace: missingFromTap(
                    this.namespace,
                    options.namespace
                ),
                missingTrust: missingFromTap(this.trust, options.trust),
                trustPulls: pulls && { ...pulls },
                debug: coordinator.debug(),
            };
        }
        return markReady.call(this);
    };
    coordinatorProto.setResult = function (
        this: Coordinator,
        entry: { hash: string },
        result: SessionResult
    ) {
        probe.results.push({ at: performance.now(), peer: entry.hash, result });
        return setResult.call(this, entry, result);
    };
    return probe;
};

type Topology = "parent" | "no-parent" | "relayed";

describe("readiness departure across processes", () => {
    const children = new Set<RunningChild>();
    const peers: Peerbit[] = [];
    const probes: Array<Pick<Probe, "restore">> = [];
    const holds: Array<ReturnType<typeof holdFlips>> = [];

    afterEach(async () => {
        for (const probe of probes.splice(0)) probe.restore();
        for (const hold of holds.splice(0)) hold.restore();
        const stops = await Promise.allSettled(
            [...children].map(async (running) => {
                const { child } = running;
                if (child.exitCode === null && child.signalCode === null) {
                    // SIGKILL ends a frozen child too; the SIGCONT is test
                    // 54's own cleanup, for a run that failed before it.
                    if (process.platform !== "win32") child.kill("SIGCONT");
                    child.kill("SIGKILL");
                }
                await withTimeout(
                    running.closed,
                    30_000,
                    "departure child cleanup timed out"
                );
                children.delete(running);
            })
        );
        await stopTestPeers(peers);
        const failed = stops.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        );
        if (failed) throw failed.reason;
    });

    const createPeer = async (deny?: Set<string>) => {
        const denied = (peerId: unknown) => !!deny?.has(String(peerId));
        const peer = await Peerbit.create(
            deny
                ? ({
                      libp2p: {
                          connectionGater: {
                              denyDialPeer: async (peerId: unknown) =>
                                  denied(peerId),
                              denyInboundEncryptedConnection: async (
                                  peerId: unknown
                              ) => denied(peerId),
                              denyOutboundEncryptedConnection: async (
                                  peerId: unknown
                              ) => denied(peerId),
                              denyInboundRelayedConnection: async (
                                  _relay: unknown,
                                  remote: unknown
                              ) => denied(remote),
                              denyOutboundRelayedConnection: async (
                                  _relay: unknown,
                                  remote: unknown
                              ) => denied(remote),
                          },
                      },
                  } as any)
                : {}
        );
        peers.push(peer);
        return peer;
    };

    /**
     * R (the child), D (the creator, one file) and J (a fresh full
     * joiner), wired as `topology` says. Every peer's pubsub root
     * candidates are [J] (J roots every shard and R dials only J, so J is
     * R's fanout parent), [R] (R roots every shard, so R has no parent) or
     * [D] (R and J dial only D and never connect to each other, so D
     * relays and is R's parent). Returns once J's coordinator holds D
     * contained and qualified and R asking, unanswered, with R having
     * dropped J's OPEN.
     */
    const setup = async (topology: Topology) => {
        const running = startChild();
        children.add(running);
        const hello = await reportOf(running, "hello");
        const r = hello.hash;

        const deny = new Set<string>();
        const donorPeer = await createPeer();
        const joinerPeer = await createPeer(deny);
        const donor = hashOf(donorPeer);
        const joiner = hashOf(joinerPeer);
        if (topology === "relayed") deny.add(hello.peerId);
        const candidates =
            topology === "parent"
                ? [joiner]
                : topology === "no-parent"
                  ? [r]
                  : [donor];
        for (const peer of [donorPeer, joinerPeer]) {
            (peer.services.pubsub as any).setTopicRootCandidates(candidates);
        }
        // Connected before anything subscribes, so every shard resolves
        // its root at once.
        await joinerPeer.dial(donorPeer);
        const connect: DepartureCommand = {
            type: "connect",
            dial:
                topology === "parent"
                    ? tcpAddrs(joinerPeer)
                    : topology === "no-parent"
                      ? [...tcpAddrs(joinerPeer), ...tcpAddrs(donorPeer)]
                      : tcpAddrs(donorPeer),
            candidates,
            deny: topology === "relayed" ? [joinerPeer.peerId.toString()] : [],
        };
        running.child.send(connect);
        await reportOf(running, "connected");

        const donorFs = await openSharedFs({
            peerbit: donorPeer,
            machineLabel: "departure-d",
            gc: false,
        });
        await donorFs.writeFile("/donor.txt", "from the donor");
        const open: DepartureCommand = {
            type: "open",
            address: donorFs.address!,
        };
        running.child.send(open);
        const opened = await reportOf(running, "opened");
        // S13: the child's anchor worker runs under tsx (the `__name` shim).
        expect(opened.anchorMode).toBe("worker");

        const probe = installProbe(r);
        probes.push(probe);
        // J's decisions wait until R is in J's view. R reaches it by its
        // readiness subscription (relayed through D in the relayed
        // topology), which can land after J contained D, and a peer
        // visible only after the decision is not waited for (design 2.3).
        // Held, J cannot turn ready on D alone first; released below, a
        // parked decision finds R Required and flips nothing.
        const flips = holdFlips(joinerPeer);
        holds.push(flips);
        const fs = await openSharedFs({
            peerbit: joinerPeer,
            address: donorFs.address!,
            machineLabel: "departure-j",
            bootstrap: false,
            gc: false,
        });
        probe.fs = fs;
        let coordinator!: Coordinator;
        await waitUntil(() => {
            coordinator = runtimeOf(fs)!.coordinator!;
            expect(coordinator).toBeDefined();
        });
        (fs.program as any).events.addEventListener("write:ready", () => {
            const record = coordinator.record(r);
            probe.ready.push({
                at: performance.now(),
                state: record?.state,
                gap: record?.gap && { ...record.gap },
            });
        });
        const topic: string = (fs.program as any).readiness.topic;
        expect(opened.topic).toBe(topic);

        await reportOf(running, "dropped", (report) => report.from === joiner);
        await waitUntil(() => {
            expect(coordinator.record(donor)).toMatchObject({
                state: "contained",
                qualified: true,
            });
            expect(coordinator.record(r)).toMatchObject({
                state: "asking",
                headerHeld: false,
                departed: false,
            });
            expect(coordinator.ports.transport.isReachable(r)).toBe(true);
        });
        // Gated by R alone.
        const status = fs.bootstrapStatus();
        expect(status.writeReady).toBe(false);
        expect(status.readiness).toMatchObject({
            satisfied: false,
            required: [r],
        });
        expect(probe.ready).toEqual([]);
        // Whether this run took the race the hold covers: a decision parked
        // before R turned Required, which the release must not flip.
        console.info(
            `readiness-departure setup: ${flips.parked()} decision(s) parked at release`
        );
        flips.release();
        await waitUntil(() =>
            expect(runtimeOf(fs)!.debug().coordinator!.decisions.inFlight).toBe(
                false
            )
        );
        expect(fs.bootstrapStatus().writeReady).toBe(false);
        return {
            running,
            donorPeer,
            joinerPeer,
            fs,
            coordinator,
            probe,
            topic,
            donor,
            joiner,
            r,
            rPeerId: hello.peerId,
        };
    };

    type World = Awaited<ReturnType<typeof setup>>;

    /**
     * R was alive and asked once up to `at`: never departed (a wrong `left`
     * that came back would also have opened a second session), and only
     * J's coordinator handled events in this process.
     */
    const expectAliveUntil = (world: World, at: number) => {
        const { probe, coordinator, r } = world;
        for (const seen of probe.coordinators) expect(seen).toBe(coordinator);
        expect(
            probe.transport.filter((entry) => entry.at < at && entry.departed)
        ).toEqual([]);
        expect(coordinator.record(r)).toMatchObject({
            departed: false,
            sessionsOpened: 1,
        });
    };

    /**
     * R's departure after `at`: at the first re-read trigger J's
     * coordinator handled once J's route table no longer reached R, and
     * never on a reachable read.
     */
    const departureAfter = (world: World, at: number) => {
        const { probe, r } = world;
        const after = probe.transport.filter((entry) => entry.at >= at);
        const index = after.findIndex((entry) => entry.departed);
        expect(index, JSON.stringify(after)).toBeGreaterThanOrEqual(0);
        const departure = after[index];
        expect(departure.reachable).toBe(false);
        expect(index).toBe(
            after.findIndex(
                (entry) => !entry.reachable && isTrigger(entry.event, r)
            )
        );
        return departure;
    };

    /** Left before answering: J stays gated until the attempt ends (D:682). */
    const expectWaitingLeft = (world: World, departure: Delivered) => {
        const { r } = world;
        expect(departure.state).toBe("left-unanswered");
        expect(departure.status).toMatchObject({
            state: "waiting-left",
            satisfied: false,
            required: [r],
            gaps: [],
        });
        expect(departure.status!.inFlight).toContainEqual(
            expect.objectContaining({ peer: r, state: "left-unanswered" })
        );
    };

    /**
     * Then `left` with a gap of unknown rows when the attempt in flight
     * ends (D4), and J ready with D, once, only after that.
     */
    const expectLeftThenReady = async (world: World, departure: Delivered) => {
        const { probe, coordinator, fs, r, donor } = world;
        await waitUntil(() =>
            expect(coordinator.record(r)?.state).toBe("left")
        );
        const ended = probe.attempts.find(({ state }) => state === "left");
        expect(ended, JSON.stringify(probe.attempts)).toBeDefined();
        expect(ended!.at).toBeGreaterThan(departure.at);
        expect(ended!.gap).toEqual({ missing: "unknown" });
        expect(ended!.status).toMatchObject({ required: [] });
        expect(ended!.status!.gaps).toEqual([{ peer: r, missing: "unknown" }]);

        await fs.awaitWriteReady({ timeout: WAIT_TIMEOUT_MS });
        expect(probe.ready).toEqual([
            {
                at: expect.any(Number),
                state: "left",
                gap: { missing: "unknown" },
            },
        ]);
        expect(probe.ready[0].at).toBeGreaterThanOrEqual(ended!.at);
        const status = fs.bootstrapStatus();
        expect(status.writeReady).toBe(true);
        expect(status.readiness).toMatchObject({
            state: "ready",
            required: [],
            excluded: [],
            gaps: [{ peer: r, missing: "unknown" }],
        });
        expect(status.readiness!.contained).toEqual([
            expect.objectContaining({
                peer: donor,
                qualified: true,
                source: "creator",
                departed: false,
            }),
        ]);
        expect(coordinator.record(donor)?.departed).toBe(false);
        // Gone by reachability (A'), never as a store R closed (D6).
        expect(coordinator.record(r)).toMatchObject({
            departed: true,
            storeClosed: false,
        });
        const proof = coordinator.proof();
        expect(proof.contained.map(({ peer }) => peer)).toEqual([donor]);
        expect(proof.gaps).toEqual([{ peer: r, missing: "unknown" }]);
    };

    /** One evidence line per test (latencies from the fault, in ms). */
    const report = (
        name: string,
        world: World,
        faultAt: number,
        departure?: Delivered
    ) => {
        const { probe, r } = world;
        const ms = (at?: number) =>
            at === undefined ? undefined : Math.round(at - faultAt);
        console.log(
            "readiness-departure:",
            JSON.stringify({
                test: name,
                departureMs: ms(departure?.at),
                leftMs: ms(
                    probe.attempts.find(({ state }) => state === "left")?.at
                ),
                readyMs: ms(probe.ready[0]?.at),
                events: probe.transport
                    .filter((entry) => entry.at >= faultAt)
                    .map((entry) => ({
                        ms: ms(entry.at),
                        kind: entry.event.kind,
                        source:
                            (entry.event as any).source ??
                            (entry.event as any).type ??
                            (entry.event as any).reason,
                        namesR: (entry.event as any).peer === r,
                        reachable: entry.reachable,
                        state: entry.state,
                    })),
            })
        );
    };

    it(
        "53: kill -9 of R with J as its fanout parent: left-unanswered at the first unreachable read, then a gap, then ready",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
            const world = await setup("parent");
            const { joinerPeer, topic, r, running } = world;
            // J is R's fanout parent on the readiness topic's shard.
            const { shard, root } = shardOf(joinerPeer, topic);
            expect(root).toBe(world.joiner);
            await waitUntil(() =>
                expect(
                    fanoutParentChannels(joinerPeer, r).map(
                        (channel) => channel.id.topic
                    )
                ).toContain(shard)
            );
            const lostChild: number[] = [];
            (joinerPeer.services as any).fanout.addEventListener(
                "fanout:peer-unreachable",
                (event: any) => {
                    if (event.detail?.publicKeyHash === r) {
                        lostChild.push(performance.now());
                    }
                }
            );
            const unsubscribed = unsubscribesOf(joinerPeer, r);

            const killedAt = performance.now();
            expectAliveUntil(world, killedAt);
            await killAbruptly(running);
            await waitUntil(() =>
                expect(world.coordinator.record(r)?.departed).toBe(true)
            );
            const departure = departureAfter(world, killedAt);
            // libp2p or fanout said so; J, R's parent, never hears an
            // unsubscribe for R before it (U-35).
            expect(departure.event.kind).toBe("reachability");
            expect(unsubscribed.filter((at) => at <= departure.at)).toEqual([]);
            expectWaitingLeft(world, departure);
            await expectLeftThenReady(world, departure);
            // J really was R's parent: its fanout tree lost R as a child.
            expect(lostChild.length).toBeGreaterThan(0);
            report("53-parent", world, killedAt, departure);
        }
    );

    it(
        "53: kill -9 of R with no fanout parent: left-unanswered at the first unreachable read, then a gap, then ready",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
            const world = await setup("no-parent");
            const { joinerPeer, donorPeer, topic, r, running } = world;
            // R roots the readiness topic's shard: nobody is its parent.
            expect(shardOf(joinerPeer, topic).root).toBe(r);
            expect(shardOf(donorPeer, topic).root).toBe(r);
            expect(fanoutParentChannels(joinerPeer, r)).toEqual([]);
            expect(fanoutParentChannels(donorPeer, r)).toEqual([]);
            const unsubscribed = unsubscribesOf(joinerPeer, r);

            const killedAt = performance.now();
            expectAliveUntil(world, killedAt);
            await killAbruptly(running);
            await waitUntil(() =>
                expect(world.coordinator.record(r)?.departed).toBe(true)
            );
            const departure = departureAfter(world, killedAt);
            expect(departure.event.kind).toBe("reachability");
            expect(unsubscribed.filter((at) => at <= departure.at)).toEqual([]);
            expectWaitingLeft(world, departure);
            await expectLeftThenReady(world, departure);
            report("53-no-parent", world, killedAt, departure);
        }
    );

    it(
        "53: kill -9 of R relayed through D: left on the re-read the relay's unsubscribe triggers, or Required until the timeout",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
            const world = await setup("relayed");
            const {
                joinerPeer,
                donorPeer,
                topic,
                r,
                rPeerId,
                running,
                coordinator,
                fs,
                probe,
            } = world;
            // J reaches R only through D, which is R's fanout parent.
            expect(connectedTo(joinerPeer, rPeerId)).toBe(false);
            expect((joinerPeer.services.pubsub as any).peers.has(r)).toBe(
                false
            );
            const { shard, root } = shardOf(donorPeer, topic);
            expect(root).toBe(world.donor);
            await waitUntil(() =>
                expect(
                    fanoutParentChannels(donorPeer, r).map(
                        (channel) => channel.id.topic
                    )
                ).toContain(shard)
            );
            expect(fanoutParentChannels(joinerPeer, r)).toEqual([]);

            const killedAt = performance.now();
            expectAliveUntil(world, killedAt);
            await killAbruptly(running);
            const departed = await waitUntil(
                () => expect(coordinator.record(r)?.departed).toBe(true),
                RELAYED_DEPARTURE_BOUND_MS
            ).then(
                () => true,
                () => false
            );
            // J never connected to R, before or after.
            expect(connectedTo(joinerPeer, rPeerId)).toBe(false);
            if (!departed) {
                // The documented liveness limit (M1 plan 7.3): no trigger
                // arrived, so R stays Required and J stays gated until the
                // caller's timeout. Never a wrong ready.
                const error = await timeoutOf(fs, 1_000);
                expect(error.readiness.required).toContain(r);
                expect(error.message).toContain(r);
                expect(fs.bootstrapStatus().writeReady).toBe(false);
                expect(probe.ready).toEqual([]);
                console.warn(
                    `readiness-departure: relayed R ${r} saw no departure trigger within ${RELAYED_DEPARTURE_BOUND_MS} ms; it stays Required (liveness limit, M1 plan 7.3)`
                );
                report("53-relayed-no-trigger", world, killedAt);
                return;
            }
            const departure = departureAfter(world, killedAt);
            expectWaitingLeft(world, departure);
            await expectLeftThenReady(world, departure);
            report("53-relayed", world, killedAt, departure);
        }
    );

    // SIGSTOP and SIGCONT do not exist on Windows: a process cannot be
    // frozen there while its sockets stay open.
    it.skipIf(process.platform === "win32")(
        "54: SIGSTOP of R: gated; ETIMEDOUT names R in flight, then reachable and silent; ready after it leaves",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
            const world = await setup("parent");
            const { coordinator, fs, r, running, probe } = world;
            const runtime = runtimeOf(fs)!;

            const stoppedAt = performance.now();
            expectAliveUntil(world, stoppedAt);
            expect(running.child.kill("SIGSTOP")).toBe(true);

            // While R's attempts run, it is in flight.
            const early = await timeoutOf(fs, 1_500);
            expect(early.readiness).toMatchObject({
                state: "reconciling",
                satisfied: false,
                required: [r],
                silent: [],
                gaps: [],
            });
            expect(early.readiness.inFlight).toContainEqual(
                expect.objectContaining({ peer: r, state: "asking" })
            );
            expect(early.message).toContain(r);

            // After the last attempt (35 s after J's first OPEN) R is
            // silent and still Required, unless the transport really
            // dropped it.
            await waitUntil(() => {
                const record = coordinator.record(r);
                expect(
                    record?.state === "silent" || record?.departed === true
                ).toBe(true);
            });
            const frozenDeparture = probe.transport.find(
                (entry) => entry.at >= stoppedAt && entry.departed
            );
            if (frozenDeparture) {
                // M0 P1 saw a transport close of a frozen peer at 18-21 s in
                // 4 of 15 runs (cause not found). R is unreachable then and
                // leaving is right; only a departure on a reachable read
                // would be wrong. The silent naming cannot be checked.
                expect(frozenDeparture.reachable).toBe(false);
                console.warn(
                    `readiness-departure: the transport dropped the frozen R ${r}; "reachable and silent" was not exercised in this run`
                );
            } else {
                expect(coordinator.record(r)).toMatchObject({
                    state: "silent",
                    departed: false,
                    reachable: true,
                    headerHeld: false,
                });
                const late = await timeoutOf(fs, 1_000);
                expect(late.readiness).toMatchObject({
                    state: "waiting-silent",
                    satisfied: false,
                    required: [r],
                    silent: [{ peer: r, reachable: true }],
                    inFlight: [],
                    gaps: [],
                });
                expect(late.message).toContain(`reachable and silent: ${r}`);
                // Gated with nothing in flight: no timer armed (design 4.9,
                // M1 plan 10.5).
                expect(runtime.debug().armedTimers).toBe(0);
                expect(fs.bootstrapStatus().writeReady).toBe(false);
                expect(probe.ready).toEqual([]);
            }

            // SIGCONT, then the kill: R leaves and J turns ready with D.
            expect(running.child.kill("SIGCONT")).toBe(true);
            const killedAt = performance.now();
            await killAbruptly(running);
            await waitUntil(() =>
                expect(coordinator.record(r)?.state).toBe("left")
            );
            if (!frozenDeparture) {
                // A silent R leaves at once; a resumed one (a sign of life
                // after SIGCONT) when its attempt ends.
                const departure = departureAfter(world, killedAt);
                expect(["left", "left-unanswered"]).toContain(departure.state);
            }
            expect(coordinator.record(r)?.gap).toEqual({ missing: "unknown" });
            await fs.awaitWriteReady({ timeout: WAIT_TIMEOUT_MS });
            expect(probe.ready).toEqual([
                {
                    at: expect.any(Number),
                    state: "left",
                    gap: { missing: "unknown" },
                },
            ]);
            expect(fs.bootstrapStatus().readiness).toMatchObject({
                state: "ready",
                required: [],
                gaps: [{ peer: r, missing: "unknown" }],
            });
            report("54", world, stoppedAt);
        }
    );

    it(
        "38: an access-controlled store across processes; J lacks R's one trust edge: TRUST_V1 pulls it from trustGraph.log, then the namespace scope contains; ready with the edge and the writer's rows",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
            const running = startChild();
            children.add(running);
            const hello = await reportOf(running, "hello");
            const r = hello.hash;
            const joinerPeer = await createPeer();
            const joiner = hashOf(joinerPeer);
            // R roots every shard: the one peer present throughout.
            const candidates = [r];
            (joinerPeer.services.pubsub as any).setTopicRootCandidates(
                candidates
            );
            const openAcl: DepartureCommand = { type: "open-acl", candidates };
            running.child.send(openAcl);
            const acl = await reportOf(running, "acl-opened");
            // S13: R's anchor worker runs under tsx, so R can answer.
            expect(acl.anchorMode).toBe("worker");
            const w = acl.writer;
            // The scenario: one edge (R grants W); R holds rows of its own
            // and of W's, and W's are admitted only with the edge.
            expect(acl.trust).toHaveLength(1);
            const edge = acl.trust[0].head;
            expect(new Set(acl.namespace.map(({ signer }) => signer))).toEqual(
                new Set([r, w])
            );
            const writerRows = acl.namespace.filter(
                ({ signer }) => signer === w
            );
            expect(writerRows.length).toBeGreaterThan(0);

            const probe = installTrustProbe({
                joiner,
                trustLogId: acl.trustLogId,
                edge,
                namespace: acl.namespace.map((row) =>
                    tapRow(row, NAMESPACE_V1)
                ),
                trust: acl.trust.map((row) => tapRow(row, TRUST_V1)),
            });
            probes.push(probe);
            expect(hello.addrs.length).toBeGreaterThan(0);
            await joinerPeer.dial(hello.addrs[0]);
            const openedAt = performance.now();
            const fs = await openSharedFs({
                peerbit: joinerPeer,
                address: acl.address,
                machineLabel: "departure-j",
                bootstrap: false,
                gc: false,
            });
            const runtime = runtimeOf(fs)!;
            expect(runtime.accessControlled).toBe(true);
            let coordinator!: Coordinator;
            await waitUntil(() => {
                coordinator = runtime.coordinator!;
                expect(coordinator).toBeDefined();
            });
            expect(coordinator.ports.scopes).toEqual([
                SCOPE_NAMESPACE_V1,
                SCOPE_TRUST_V1,
            ]);

            await fs.awaitWriteReady({ timeout: WAIT_TIMEOUT_MS });
            const decision = probe.decision!;
            expect(decision).toBeDefined();
            // At the decision J held every row R listed, W's included, and
            // the edge.
            expect(decision).toMatchObject({
                satisfied: true,
                missingNamespace: [],
                missingTrust: [],
            });
            // The edge moved J's trust epoch while the join ran.
            expect(decision.debug.trustTriggers.change).toBeGreaterThan(0);
            expect(decision.debug.trustEpoch).toBeGreaterThan(0);

            // TRUST_V1 pulled it: J lacked exactly the edge when R's first
            // trust run started, and its trust pull queue joined it.
            const ofR = probe.results.filter(({ peer }) => peer === r);
            const trustResults = ofR.filter(
                ({ result }) => result.scope === SCOPE_TRUST_V1
            );
            const namespaceResults = ofR.filter(
                ({ result }) => result.scope === SCOPE_NAMESPACE_V1
            );
            expect(trustResults.length).toBeGreaterThan(0);
            expect(trustResults[0].result).toMatchObject({
                count: 1,
                missingAtStart: 1,
                qualified: true,
            });
            expect(trustResults[0].result.pulled).toBeGreaterThan(0);
            expect(decision.trustPulls?.joined).toBeGreaterThan(0);
            // From trustGraph.log, by one join: the edge was absent before
            // it and present after, and nothing else delivered it.
            const delivered = probe.joins.filter(
                ({ before, after }) => !before && after
            );
            expect(delivered, JSON.stringify(probe.joins)).toHaveLength(1);
            expect(probe.trustAdded.length).toBeGreaterThan(0);
            const edgeAt = probe.trustAdded[0];
            expect(edgeAt).toBeLessThanOrEqual(delivered[0].at);

            // Then the namespace scope contains: every namespace result for
            // R came after the edge landed (W's rows need it), and it
            // admitted W's rows rather than explaining them.
            expect(namespaceResults.length).toBeGreaterThan(0);
            for (const { at } of namespaceResults) {
                expect(at).toBeGreaterThan(edgeAt);
            }
            expect(decision.at).toBeGreaterThan(namespaceResults[0].at);
            const record = coordinator.record(r)!;
            expect(record).toMatchObject({
                state: "contained",
                qualified: true,
                identity: "trusted",
                departed: false,
            });
            const namespace = record.results.get(SCOPE_NAMESPACE_V1)!;
            expect(namespace.explainedBy["rejected-untrusted"] ?? 0).toBe(0);
            expect(namespace.untrusted).toBeUndefined();
            expect(record.results.get(SCOPE_TRUST_V1)).toBeDefined();
            expect(
                coordinator
                    .proof()
                    .contained.map(({ peer, scope }) => `${scope} ${peer}`)
                    .sort()
            ).toEqual([`namespace-v1 ${r}`, `trust-v1 ${r}`]);
            const status = fs.bootstrapStatus();
            expect(status.writeReady).toBe(true);
            expect(status.readiness).toMatchObject({
                state: "ready",
                satisfied: true,
                required: [],
                excluded: [],
                gaps: [],
                trustPending: [],
                trustChecking: [],
            });
            expect(status.readiness!.contained).toEqual([
                expect.objectContaining({
                    peer: r,
                    qualified: true,
                    identity: "trusted",
                    source: "creator",
                    departed: false,
                }),
            ]);
            expect([...status.readiness!.contained[0].scopes].sort()).toEqual([
                "namespace-v1",
                "trust-v1",
            ]);

            // J's indexes: its trust rows are R's (the edge alone), and it
            // holds every namespace row of R's, W's included.
            const program = fs.program as any;
            const trustRows = await indexRows(
                program.trustGraph.trustGraph,
                TRUST_V1
            );
            expect(Object.fromEntries(trustRows)).toEqual(
                Object.fromEntries(
                    acl.trust.map(({ key, head }) => [key, head])
                )
            );
            const namespaceRows = await indexRows(
                program.entries,
                NAMESPACE_V1
            );
            for (const { key, head } of acl.namespace) {
                expect(namespaceRows.get(key), key).toBe(head);
            }

            console.log(
                "readiness-departure:",
                JSON.stringify({
                    test: "38",
                    edgeMs: Math.round(edgeAt - openedAt),
                    namespaceMs: Math.round(namespaceResults[0].at - openedAt),
                    readyMs: Math.round(decision.at - openedAt),
                    writerRows: writerRows.length,
                    // Trust exchange-heads sync tried to deliver, and when
                    // the first came (before `edgeMs`: sync would have won).
                    withheld: probe.withheld.length,
                    withheldMs: probe.withheld.map((at) =>
                        Math.round(at - openedAt)
                    ),
                    edgeJoins: probe.joins.length,
                    // W's rows J refused for trust before the edge (the
                    // order of sync and the pulls decides; not asserted).
                    trustRefusals: probe.trustRefusals.filter(({ signers }) =>
                        signers.includes(w)
                    ).length,
                    sessionsOpened: record.sessionsOpened,
                    trustTriggers: decision.debug.trustTriggers,
                    trustPulls: decision.trustPulls,
                })
            );
        }
    );
});
