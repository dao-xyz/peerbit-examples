import { performance } from "node:perf_hooks";
import {
    CloseIteratorRequest,
    CollectNextRequest,
    IterationRequest,
    PredictedSearchRequest,
    SearchRequest,
    SearchRequestIndexed,
} from "@peerbit/document";
import { RPC } from "@peerbit/rpc";
import type { Peerbit } from "peerbit";
import type { SharedFsHandle } from "../index.js";

type Role = "source" | "observer";
type Phase = "pubsub.publish" | "pubsub.data" | "rpc.request" | "rpc.response";
type Entries = SharedFsHandle["program"]["entries"];
type Listener = (event: Event) => void;
type Emitter = {
    addEventListener(type: string, listener: Listener): void;
    removeEventListener(type: string, listener: Listener): void;
};
type TraceEvent = {
    atMs: number;
    phase: Phase;
    role: Role;
    outerId: string;
    session?: string;
    from?: string;
    requestType?: string;
    iteratorId?: string;
};
const requestTypes = [
    [SearchRequest, "SearchRequest"],
    [SearchRequestIndexed, "SearchRequestIndexed"],
    [IterationRequest, "IterationRequest"],
    [CollectNextRequest, "CollectNextRequest"],
    [CloseIteratorRequest, "CloseIteratorRequest"],
    [PredictedSearchRequest, "PredictedSearchRequest"],
] as const;
class MalformedMetadata extends Error {}
const requireMetadata = (condition: unknown): void => {
    if (!condition) throw new MalformedMetadata();
};
const outerId = (id: unknown): string => {
    requireMetadata(id instanceof Uint8Array && id.byteLength === 32);
    return Buffer.from(id as Uint8Array).toString("base64");
};

/** TEST ONLY, synchronous passive boundaries, never wire/handler latency proof.
 * Pubsub payloads, decoded requests/results, and message objects are not retained.
 * Different request/response outer IDs are deliberately never paired by time.
 */
export class SparseQueryTransportProfile {
    private readonly clockOriginMs = performance.now();
    private readonly events: TraceEvent[] = [];
    private readonly ids = new Set<string>();
    private readonly boundaries = new Set<string>();
    private readonly peers = new Map<Role, Peerbit>();
    private readonly removals: Array<() => void> = [];
    private topic: string | undefined;
    private armed = false;
    private stopped = false;
    private readonly maxEvents: number;
    private readonly maxIds: number;
    private readonly counters = {
        preArmIgnored: 0,
        topicIgnored: 0,
        eventsDropped: 0,
        idsDropped: 0,
        malformed: 0,
        duplicates: 0,
        captureErrors: 0,
    };

    constructor(options: { maxEvents?: number; maxIds?: number } = {}) {
        this.maxEvents = options.maxEvents ?? 512;
        this.maxIds = options.maxIds ?? 128;
        for (const [value, maximum] of [
            [this.maxEvents, 512],
            [this.maxIds, 128],
        ]) {
            if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
                throw new RangeError("Invalid passive profile capacity");
        }
    }

    private setup(fn: () => void): void {
        try {
            if (this.stopped) throw new Error("Passive profile is stopped");
            fn();
        } catch (error) {
            try {
                this.stop();
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Passive profile setup and cleanup failed"
                );
            }
            throw error;
        }
    }

    private listen(target: unknown, type: string, listener: Listener): void {
        // Concrete Peerbit/Program event emitters are synchronous. Register the
        // removal FIRST so an emitter that adds then throws is cleaned up too.
        const emitter = target as Emitter;
        this.removals.push(() => emitter.removeEventListener(type, listener));
        emitter.addEventListener(type, listener);
    }

    attachPeer(peer: Peerbit, role: Role): void {
        this.setup(() => {
            if (
                this.armed ||
                (role !== "source" && role !== "observer") ||
                this.peers.has(role) ||
                [...this.peers.values()].includes(peer)
            )
                throw new Error("Invalid or duplicate passive peer attachment");
            this.peers.set(role, peer);
            for (const phase of ["pubsub.publish", "pubsub.data"] as const) {
                this.listen(
                    peer.services.pubsub,
                    phase.split(".")[1],
                    (event) => this.capture(event, role, phase)
                );
            }
        });
    }

    arm(sourceEntries: Entries, observerEntries: Entries): void {
        this.setup(() => {
            if (this.armed || this.peers.size !== 2)
                throw new Error(
                    "Passive profile requires both peers before arm"
                );
            const discovered = [sourceEntries, observerEntries].map(
                (entries) => {
                    const programs = entries.index.allPrograms;
                    if (!Array.isArray(programs) || programs.length > 16)
                        throw new Error(
                            "Passive query program discovery exceeded bound"
                        );
                    const rpcs = programs.filter(
                        (program) => program instanceof RPC
                    );
                    if (rpcs.length !== 1 || rpcs[0].closed !== false)
                        throw new Error(
                            "Expected exactly one opened query RPC per index"
                        );
                    const topics = rpcs[0].getTopics();
                    if (
                        !Array.isArray(topics) ||
                        topics.length !== 1 ||
                        typeof topics[0] !== "string" ||
                        topics[0].length < 1 ||
                        topics[0].length > 128
                    )
                        throw new Error(
                            "Expected one bounded query topic per index"
                        );
                    return { rpc: rpcs[0], topic: topics[0] };
                }
            );
            if (discovered[0].topic !== discovered[1].topic)
                throw new Error("Source and observer query topics differ");
            this.topic = discovered[0].topic;
            for (const [i, role] of (
                ["source", "observer"] as const
            ).entries()) {
                for (const phase of ["rpc.request", "rpc.response"] as const) {
                    this.listen(
                        discovered[i].rpc.events,
                        phase.split(".")[1],
                        (event) => this.capture(event, role, phase)
                    );
                }
            }
            this.armed = true;
        });
    }

    private capture(event: Event, role: Role, phase: Phase): void {
        if (this.stopped) return;
        if (!this.armed) {
            this.counters.preArmIgnored++;
            return;
        }
        try {
            const atMs = performance.now() - this.clockOriginMs;
            const detail = (event as CustomEvent).detail;
            const pubsub = phase.startsWith("pubsub.");
            if (pubsub) {
                const topics: unknown = detail.data.topics;
                requireMetadata(
                    Array.isArray(topics) &&
                        topics.length <= 8 &&
                        topics.every(
                            (topic) =>
                                typeof topic === "string" && topic.length <= 128
                        )
                );
                if (!(topics as string[]).includes(this.topic!)) {
                    this.counters.topicIgnored++;
                    return;
                }
            }
            const message = detail.message;
            const id = outerId(message.id);
            const boundary = `${role}:${phase}:${id}`;
            if (this.boundaries.has(boundary)) {
                this.counters.duplicates++;
                return;
            }
            if (this.events.length >= this.maxEvents) {
                this.counters.eventsDropped++;
                return;
            }
            if (!this.ids.has(id) && this.ids.size >= this.maxIds) {
                this.counters.idsDropped++;
                return;
            }
            const value: TraceEvent = { atMs, phase, role, outerId: id };
            const session = message.header?.session;
            if (session !== undefined) {
                requireMetadata(
                    typeof session === "bigint" &&
                        session >= 0n &&
                        session <= 0xffff_ffff_ffff_ffffn
                );
                value.session = String(session);
            }
            const from = pubsub
                ? message.header?.signatures?.publicKeys?.[0]
                : detail.from;
            if (from !== undefined) {
                const hash = from.hashcode();
                requireMetadata(
                    typeof hash === "string" &&
                        hash.length > 0 &&
                        hash.length <= 128
                );
                value.from = hash;
            }
            if (phase === "rpc.request") {
                const request = detail.request;
                const known = requestTypes.find(
                    ([type]) => request instanceof type
                );
                if (known) {
                    value.requestType = known[1];
                    value.iteratorId = outerId(request.id);
                }
            }
            this.ids.add(id);
            this.boundaries.add(boundary);
            this.events.push(value);
        } catch (error) {
            if (error instanceof MalformedMetadata) this.counters.malformed++;
            else this.counters.captureErrors++;
        }
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.armed = false;
        const errors: unknown[] = [];
        for (const remove of this.removals.splice(0)) {
            try {
                remove();
            } catch (error) {
                errors.push(error);
            }
        }
        this.peers.clear();
        if (errors.length)
            throw new AggregateError(
                errors,
                "Passive profile listener cleanup failed"
            );
    }

    snapshot() {
        return {
            clockOriginMs: this.clockOriginMs,
            events: this.events.map((event) => ({ ...event })),
            counters: { ...this.counters },
        };
    }
}
