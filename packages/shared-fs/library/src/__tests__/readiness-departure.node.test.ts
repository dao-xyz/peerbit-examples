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
    type PeerRecord,
    type PeerState,
    type ReadinessStatus,
    type TransportEvent,
} from "../readiness/coordinator.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import type {
    DepartureCommand,
    DepartureReport,
} from "./readiness-departure.protocol.js";
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

type Topology = "parent" | "no-parent" | "relayed";

describe("readiness departure across processes", () => {
    const children = new Set<RunningChild>();
    const peers: Peerbit[] = [];
    const probes: Probe[] = [];

    afterEach(async () => {
        for (const probe of probes.splice(0)) probe.restore();
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
        const fs = await openSharedFs({
            peerbit: joinerPeer,
            address: donorFs.address!,
            machineLabel: "departure-j",
            bootstrap: false,
            gc: false,
            writeReadinessSettleMs: 100,
        } as any);
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
                // Gated with nothing in flight: no timer armed (design 4.9;
                // the tracker's own poll is commit 4's).
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
});
