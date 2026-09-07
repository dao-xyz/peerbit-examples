import {
    CloseIteratorRequest,
    CollectNextRequest,
    IterationRequest,
    SearchRequest,
    SearchRequestIndexed,
} from "@peerbit/document";
import { RPC } from "@peerbit/rpc";
import { describe, expect, it, vi } from "vitest";
import { SparseQueryTransportProfile } from "./sparse-query-transport-profile.js";

type Peer = Parameters<SparseQueryTransportProfile["attachPeer"]>[0];
type Entries = Parameters<SparseQueryTransportProfile["arm"]>[0];
type Listener = (event: CustomEvent<unknown>) => void;
const topic = "public-query-topic";
const id = (value: number) => new Uint8Array(32).fill(value);

// Synchronous event fixtures exercise observation only: no real peer, transport,
// RPC handler, payload codec or document query is started by this file.
const emitter = () => {
    const listeners = new Map<string, Set<Listener>>();
    const addEventListener = vi.fn((type: string, listener: Listener) => {
        const group = listeners.get(type) ?? new Set<Listener>();
        group.add(listener);
        listeners.set(type, group);
    });
    const removeEventListener = vi.fn((type: string, listener: Listener) => {
        listeners.get(type)?.delete(listener);
    });
    return {
        addEventListener,
        removeEventListener,
        dispatchEvent(event: CustomEvent<unknown>) {
            for (const listener of [...(listeners.get(event.type) ?? [])]) {
                listener(event);
            }
            return true;
        },
        emit(type: string, detail: unknown) {
            return this.dispatchEvent(new CustomEvent(type, { detail }));
        },
        listenerCount() {
            return [...listeners.values()].reduce(
                (sum, group) => sum + group.size,
                0
            );
        },
    };
};

const rpcFixture = (topics = [topic], closed = false) => {
    const events = emitter();
    // Keep instanceof meaningful while replacing only public API properties.
    const rpc = Object.create(RPC.prototype) as RPC<unknown, unknown>;
    Object.defineProperties(rpc, {
        closed: { value: closed, configurable: true },
        events: { value: events },
        getTopics: { value: () => topics, configurable: true },
    });
    return { rpc, events };
};

const entries = (...programs: unknown[]) =>
    ({ index: { allPrograms: programs } }) as unknown as Entries;

const peerFixture = (name: string) => {
    const pubsub = emitter();
    const publicKey = { hashcode: () => name };
    const peer = { identity: { publicKey }, services: { pubsub } };
    return { peer: peer as unknown as Peer, pubsub, publicKey };
};

const message = (messageId: Uint8Array, sender = "public-source") => ({
    id: messageId,
    header: {
        session: 17n,
        signatures: { publicKeys: [{ hashcode: () => sender }] },
    },
    get data(): never {
        throw new Error("Message payload must not be inspected");
    },
});

const transport = (messageId: Uint8Array, topics = [topic]) => ({
    message: message(messageId),
    data: {
        topics,
        get data(): never {
            throw new Error("Pubsub payload must not be inspected");
        },
    },
});

const decodedRequest = (
    outerId: Uint8Array,
    request: unknown = new SearchRequest()
) => ({
    message: message(outerId, "public-observer"),
    request,
    from: { hashcode: () => "public-observer" },
});

const decodedResponse = (outerId: Uint8Array) => ({
    message: message(outerId),
    get response(): never {
        throw new Error("Decoded response payload must not be inspected");
    },
    from: { hashcode: () => "public-source" },
});

const fixture = (
    options?: ConstructorParameters<typeof SparseQueryTransportProfile>[0]
) => {
    const profile = new SparseQueryTransportProfile(options);
    const source = peerFixture("public-source");
    const observer = peerFixture("public-observer");
    const sourceRpc = rpcFixture();
    const observerRpc = rpcFixture();
    profile.attachPeer(source.peer, "source");
    profile.attachPeer(observer.peer, "observer");
    const arm = () =>
        profile.arm(entries(sourceRpc.rpc), entries(observerRpc.rpc));
    return { profile, source, observer, sourceRpc, observerRpc, arm };
};

describe("test-only sparse query transport profile", () => {
    it("registers pubsub listeners before arming and discovers RPC listeners only when armed", () => {
        const test = fixture();
        expect(
            test.source.pubsub.addEventListener.mock.calls.map(([type]) => type)
        ).toEqual(["publish", "data"]);
        expect(
            test.observer.pubsub.addEventListener.mock.calls.map(
                ([type]) => type
            )
        ).toEqual(["publish", "data"]);
        expect(test.sourceRpc.events.listenerCount()).toBe(0);
        expect(test.observerRpc.events.listenerCount()).toBe(0);
        test.arm();
        expect(
            test.sourceRpc.events.addEventListener.mock.calls.map(
                ([type]) => type
            )
        ).toEqual(["request", "response"]);
        expect(
            test.observerRpc.events.addEventListener.mock.calls.map(
                ([type]) => type
            )
        ).toEqual(["request", "response"]);
        expect(test.profile.snapshot().events).toEqual([]);
        test.profile.stop();
    });

    it("ignores pre-arm and unrelated traffic without retaining their IDs or reading payloads", () => {
        const test = fixture({ maxIds: 1 });
        const unreadable = {
            get data(): never {
                throw new Error("Pre-arm metadata inspected");
            },
            get message(): never {
                throw new Error("Pre-arm message inspected");
            },
        };
        test.source.pubsub.emit("publish", unreadable);
        test.observer.pubsub.emit("data", unreadable);
        test.arm();
        const unrelated = transport(id(7), ["not-query-topic"]);
        Object.defineProperty(unrelated, "message", {
            get() {
                throw new Error("Unrelated message inspected");
            },
        });
        test.source.pubsub.emit("publish", unrelated);
        test.source.pubsub.emit("publish", transport(id(7)));
        expect(test.profile.snapshot()).toMatchObject({
            events: [{ outerId: Buffer.from(id(7)).toString("base64") }],
            counters: {
                preArmIgnored: 2,
                topicIgnored: 1,
                idsDropped: 0,
                captureErrors: 0,
            },
        });
        test.profile.stop();
    });

    it("correlates exact outer IDs within each direction without pairing request and response IDs", () => {
        const test = fixture();
        test.arm();
        const requestId = id(11);
        const responseId = id(12);
        const request = new SearchRequest();
        request.id = id(13);
        const expectedRequestId = Buffer.from(requestId).toString("base64");
        const expectedResponseId = Buffer.from(responseId).toString("base64");
        test.observer.pubsub.emit("publish", transport(requestId.slice()));
        test.source.pubsub.emit("data", transport(requestId.slice()));
        test.sourceRpc.events.emit(
            "request",
            decodedRequest(requestId.slice(), request)
        );
        test.source.pubsub.emit("publish", transport(responseId.slice()));
        test.observer.pubsub.emit("data", transport(responseId.slice()));
        test.observerRpc.events.emit(
            "response",
            decodedResponse(responseId.slice())
        );
        requestId.fill(99);
        responseId.fill(99);
        request.id.fill(99);
        const snapshot = test.profile.snapshot();
        expect(
            snapshot.events.map(({ phase, role, outerId }) => ({
                phase,
                role,
                outerId,
            }))
        ).toEqual([
            {
                phase: "pubsub.publish",
                role: "observer",
                outerId: expectedRequestId,
            },
            {
                phase: "pubsub.data",
                role: "source",
                outerId: expectedRequestId,
            },
            {
                phase: "rpc.request",
                role: "source",
                outerId: expectedRequestId,
            },
            {
                phase: "pubsub.publish",
                role: "source",
                outerId: expectedResponseId,
            },
            {
                phase: "pubsub.data",
                role: "observer",
                outerId: expectedResponseId,
            },
            {
                phase: "rpc.response",
                role: "observer",
                outerId: expectedResponseId,
            },
        ]);
        expect(snapshot.events[2]).toMatchObject({
            iteratorId: Buffer.from(id(13)).toString("base64"),
            from: "public-observer",
            session: "17",
        });
        expect(snapshot.events[5]).toMatchObject({
            from: "public-source",
            session: "17",
        });
        expect(snapshot.events[5]).not.toHaveProperty("iteratorId");
        expect(snapshot.events[5]).not.toHaveProperty("requestId");
        expect(snapshot.counters.captureErrors).toBe(0);
        expect(Number.isFinite(snapshot.clockOriginMs)).toBe(true);
        for (let i = 0; i < snapshot.events.length; i++) {
            expect(snapshot.events[i].atMs).toBeGreaterThanOrEqual(
                i ? snapshot.events[i - 1].atMs : 0
            );
        }
        test.profile.stop();
    });

    it("records exported search and iterator IDs without evaluating query predicates", () => {
        const test = fixture();
        test.arm();
        const iteratorId = id(41);
        const requests = [
            new SearchRequest(),
            new SearchRequestIndexed({ replicate: false }),
            new IterationRequest(),
            new CollectNextRequest({ id: iteratorId, amount: 8 }),
            new CloseIteratorRequest({ id: iteratorId }),
        ];
        for (const [index, request] of requests.entries()) {
            request.id = iteratorId.slice();
            Object.defineProperty(request, "query", {
                get() {
                    throw new Error("Query predicate inspected");
                },
            });
            test.sourceRpc.events.emit(
                "request",
                decodedRequest(id(index + 1), request)
            );
        }
        const snapshot = test.profile.snapshot();
        expect(snapshot.events).toHaveLength(5);
        expect(snapshot.events.map((event) => event.iteratorId)).toEqual(
            requests.map(() => Buffer.from(iteratorId).toString("base64"))
        );
        expect(snapshot.events.map((event) => event.requestType)).toEqual([
            "SearchRequest",
            "SearchRequestIndexed",
            "IterationRequest",
            "CollectNextRequest",
            "CloseIteratorRequest",
        ]);
        expect(snapshot.counters.captureErrors).toBe(0);
        test.profile.stop();
    });

    it("bounds retained events and counts dropped events", () => {
        const test = fixture({ maxEvents: 2 });
        test.arm();
        for (let i = 1; i <= 3; i++)
            test.source.pubsub.emit("publish", transport(id(i)));
        expect(test.profile.snapshot()).toMatchObject({
            events: [
                { outerId: Buffer.from(id(1)).toString("base64") },
                { outerId: Buffer.from(id(2)).toString("base64") },
            ],
            counters: { eventsDropped: 1 },
        });
        test.profile.stop();
    });

    it("bounds unique outer IDs while allowing the same ID at another observation stage", () => {
        const test = fixture({ maxIds: 1 });
        test.arm();
        test.observer.pubsub.emit("publish", transport(id(1)));
        test.source.pubsub.emit("data", transport(id(2)));
        test.source.pubsub.emit("data", transport(id(1)));
        const snapshot = test.profile.snapshot();
        expect(snapshot.events.map((event) => event.outerId)).toEqual([
            Buffer.from(id(1)).toString("base64"),
            Buffer.from(id(1)).toString("base64"),
        ]);
        expect(snapshot.counters.idsDropped).toBe(1);
        test.profile.stop();
    });

    it("counts duplicate role/phase/ID observations without hiding distinct stages or roles", () => {
        const test = fixture();
        test.arm();
        test.source.pubsub.emit("publish", transport(id(1)));
        test.source.pubsub.emit("publish", transport(id(1)));
        test.source.pubsub.emit("data", transport(id(1)));
        test.observer.pubsub.emit("publish", transport(id(1)));
        expect(test.profile.snapshot().events).toHaveLength(3);
        expect(test.profile.snapshot().counters.duplicates).toBe(1);
        test.profile.stop();
    });

    it("rejects malformed outer IDs and does not consume capacity for them", () => {
        const test = fixture({ maxIds: 1 });
        test.arm();
        const invalidIds: unknown[] = [
            new Uint8Array(31),
            new Uint8Array(33),
            Array(32).fill(1),
            "not-bytes",
        ];
        for (const invalidId of invalidIds) {
            const detail = transport(id(1));
            Object.defineProperty(detail.message, "id", { value: invalidId });
            test.source.pubsub.emit("publish", detail);
        }
        test.source.pubsub.emit("publish", transport(id(1)));
        expect(test.profile.snapshot()).toMatchObject({
            events: [{ outerId: Buffer.from(id(1)).toString("base64") }],
            counters: { malformed: 4, idsDropped: 0 },
        });
        test.profile.stop();
    });

    it("contains hostile metadata accessors so subsequent application listeners still run", () => {
        const test = fixture();
        test.arm();
        const applicationPubsub = vi.fn();
        const applicationRpc = vi.fn();
        test.source.pubsub.addEventListener("data", applicationPubsub);
        test.sourceRpc.events.addEventListener("response", applicationRpc);
        const hostile = transport(id(1));
        Object.defineProperty(hostile.message, "id", {
            get() {
                throw undefined;
            },
        });
        const hostileResponse = decodedResponse(id(2));
        Object.defineProperty(hostileResponse, "from", {
            get() {
                throw new Error("Hostile sender getter");
            },
        });
        expect(() => test.source.pubsub.emit("data", hostile)).not.toThrow();
        expect(() =>
            test.sourceRpc.events.emit("response", hostileResponse)
        ).not.toThrow();
        expect(applicationPubsub).toHaveBeenCalledTimes(1);
        expect(applicationRpc).toHaveBeenCalledTimes(1);
        expect(test.profile.snapshot().counters.captureErrors).toBe(2);
        test.profile.stop();
    });

    it("returns detached serializable snapshots", () => {
        const test = fixture();
        test.arm();
        test.source.pubsub.emit("publish", transport(id(1)));
        const snapshot = test.profile.snapshot();
        const original = test.profile.snapshot();
        snapshot.events[0].outerId = "mutated";
        snapshot.events.push({ ...snapshot.events[0] });
        snapshot.counters.captureErrors = 999;
        snapshot.clockOriginMs = -1;
        expect(test.profile.snapshot()).toEqual(original);
        expect(() => JSON.stringify(test.profile.snapshot())).not.toThrow();
        test.profile.stop();
    });

    it("stops capture and removes every owned listener exactly once", () => {
        const test = fixture();
        test.arm();
        const buses = [
            test.source.pubsub,
            test.observer.pubsub,
            test.sourceRpc.events,
            test.observerRpc.events,
        ];
        const retained = buses.flatMap((bus) =>
            bus.addEventListener.mock.calls.map(([, listener]) => listener)
        );
        test.source.pubsub.emit("publish", transport(id(1)));
        test.profile.stop();
        const frozen = test.profile.snapshot();
        for (const listener of retained)
            listener(new CustomEvent("data", { detail: transport(id(2)) }));
        test.profile.stop();
        expect(test.profile.snapshot()).toEqual(frozen);
        for (const bus of buses) {
            expect(bus.listenerCount()).toBe(0);
            expect(bus.removeEventListener).toHaveBeenCalledTimes(2);
            for (const call of bus.addEventListener.mock.calls) {
                expect(bus.removeEventListener.mock.calls).toContainEqual(call);
            }
        }
    });

    it("attempts all cleanup removals and preserves multiple errors including undefined", () => {
        const test = fixture();
        test.arm();
        const first = new Error("First removal failed");
        const last = new Error("Last removal failed");
        test.source.pubsub.removeEventListener.mockImplementationOnce(() => {
            throw first;
        });
        test.observer.pubsub.removeEventListener.mockImplementationOnce(() => {
            throw undefined;
        });
        test.observerRpc.events.removeEventListener.mockImplementationOnce(
            () => {
                throw last;
            }
        );
        let failure: unknown;
        try {
            test.profile.stop();
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(AggregateError);
        const errors = (failure as AggregateError).errors;
        expect(errors).toHaveLength(3);
        expect(errors).toContain(first);
        expect(errors).toContain(undefined);
        expect(errors).toContain(last);
        const frozen = test.profile.snapshot();
        test.source.pubsub.emit("publish", transport(id(1)));
        test.observer.pubsub.emit("publish", transport(id(2)));
        expect(() => test.profile.stop()).not.toThrow();
        expect(test.profile.snapshot()).toEqual(frozen);
        for (const bus of [
            test.source.pubsub,
            test.observer.pubsub,
            test.sourceRpc.events,
            test.observerRpc.events,
        ]) {
            expect(bus.removeEventListener).toHaveBeenCalledTimes(2);
        }
    });

    it("fails closed on missing RPC discovery and cleans already attached pubsub listeners", () => {
        const test = fixture();
        expect(() =>
            test.profile.arm(entries(), entries(test.observerRpc.rpc))
        ).toThrow();
        expect(test.source.pubsub.listenerCount()).toBe(0);
        expect(test.observer.pubsub.listenerCount()).toBe(0);
        expect(test.sourceRpc.events.listenerCount()).toBe(0);
        expect(test.observerRpc.events.listenerCount()).toBe(0);
        const frozen = test.profile.snapshot();
        test.source.pubsub.emit("publish", transport(id(1)));
        expect(test.profile.snapshot()).toEqual(frozen);
        expect(() => test.profile.stop()).not.toThrow();
    });

    it("rejects a closed RPC rather than treating it as an opened query program", () => {
        const test = fixture();
        const closed = rpcFixture([topic], true);
        expect(() =>
            test.profile.arm(entries(closed.rpc), entries(test.observerRpc.rpc))
        ).toThrow();
        expect(closed.events.listenerCount()).toBe(0);
        expect(test.source.pubsub.listenerCount()).toBe(0);
        expect(test.observer.pubsub.listenerCount()).toBe(0);
    });

    it("rejects ambiguous opened RPC discovery", () => {
        const test = fixture();
        const extra = rpcFixture();
        expect(() =>
            test.profile.arm(
                entries(test.sourceRpc.rpc, extra.rpc),
                entries(test.observerRpc.rpc)
            )
        ).toThrow();
        expect(test.sourceRpc.events.listenerCount()).toBe(0);
        expect(extra.events.listenerCount()).toBe(0);
        expect(test.source.pubsub.listenerCount()).toBe(0);
        expect(test.observer.pubsub.listenerCount()).toBe(0);
    });

    it("rejects mismatched source and observer query topics", () => {
        const test = fixture();
        const other = rpcFixture(["another-query-topic"]);
        expect(() =>
            test.profile.arm(entries(test.sourceRpc.rpc), entries(other.rpc))
        ).toThrow();
        expect(test.sourceRpc.events.listenerCount()).toBe(0);
        expect(other.events.listenerCount()).toBe(0);
        expect(test.source.pubsub.listenerCount()).toBe(0);
        expect(test.observer.pubsub.listenerCount()).toBe(0);
    });

    it("preserves discovery failure alongside cleanup failure", () => {
        const test = fixture();
        const discovery = new Error("Public topic lookup failed");
        const cleanup = new Error("Cleanup failed after discovery");
        Object.defineProperty(test.sourceRpc.rpc, "getTopics", {
            value: () => {
                throw discovery;
            },
        });
        test.source.pubsub.removeEventListener.mockImplementationOnce(() => {
            throw cleanup;
        });
        let failure: unknown;
        try {
            test.arm();
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(AggregateError);
        const errors = (failure as AggregateError).errors;
        expect(errors[0]).toBe(discovery);
        // Cleanup may be represented as a nested aggregate; the original error
        // identity must survive whichever shape the public cleanup uses.
        const nested = errors.flatMap((error) =>
            error instanceof AggregateError ? error.errors : [error]
        );
        expect(nested).toContain(cleanup);
        expect(test.source.pubsub.removeEventListener).toHaveBeenCalledTimes(2);
        expect(test.observer.pubsub.removeEventListener).toHaveBeenCalledTimes(
            2
        );
        expect(() => test.profile.stop()).not.toThrow();
    });

    it("validates bounded configuration and permits zero diagnostic capacity", () => {
        for (const invalid of [-1, 0.5, NaN, Infinity, 513]) {
            expect(
                () => new SparseQueryTransportProfile({ maxEvents: invalid })
            ).toThrow();
        }
        for (const invalid of [-1, 0.5, NaN, Infinity, 129]) {
            expect(
                () => new SparseQueryTransportProfile({ maxIds: invalid })
            ).toThrow();
        }
        const test = fixture({ maxEvents: 0, maxIds: 0 });
        test.arm();
        expect(() =>
            test.source.pubsub.emit("publish", transport(id(1)))
        ).not.toThrow();
        expect(test.profile.snapshot().events).toEqual([]);
        test.profile.stop();
    });

    it("cleans a listener that was added before registration threw and retains the original error", () => {
        const test = fixture();
        const failure = new Error("Registration failed after addition");
        const originalAdd =
            test.sourceRpc.events.addEventListener.getMockImplementation()!;
        test.sourceRpc.events.addEventListener.mockImplementationOnce(
            (type, listener) => {
                originalAdd(type, listener);
                throw failure;
            }
        );
        let caught: unknown;
        try {
            test.arm();
        } catch (error) {
            caught = error;
        }
        expect(caught).toBe(failure);
        expect(test.sourceRpc.events.listenerCount()).toBe(0);
        expect(test.sourceRpc.events.removeEventListener).toHaveBeenCalledTimes(
            1
        );
        expect(test.source.pubsub.listenerCount()).toBe(0);
        expect(test.observer.pubsub.listenerCount()).toBe(0);
        expect(test.observerRpc.events.addEventListener).not.toHaveBeenCalled();
        expect(() => test.profile.stop()).not.toThrow();
    });

    it("drains detached bounded windows while preserving listeners, clocks and lifetime counters", () => {
        const test = fixture({ maxEvents: 1, maxIds: 1 });
        expect(() => test.profile.takeWindow()).toThrow("armed");
        test.source.pubsub.emit("data", {});
        test.arm();
        test.observer.pubsub.emit("publish", transport(id(1)));
        test.observer.pubsub.emit("publish", transport(id(1)));
        test.source.pubsub.emit("data", transport(id(2)));
        const first = test.profile.takeWindow();
        expect(first.events).toHaveLength(1);
        expect(first.counters).toMatchObject({
            preArmIgnored: 1,
            duplicates: 1,
            eventsDropped: 1,
        });
        expect(test.profile.snapshot().events).toEqual([]);
        expect(test.source.pubsub.listenerCount()).toBe(2);
        expect(test.sourceRpc.events.listenerCount()).toBe(2);
        // The same ID after a drain is a new window-local boundary, not a
        // duplicate. No chain is inferred between the returned windows.
        test.observer.pubsub.emit("publish", transport(id(1)));
        const second = test.profile.takeWindow();
        expect(second.clockOriginMs).toBe(first.clockOriginMs);
        expect(second.events).toHaveLength(1);
        expect(second.events[0].atMs).toBeGreaterThanOrEqual(
            first.events[0].atMs
        );
        expect(second.counters).toEqual(first.counters);
        first.events[0].outerId = "mutated";
        first.counters.duplicates = 999;
        expect(second.events[0].outerId).not.toBe("mutated");
        expect(test.profile.snapshot().counters.duplicates).toBe(1);
        test.observer.pubsub.emit("publish", transport(id(3)));
        expect(test.profile.takeWindow().events[0].outerId).toBe(
            Buffer.from(id(3)).toString("base64")
        );
        test.profile.stop();
        const stopped = test.profile.snapshot();
        expect(() => test.profile.takeWindow()).toThrow("armed");
        expect(test.profile.snapshot()).toEqual(stopped);
    });

    it("reports partial same-ID chains when a drain divides their boundaries", () => {
        const test = fixture();
        test.arm();
        test.observer.pubsub.emit("publish", transport(id(1)));
        const first = test.profile.takeWindow();
        test.source.pubsub.emit("data", transport(id(1)));
        test.sourceRpc.events.emit("request", decodedRequest(id(1)));
        const second = test.profile.takeWindow();
        expect(first.events.map((event) => event.phase)).toEqual([
            "pubsub.publish",
        ]);
        expect(second.events.map((event) => event.phase)).toEqual([
            "pubsub.data",
            "rpc.request",
        ]);
        expect(second.counters.duplicates).toBe(0);
        test.profile.stop();
    });

    it("drops malformed optional metadata but never inspects IDs on unknown request classes", () => {
        const test = fixture({ maxIds: 1 });
        test.arm();
        for (const invalidSession of [-1n, 1n << 64n, 1]) {
            const detail = transport(id(1));
            Object.defineProperty(detail.message.header, "session", {
                value: invalidSession,
            });
            test.source.pubsub.emit("publish", detail);
        }
        const unknownRequest = {
            get id(): never {
                throw new Error("Unknown request inspected");
            },
            get query(): never {
                throw new Error("Unknown query inspected");
            },
        };
        test.sourceRpc.events.emit(
            "request",
            decodedRequest(id(1), unknownRequest)
        );
        const snapshot = test.profile.snapshot();
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0]).not.toHaveProperty("iteratorId");
        expect(snapshot.events[0]).not.toHaveProperty("requestType");
        expect(snapshot.counters).toMatchObject({
            malformed: 3,
            captureErrors: 0,
            idsDropped: 0,
        });
        test.profile.stop();
    });
});
