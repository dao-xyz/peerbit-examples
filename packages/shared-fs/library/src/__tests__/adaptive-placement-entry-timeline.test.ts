import { describe, expect, it, vi } from "vitest";
import {
    createPlacementEntryTimeline,
    type PlacementEntryContext,
} from "./adaptive-placement-entry-timeline.js";
import type { PlacementErrorInfo } from "./adaptive-placement-telemetry.js";

const context = (
    changes: Partial<PlacementEntryContext> = {}
): PlacementEntryContext => ({
    request: 7,
    plane: "chunks",
    file: 3,
    part: 0,
    documentId: "chunk-id",
    bytes: 4096,
    logAddress: "chunk-log",
    requestedMinAcks: 3,
    ...changes,
});
const fixture = () => {
    let time = 10;
    return createPlacementEntryTimeline({ now: () => time++ });
};

describe("synchronous bounded entry timeline", () => {
    it("records exact ordered context, fulfilled hash, rejection facts and a pending span", () => {
        const timeline = fixture();
        const first = context();
        timeline.begin(first);
        expect(timeline.snapshot().records[0]).toEqual({
            seq: 1,
            status: "pending",
            invocationAtMs: 10,
            context: first,
        });
        timeline.fulfilled()?.(() => "committed-chunk");
        const second = context({
            plane: "metadata",
            part: undefined,
            documentId: "/file-3",
            logAddress: "metadata-log",
            bytes: 16384,
        });
        timeline.begin(second);
        timeline.rejected({
            name: "PersistedDeliveryError",
            message: "receipt unavailable",
            localCommitSucceeded: true,
            retrySafe: false,
            committedHashes: ["committed-meta"],
            stack: "must not retain",
            cause: { name: "Error", message: "must not retain" },
        });
        timeline.begin(context({ request: 8, file: 4 }));
        const result = timeline.snapshot();
        expect(result.schema).toBe(1);
        expect(result.clock).toBe("writer-process.performance.now");
        expect(result.records.map(({ seq, status }) => [seq, status])).toEqual([
            [1, "fulfilled"],
            [2, "rejected"],
            [3, "pending"],
        ]);
        expect(result.records[0]).toMatchObject({
            resultAtMs: 11,
            elapsedMs: 1,
            committedEntryHash: "committed-chunk",
        });
        expect(result.records[1]).toEqual({
            seq: 2,
            status: "rejected",
            invocationAtMs: 12,
            resultAtMs: 13,
            elapsedMs: 1,
            context: { ...second },
            failure: {
                name: "PersistedDeliveryError",
                message: "receipt unavailable",
                localCommitSucceeded: true,
                retrySafe: false,
                committedHashes: ["committed-meta"],
            },
        });
        expect(result.records[2]).not.toHaveProperty("resultAtMs");
        expect(result.invalid).toBe(0);
        expect(result.omitted).toBe(0);
    });

    it("detaches input and every nested snapshot field", () => {
        const timeline = fixture();
        const input = context();
        const evidence = {
            name: "Error",
            message: "original",
            committedHashes: ["hash"],
        };
        timeline.begin(input);
        input.documentId = "changed";
        timeline.rejected(evidence);
        evidence.committedHashes[0] = "changed";
        const snapshot = timeline.snapshot();
        snapshot.records[0].context.documentId = "changed-again";
        snapshot.records[0].failure!.committedHashes!.push("extra");
        snapshot.records[0].failure!.message = "changed";
        snapshot.records.length = 0;
        expect(timeline.snapshot().records[0]).toMatchObject({
            context: { documentId: "chunk-id" },
            failure: { message: "original", committedHashes: ["hash"] },
        });
    });

    it("keeps all first128 spans and never settles a prior span on overflow", () => {
        const timeline = fixture();
        for (let i = 0; i < 128; i++) {
            timeline.begin(context({ file: i }));
            timeline.fulfilled()?.(() => `hash-${i}`);
        }
        const original = timeline.snapshot().records;
        for (let i = 0; i < 1000; i++) {
            timeline.begin(context({ file: 128 + i }));
            if (i % 2) expect(timeline.fulfilled()).toBeUndefined();
            else timeline.rejected({ name: "Error", message: "overflow" });
        }
        expect(timeline.snapshot()).toMatchObject({
            records: original,
            omitted: 1000,
            invalid: 0,
        });
        expect(timeline.snapshot().records).toHaveLength(128);
        timeline.begin(context());
        timeline.begin(context());
        expect(timeline.fulfilled()).toBeUndefined();
        expect(timeline.snapshot()).toMatchObject({
            omitted: 1001,
            invalid: 1,
            records: original,
        });
    });

    it("does not relabel pending context on a second begin", () => {
        const timeline = fixture();
        timeline.begin(context());
        timeline.begin(context({ request: 99, documentId: "different" }));
        expect(timeline.snapshot().records).toHaveLength(1);
        expect(timeline.snapshot().records[0]).toMatchObject({
            status: "pending",
            context: context(),
        });
        timeline.fulfilled()?.(() => "original");
        expect(timeline.snapshot().invalid).toBe(1);
        expect(timeline.fulfilled()).toBeUndefined();
        timeline.rejected({ name: "Error", message: "unowned" });
        expect(timeline.snapshot().invalid).toBe(2);
    });

    it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, "bad"])(
        "keeps outcomes when clock returns invalid %s",
        (value) => {
            const timeline = createPlacementEntryTimeline({
                now: () => value as number,
            });
            expect(() => {
                timeline.begin(context());
                timeline.fulfilled()?.(() => "hash");
            }).not.toThrow();
            expect(timeline.snapshot()).toMatchObject({
                invalid: 2,
                records: [
                    {
                        status: "fulfilled",
                        invocationAtMs: null,
                        resultAtMs: null,
                        elapsedMs: null,
                        committedEntryHash: "hash",
                    },
                ],
            });
        }
    );

    it("contains thrown clocks and backward time", () => {
        const now = vi
            .fn()
            .mockImplementationOnce(() => {
                throw undefined;
            })
            .mockReturnValueOnce(12)
            .mockReturnValueOnce(20)
            .mockReturnValueOnce(19);
        const timeline = createPlacementEntryTimeline({ now });
        expect(() => {
            timeline.begin(context());
            timeline.rejected({ name: "Error", message: "original" });
            timeline.begin(context());
            timeline.fulfilled()?.(() => "hash");
        }).not.toThrow();
        expect(timeline.snapshot().records[0]).toMatchObject({
            status: "rejected",
            invocationAtMs: null,
            resultAtMs: 12,
            elapsedMs: null,
        });
        expect(timeline.snapshot().records[1]).toMatchObject({
            status: "fulfilled",
            invocationAtMs: 20,
            resultAtMs: null,
            elapsedMs: null,
        });
        expect(timeline.snapshot().invalid).toBe(2);
    });

    it.each([undefined, "", "x".repeat(513), 42, {}])(
        "does not turn fulfilled status into failure for invalid hash %s",
        (hash) => {
            const timeline = fixture();
            timeline.begin(context());
            timeline.fulfilled()?.(() => hash);
            expect(timeline.snapshot().records[0].status).toBe("fulfilled");
            expect(timeline.snapshot().records[0]).not.toHaveProperty(
                "committedEntryHash"
            );
            expect(timeline.snapshot().invalid).toBe(1);
        }
    );

    it("bounds failure text and exact hashes while carrying omitted evidence", () => {
        const timeline = fixture();
        timeline.begin(context());
        timeline.rejected({
            name: "n".repeat(600),
            message: "m".repeat(600),
            committedHashes: [
                "",
                ...Array.from({ length: 20 }, (_, i) => `hash-${i}`),
            ],
            committedHashesOmitted: 10,
        });
        const result = timeline.snapshot();
        expect(result.records[0].failure).toEqual({
            name: "n".repeat(512),
            message: "m".repeat(512),
            committedHashes: Array.from({ length: 7 }, (_, i) => `hash-${i}`),
            committedHashesOmitted: 24,
        });
        expect(result.invalid).toBe(3);
        expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("timestamps before extraction, invokes the callback once and never overwrites evidence", () => {
        let time = 10;
        const timeline = createPlacementEntryTimeline({ now: () => time });
        timeline.begin(context());
        time = 12;
        const capture = timeline.fulfilled()!;
        const extract = vi.fn(() => {
            time = 99;
            return "hash";
        });
        capture(extract);
        capture(extract);
        expect(extract).toHaveBeenCalledTimes(1);
        expect(timeline.snapshot().records[0]).toMatchObject({
            status: "fulfilled",
            resultAtMs: 12,
            elapsedMs: 2,
            committedEntryHash: "hash",
        });
        expect(timeline.snapshot().invalid).toBe(1);
    });

    it("binds delayed evidence to the old span and contains extraction faults", () => {
        const timeline = fixture();
        timeline.begin(context());
        const first = timeline.fulfilled()!;
        timeline.begin(context({ request: 8 }));
        first(() => "first-hash");
        const second = timeline.fulfilled()!;
        expect(() =>
            second(() => {
                throw undefined;
            })
        ).not.toThrow();
        const before = timeline.snapshot();
        timeline.rejected({ name: "Error", message: "later IPC failure" });
        expect(timeline.snapshot()).toEqual(before);
        expect(before.records[0].committedEntryHash).toBe("first-hash");
        expect(before.records[1]).toMatchObject({ status: "fulfilled" });
        expect(before.records[1]).not.toHaveProperty("committedEntryHash");
        expect(before.invalid).toBe(1);
    });

    it("never invokes hostile error/context accessors or inspects stacks and causes", () => {
        const getter = vi.fn(() => {
            throw new Error("must not run");
        });
        const timeline = fixture();
        timeline.begin(
            Object.defineProperty(context(), "documentId", { get: getter })
        );
        expect(timeline.snapshot().records).toHaveLength(0);
        timeline.begin(context());
        const evidence = Object.defineProperties(
            {},
            Object.fromEntries(
                [
                    "name",
                    "message",
                    "localCommitSucceeded",
                    "retrySafe",
                    "committedHashes",
                    "stack",
                    "cause",
                ].map((key) => [key, { get: getter }])
            )
        );
        expect(() =>
            timeline.rejected(evidence as PlacementErrorInfo)
        ).not.toThrow();
        expect(timeline.snapshot().records[0]).toMatchObject({
            status: "rejected",
            failure: {},
        });
        expect(getter).not.toHaveBeenCalled();
        expect(timeline.snapshot().invalid).toBeGreaterThan(0);
    });

    it("contains revoked proxies and malformed array lengths", () => {
        const revoked = Proxy.revocable([], {});
        revoked.revoke();
        const timeline = fixture();
        timeline.begin(context());
        expect(() =>
            timeline.rejected({
                name: "Error",
                message: "original",
                committedHashes: revoked.proxy,
            })
        ).not.toThrow();
        timeline.begin(context());
        timeline.rejected({
            name: "Error",
            message: "other",
            committedHashes: new Proxy([], {
                getOwnPropertyDescriptor: () => {
                    throw undefined;
                },
            }),
        });
        expect(
            timeline.snapshot().records.map((r) => r.failure?.message)
        ).toEqual(["original", "other"]);
        expect(timeline.snapshot().invalid).toBeGreaterThan(0);
    });

    it.each([
        { request: 0 },
        { request: NaN },
        { plane: "other" },
        { file: -1 },
        { part: 0.5 },
        { documentId: "" },
        { documentId: "x".repeat(513) },
        { bytes: Infinity },
        { logAddress: "" },
        { requestedMinAcks: 1 },
    ])("rejects invalid context before creating a span: %j", (changes) => {
        const timeline = fixture();
        expect(() =>
            timeline.begin(context(changes as Partial<PlacementEntryContext>))
        ).not.toThrow();
        expect(timeline.snapshot()).toMatchObject({
            records: [],
            omitted: 0,
            invalid: 1,
        });
    });

    it("accepts boundary context values and bounds a full ASCII snapshot", () => {
        const timeline = fixture();
        for (let i = 0; i < 128; i++) {
            timeline.begin(
                context({
                    request: Number.MAX_SAFE_INTEGER,
                    file: 0,
                    part: 0,
                    bytes: 0,
                    requestedMinAcks: 2,
                    documentId: "d".repeat(512),
                    logAddress: "l".repeat(512),
                })
            );
            timeline.rejected({
                name: "n".repeat(512),
                message: "m".repeat(512),
                committedHashes: Array(8).fill("h".repeat(512)),
                committedHashesOmitted: Number.MAX_SAFE_INTEGER,
            });
        }
        const result = timeline.snapshot();
        expect(result.invalid).toBe(0);
        expect(JSON.stringify(result).length).toBeLessThan(850_000);
        expect(result.records[0].failure?.committedHashesOmitted).toBe(
            Number.MAX_SAFE_INTEGER
        );
    });

    it("bounds JSON escaping expansion without dropping the first evidence", () => {
        const timeline = fixture();
        const escaped = "\u0000".repeat(512);
        for (let i = 0; i < 128; i++) {
            timeline.begin(
                context({ documentId: escaped, logAddress: escaped })
            );
            timeline.rejected({
                name: escaped,
                message: escaped,
                committedHashes: Array(8).fill(escaped),
            });
        }
        const snapshot = timeline.snapshot();
        expect(snapshot.records).toHaveLength(128);
        expect(snapshot.invalid).toBe(0);
        const json = JSON.stringify(snapshot);
        // Each retained UTF-16 code unit can expand to six JSON characters.
        expect(json.length).toBeLessThan(4_800_000);
        expect(JSON.parse(json).records[0].failure.message).toBe(escaped);
    });

    it("settles before the single original entry access without masking its failure", () => {
        const timeline = fixture();
        const originalError = new Error("entry materialization failed");
        const getter = vi.fn(() => {
            throw originalError;
        });
        const result = {
            get entry(): { hash: string } {
                return getter();
            },
        };
        timeline.begin(context());
        const captureHash = timeline.fulfilled();
        expect(getter).not.toHaveBeenCalled();
        let observed: unknown;
        try {
            const entry = result.entry;
            captureHash?.(() => entry.hash);
        } catch (error) {
            observed = error;
            timeline.rejected({
                name: originalError.name,
                message: originalError.message,
            });
        }
        expect(observed).toBe(originalError);
        expect(getter).toHaveBeenCalledTimes(1);
        expect(timeline.snapshot().records[0]).toMatchObject({
            status: "fulfilled",
        });
        expect(timeline.snapshot().records[0]).not.toHaveProperty(
            "committedEntryHash"
        );
        expect(timeline.snapshot().invalid).toBe(0);
    });
});
