import { describe, expect, it, vi } from "vitest";
import {
    createPlacementSettlementProfile,
    type PlacementSettlementOperation,
} from "./adaptive-placement-settlement-profile.js";

const namespace = {
    runId: "a".repeat(64),
    peer: 0,
    generation: 1,
    plane: "chunks" as const,
    observerHash: "writer",
};
const label: PlacementSettlementOperation = {
    request: 4,
    kind: "put",
    file: 0,
    part: 2,
};
const fields = {
    plan: {
        round: 1,
        entryIndex: 0,
        remoteLeaderCount: 4,
        selectedRequestPeerCount: 3,
        carriedAckCount: 0,
    },
    candidate: { round: 1, entryIndex: 0, status: "selected-for-request" },
    peerPhase: {
        round: 1,
        phase: "confirmation",
        edge: "start",
        outcome: "pending",
        requestedEntries: 1,
    },
    progress: { round: 1, attempt: 0, entryIndex: 0, carriedAckCount: 2 },
    settle: {
        round: 0,
        outcome: "quorum-validated",
        emittedEvents: 4,
        droppedEvents: 0,
    },
};
const event = (
    family: keyof typeof fields = "plan",
    traceId = "persisted:1",
    details: Record<string, unknown> = {}
): {
    name: string;
    component: string;
    traceId: string;
    entries: number;
    peer: string | undefined;
    durationMs: number;
    details: Record<string, unknown>;
} => ({
    name: `sharedLog.persistedDelivery.${family}`,
    component: "shared-log",
    traceId,
    entries: 1,
    peer: ["candidate", "peerPhase", "progress"].includes(family)
        ? "remote"
        : undefined,
    durationMs: 2.5,
    details: {
        v: 1,
        minAcks: 3,
        leaderDegree: 4,
        entrySampleWindow: 1,
        entriesOutsideSampleWindow: 0,
        elapsedMs: 5,
        ...fields[family],
        ...details,
    },
});
const fixture = (now?: () => number) => {
    const profile = createPlacementSettlementProfile({
        ...namespace,
        now: now ?? (() => 7),
    });
    profile.bindLog("chunk-log");
    return profile;
};

describe("bounded persisted settlement profile collector", () => {
    it("preserves all five families and arrival order without inventing causal pairs", () => {
        const profile = fixture();
        for (const family of [
            "candidate",
            "plan",
            "peerPhase",
            "progress",
            "settle",
        ] as const)
            profile.sink(event(family), label);
        const result = profile.snapshot();
        expect(result.namespace).toEqual({
            ...namespace,
            logAddress: "chunk-log",
        });
        expect(result.traces).toHaveLength(1);
        expect(result.traces[0].operation).toEqual(label);
        expect(result.traces[0].events.map((e) => [e.seq, e.name])).toEqual([
            [1, "sharedLog.persistedDelivery.candidate"],
            [2, "sharedLog.persistedDelivery.plan"],
            [3, "sharedLog.persistedDelivery.peerPhase"],
            [4, "sharedLog.persistedDelivery.progress"],
        ]);
        expect(result.traces[0].terminal).toMatchObject({
            seq: 5,
            receivedAtMs: 7,
            details: { round: 0, outcome: "quorum-validated" },
        });
        expect(result.counters.invalidEvents).toBe(0);
        expect(result.counters.saturated).toBe(false);
    });

    it("detaches input, labels, namespace and all nested snapshot records", () => {
        const options = { ...namespace };
        const profile = createPlacementSettlementProfile(options);
        profile.bindLog("chunk-log");
        options.observerHash = "changed";
        const input = event();
        const operation = { ...label };
        profile.sink(input, operation);
        profile.sink(event("settle"), operation);
        input.details.carriedAckCount = 99;
        operation.request = 99;
        const snap = profile.snapshot();
        snap.namespace.observerHash = "mutated";
        snap.traces[0].events[0].details.carriedAckCount = 88;
        snap.traces[0].terminal!.details.outcome = "mutated";
        snap.traces[0].operation!.request = 88;
        snap.traces[0].events.length = 0;
        snap.counters.invalidEvents = 99;
        const next = profile.snapshot();
        expect(next.namespace.observerHash).toBe("writer");
        expect(next.traces[0].operation!.request).toBe(4);
        expect(next.traces[0].events[0].details.carriedAckCount).toBe(0);
        expect(next.traces[0].terminal!.details.outcome).toBe(
            "quorum-validated"
        );
        expect(next.counters.invalidEvents).toBe(0);
    });

    it("preserves declining progress, repeated unnumbered phases and explicit zeros", () => {
        const profile = fixture();
        profile.sink(event("progress", "trace", { carriedAckCount: 3 }));
        profile.sink(event("progress", "trace", { carriedAckCount: 1 }));
        profile.sink(
            event("peerPhase", "trace", {
                phase: "transfer-admission",
                edge: "end",
                outcome: "not-admitted",
                timeoutMs: 0,
            })
        );
        profile.sink(event("peerPhase", "trace"));
        const entries = profile.snapshot().traces[0].events;
        expect(
            entries.slice(0, 2).map((e) => e.details.carriedAckCount)
        ).toEqual([3, 1]);
        expect(entries[2].details).toMatchObject({
            phase: "transfer-admission",
            outcome: "not-admitted",
            timeoutMs: 0,
        });
        expect(entries[2].details).not.toHaveProperty("acceptedEntries");
        expect(entries[2].details).not.toHaveProperty("attempt");
        expect(entries[3].details).not.toHaveProperty("acceptedEntries");
        expect(profile.snapshot().counters.invalidEvents).toBe(0);
    });

    it("preserves a fulfilled receipt request with zero accepted entries exactly", () => {
        const profile = fixture();
        profile.sink(
            event("peerPhase", "receipt", {
                phase: "receipt-request",
                edge: "end",
                outcome: "fulfilled",
                attempt: 1,
                timeoutMs: 20_000,
                acceptedEntries: 0,
            })
        );
        const result = profile.snapshot();
        expect(result.traces[0].events[0]).toEqual({
            seq: 1,
            name: "sharedLog.persistedDelivery.peerPhase",
            component: "shared-log",
            traceId: "receipt",
            entries: 1,
            peer: "remote",
            durationMs: 2.5,
            receivedAtMs: 7,
            details: {
                v: 1,
                minAcks: 3,
                leaderDegree: 4,
                entrySampleWindow: 1,
                entriesOutsideSampleWindow: 0,
                elapsedMs: 5,
                round: 1,
                phase: "receipt-request",
                edge: "end",
                outcome: "fulfilled",
                requestedEntries: 1,
                attempt: 1,
                timeoutMs: 20_000,
                acceptedEntries: 0,
            },
        });
        expect(result.traces[0]).not.toHaveProperty("operation");
        expect(result.traces[0]).not.toHaveProperty("terminal");
        expect(result.counters.invalidEvents).toBe(0);
    });

    it("keeps terminal-only and unfinished traces without diagnosing failure", () => {
        const profile = fixture();
        profile.sink(event("settle", "terminal"));
        profile.sink(event("candidate", "incomplete"));
        const [terminal, incomplete] = profile.snapshot().traces;
        expect(terminal.events).toEqual([]);
        expect(terminal.terminal).toBeDefined();
        expect(incomplete).not.toHaveProperty("terminal");
        expect(incomplete).not.toHaveProperty("failure");
        expect(incomplete).not.toHaveProperty("operation");
    });

    it("reserves a terminal after first256 detail events and preserves upstream omissions separately", () => {
        const profile = fixture();
        for (let i = 0; i < 300; i++) profile.sink(event("plan"));
        profile.sink(
            event("settle", "persisted:1", {
                emittedEvents: 257,
                droppedEvents: 9,
            })
        );
        const result = profile.snapshot();
        expect(result.traces[0].events).toHaveLength(256);
        expect(result.traces[0].events[255].seq).toBe(256);
        expect(result.traces[0].terminal).toMatchObject({
            seq: 301,
            details: { droppedEvents: 9, emittedEvents: 257 },
        });
        expect(result.counters.detailDroppedEvents).toBe(44);
        expect(result.counters.invalidEvents).toBe(0);
        const terminal = result.traces[0].terminal;
        profile.sink(event("progress"));
        profile.sink(event("settle", "persisted:1", { outcome: "failed" }));
        expect(profile.snapshot().counters.lateEvents).toBe(2);
        expect(profile.snapshot().traces[0].terminal).toEqual(terminal);
    });

    it("bounds and detaches eight full traces with maximally escaped text", () => {
        const profile = createPlacementSettlementProfile({
            ...namespace,
            runId: "\u0000".repeat(64),
            observerHash: "\u000b".repeat(128),
            now: () => Number.MAX_VALUE,
        });
        profile.bindLog("\u0000".repeat(128));
        for (let i = 0; i < 8; i++) {
            const traceId = String.fromCharCode(i + 14).repeat(128);
            const detail = event("peerPhase", traceId, {
                phase: "receipt-request",
                edge: "end",
                outcome: "fulfilled",
                attempt: Number.MAX_SAFE_INTEGER,
                timeoutMs: Number.MAX_VALUE,
                acceptedEntries: Number.MAX_SAFE_INTEGER,
            });
            detail.peer = "\u000e".repeat(128);
            detail.entries = Number.MAX_SAFE_INTEGER;
            detail.durationMs = Number.MAX_VALUE;
            for (let j = 0; j < 256; j++) profile.sink(detail, label);
            profile.sink(
                event("settle", traceId, { emittedEvents: 257 }),
                label
            );
        }
        const result = profile.snapshot();
        expect(result.traces).toHaveLength(8);
        for (const trace of result.traces) {
            expect(trace.events).toHaveLength(256);
            expect(trace.terminal).toBeDefined();
        }
        expect(result.counters).toMatchObject({
            matchingEvents: 8 * 257,
            invalidEvents: 0,
            detailDroppedEvents: 0,
            capacityDroppedEvents: 0,
            evictedTraces: 0,
            evictedEvents: 0,
        });
        const serialized = JSON.stringify(result);
        // JSON escapes every control character to six ASCII bytes. This bound
        // includes both repeated trace IDs and full-length remote peer names.
        expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(
            8 * 1024 * 1024
        );
        result.namespace.logAddress = "changed";
        result.traces[0].operation!.request = 99;
        result.traces[0].events[0].peer = "changed";
        result.traces[0].events[0].details.acceptedEntries = 0;
        result.traces[0].terminal!.details.outcome = "changed";
        result.traces[7].events.length = 0;
        expect(JSON.stringify(profile.snapshot())).toBe(serialized);
    });

    it("evicts the oldest completed trace, never an older incomplete one", () => {
        const profile = fixture();
        for (let i = 0; i < 8; i++) profile.sink(event("plan", `trace${i}`));
        profile.sink(event("settle", "trace2"));
        profile.sink(event("settle", "trace4"));
        profile.sink(event("candidate", "new"));
        let snap = profile.snapshot();
        expect(snap.traces.map((t) => t.traceId)).toEqual([
            "trace0",
            "trace1",
            "trace3",
            "trace4",
            "trace5",
            "trace6",
            "trace7",
            "new",
        ]);
        expect(snap.counters).toMatchObject({
            evictedTraces: 1,
            evictedEvents: 2,
        });
        profile.sink(event("settle", "trace2")); // Old IDs have unknown coverage after eviction.
        snap = profile.snapshot();
        expect(snap.traces.at(-1)!.traceId).toBe("trace2");
        expect(snap.traces.at(-1)!.events).toEqual([]);
        expect(snap.counters).toMatchObject({
            evictedTraces: 2,
            evictedEvents: 4,
            lateEvents: 0,
        });
    });

    it("reports event loss under all-incomplete pressure, not distinct lost traces", () => {
        const profile = fixture();
        for (let i = 0; i < 8; i++) profile.sink(event("plan", `trace${i}`));
        profile.sink(event("candidate", "overflow"));
        profile.sink(event("plan", "overflow"));
        profile.sink(event("settle", "overflow"));
        const result = profile.snapshot();
        expect(result.traces).toHaveLength(8);
        expect(result.counters).toMatchObject({
            capacityDroppedEvents: 3,
            terminalCapacityDroppedEvents: 1,
            evictedTraces: 0,
        });
        expect(result.counters).not.toHaveProperty("droppedTraces");
        profile.sink(event("settle", "trace0"));
        expect(profile.snapshot().traces[0].terminal).toBeDefined();
    });

    it("does not retain matching pre-bind traffic and binds only one stable log", () => {
        const profile = createPlacementSettlementProfile(namespace);
        profile.sink(event());
        profile.sink(event("settle"));
        expect(profile.snapshot()).toMatchObject({
            namespace: { logAddress: null },
            traces: [],
            counters: { unboundEvents: 2 },
        });
        profile.bindLog("log");
        profile.bindLog("log");
        expect(() => profile.bindLog("other")).toThrow();
        expect(() => profile.bindLog("")).toThrow();
        profile.sink(event("candidate"));
        expect(profile.snapshot().traces[0].events[0].seq).toBe(3);
    });

    it("separates unsupported versions, unknown families and malformed events", () => {
        const profile = fixture();
        profile.sink(null);
        profile.sink({ name: "unrelated" });
        profile.sink(event("plan", "new-version", { v: 2 }));
        profile.sink({
            ...event(),
            name: "sharedLog.persistedDelivery.future",
        });
        profile.sink(event("plan", "missing-version", { v: undefined }));
        expect(profile.snapshot()).toMatchObject({
            traces: [],
            counters: {
                matchingEvents: 3,
                unsupportedVersions: 1,
                unknownFamilies: 1,
                invalidEvents: 1,
            },
        });
    });

    it.each([
        "v",
        "minAcks",
        "leaderDegree",
        "entrySampleWindow",
        "entriesOutsideSampleWindow",
        "elapsedMs",
        "round",
        "entryIndex",
        "carriedAckCount",
        "remoteLeaderCount",
        "selectedRequestPeerCount",
    ])("rejects missing required plan field %s without default zero", (key) => {
        const profile = fixture();
        profile.sink(event("plan", "bad", { [key]: undefined }));
        expect(profile.snapshot()).toMatchObject({
            traces: [],
            counters: { invalidEvents: 1 },
        });
    });

    it.each([
        { entries: undefined },
        { durationMs: undefined },
        { durationMs: NaN },
        { durationMs: -1 },
        { component: "wrong" },
        { traceId: "x".repeat(129) },
        { peer: "x".repeat(129) },
    ])("rejects malformed top-level fields: %j", (changes) => {
        const profile = fixture();
        profile.sink({ ...event(), ...changes });
        expect(profile.snapshot()).toMatchObject({
            traces: [],
            counters: { invalidEvents: 1 },
        });
    });

    it.each(["candidate", "peerPhase", "progress"] as const)(
        "requires a remote peer for %s",
        (family) => {
            const profile = fixture();
            profile.sink({ ...event(family), peer: undefined });
            expect(profile.snapshot().counters.invalidEvents).toBe(1);
            expect(profile.snapshot().traces).toEqual([]);
        }
    );

    it("does not invoke hostile whitelisted accessors or unknown payload accessors", () => {
        const getter = vi.fn(() => {
            throw new Error("do not invoke");
        });
        const profile = fixture();
        const source = event();
        Object.defineProperty(source.details, "payload", { get: getter });
        Object.defineProperty(source, "hashes", { get: getter });
        profile.sink(source);
        profile.sink(
            Object.defineProperty(event("plan", "bad"), "traceId", {
                get: getter,
            })
        );
        profile.sink({
            ...event("plan", "bad2"),
            details: Object.defineProperty({ ...event().details }, "round", {
                get: getter,
            }),
        });
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        expect(() => profile.sink(revoked.proxy)).not.toThrow();
        expect(getter).not.toHaveBeenCalled();
        expect(profile.snapshot().traces).toHaveLength(1);
        expect(
            profile.snapshot().traces[0].events[0].details
        ).not.toHaveProperty("payload");
        expect(profile.snapshot().counters.invalidEvents).toBe(3);
    });

    it.each([NaN, Infinity, -1])(
        "retains the event with null on clock fault %s",
        (value) => {
            const profile = fixture(() => value);
            profile.sink(event("settle"));
            expect(
                profile.snapshot().traces[0].terminal!.receivedAtMs
            ).toBeNull();
            expect(profile.snapshot().counters.invalidEvents).toBe(1);
        }
    );

    it("contains thrown clocks and preserves the original event outcome", () => {
        const profile = fixture(() => {
            throw undefined;
        });
        expect(() =>
            profile.sink(
                event("settle", "failure", {
                    outcome: "failed",
                    reason: "timeout",
                })
            )
        ).not.toThrow();
        expect(profile.snapshot().traces[0].terminal).toMatchObject({
            receivedAtMs: null,
            details: { outcome: "failed", reason: "timeout" },
        });
    });

    it("preserves first attribution on conflicts, including terminal evidence", () => {
        const profile = fixture();
        profile.sink(event(), label);
        profile.sink(event("progress"), { ...label, request: 5 });
        profile.sink(event("settle"), { request: 6, kind: "barrier" });
        const result = profile.snapshot();
        expect(result.traces[0].operation).toEqual(label);
        expect(result.traces[0].events).toHaveLength(2);
        expect(result.traces[0].terminal).toBeDefined();
        expect(result.counters).toMatchObject({
            invalidEvents: 2,
            operationConflicts: 2,
        });
    });

    it("does not infer a missing first operation or treat later absence as a relabel", () => {
        const profile = fixture();
        profile.sink(event());
        profile.sink(event("settle"), label);
        expect(profile.snapshot().traces[0]).not.toHaveProperty("operation");
        expect(profile.snapshot().counters.operationConflicts).toBe(1);
        const other = fixture();
        other.sink(event(), label);
        other.sink(event("settle"));
        expect(other.snapshot().counters.operationConflicts).toBe(0);
    });

    it("accepts repeated barrier labels without inventing file or part", () => {
        const profile = fixture();
        const barrier: PlacementSettlementOperation = {
            request: 9,
            kind: "barrier",
        };
        profile.sink(event("plan"), barrier);
        profile.sink(event("settle"), { ...barrier });
        expect(profile.snapshot().traces[0].operation).toEqual(barrier);
        expect(profile.snapshot().counters.operationConflicts).toBe(0);
    });

    it("separates identical trace IDs by run, process generation and log plane", () => {
        const one = fixture();
        const two = createPlacementSettlementProfile({
            ...namespace,
            runId: "b".repeat(64),
            generation: 2,
            plane: "metadata",
        });
        two.bindLog("metadata-log");
        one.sink(event());
        two.sink(event());
        expect(one.snapshot().traces[0].traceId).toBe(
            two.snapshot().traces[0].traceId
        );
        expect(one.snapshot().namespace).not.toEqual(two.snapshot().namespace);
        expect(() =>
            JSON.stringify([one.snapshot(), two.snapshot()])
        ).not.toThrow();
    });

    it.each([
        { runId: "" },
        { runId: "x".repeat(65) },
        { observerHash: "x".repeat(129) },
        { peer: -1 },
        { generation: 0 },
        { plane: "other" },
        { now: 3 },
    ])("rejects invalid trusted setup: %j", (changes) => {
        expect(() =>
            createPlacementSettlementProfile({
                ...namespace,
                ...changes,
            } as Parameters<typeof createPlacementSettlementProfile>[0])
        ).toThrow();
    });
});
