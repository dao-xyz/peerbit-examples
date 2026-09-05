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
