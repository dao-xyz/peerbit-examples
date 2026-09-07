import { performance } from "node:perf_hooks";
import { StringMatch } from "@peerbit/document";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SparseQueryScanProfile } from "./sparse-query-scan-profile.js";

type Entries = Parameters<SparseQueryScanProfile["wrap"]>[0];
type Options = NonNullable<Parameters<Entries["index"]["iterate"]>[1]>;
type Config = ConstructorParameters<typeof SparseQueryScanProfile>[0];
let now = 0;
beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

const source = "public-source-hash";
const request = {
    query: [new StringMatch({ key: "id", value: "private-chunk-id" })],
};
const options: Options = {
    local: false,
    remote: { from: [source], replicate: false },
};
const fixture = () => {
    const row = new Proxy(
        {},
        {
            get() {
                throw new Error("Payload inspected");
            },
        }
    );
    const iterators: Array<ReturnType<typeof makeIterator>> = [];
    const receivers: unknown[] = [];
    const makeIterator = (supplied?: Options) => ({
        done() {
            return true;
        },
        next: vi.fn(async function (this: unknown, _amount: number) {
            receivers.push(this);
            now += 2;
            const remote = supplied?.remote;
            if (typeof remote === "object")
                remote.onResponse?.(
                    row as never,
                    { hashcode: () => source } as never
                );
            return [row];
        }),
        close: vi.fn(async function (this: unknown) {
            receivers.push(this);
            now++;
        }),
    });
    const index = {
        identify() {
            return this;
        },
        iterate: vi.fn(function (
            this: unknown,
            _request: unknown,
            supplied?: Options
        ) {
            receivers.push(this);
            now++;
            const iterator = makeIterator(supplied);
            iterators.push(iterator);
            return iterator;
        }),
    };
    const entries = { index };
    return {
        entries: entries as unknown as Entries,
        index,
        iterators,
        receivers,
        row,
    };
};
const query = async (entries: Entries) => {
    const iterator = entries.index.iterate(request, options);
    await iterator.next(8);
    await iterator.close();
};
const transportFixture = () => {
    const counters = {
        preArmIgnored: 0,
        topicIgnored: 0,
        eventsDropped: 0,
        idsDropped: 0,
        malformed: 0,
        duplicates: 0,
        captureErrors: 0,
    };
    const snapshot = () => ({
        clockOriginMs: 0,
        events: [],
        counters: { ...counters },
    });
    const takeWindow = vi.fn(snapshot);
    return {
        takeWindow,
        snapshot,
        asTransport: { takeWindow, snapshot } as unknown as Config["transport"],
    };
};
const make = (config: Partial<Config> = {}) => {
    const original = fixture();
    const profile = new SparseQueryScanProfile({ source, ...config });
    const wrapped = profile.wrap(original.entries);
    profile.begin();
    return { ...original, profile, wrapped };
};

describe("test-only bounded sparse scan profile", () => {
    it("uses the optional pre-begin facade once, original entries outside windows and one active wrapper", async () => {
        const original = fixture();
        const initial = fixture();
        const profile = new SparseQueryScanProfile({ source });
        const wrapped = profile.wrap(original.entries, initial.entries);
        const early = wrapped.index.iterate(request, options);
        expect(early).toBe(initial.iterators[0]);
        expect(original.index.iterate).not.toHaveBeenCalled();
        profile.begin();
        const outside = wrapped.index.iterate(request, options);
        expect(outside).toBe(original.iterators[0]);
        expect(original.index.iterate.mock.calls[0][1]).toBe(options);
        await profile.measure(1, async () => {
            const active = wrapped.index.iterate(request, options);
            const rows = await active.next(8);
            expect(rows[0]).toBe(original.row);
            await active.close();
            expect(active.done()).toBe(true);
        });
        expect(initial.index.iterate).toHaveBeenCalledTimes(1);
        expect(original.index.iterate).toHaveBeenCalledTimes(2);
        expect(original.receivers).toEqual([
            original.index,
            original.index,
            original.iterators[1],
            original.iterators[1],
        ]);
        expect(options.remote).not.toHaveProperty("onResponse");
        expect(original.index.iterate.mock.calls[1][1]).toMatchObject(options);
        profile.stop();
    });

    it("binds an iterator to its creation window instead of a later active window", async () => {
        const test = make();
        let old!: ReturnType<Entries["index"]["iterate"]>;
        await test.profile.measure(1, async () => {
            old = test.wrapped.index.iterate(request, options);
        });
        const first = test.profile.snapshot();
        await test.profile.measure(2, async () => {
            await old.next(8);
            await old.close();
        });
        const snapshot = test.profile.snapshot();
        expect(
            snapshot.windows.find((window) => window.ordinal === 1)?.phase
        ).toEqual(first.windows[0].phase);
        expect(
            snapshot.windows
                .find((window) => window.ordinal === 2)
                ?.phase?.events.map((event) => event.phase)
        ).toEqual(["operation.start", "operation.end"]);
        expect(snapshot.aggregates["chunk-id"]).toMatchObject({
            queries: 1,
            nextCalls: 0,
            closeCalls: 0,
        });
        test.profile.stop();
    });

    it("drains preamble once at begin and one temporal transport window per measured file", async () => {
        const transport = transportFixture();
        const test = make({ transport: transport.asTransport });
        expect(transport.takeWindow).toHaveBeenCalledTimes(1);
        await test.profile.measure(1, async () => query(test.wrapped));
        await test.profile.measure(2, async () => query(test.wrapped));
        expect(transport.takeWindow).toHaveBeenCalledTimes(3);
        expect(test.profile.snapshot().preamble).toMatchObject({
            eventCount: 0,
        });
        test.profile.stop();
    });

    it("preserves a successful value if transport diagnostic draining throws", async () => {
        const transport = transportFixture();
        const test = make({ transport: transport.asTransport });
        transport.takeWindow.mockImplementationOnce(() => {
            throw new Error("Diagnostic drain failure");
        });
        const value = {};
        expect(await test.profile.measure(1, async () => value)).toBe(value);
        expect(test.profile.snapshot().counters.diagnosticErrors).toBe(1);
        test.profile.stop();
    });

    it("preserves undefined application rejection even when diagnostic draining also throws", async () => {
        const transport = transportFixture();
        const test = make({ transport: transport.asTransport });
        transport.takeWindow.mockImplementationOnce(() => {
            throw new Error("Diagnostic drain failure");
        });
        let rejected = false;
        let reason: unknown = "not-rejected";
        try {
            await test.profile.measure(1, async () => {
                throw undefined;
            });
        } catch (error) {
            rejected = true;
            reason = error;
        }
        expect(rejected).toBe(true);
        expect(reason).toBeUndefined();
        expect(test.profile.snapshot()).toMatchObject({
            firstFailure: {
                ordinal: 1,
                outcome: "rejected",
                rejectionType: "undefined",
            },
            counters: { failedWindows: 1, diagnosticErrors: 1 },
        });
        test.profile.stop();
    });

    it("rejects overlapping and nested windows without running either extra callback", async () => {
        const test = make();
        let release!: () => void;
        const wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        const nested = vi.fn(async () => {});
        const running = test.profile.measure(1, async () => {
            await expect(test.profile.measure(2, nested)).rejects.toThrow();
            await wait;
        });
        const overlapping = vi.fn(async () => {});
        await expect(test.profile.measure(3, overlapping)).rejects.toThrow();
        release();
        await running;
        expect(nested).not.toHaveBeenCalled();
        expect(overlapping).not.toHaveBeenCalled();
        test.profile.stop();
    });

    it("freezes capture on stop while preserving original outside-window iteration", async () => {
        const test = make();
        await test.profile.measure(1, async () => query(test.wrapped));
        test.profile.stop();
        const snapshot = test.profile.snapshot();
        await query(test.wrapped);
        test.profile.stop();
        expect(test.profile.snapshot()).toEqual(snapshot);
        const callback = vi.fn(async () => {});
        await expect(test.profile.measure(2, callback)).rejects.toThrow();
        expect(callback).not.toHaveBeenCalled();
    });

    it("returns detached serializable snapshots without retaining predicates or payloads", async () => {
        const test = make();
        await test.profile.measure(1, async () => query(test.wrapped));
        const snapshot = test.profile.snapshot();
        const original = JSON.stringify(snapshot);
        expect(original).not.toContain("private-chunk-id");
        const mutate = (value: unknown): void => {
            if (!value || typeof value !== "object") return;
            for (const key of Object.keys(value)) {
                const record = value as Record<string, unknown>;
                if (typeof record[key] === "number") record[key] = -999;
                else mutate(record[key]);
            }
        };
        mutate(snapshot);
        expect(JSON.stringify(test.profile.snapshot())).toBe(original);
        test.profile.stop();
    });

    it("retains top K with stable ties while aggregating every completed window", async () => {
        const test = make({ maxWindows: 2 });
        for (const [ordinal, extra] of [
            [1, 6],
            [2, 6],
            [3, 1],
        ]) {
            await test.profile.measure(ordinal, async () => {
                await query(test.wrapped);
                now += extra;
            });
        }
        const snapshot = test.profile.snapshot();
        expect(
            snapshot.windows.map(({ ordinal, durationMs }) => [
                ordinal,
                durationMs,
            ])
        ).toEqual([
            [1, 10],
            [2, 10],
        ]);
        expect(snapshot.counters.completedWindows).toBe(3);
        expect(snapshot.aggregates["chunk-id"]).toEqual({
            queries: 3,
            nextCalls: 3,
            nextTotalMs: 6,
            nextMaxMs: 2,
            nextBuckets: [0, 3, 0, 0, 0],
            nextRejected: 0,
            closeCalls: 3,
            closeRejected: 0,
        });
        test.profile.stop();
    });

    it("retains the first application failure even after it leaves the slowest windows", async () => {
        const test = make({ maxWindows: 1 });
        const first = new Error("Original application failure");
        await expect(
            test.profile.measure(1, async () => {
                now++;
                throw first;
            })
        ).rejects.toBe(first);
        await expect(
            test.profile.measure(2, async () => {
                now += 20;
                throw null;
            })
        ).rejects.toBeNull();
        await test.profile.measure(3, async () => {
            now += 30;
        });
        const snapshot = test.profile.snapshot();
        expect(snapshot.windows.map((window) => window.ordinal)).toEqual([3]);
        expect(snapshot.firstFailure).toMatchObject({
            ordinal: 1,
            durationMs: 1,
            outcome: "rejected",
            rejectionType: "object",
        });
        expect(JSON.stringify(snapshot)).not.toContain(first.message);
        expect(snapshot.counters).toMatchObject({
            completedWindows: 3,
            failedWindows: 2,
        });
        test.profile.stop();
    });

    it("reports phase truncation instead of claiming complete aggregate coverage", async () => {
        const test = make();
        await test.profile.measure(1, async () => {
            const iterator = test.wrapped.index.iterate(request, options);
            for (let i = 0; i < 100; i++) await iterator.next(8);
            await iterator.close();
        });
        const snapshot = test.profile.snapshot();
        expect(snapshot.windows[0].phase?.events).toHaveLength(128);
        expect(snapshot.counters.phaseDropped).toBeGreaterThan(0);
        expect(snapshot.counters.phaseDropped).toBe(
            snapshot.windows[0].phase?.dropped
        );
        expect(snapshot.aggregates["chunk-id"].nextCalls).toBeLessThan(100);
        test.profile.stop();
    });

    it("reports phase observer errors without masking successful query completion", async () => {
        const test = make();
        await test.profile.measure(1, async () => {
            const iterator = test.wrapped.index.iterate(request, options);
            const remote = test.index.iterate.mock.calls[0][1]?.remote;
            if (typeof remote !== "object")
                throw new Error("Missing remote hook");
            remote.onResponse?.(
                test.row as never,
                {
                    hashcode() {
                        throw undefined;
                    },
                } as never
            );
            await iterator.next(8);
            await iterator.close();
        });
        expect(test.profile.snapshot().counters).toMatchObject({
            completedWindows: 1,
            failedWindows: 0,
            phaseObserverErrors: 1,
        });
        test.profile.stop();
    });

    it("distinguishes logical queries from next pages and retains rejection counts", async () => {
        const test = make();
        const nextError = new Error("Page failed");
        const closeError = new Error("Close failed");
        await test.profile.measure(1, async () => {
            const iterator = test.wrapped.index.iterate(request, options);
            await iterator.next(8);
            test.iterators[0].next.mockImplementationOnce(async () => {
                now += 20;
                throw nextError;
            });
            test.iterators[0].close.mockImplementationOnce(async () => {
                throw closeError;
            });
            await expect(iterator.next(8)).rejects.toBe(nextError);
            await expect(iterator.close()).rejects.toBe(closeError);
        });
        expect(test.profile.snapshot().aggregates["chunk-id"]).toEqual({
            queries: 1,
            nextCalls: 2,
            nextTotalMs: 22,
            nextMaxMs: 20,
            nextBuckets: [0, 1, 1, 0, 0],
            nextRejected: 1,
            closeCalls: 1,
            closeRejected: 1,
        });
        test.profile.stop();
    });

    it("validates options, ordinals and lifecycle while allowing zero retained slow windows", async () => {
        for (const maxWindows of [-1, 0.5, NaN, Infinity, 9])
            expect(
                () => new SparseQueryScanProfile({ source, maxWindows })
            ).toThrow();
        for (const invalidSource of ["", " ", "x".repeat(129)])
            expect(
                () => new SparseQueryScanProfile({ source: invalidSource })
            ).toThrow();
        const profile = new SparseQueryScanProfile({ source, maxWindows: 0 });
        await expect(profile.measure(1, async () => {})).rejects.toThrow();
        profile.begin();
        expect(() => profile.begin()).toThrow();
        for (const ordinal of [0, -1, 0.5, NaN, Infinity])
            await expect(
                profile.measure(ordinal, async () => {})
            ).rejects.toThrow();
        await profile.measure(1, async () => {});
        await expect(
            profile.measure(2, async () => {
                throw undefined;
            })
        ).rejects.toBeUndefined();
        expect(profile.snapshot().windows).toEqual([]);
        expect(profile.snapshot().firstFailure?.ordinal).toBe(2);
        expect(profile.snapshot().counters.completedWindows).toBe(2);
        profile.stop();
    });

    it("records a preamble drain failure and continues the application with visible diagnostics", async () => {
        const transport = transportFixture();
        transport.takeWindow.mockImplementationOnce(() => {
            throw undefined;
        });
        const test = make({ transport: transport.asTransport });
        expect(test.profile.snapshot().counters.diagnosticErrors).toBe(1);
        expect(test.profile.snapshot().preamble).toBeUndefined();
        await test.profile.measure(1, async () => query(test.wrapped));
        expect(test.profile.snapshot()).toMatchObject({
            counters: {
                diagnosticErrors: 1,
                completedWindows: 1,
                failedWindows: 0,
            },
        });
        test.profile.stop();
    });
});
