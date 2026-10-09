import { Ed25519Keypair, type PublicSignKey } from "@peerbit/crypto";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import type { TransportEvent } from "../readiness/coordinator.js";
import {
    LifeRecorder,
    PeerbitTransport,
    blocksEvents,
    directPeer,
    fanoutEvents,
    isReachable,
    libp2pEvents,
    peerHashOf,
    routesReachable,
    selfHash,
    transportTestHooks,
} from "../readiness/reachability.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Peers as the joiner's coordinator sees them (PR-3 commit 2, SPEC2 section
 * 3; design 4.7 and 4.9, D3 = A'): the private reads of M1, each failing
 * closed to "reachable", `PeerbitTransport`'s event mapping, on a fake node
 * and on in-process Peerbit peers (5.4.10 as installed), and the
 * `LifeRecorder` that keeps the signs of life from J's open until the
 * coordinator starts.
 */

const until = async (
    assertion: () => Promise<void> | void,
    timeoutMs = process.env.CI ? 90_000 : 30_000
) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            return await assertion();
        } catch (error) {
            if (Date.now() > deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
};

const keys = async (n: number): Promise<PublicSignKey[]> =>
    Promise.all(
        Array.from(
            { length: n },
            async () => (await Ed25519Keypair.create()).publicKey
        )
    );

const dispatch = (target: EventTarget, type: string, detail: unknown) =>
    target.dispatchEvent(new CustomEvent(type, { detail }));

/** A node shaped as Peerbit 5.4.10 exposes it, every part replaceable. */
const fakeNode = (
    self: PublicSignKey,
    options: {
        routes?: Map<string, boolean>;
        peers?: Set<string>;
        subscribers?: PublicSignKey[] | undefined;
    } = {}
) => {
    const routes = options.routes ?? new Map<string, boolean>();
    const peers = options.peers ?? new Set<string>();
    const routeReads: Array<[string, string]> = [];
    const pubsub = Object.assign(new EventTarget(), {
        routes: {
            isReachable: (from: string, target: string) => {
                routeReads.push([from, target]);
                return routes.get(target) ?? false;
            },
        },
        peers,
        subscribers: options.subscribers as PublicSignKey[] | undefined,
        getSubscribers(_topic: string) {
            return this.subscribers;
        },
    });
    const libp2p = new EventTarget();
    const fanout = new EventTarget();
    const blocks = new EventTarget();
    const replicators = new Set<string>();
    const logEvents = new EventTarget();
    const log = {
        getReplicators: async () => new Set(replicators),
        events: logEvents,
    };
    const node = {
        identity: { publicKey: self },
        libp2p,
        services: { pubsub, fanout, blocks },
    };
    return {
        node,
        pubsub,
        libp2p,
        fanout,
        blocks,
        log,
        logEvents,
        routes,
        peers,
        replicators,
        routeReads,
    };
};

describe("readiness reachability", () => {
    describe("private reads (SPEC2 3.1)", () => {
        it("selfHash reads node.identity.publicKey, and nothing else", async () => {
            const [key] = await keys(1);
            expect(selfHash({ identity: { publicKey: key } })).toBe(
                key.hashcode()
            );
            expect(selfHash(undefined)).toBeUndefined();
            expect(selfHash({})).toBeUndefined();
            expect(
                selfHash({
                    get identity(): never {
                        throw new Error("closed");
                    },
                })
            ).toBeUndefined();
        });

        it("routesReachable and directPeer answer the read, or undefined when it cannot be made", async () => {
            const [self, peer] = await keys(2);
            const fake = fakeNode(self, {
                routes: new Map([[peer.hashcode(), true]]),
                peers: new Set([peer.hashcode()]),
            });
            expect(
                routesReachable(fake.node, self.hashcode(), peer.hashcode())
            ).toBe(true);
            expect(fake.routeReads).toEqual([
                [self.hashcode(), peer.hashcode()],
            ]);
            expect(directPeer(fake.node, peer.hashcode())).toBe(true);
            fake.routes.set(peer.hashcode(), false);
            fake.peers.clear();
            expect(
                routesReachable(fake.node, self.hashcode(), peer.hashcode())
            ).toBe(false);
            expect(directPeer(fake.node, peer.hashcode())).toBe(false);

            // Missing, renamed, throwing or non-boolean: no answer.
            const broken: unknown[] = [
                undefined,
                {},
                { services: {} },
                { services: { pubsub: {} } },
                { services: { pubsub: { routes: {}, peers: {} } } },
                {
                    services: {
                        pubsub: {
                            routes: { isReachable: () => "yes" },
                            peers: { has: () => 1 },
                        },
                    },
                },
                {
                    services: {
                        pubsub: {
                            routes: {
                                isReachable: () => {
                                    throw new Error("stopped");
                                },
                            },
                            peers: {
                                has: () => {
                                    throw new Error("stopped");
                                },
                            },
                        },
                    },
                },
                {
                    get services(): never {
                        throw new Error("no libp2p");
                    },
                },
            ];
            for (const node of broken) {
                expect(routesReachable(node, "j", "r")).toBeUndefined();
                expect(directPeer(node, "r")).toBeUndefined();
            }
        });

        it("isReachable is A' and fails closed: unreachable only when both reads were made and both say no", async () => {
            const [self, peer] = await keys(2);
            const r = peer.hashcode();
            const answers = [true, false, undefined] as const;
            for (const routes of answers) {
                for (const direct of answers) {
                    const node = {
                        identity: { publicKey: self },
                        services: {
                            pubsub: {
                                routes:
                                    routes === undefined
                                        ? undefined
                                        : { isReachable: () => routes },
                                peers:
                                    direct === undefined
                                        ? undefined
                                        : { has: () => direct },
                            },
                        },
                    };
                    const expected = !(routes === false && direct === false);
                    expect(
                        isReachable(node, self.hashcode(), r),
                        `routes ${routes}, direct ${direct}`
                    ).toBe(expected);
                }
            }
            // Without J's own hash the route read is not made.
            const fake = fakeNode(self);
            expect(isReachable(fake.node, "", r)).toBe(true);
            expect(fake.routeReads).toEqual([]);
            // A node without pubsub at all.
            expect(isReachable({}, self.hashcode(), r)).toBe(true);
        });

        it("libp2pEvents, fanoutEvents and blocksEvents return a listenable source or undefined", async () => {
            const [self] = await keys(1);
            const fake = fakeNode(self);
            expect(libp2pEvents(fake.node)).toBe(fake.libp2p);
            expect(fanoutEvents(fake.node)).toBe(fake.fanout);
            expect(blocksEvents(fake.node)).toBe(fake.blocks);
            expect(libp2pEvents({})).toBeUndefined();
            expect(fanoutEvents({ services: {} })).toBeUndefined();
            expect(blocksEvents({ services: { blocks: {} } })).toBeUndefined();
            expect(libp2pEvents({ libp2p: { addEventListener() {} } })).toBe(
                undefined
            );
            expect(
                libp2pEvents({
                    get libp2p(): never {
                        throw new Error("stopped");
                    },
                })
            ).toBeUndefined();
            expect(
                fanoutEvents({
                    get services(): never {
                        throw new Error("stopped");
                    },
                })
            ).toBeUndefined();
            expect(
                blocksEvents({
                    get services(): never {
                        throw new Error("stopped");
                    },
                })
            ).toBeUndefined();
        });

        it("peerHashOf maps a libp2p peer id to the key's hashcode, or undefined", async () => {
            const keypair = await Ed25519Keypair.create();
            expect(peerHashOf(keypair.publicKey.toPeerId())).toBe(
                keypair.publicKey.hashcode()
            );
            expect(peerHashOf(undefined)).toBeUndefined();
            expect(peerHashOf("12D3KooW")).toBeUndefined();
            expect(peerHashOf({ type: "RSA" })).toBeUndefined();
        });
    });

    describe("PeerbitTransport on a fake node (SPEC2 3.2)", () => {
        const topic = "readiness-topic";

        const setup = async () => {
            const [self, r, s] = await keys(3);
            const fake = fakeNode(self);
            const transport = new PeerbitTransport(fake.node, {
                topic,
                log: fake.log,
            });
            const events: TransportEvent[] = [];
            const detach = transport.listen((event) => events.push(event));
            return { self, r, s, fake, transport, events, detach };
        };

        afterEach(() => {
            globalThis.__SFS_READINESS_TRANSPORT_HOOKS__ = undefined;
        });

        it("maps every source to its event, dropping J itself and other topics", async () => {
            const { self, r, fake, transport, events } = await setup();
            expect(transport.self).toBe(self.hashcode());
            const R = r.hashcode();
            dispatch(fake.pubsub, "subscribe", { from: r, topics: [topic] });
            dispatch(fake.pubsub, "subscribe", { from: r, topics: ["other"] });
            dispatch(fake.pubsub, "subscribe", { from: self, topics: [topic] });
            for (const reason of [
                "remote-unsubscribe",
                "peer-unreachable",
                "peer-session-reset",
                "something-new",
                undefined,
            ]) {
                dispatch(fake.pubsub, "unsubscribe", {
                    from: r,
                    topics: [topic, "other"],
                    reason,
                });
            }
            dispatch(fake.logEvents, "replicator:join", { publicKey: r });
            dispatch(fake.logEvents, "replication:change", { publicKey: r });
            dispatch(fake.logEvents, "replicator:leave", { publicKey: r });
            dispatch(fake.logEvents, "replicator:join", { publicKey: self });
            dispatch(fake.libp2p, "peer:connect", r.toPeerId());
            dispatch(fake.libp2p, "peer:disconnect", r.toPeerId());
            // A peer id without a key: the event names no peer (a sweep).
            dispatch(fake.libp2p, "peer:disconnect", { type: "RSA" });
            dispatch(fake.libp2p, "peer:connect", self.toPeerId());
            // The shared route table's events, on whichever stream applied
            // the change first.
            dispatch(fake.fanout, "peer:unreachable", r);
            dispatch(fake.pubsub, "peer:unreachable", r);
            dispatch(fake.pubsub, "peer:reachable", r);
            dispatch(fake.fanout, "peer:reachable", r);
            dispatch(fake.blocks, "peer:unreachable", r);
            dispatch(fake.blocks, "peer:reachable", r);
            dispatch(fake.pubsub, "peer:unreachable", self);
            dispatch(fake.fanout, "peer:reachable", self);
            // Malformed events are dropped.
            dispatch(fake.pubsub, "subscribe", undefined);
            dispatch(fake.pubsub, "subscribe", { from: {}, topics: [topic] });
            dispatch(fake.logEvents, "replicator:join", {});
            expect(events).toEqual([
                { kind: "subscribe", peer: R, key: r },
                {
                    kind: "unsubscribe",
                    peer: R,
                    reason: "remote-unsubscribe",
                },
                { kind: "unsubscribe", peer: R, reason: "peer-unreachable" },
                {
                    kind: "unsubscribe",
                    peer: R,
                    reason: "peer-session-reset",
                },
                // An unknown reason is never departure: no reason at all.
                { kind: "unsubscribe", peer: R },
                { kind: "unsubscribe", peer: R },
                { kind: "replicator", type: "join", peer: R, key: r },
                { kind: "replicator", type: "change", peer: R, key: r },
                { kind: "replicator", type: "leave", peer: R, key: r },
                { kind: "reachability", source: "connect", peer: R },
                { kind: "reachability", source: "disconnect", peer: R },
                { kind: "reachability", source: "disconnect" },
                { kind: "reachability", source: "unreachable", peer: R },
                { kind: "reachability", source: "unreachable", peer: R },
                { kind: "reachability", source: "connect", peer: R },
                { kind: "reachability", source: "connect", peer: R },
                { kind: "reachability", source: "unreachable", peer: R },
                { kind: "reachability", source: "connect", peer: R },
            ]);
        });

        it("reads subscribers and replicators without J, duplicates or hidden peers", async () => {
            const { self, r, s, fake, transport } = await setup();
            expect(await transport.subscribers()).toEqual([]);
            fake.pubsub.subscribers = [r, self, s, r];
            expect(await transport.subscribers()).toEqual([
                { hash: r.hashcode(), key: r },
                { hash: s.hashcode(), key: s },
            ]);
            fake.replicators.add(self.hashcode());
            fake.replicators.add(r.hashcode());
            expect(await transport.replicators()).toEqual([r.hashcode()]);
            // The test hook hides R's subscription from J only.
            globalThis.__SFS_READINESS_TRANSPORT_HOOKS__ = {
                hideSubscriber: (observer, peer) =>
                    observer === self.hashcode() && peer === r.hashcode(),
            };
            expect(transportTestHooks()).toBeDefined();
            expect(await transport.subscribers()).toEqual([
                { hash: s.hashcode(), key: s },
            ]);
            // Hidden as a subscriber, still a replicator.
            expect(await transport.replicators()).toEqual([r.hashcode()]);
            // A failing read rejects (the coordinator stays undiscovered).
            fake.log.getReplicators = async () => {
                throw new Error("cold index");
            };
            await expect(transport.replicators()).rejects.toThrow("cold index");
            fake.pubsub.getSubscribers = () => {
                throw new Error("stopped");
            };
            await expect(transport.subscribers()).rejects.toThrow("stopped");
        });

        it("hides a hidden subscriber's subscribe and unsubscribe, not its replication", async () => {
            const { self, r, fake, events } = await setup();
            globalThis.__SFS_READINESS_TRANSPORT_HOOKS__ = {
                hideSubscriber: (observer, peer) =>
                    observer === self.hashcode() && peer === r.hashcode(),
            };
            dispatch(fake.pubsub, "subscribe", { from: r, topics: [topic] });
            dispatch(fake.pubsub, "unsubscribe", {
                from: r,
                topics: [topic],
                reason: "remote-unsubscribe",
            });
            dispatch(fake.logEvents, "replication:change", { publicKey: r });
            expect(events).toEqual([
                {
                    kind: "replicator",
                    type: "change",
                    peer: r.hashcode(),
                    key: r,
                },
            ]);
            // A throwing hook hides nothing.
            globalThis.__SFS_READINESS_TRANSPORT_HOOKS__ = {
                hideSubscriber: () => {
                    throw new Error("hook bug");
                },
            };
            dispatch(fake.pubsub, "subscribe", { from: r, topics: [topic] });
            expect(events.at(-1)).toEqual({
                kind: "subscribe",
                peer: r.hashcode(),
                key: r,
            });
        });

        it("listen is idempotent per listener, a detach or dispose stops delivery, and a throwing listener stays contained", async () => {
            const { r, fake, transport, events, detach } = await setup();
            const listener = (event: TransportEvent) => events.push(event);
            const first = transport.listen(listener);
            expect(transport.listen(listener)).toBe(first);
            dispatch(fake.logEvents, "replication:change", { publicKey: r });
            expect(events).toHaveLength(2);
            first();
            first();
            dispatch(fake.logEvents, "replication:change", { publicKey: r });
            expect(events).toHaveLength(3);
            // A detached listener may be attached again.
            const again = transport.listen(listener);
            expect(again).not.toBe(first);
            dispatch(fake.logEvents, "replication:change", { publicKey: r });
            expect(events).toHaveLength(5);
            again();
            // A listener that throws neither escapes nor stops the others.
            let after = 0;
            transport.listen(() => {
                throw new Error("listener bug");
            });
            transport.listen(() => after++);
            expect(() =>
                dispatch(fake.logEvents, "replication:change", { publicKey: r })
            ).not.toThrow();
            expect(after).toBe(1);
            expect(events).toHaveLength(6);
            detach();
            transport.dispose();
            transport.dispose();
            dispatch(fake.logEvents, "replication:change", { publicKey: r });
            dispatch(fake.pubsub, "subscribe", { from: r, topics: [topic] });
            dispatch(fake.libp2p, "peer:disconnect", r.toPeerId());
            expect(after).toBe(1);
            expect(events).toHaveLength(6);
            // Listening after dispose attaches nothing.
            let late = 0;
            transport.listen(() => late++)();
            dispatch(fake.logEvents, "replication:change", { publicKey: r });
            expect(late).toBe(0);
        });

        it("a removed listener that its emitter still fires delivers nothing (main-event 1.0.3-1.0.4)", async () => {
            const [self, r] = await keys(2);
            // An emitter whose removeEventListener does not remove.
            const sticky = {
                listeners: [] as Array<(event: any) => void>,
                addEventListener(_type: string, fn: (event: any) => void) {
                    this.listeners.push(fn);
                },
                removeEventListener() {},
                fire(detail: unknown) {
                    for (const fn of this.listeners) fn({ detail });
                },
            };
            const fake = fakeNode(self);
            const transport = new PeerbitTransport(fake.node, {
                topic,
                log: {
                    getReplicators: async () => new Set(),
                    events: sticky,
                },
            });
            const events: TransportEvent[] = [];
            const detach = transport.listen((event) => events.push(event));
            sticky.fire({ publicKey: r });
            expect(events).toHaveLength(3);
            detach();
            sticky.fire({ publicKey: r });
            expect(events).toHaveLength(3);
        });

        it("a node without an identity listens to nothing and rejects its reads; one without pubsub or libp2p still listens to the rest", async () => {
            const [self, r] = await keys(2);
            const fake = fakeNode(self);
            const anonymous = new PeerbitTransport(
                { services: fake.node.services, libp2p: fake.libp2p },
                { topic, log: fake.log }
            );
            expect(anonymous.self).toBe("");
            let events = 0;
            anonymous.listen(() => events++);
            dispatch(fake.logEvents, "replication:change", { publicKey: r });
            dispatch(fake.pubsub, "subscribe", { from: r, topics: [topic] });
            expect(events).toBe(0);
            await expect(anonymous.subscribers()).rejects.toThrow(/identity/);
            await expect(anonymous.replicators()).rejects.toThrow(/identity/);
            // Fail closed: no route read without J's hash.
            expect(anonymous.isReachable(r.hashcode())).toBe(true);

            const bare = new PeerbitTransport(
                { identity: { publicKey: self } },
                { topic, log: fake.log }
            );
            const seen: TransportEvent[] = [];
            bare.listen((event) => seen.push(event));
            dispatch(fake.logEvents, "replicator:join", { publicKey: r });
            expect(seen).toEqual([
                {
                    kind: "replicator",
                    type: "join",
                    peer: r.hashcode(),
                    key: r,
                },
            ]);
            await expect(bare.subscribers()).rejects.toThrow(/pubsub/);
            expect(bare.isReachable(r.hashcode())).toBe(true);
            bare.dispose();
        });

        it("tolerates an emitter whose add and remove return promises (the PubSub interface)", async () => {
            const [self, r] = await keys(2);
            const target = new EventTarget();
            const asyncEmitter = {
                addEventListener: (type: string, fn: any) => {
                    target.addEventListener(type, fn);
                    return Promise.reject(new Error("late failure"));
                },
                removeEventListener: (type: string, fn: any) => {
                    target.removeEventListener(type, fn);
                    return Promise.reject(new Error("late failure"));
                },
            };
            const transport = new PeerbitTransport(
                {
                    identity: { publicKey: self },
                    services: { pubsub: asyncEmitter },
                },
                {
                    topic,
                    log: {
                        getReplicators: async () => new Set(),
                        events: new EventTarget(),
                    },
                }
            );
            const events: TransportEvent[] = [];
            const detach = transport.listen((event) => events.push(event));
            dispatch(target, "subscribe", { from: r, topics: [topic] });
            expect(events).toEqual([
                { kind: "subscribe", peer: r.hashcode(), key: r },
            ]);
            detach();
            dispatch(target, "subscribe", { from: r, topics: [topic] });
            expect(events).toHaveLength(1);
            // The rejected promises are handled (an unhandled rejection
            // would fail the run).
            await new Promise((resolve) => setImmediate(resolve));
        });
    });

    describe("PeerbitTransport on Peerbit (SPEC2 7.2)", () => {
        const peers: Peerbit[] = [];
        afterEach(async () => {
            globalThis.__SFS_READINESS_TRANSPORT_HOOKS__ = undefined;
            await stopTestPeers(peers);
        });
        const createPeer = async () => {
            const peer = await Peerbit.create();
            peers.push(peer);
            return peer;
        };
        const stopPeer = async (peer: Peerbit) => {
            peers.splice(peers.indexOf(peer), 1);
            await peer.stop();
        };
        const transportOf = (peer: Peerbit, fs: SharedFsHandle) =>
            new PeerbitTransport(peer, {
                topic: (fs.program as any).readiness.topic,
                log: (fs.program as any).entries.log,
            });
        const has = (
            events: TransportEvent[],
            match: Partial<TransportEvent>
        ) =>
            events.some((event) =>
                Object.entries(match).every(
                    ([key, value]) => (event as any)[key] === value
                )
            );

        it("sees a donor subscribe, replicate, unsubscribe and become unreachable; hides it on request; detaches on dispose", async () => {
            const jPeer = await createPeer();
            const j = await openSharedFs({
                peerbit: jPeer,
                machineLabel: "j",
                gc: false,
            });
            const transport = transportOf(jPeer, j);
            const J = jPeer.identity.publicKey.hashcode();
            expect(transport.self).toBe(J);
            const events: TransportEvent[] = [];
            transport.listen((event) => events.push(event));

            const dPeer = await createPeer();
            const D = dPeer.identity.publicKey.hashcode();
            await dPeer.dial(jPeer);
            let d = await openSharedFs({
                peerbit: dPeer,
                address: j.address,
                machineLabel: "d",
                gc: false,
            });
            await until(async () => {
                expect(has(events, { kind: "subscribe", peer: D })).toBe(true);
                expect(
                    has(events, { kind: "replicator", type: "join", peer: D })
                ).toBe(true);
                expect(has(events, { kind: "reachability", peer: D })).toBe(
                    true
                );
                expect(
                    (await transport.subscribers()).map((s) => s.hash)
                ).toEqual([D]);
                expect(await transport.replicators()).toEqual([D]);
            });
            expect(transport.isReachable(D)).toBe(true);
            // Never J itself.
            expect(events.some((event) => (event as any).peer === J)).toBe(
                false
            );
            // The test hook hides D's subscription from J, not its
            // replication (design test 16).
            const hide = () => {
                globalThis.__SFS_READINESS_TRANSPORT_HOOKS__ = {
                    hideSubscriber: (observer, peer) =>
                        observer === J && peer === D,
                };
            };
            hide();
            expect(await transport.subscribers()).toEqual([]);
            expect(await transport.replicators()).toEqual([D]);
            globalThis.__SFS_READINESS_TRANSPORT_HOOKS__ = undefined;

            // D closes its filesystem on a node that stays up: an explicit
            // unsubscribe of the readiness topic (G2-6), and a replicator
            // leave; D stays reachable.
            events.length = 0;
            await d.program.close();
            await until(() => {
                expect(
                    events.some(
                        (event) =>
                            event.kind === "unsubscribe" &&
                            event.peer === D &&
                            event.reason === "remote-unsubscribe"
                    )
                ).toBe(true);
            });
            expect(transport.isReachable(D)).toBe(true);

            // D opens again while hidden: its replication arrives, its
            // subscription does not.
            hide();
            events.length = 0;
            d = await openSharedFs({
                peerbit: dPeer,
                address: j.address,
                machineLabel: "d",
                gc: false,
            });
            await until(() =>
                expect(has(events, { kind: "replicator", peer: D })).toBe(true)
            );
            expect(has(events, { kind: "subscribe", peer: D })).toBe(false);
            globalThis.__SFS_READINESS_TRANSPORT_HOOKS__ = undefined;
            await until(async () =>
                expect(
                    (await transport.subscribers()).map((s) => s.hash)
                ).toEqual([D])
            );

            // D's node stops: unreachable, and events name it.
            events.length = 0;
            await stopPeer(dPeer);
            await until(() => {
                expect(transport.isReachable(D)).toBe(false);
                expect(
                    events.some(
                        (event) =>
                            event.kind === "reachability" &&
                            event.source !== "connect" &&
                            event.peer === D
                    )
                ).toBe(true);
            });

            // After dispose nothing is delivered.
            transport.dispose();
            events.length = 0;
            const ePeer = await createPeer();
            await ePeer.dial(jPeer);
            const e = await openSharedFs({
                peerbit: ePeer,
                address: j.address,
                machineLabel: "e",
                gc: false,
            });
            const E = ePeer.identity.publicKey.hashcode();
            // A fresh view sees E, so the events did happen.
            const fresh = transportOf(jPeer, j);
            await until(async () =>
                expect(
                    (await fresh.subscribers()).map((s) => s.hash)
                ).toContain(E)
            );
            expect(events).toEqual([]);
            fresh.dispose();
            await e.program.close();
        });

        it("re-reads a peer reachable once its dropped connection is back: the route table's peer:reachable, on whichever stream applied it", async () => {
            const jPeer = await createPeer();
            const rPeer = await createPeer();
            const J = jPeer.identity.publicKey.hashcode();
            const R = rPeer.identity.publicKey.hashcode();
            await jPeer.dial(rPeer);
            await until(() => expect(isReachable(jPeer, J, R)).toBe(true));
            const transport = new PeerbitTransport(jPeer, {
                topic: "readiness-reconnect",
                log: {
                    getReplicators: async () => new Set(),
                    events: new EventTarget(),
                },
            });
            // What the re-read each delivered event causes finds.
            const reads: boolean[] = [];
            transport.listen(() => reads.push(transport.isReachable(R)));
            for (const connection of (jPeer as any).libp2p.getConnections(
                rPeer.peerId
            )) {
                connection.abort(new Error("test: the connection dropped"));
            }
            // R departs, then comes back; libp2p's connect arrives before the
            // route is added again, so only the route table's own event
            // (fanout's, on 5.4.10) re-reads R reachable.
            await until(() => {
                expect(reads).toContain(false);
                expect(reads.lastIndexOf(true)).toBeGreaterThan(
                    reads.indexOf(false)
                );
            });
            expect(isReachable(jPeer, J, R)).toBe(true);
            transport.dispose();
        });

        it("fails closed on a node whose private fields moved", async () => {
            const jPeer = await createPeer();
            const self = jPeer.identity.publicKey.hashcode();
            const [stranger] = await keys(1);
            // The real node: a peer it never met is unreachable.
            expect(isReachable(jPeer, self, stranger.hashcode())).toBe(false);
            // Renamed fields: every read fails, so every peer is reachable.
            const moved = new Proxy(jPeer, {
                get(target, property, receiver) {
                    if (property === "services") {
                        return {
                            pubsub: { routes: undefined, peers: undefined },
                        };
                    }
                    return Reflect.get(target, property, receiver);
                },
            });
            expect(isReachable(moved, self, stranger.hashcode())).toBe(true);
            const transport = new PeerbitTransport(moved, {
                topic: "t",
                log: {
                    getReplicators: async () => new Set(),
                    events: new EventTarget(),
                },
            });
            expect(transport.isReachable(stranger.hashcode())).toBe(true);
            transport.dispose();
        });
    });

    describe("LifeRecorder (signs of life from J's open)", () => {
        it("keeps each peer that announced replication or sent a message, once; a leave is none; take hands them over once and detaches", async () => {
            const [r, s, t, u] = await keys(4);
            const events = new EventTarget();
            const recorder = new LifeRecorder(events);
            dispatch(events, "replicator:join", { publicKey: r });
            dispatch(events, "replication:change", { publicKey: s });
            dispatch(events, "replication:change", { publicKey: r });
            // J's own liveness eviction dispatches a leave: not R's doing.
            dispatch(events, "replicator:leave", { publicKey: u });
            recorder.noteMessage(t);
            recorder.noteMessage(r);
            // Malformed: dropped.
            dispatch(events, "replicator:join", {});
            dispatch(events, "replicator:join", undefined);
            recorder.noteMessage(undefined);
            expect(recorder.take()).toEqual([
                r.hashcode(),
                s.hashcode(),
                t.hashcode(),
            ]);
            // Detached: nothing more is kept or handed over.
            dispatch(events, "replicator:join", { publicKey: u });
            recorder.noteMessage(s);
            expect(recorder.take()).toEqual([]);
        });

        it("records nothing without a source; dispose detaches and forgets", async () => {
            const [r] = await keys(1);
            expect(new LifeRecorder(undefined).take()).toEqual([]);
            expect(new LifeRecorder({}).take()).toEqual([]);
            let listeners = 0;
            const events = new EventTarget();
            const source = {
                addEventListener: (type: string, listener: any) => {
                    listeners++;
                    events.addEventListener(type, listener);
                },
                removeEventListener: (type: string, listener: any) => {
                    listeners--;
                    events.removeEventListener(type, listener);
                },
            };
            const recorder = new LifeRecorder(source);
            expect(listeners).toBe(2);
            dispatch(events, "replicator:join", { publicKey: r });
            recorder.dispose();
            expect(listeners).toBe(0);
            expect(recorder.take()).toEqual([]);
        });
    });
});
