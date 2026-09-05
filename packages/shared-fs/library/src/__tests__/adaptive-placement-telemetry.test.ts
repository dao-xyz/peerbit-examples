import { describe, expect, it } from "vitest";
import {
    createPlacementProfile,
    errorInfo,
} from "./adaptive-placement-telemetry.js";

describe("bounded placement profile", () => {
    it("summarizes only names and durationMs, with detached snapshots", () => {
        const profile = createPlacementProfile();
        const event = {
            name: "sharedLog.open.fanout",
            durationMs: 2.5,
            count: 100,
            peer: "private-peer",
            details: { secret: "private-payload" },
        };
        profile.sink(event);
        profile.sink({ name: event.name, durationMs: 0 });
        profile.sink({ name: event.name });
        event.durationMs = 999;
        const first = profile.snapshot();
        expect(first.events).toEqual([
            {
                name: event.name,
                count: 3,
                timedCount: 2,
                sumMs: 2.5,
                maxMs: 2.5,
            },
        ]);
        first.events[0].count = 999;
        first.events.push({
            name: "injected",
            count: 1,
            timedCount: 0,
            sumMs: 0,
            maxMs: 0,
        });
        expect(profile.snapshot().events).toHaveLength(1);
        expect(profile.snapshot().events[0].count).toBe(3);
        expect(JSON.stringify(profile.snapshot())).not.toMatch(
            /private|details/
        );
    });

    it("bounds distinct names but continues aggregating admitted names", () => {
        const profile = createPlacementProfile({ maxEvents: 2 });
        for (let i = 0; i < 10_000; i++) profile.sink({ name: `event.${i}` });
        profile.sink({ name: "event.0", durationMs: 3 });
        expect(profile.snapshot()).toMatchObject({
            total: 10_001,
            invalid: 0,
            dropped: 9_998,
            maxEvents: 2,
        });
        expect(profile.snapshot().events).toHaveLength(2);
        expect(profile.snapshot().events[0]).toMatchObject({
            count: 2,
            timedCount: 1,
            sumMs: 3,
        });
        const capped = createPlacementProfile({ maxEvents: 100_000 });
        expect(capped.snapshot().maxEvents).toBe(128);
        const disabled = createPlacementProfile({ maxEvents: 0 });
        disabled.sink({ name: "valid" });
        expect(disabled.snapshot()).toMatchObject({ dropped: 1, events: [] });
    });

    it("rejects malformed names and ignores unsafe timings without throwing", () => {
        const profile = createPlacementProfile();
        for (const event of [
            null,
            undefined,
            1,
            "event",
            {},
            { name: "" },
            { name: "bad name" },
            { name: "x".repeat(97) },
        ])
            expect(() => profile.sink(event)).not.toThrow();
        for (const durationMs of [-1, Infinity, NaN, Number.MAX_VALUE, "2", 2n])
            profile.sink({ name: "valid", durationMs });
        expect(profile.snapshot()).toMatchObject({
            total: 14,
            invalid: 14,
            dropped: 0,
        });
        expect(profile.snapshot().events).toEqual([
            { name: "valid", count: 6, timedCount: 0, sumMs: 0, maxMs: 0 },
        ]);
    });

    it("never invokes accessors or retains arbitrary payloads", () => {
        let called = 0;
        const profile = createPlacementProfile();
        const trap = () => {
            called++;
            throw new Error("getter");
        };
        profile.sink(Object.defineProperty({}, "name", { get: trap }));
        profile.sink(
            Object.defineProperty({ name: "valid" }, "durationMs", {
                get: trap,
            })
        );
        profile.sink(
            Object.defineProperty({ name: "valid" }, "details", { get: trap })
        );
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        expect(() => profile.sink(proxy)).not.toThrow();
        expect(called).toBe(0);
        expect(profile.snapshot()).toMatchObject({ total: 4, invalid: 3 });
    });

    it("keeps cumulative values finite and marks saturation", () => {
        const profile = createPlacementProfile();
        profile.sink({ name: "event", durationMs: Number.MAX_SAFE_INTEGER });
        profile.sink({ name: "event", durationMs: Number.MAX_SAFE_INTEGER });
        expect(profile.snapshot()).toMatchObject({ saturated: true });
        expect(profile.snapshot().events[0].sumMs).toBe(
            Number.MAX_SAFE_INTEGER
        );
    });

    it("captures only whitelisted slow join-plan primitives and detaches them", () => {
        const profile = createPlacementProfile();
        const event = {
            name: "sharedLog.receive.joinPlan",
            durationMs: 20_000,
            entries: 4,
            count: 3,
            peer: "private-peer",
            details: {
                immediateReplicatingLeaderPlanHits: 0,
                immediateReplicatingLeaderPlans: 2,
                nativeSynchronousJoinPlan: false,
                nativeAllKeptJoinPlan: true,
                payload: { secret: "private-payload" },
            },
        };
        profile.sink(event);
        const first = profile.snapshot();
        expect(first.slowJoinPlan).toEqual({
            thresholdMs: 1_000,
            maxSamples: 8,
            observed: 1,
            dropped: 0,
            invalidFields: 0,
            samples: [
                {
                    durationMs: 20_000,
                    entries: 4,
                    count: 3,
                    details: {
                        immediateReplicatingLeaderPlanHits: 0,
                        immediateReplicatingLeaderPlans: 2,
                        nativeSynchronousJoinPlan: false,
                        nativeAllKeptJoinPlan: true,
                    },
                },
            ],
        });
        expect(first.events[0].count).toBe(1);
        event.details.immediateReplicatingLeaderPlans = 999;
        first.slowJoinPlan.samples[0].details!.nativeAllKeptJoinPlan = false;
        first.slowJoinPlan.samples[0].entries = 999;
        first.slowJoinPlan.samples.push({ durationMs: 9_999 });
        expect(profile.snapshot().slowJoinPlan.samples).toHaveLength(1);
        expect(profile.snapshot().slowJoinPlan.samples[0]).toMatchObject({
            entries: 4,
            details: {
                immediateReplicatingLeaderPlans: 2,
                nativeAllKeptJoinPlan: true,
            },
        });
        expect(JSON.stringify(profile.snapshot())).not.toMatch(
            /private|payload|secret|peer/
        );
    });

    it("retains missing join-plan fields as unknown instead of zero or false", () => {
        const profile = createPlacementProfile();
        profile.sink({
            name: "sharedLog.receive.joinPlan",
            durationMs: 1_000,
        });
        profile.sink({
            name: "sharedLog.receive.joinPlan",
            durationMs: 1_001,
            entries: 2,
            count: 0,
            details: { nativeFastDrop: true },
        });
        profile.sink({
            name: "sharedLog.receive.joinPlan",
            durationMs: 1_002,
            details: Object.create({ nativeSynchronousJoinPlan: false }),
        });
        expect(profile.snapshot().slowJoinPlan).toMatchObject({
            observed: 3,
            invalidFields: 0,
            samples: [
                { durationMs: 1_002 },
                { durationMs: 1_001, entries: 2, count: 0 },
                { durationMs: 1_000 },
            ],
        });
        for (const sample of profile.snapshot().slowJoinPlan.samples)
            expect(sample).not.toHaveProperty("details");
        expect(profile.snapshot().slowJoinPlan.samples[0]).not.toHaveProperty(
            "entries"
        );
    });

    it("bounds slow samples while continuing exact named aggregates", () => {
        const profile = createPlacementProfile();
        for (let i = 0; i < 10_000; i++)
            profile.sink({
                name: "sharedLog.receive.joinPlan",
                durationMs: 1_000 + i,
                entries: i,
                details: { payload: "x".repeat(1_000) },
            });
        const snapshot = profile.snapshot();
        expect(snapshot.slowJoinPlan).toMatchObject({
            observed: 10_000,
            dropped: 9_992,
            invalidFields: 0,
        });
        expect(
            snapshot.slowJoinPlan.samples.map((sample) => sample.entries)
        ).toEqual([9_999, 9_998, 9_997, 9_996, 9_995, 9_994, 9_993, 9_992]);
        expect(snapshot.events[0]).toMatchObject({
            count: 10_000,
            timedCount: 10_000,
            sumMs: 59_995_000,
            maxMs: 10_999,
        });
        expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(4_096);
    });

    it("retains a later slowest span and keeps earlier samples on tied durations", () => {
        const profile = createPlacementProfile();
        for (let entries = 0; entries < 10; entries++)
            profile.sink({
                name: "sharedLog.receive.joinPlan",
                durationMs: 1_000,
                entries,
            });
        profile.sink({
            name: "sharedLog.receive.joinPlan",
            durationMs: 20_000,
            entries: 10,
            details: { immediateReplicatingLeaderPlanHits: 0 },
        });
        expect(profile.snapshot().slowJoinPlan).toMatchObject({
            observed: 11,
            dropped: 3,
        });
        expect(
            profile
                .snapshot()
                .slowJoinPlan.samples.map((sample) => sample.entries)
        ).toEqual([10, 0, 1, 2, 3, 4, 5, 6]);
        expect(profile.snapshot().slowJoinPlan.samples[0]).toMatchObject({
            durationMs: 20_000,
            details: { immediateReplicatingLeaderPlanHits: 0 },
        });
        profile.sink({
            name: "sharedLog.receive.joinPlan",
            durationMs: 1_000,
            entries: Infinity,
        });
        expect(profile.snapshot().slowJoinPlan).toMatchObject({
            observed: 12,
            dropped: 4,
            invalidFields: 1,
        });
    });

    it("requires an admitted matching name and valid slow duration", () => {
        const profile = createPlacementProfile();
        profile.sink({ name: "other", durationMs: 10_000 });
        for (const durationMs of [
            999.999,
            undefined,
            -1,
            Infinity,
            NaN,
            "1000",
        ])
            profile.sink({ name: "sharedLog.receive.joinPlan", durationMs });
        expect(profile.snapshot().slowJoinPlan).toMatchObject({
            observed: 0,
            samples: [],
        });
        const noNames = createPlacementProfile({ maxEvents: 0 });
        noNames.sink({
            name: "sharedLog.receive.joinPlan",
            durationMs: 1_000,
        });
        expect(noNames.snapshot()).toMatchObject({
            dropped: 1,
            slowJoinPlan: { observed: 0, samples: [] },
        });
    });

    it("omits malformed slow fields and never invokes their accessors", () => {
        const profile = createPlacementProfile();
        profile.sink({
            name: "sharedLog.receive.joinPlan",
            durationMs: 1_000,
            entries: -1,
            count: NaN,
            details: {
                immediateReplicatingLeaderPlanHits: 1.5,
                immediateReplicatingLeaderPlans: 2n,
                nativeSynchronousJoinPlan: "false",
                nativeAllKeptJoinPlan: 0,
            },
        });
        let called = 0;
        const getter = () => {
            called++;
            throw new Error("must not call");
        };
        profile.sink(
            Object.defineProperties(
                { name: "sharedLog.receive.joinPlan", durationMs: 1_001 },
                {
                    entries: { get: getter },
                    count: { get: getter },
                    details: { get: getter },
                }
            )
        );
        profile.sink({
            name: "sharedLog.receive.joinPlan",
            durationMs: 1_002,
            details: Object.defineProperty({}, "nativeAllKeptJoinPlan", {
                get: getter,
            }),
        });
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        expect(() =>
            profile.sink({
                name: "sharedLog.receive.joinPlan",
                durationMs: 1_003,
                details: proxy,
            })
        ).not.toThrow();
        profile.sink({
            name: "sharedLog.receive.joinPlan",
            durationMs: 1_004,
            details: null,
        });
        expect(called).toBe(0);
        expect(profile.snapshot()).toMatchObject({
            invalid: 0,
            slowJoinPlan: {
                observed: 5,
                invalidFields: 15,
                samples: [
                    { durationMs: 1_004 },
                    { durationMs: 1_003 },
                    { durationMs: 1_002 },
                    { durationMs: 1_001 },
                    { durationMs: 1_000 },
                ],
            },
        });
        expect(() => JSON.stringify(profile.snapshot())).not.toThrow();
    });
});

describe("bounded placement error evidence", () => {
    it("preserves commit facts, nested causes and aggregate failures", () => {
        const cause = new TypeError("transport failed");
        const error = Object.assign(new Error("receipt failed", { cause }), {
            localCommitSucceeded: true,
            retrySafe: false,
            nativeCommitApplied: true,
            committedHashes: ["entry-a"],
            committedCids: ["cid-a"],
            failedCids: ["cid-b"],
            peer: "do-not-copy",
        });
        const result = errorInfo(
            new AggregateError([error], "cleanup also failed")
        );
        expect(result).toMatchObject({
            name: "AggregateError",
            message: "cleanup also failed",
            errors: [
                {
                    name: "Error",
                    message: "receipt failed",
                    localCommitSucceeded: true,
                    retrySafe: false,
                    nativeCommitApplied: true,
                    committedHashes: ["entry-a"],
                    committedCids: ["cid-a"],
                    failedCids: ["cid-b"],
                    cause: { name: "TypeError", message: "transport failed" },
                },
            ],
        });
        expect(result.errors![0].stack).toContain("receipt failed");
        expect(JSON.stringify(result)).not.toContain("do-not-copy");
        result.errors![0].committedHashes!.push("changed");
        expect(error.committedHashes).toEqual(["entry-a"]);
    });

    it("caps commit arrays and aggregate members with explicit omissions", () => {
        const result = errorInfo({
            committedHashes: Array.from({ length: 40 }, (_, i) => `hash-${i}`),
            committedHashesOmitted: 2,
            failedCids: ["valid", 4, {}],
            errors: Array.from({ length: 20 }, () => "child"),
        });
        expect(result.committedHashes).toHaveLength(16);
        expect(result.committedHashesOmitted).toBe(26);
        expect(result.failedCids).toEqual(["valid"]);
        expect(result.failedCidsOmitted).toBe(2);
        expect(result.errors).toHaveLength(4);
        expect(result.errorsOmitted).toBe(16);
    });

    it("retains detached remote causes and their existing omission evidence", () => {
        const remote = {
            name: "PersistedDeliveryError",
            message: "remote failure",
            stack: "remote stack",
            localCommitSucceeded: true,
            retrySafe: false,
            committedHashes: ["hash-a"],
            committedHashesOmitted: 5,
            truncated: ["stack", "private arbitrary payload"],
        };
        const result = errorInfo(new Error("worker failed", { cause: remote }));
        expect(result.cause).toMatchObject({
            ...remote,
            truncated: ["stack"],
        });
        expect(JSON.stringify(result)).not.toContain(
            "private arbitrary payload"
        );
    });

    it("terminates cycles and deep causes, without mislabeling shared siblings", () => {
        const cycle: any = new Error("cycle");
        cycle.cause = cycle;
        cycle.errors = [cycle];
        expect(errorInfo(cycle).cause?.truncated).toContain("cycle");
        const deep: any = {};
        let current = deep;
        for (let i = 0; i < 100; i++) current = current.cause = {};
        expect(JSON.stringify(errorInfo(deep))).toContain("depth");
        const shared = new Error("shared");
        expect(
            errorInfo({ errors: [shared, shared] }).errors?.map(
                (child) => child.message
            )
        ).toEqual(["shared", "shared"]);
    });

    it("handles hostile getters, proxies and non-JSON-safe values", () => {
        let called = 0;
        const hostile = Object.defineProperties(
            {},
            {
                name: {
                    get: () => {
                        called++;
                        throw new Error("do not call");
                    },
                },
                cause: {
                    get: () => {
                        called++;
                        throw new Error("do not call");
                    },
                },
                stack: {
                    get: () => {
                        called++;
                        throw new Error("do not call");
                    },
                },
            }
        );
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        for (const value of [
            hostile,
            proxy,
            2n,
            Symbol("private"),
            () => {},
            undefined,
        ]) {
            expect(() => JSON.stringify(errorInfo(value))).not.toThrow();
        }
        expect(called).toBe(0);
        expect(errorInfo(hostile).truncated).toContain("name:unreadable");
        expect(
            errorInfo({ retrySafe: "false", nativeCommitApplied: 1 }).retrySafe
        ).toBeUndefined();
    });

    it("bounds serialized output even for deeply branching escape-heavy errors", () => {
        const build = (depth: number): any => ({
            name: "\u0000".repeat(1_000),
            message: "\u0000".repeat(20_000),
            stack: "\u0000".repeat(20_000),
            committedHashes: Array(100).fill("\u0000".repeat(1_000)),
            ...(depth
                ? {
                      cause: build(depth - 1),
                      errors: Array(4).fill(build(depth - 1)),
                  }
                : {}),
        });
        const result = errorInfo(build(4));
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
            128 * 1_024
        );
        expect(JSON.stringify(result)).toContain("truncated");
        expect(JSON.stringify(result)).toContain("nodes");
    });
});
