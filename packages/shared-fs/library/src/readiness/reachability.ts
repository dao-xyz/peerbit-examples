import { getPublicKeyFromPeerId, type PublicSignKey } from "@peerbit/crypto";
import type { CoordinatorTransport, TransportEvent } from "./coordinator.js";

/**
 * Peers as the coordinator sees them on Peerbit 5.4.10 (WRITE_READINESS_V2.md
 * sections 4.7 and 4.9, D3 = A'; M1 plan section 9).
 *
 * **The only private reads of M1** live here, each in one function below,
 * reached through `as any` with `typeof` guards (they are not on the
 * `ProgramClient` or `PubSub` interfaces) and kept until U-37:
 *
 * | read                                         | declared at (installed dists)                               |
 * | -------------------------------------------- | ----------------------------------------------------------- |
 * | `services.pubsub.routes.isReachable(J, R)`   | `@peerbit/stream index.d.ts:299`, `routes.d.ts:31`, `routes.js:337` |
 * | `services.pubsub.peers.has(R)`               | `@peerbit/stream index.d.ts:296`                            |
 * | `node.libp2p` `peer:connect`/`peer:disconnect` | `peerbit peer.d.ts:213` (the concrete client's getter)    |
 * | `services.fanout` `peer:reachable`/`peer:unreachable` | `peerbit libp2p.js:97`; dispatched at `@peerbit/stream index.js:1653-1685` |
 * | `services.blocks` `peer:reachable`/`peer:unreachable` | `peerbit libp2p.js:98` (`DirectBlock extends DirectStream`, `@peerbit/blocks libp2p.js:17`); the same dispatch |
 *
 * A read that cannot be made (a missing service, a renamed field, a throw)
 * answers "reachable": the peer keeps blocking until the caller's timeout or
 * `assumeComplete()`. It never makes a peer leave, so a Peerbit bump that
 * moves these fields costs liveness, never a wrong ready. A missing event
 * source only means fewer re-reads.
 *
 * Everything else here is public: the readiness topic's subscribers and its
 * `subscribe`/`unsubscribe` events (`@peerbit/pubsub-interface
 * index.d.ts:50-56`, `74-75`), pubsub's `peer:reachable`/`peer:unreachable`
 * (`PubSubEvents extends PeerEvents`, `@peerbit/stream-interface
 * index.d.ts:5-9`), the namespace log's `getReplicators()` and
 * `replicator:join`/`replicator:leave`/`replication:change`
 * (`@peerbit/shared-log index.d.ts:471-473`, `1123`), and
 * `getPublicKeyFromPeerId` (`@peerbit/crypto from.d.ts:5`).
 *
 * **One route table, one event.** Pubsub, fanout and blocks are
 * DirectStreams that share one route table per private key
 * (`sharedRouting` defaults to true, `@peerbit/stream index.js:939`,
 * `1160-1181`). `Routes.remove` reports a peer unreachable only to the
 * first stream that removes it (`routes.js:264-294`), and
 * `addRouteConnection` dispatches `peer:reachable` only when the route is
 * new (`index.js:1653-1667`). So each route change is dispatched on
 * exactly one of the three, whichever applied it first: on 5.4.10 that is
 * fanout in practice, and pubsub dispatches neither. The transport listens
 * to both events on all three; each only adds a re-read.
 *
 * **Relayed peers.** Fanout dispatches `peer:unreachable` only for a peer
 * whose public key it knows ("best-effort"), and libp2p `peer:disconnect`
 * names the relay, not R. So a disconnect re-reads every blocking record
 * (an event without a peer), and pubsub's `unsubscribe` of the readiness
 * topic, which peers other than R's fanout parent receive, re-reads R.
 * If neither arrives, R stays Required until the caller's timeout (liveness,
 * never a wrong ready); the relayed variant of design test 53 checks it.
 *
 * Every listener checks that it is still the attached one before it
 * delivers (main-event 1.0.3-1.0.4 can leave a removed listener firing).
 */

/**
 * Test-only fault hooks, set by a test on `globalThis` (product code never
 * sets them, and without them nothing here changes). Design section 8:
 * "suppress the readiness Subscribe".
 */
export interface ReadinessTransportTestHooks {
    /**
     * J (`observer`) does not see `peer`'s readiness-topic subscription:
     * neither in `subscribers()` nor as a `subscribe` event (design test 16,
     * U-1). Directed messages still flow both ways.
     */
    hideSubscriber?(observer: string, peer: string): boolean;
}

declare global {
    // eslint-disable-next-line no-var
    var __SFS_READINESS_TRANSPORT_HOOKS__:
        | ReadinessTransportTestHooks
        | undefined;
}

/** The test hooks when a test set them, else undefined. */
export const transportTestHooks = (): ReadinessTransportTestHooks | undefined =>
    globalThis.__SFS_READINESS_TRANSPORT_HOOKS__;

/** An event source as the transport attaches to it. */
export interface EventSourceLike {
    addEventListener(type: string, listener: (event: any) => void): void;
    removeEventListener(type: string, listener: (event: any) => void): void;
}

/** `node.services.pubsub`, or undefined (`services` is a getter that throws without libp2p). */
const pubsubOf = (node: unknown): any => {
    try {
        return (node as any)?.services?.pubsub;
    } catch {
        return undefined;
    }
};

/** `source` when it can be listened on, else undefined. */
const eventSource = (source: any): EventSourceLike | undefined =>
    typeof source?.addEventListener === "function" &&
    typeof source?.removeEventListener === "function"
        ? source
        : undefined;

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
    typeof (value as any)?.then === "function";

/** J's own `hashcode()` (`node.identity.publicKey`, public). */
export const selfHash = (node: unknown): string | undefined => {
    try {
        const hash = (node as any)?.identity?.publicKey?.hashcode?.();
        return typeof hash === "string" && hash.length > 0 ? hash : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Private read 1: `services.pubsub.routes.isReachable(self, peer)`.
 * Undefined when the read cannot be made.
 */
export const routesReachable = (
    node: unknown,
    self: string,
    peer: string
): boolean | undefined => {
    try {
        const routes = pubsubOf(node)?.routes;
        if (typeof routes?.isReachable !== "function") return undefined;
        const answer = routes.isReachable(self, peer);
        return typeof answer === "boolean" ? answer : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Private read 2: `services.pubsub.peers.has(peer)` (a direct neighbour).
 * Undefined when the read cannot be made.
 */
export const directPeer = (
    node: unknown,
    peer: string
): boolean | undefined => {
    try {
        const peers = pubsubOf(node)?.peers;
        if (typeof peers?.has !== "function") return undefined;
        const answer = peers.has(peer);
        return typeof answer === "boolean" ? answer : undefined;
    } catch {
        return undefined;
    }
};

/** Private read 3: `node.libp2p`, for `peer:connect` and `peer:disconnect`. */
export const libp2pEvents = (node: unknown): EventSourceLike | undefined => {
    try {
        return eventSource((node as any)?.libp2p);
    } catch {
        return undefined;
    }
};

/**
 * Private read 4: `services.fanout`, for `peer:reachable` and
 * `peer:unreachable`.
 */
export const fanoutEvents = (node: unknown): EventSourceLike | undefined => {
    try {
        return eventSource((node as any)?.services?.fanout);
    } catch {
        return undefined;
    }
};

/**
 * Private read 5: `services.blocks` as an event source, for
 * `peer:reachable`/`peer:unreachable` (the service is public, its events
 * are not on the `Blocks` interface).
 */
export const blocksEvents = (node: unknown): EventSourceLike | undefined => {
    try {
        return eventSource((node as any)?.services?.blocks);
    } catch {
        return undefined;
    }
};

/**
 * A' (plan 7.3): `routes.isReachable(self, peer) || peers.has(peer)`. Fails
 * closed: true unless a read was made and both say no.
 */
export const isReachable = (
    node: unknown,
    self: string,
    peer: string
): boolean => {
    // Without J's own hash the route read cannot be made.
    const routes = self ? routesReachable(node, self, peer) : undefined;
    if (routes === true) return true;
    const direct = directPeer(node, peer);
    if (direct === true) return true;
    return !(routes === false && direct === false);
};

/**
 * The hashcode of a libp2p peer id (`getPublicKeyFromPeerId`), or undefined
 * for an id that does not carry a key (the event then re-reads every
 * blocking record).
 */
export const peerHashOf = (peerId: unknown): string | undefined => {
    if (peerId == null || typeof peerId !== "object") return undefined;
    try {
        const hash = getPublicKeyFromPeerId(peerId as any).hashcode();
        return typeof hash === "string" && hash.length > 0 ? hash : undefined;
    } catch {
        return undefined;
    }
};

/** The hashcode of an event's `PublicSignKey`, or undefined. */
const keyHashOf = (key: unknown): string | undefined => {
    try {
        const hash = (key as any)?.hashcode?.();
        return typeof hash === "string" && hash.length > 0 ? hash : undefined;
    } catch {
        return undefined;
    }
};

const UNSUBSCRIBE_REASONS: ReadonlySet<string> = new Set([
    "remote-unsubscribe",
    "peer-unreachable",
    "peer-session-reset",
]);

/** The namespace log as the transport reads it (public API). */
export interface ReplicatorSource {
    getReplicators(): Promise<Set<string>>;
    readonly events: EventSourceLike;
}

export interface PeerbitTransportOptions {
    /** The readiness RPC's topic (`RPC.topic`). */
    topic: string;
    /** The namespace store's `SharedLog` (`entries.log`). */
    log: ReplicatorSource;
}

/**
 * `CoordinatorTransport` over a Peerbit node: the four private reads above,
 * the readiness topic's pubsub events and subscribers, pubsub's own
 * reachability events, and the namespace log's replicator events. `listen`
 * attaches every source at once and returns one detach; `dispose` detaches
 * all.
 *
 * Events map as follows (J itself and other topics are dropped):
 *
 * - pubsub `subscribe` / `unsubscribe` of the topic → `subscribe` /
 *   `unsubscribe` (its `reason` when it is one of pubsub's three, else none,
 *   so only an explicit `remote-unsubscribe` can mean departure; a program
 *   close sends it, `@peerbit/pubsub-interface index.d.ts:15-21`);
 * - `replicator:join` / `replication:change` / `replicator:leave` →
 *   `replicator` `join` / `change` / `leave`;
 * - libp2p `peer:connect` / `peer:disconnect` → `reachability` `connect` /
 *   `disconnect`, naming the peer when its id carries a key;
 * - `peer:reachable` / `peer:unreachable` of pubsub, fanout and blocks →
 *   `reachability` `connect` / `unreachable`. They are dispatched after the
 *   shared route table changed, so the re-read they cause sees the change
 *   (a libp2p disconnect can arrive before the routes through it are
 *   removed, and a libp2p connect before the route is added again); they
 *   also cover replicators that never subscribed to the readiness topic.
 *
 * Every event only adds a reason to re-read; none decides by itself.
 */
export class PeerbitTransport implements CoordinatorTransport {
    readonly self: string;
    /** Whether `self` was read (an empty `self` reads no route). */
    private readonly identified: boolean;
    private readonly listening = new Map<
        (event: TransportEvent) => void,
        () => void
    >();
    private disposed = false;

    constructor(
        readonly node: unknown,
        readonly options: PeerbitTransportOptions
    ) {
        const self = selfHash(node);
        this.identified = self !== undefined;
        this.self = self ?? "";
    }

    isReachable(peer: string): boolean {
        return isReachable(this.node, this.self, peer);
    }

    async subscribers(): Promise<Array<{ hash: string; key: PublicSignKey }>> {
        if (!this.identified) {
            throw new Error("readiness: the node has no identity");
        }
        const pubsub = pubsubOf(this.node);
        if (typeof pubsub?.getSubscribers !== "function") {
            throw new Error("readiness: the node has no pubsub");
        }
        // `undefined`: no remote subscriber known (`@peerbit/pubsub
        // index.js:3101-3114`), an empty list.
        const keys: unknown[] =
            (await pubsub.getSubscribers(this.options.topic)) ?? [];
        const out: Array<{ hash: string; key: PublicSignKey }> = [];
        const seen = new Set<string>();
        for (const key of keys) {
            const hash = keyHashOf(key);
            if (hash === undefined || hash === this.self || seen.has(hash)) {
                continue;
            }
            seen.add(hash);
            if (this.hidden(hash)) continue;
            out.push({ hash, key: key as PublicSignKey });
        }
        return out;
    }

    async replicators(): Promise<string[]> {
        if (!this.identified) {
            throw new Error("readiness: the node has no identity");
        }
        const replicators = await this.options.log.getReplicators();
        const out: string[] = [];
        for (const hash of replicators) {
            if (typeof hash === "string" && hash !== this.self) out.push(hash);
        }
        return out;
    }

    listen(listener: (event: TransportEvent) => void): () => void {
        if (this.disposed || !this.identified) return () => {};
        const existing = this.listening.get(listener);
        if (existing) return existing;
        const { topic, log } = this.options;
        const offs: Array<() => void> = [];
        let attached = true;
        const deliver = (event: TransportEvent) => {
            if (!attached || this.disposed) return;
            try {
                listener(event);
            } catch {
                // The coordinator's handlers never throw (S15); an error
                // here must not reach the emitter's other listeners.
            }
        };
        const on = (
            source: EventSourceLike | undefined,
            type: string,
            handle: (event: any) => void
        ) => {
            if (!source) return;
            const wrapped = (event: any) => {
                // A removed listener may still fire once on older
                // main-event versions; only an attached one delivers.
                if (!attached || this.disposed) return;
                try {
                    handle(event);
                } catch {
                    // A malformed event is dropped.
                }
            };
            try {
                const added: unknown = source.addEventListener(type, wrapped);
                if (isPromiseLike(added)) {
                    void Promise.resolve(added).catch(() => {});
                }
            } catch {
                return;
            }
            offs.push(() => {
                try {
                    const removed: unknown = source.removeEventListener(
                        type,
                        wrapped
                    );
                    if (isPromiseLike(removed)) {
                        void Promise.resolve(removed).catch(() => {});
                    }
                } catch {
                    // The emitter is gone with its node.
                }
            });
        };

        const pubsub = eventSource(pubsubOf(this.node));
        on(pubsub, "subscribe", (event) => {
            const detail = event?.detail;
            const peer = this.topicPeer(detail);
            if (peer === undefined || this.hidden(peer)) return;
            deliver({ kind: "subscribe", peer, key: detail.from });
        });
        on(pubsub, "unsubscribe", (event) => {
            const detail = event?.detail;
            const peer = this.topicPeer(detail);
            if (peer === undefined || this.hidden(peer)) return;
            const reason = detail?.reason;
            deliver(
                typeof reason === "string" && UNSUBSCRIBE_REASONS.has(reason)
                    ? {
                          kind: "unsubscribe",
                          peer,
                          reason: reason as
                              | "remote-unsubscribe"
                              | "peer-unreachable"
                              | "peer-session-reset",
                      }
                    : { kind: "unsubscribe", peer }
            );
        });
        const reachability =
            (source: "connect" | "unreachable") => (event: any) => {
                const peer = keyHashOf(event?.detail);
                if (peer === this.self) return;
                deliver(
                    peer === undefined
                        ? { kind: "reachability", source }
                        : { kind: "reachability", source, peer }
                );
            };
        // A route change is dispatched only on the stream that applied it
        // first (see the header), so every stream sharing the table.
        for (const stream of new Set([
            pubsub,
            fanoutEvents(this.node),
            blocksEvents(this.node),
        ])) {
            on(stream, "peer:reachable", reachability("connect"));
            on(stream, "peer:unreachable", reachability("unreachable"));
        }

        const replicator =
            (type: "join" | "change" | "leave") => (event: any) => {
                const key = event?.detail?.publicKey;
                const peer = keyHashOf(key);
                if (peer === undefined || peer === this.self) return;
                deliver({ kind: "replicator", type, peer, key });
            };
        const logEvents = eventSource(log?.events);
        on(logEvents, "replicator:join", replicator("join"));
        on(logEvents, "replication:change", replicator("change"));
        on(logEvents, "replicator:leave", replicator("leave"));

        const libp2p = libp2pEvents(this.node);
        const connection =
            (source: "connect" | "disconnect") => (event: any) => {
                const peer = peerHashOf(event?.detail);
                if (peer === this.self) return;
                deliver(
                    peer === undefined
                        ? { kind: "reachability", source }
                        : { kind: "reachability", source, peer }
                );
            };
        on(libp2p, "peer:connect", connection("connect"));
        on(libp2p, "peer:disconnect", connection("disconnect"));

        const detach = () => {
            if (!attached) return;
            attached = false;
            if (this.listening.get(listener) === detach) {
                this.listening.delete(listener);
            }
            for (const off of offs.splice(0)) off();
        };
        this.listening.set(listener, detach);
        return detach;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const detach of [...this.listening.values()]) detach();
        this.listening.clear();
    }

    /** The sender of a pubsub (un)subscription of the topic, J excluded. */
    private topicPeer(detail: any): string | undefined {
        const topics = detail?.topics;
        if (!Array.isArray(topics) || !topics.includes(this.options.topic)) {
            return undefined;
        }
        const peer = keyHashOf(detail?.from);
        return peer === undefined || peer === this.self ? undefined : peer;
    }

    /** The test hook hides `peer`'s subscription from J. */
    private hidden(peer: string): boolean {
        const hooks = transportTestHooks();
        if (!hooks?.hideSubscriber) return false;
        try {
            return hooks.hideSubscriber(this.self, peer) === true;
        } catch {
            return false;
        }
    }
}

/**
 * Who showed J a sign of life from its open until the coordinator's
 * listeners attach (`CoordinatorPorts.signsOfLife`; design 2.1 "Live"
 * counts from J's open): a replication announcement of the namespace log
 * (`replicator:join`, `replication:change`), listened on from before the
 * store opens, or a readiness message the runtime notes before a
 * coordinator runs. shared-log dispatches `replicator:join` once per peer
 * (`_replicatorJoinEmitted`) and `replication:change` only when ranges
 * differ (`@peerbit/shared-log index.js:6540-6577`), so an idle replicator
 * that announced itself while J's open ran sends nothing a later listener
 * could see. A `replicator:leave` is no sign of life (J's own liveness
 * eviction dispatches it too). One hashcode per peer, so the record is
 * bounded by the peers J hears from; `take` hands it over once and
 * detaches.
 */
export class LifeRecorder {
    private readonly peers = new Set<string>();
    private readonly offs: Array<() => void> = [];
    private recording = true;

    /** `events`: the namespace log's (`entries.log.events`). */
    constructor(events: unknown) {
        const source = eventSource(events);
        if (!source) return;
        const announced = (event: any) => {
            if (!this.recording) return;
            try {
                const peer = keyHashOf(event?.detail?.publicKey);
                if (peer !== undefined) this.peers.add(peer);
            } catch {
                // A malformed event is dropped.
            }
        };
        for (const type of ["replicator:join", "replication:change"]) {
            try {
                const added: unknown = source.addEventListener(type, announced);
                if (isPromiseLike(added)) {
                    void Promise.resolve(added).catch(() => {});
                }
            } catch {
                continue;
            }
            this.offs.push(() => {
                try {
                    const removed: unknown = source.removeEventListener(
                        type,
                        announced
                    );
                    if (isPromiseLike(removed)) {
                        void Promise.resolve(removed).catch(() => {});
                    }
                } catch {
                    // The emitter is gone with its store.
                }
            });
        }
    }

    /** A readiness message signed by `key` reached J. */
    noteMessage(key: PublicSignKey | undefined): void {
        if (!this.recording) return;
        const peer = keyHashOf(key);
        if (peer !== undefined) this.peers.add(peer);
    }

    /** Every recorded peer, in first-arrival order; then detaches. */
    take(): string[] {
        const out = [...this.peers];
        this.dispose();
        return out;
    }

    /** Detaches and forgets (idempotent). */
    dispose(): void {
        this.recording = false;
        this.peers.clear();
        for (const off of this.offs.splice(0)) off();
    }
}
