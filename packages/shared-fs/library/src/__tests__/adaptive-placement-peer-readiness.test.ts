import { Ed25519PublicKey, type PublicSignKey } from "@peerbit/crypto";
import type { PersistedReceiptPeerReadiness } from "@peerbit/shared-log";
import { describe, expect, it, vi } from "vitest";
import {
    capturePlacementPeerReadiness,
    type PlacementPeerReadinessInput,
} from "./adaptive-placement-peer-readiness.js";

const candidate = (peer: number) => ({
    peer,
    key: new Ed25519PublicKey({ publicKey: new Uint8Array(32).fill(peer) }),
});
const ready = (): PersistedReceiptPeerReadiness => ({
    status: "ready",
    generation: "generation-1",
});
const fixture = () => {
    const chunks = {
        address: "chunks-log",
        getPersistedReceiptPeerReadiness: vi.fn(async () => ready()),
    };
    const metadata = {
        address: "metadata-log",
        getPersistedReceiptPeerReadiness: vi.fn(async () => ready()),
    };
    const input: PlacementPeerReadinessInput = {
        observerHash: "observer",
        candidates: [candidate(1), candidate(2)],
        logs: [
            {
                plane: "chunks",
                log: chunks,
                committedEntryHash: "committed-chunk",
            },
            { plane: "metadata", log: metadata },
        ],
    };
    return { input, chunks, metadata };
};
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};

describe("bounded placement peer readiness", () => {
    it("preserves actual keys and receivers and passes exactly diagnostic-only options", async () => {
        const { input, chunks, metadata } = fixture();
        const records = await capturePlacementPeerReadiness(input);
        expect(records).toHaveLength(4);
        for (const log of [chunks, metadata]) {
            expect(log.getPersistedReceiptPeerReadiness).toHaveBeenCalledTimes(
                2
            );
            input.candidates.forEach(({ key }, index) => {
                const call = log.getPersistedReceiptPeerReadiness.mock.calls[
                    index
                ] as unknown[];
                expect(call).toHaveLength(2);
                expect(call[0]).toBe(key);
                expect(call[1]).toEqual({ diagnostics: true });
                expect(Object.keys(call[1] as object)).toEqual(["diagnostics"]);
                expect(
                    log.getPersistedReceiptPeerReadiness.mock.contexts[index]
                ).toBe(log);
            });
        }
        expect(records.map(({ peer, plane }) => [peer, plane])).toEqual([
            [1, "chunks"],
            [1, "metadata"],
            [2, "chunks"],
            [2, "metadata"],
        ]);
        records.forEach((record) => {
            expect(record.observerHash).toBe("observer");
            expect(record.remoteHash).toBe(
                input.candidates
                    .find(({ peer }) => peer === record.peer)!
                    .key.hashcode()
            );
            expect(record.logAddress).toBe(`${record.plane}-log`);
            if (record.plane === "chunks")
                expect(record.committedEntryHash).toBe("committed-chunk");
            else expect(record).not.toHaveProperty("committedEntryHash");
        });
    });

    it.each([
        [
            "too many candidates",
            (input: PlacementPeerReadinessInput) => {
                input.candidates = Array.from({ length: 6 }, (_, i) =>
                    candidate(i + 1)
                );
            },
        ],
        [
            "duplicate peer",
            (input: PlacementPeerReadinessInput) => {
                input.candidates = [candidate(1), { ...candidate(2), peer: 1 }];
            },
        ],
        [
            "duplicate hash",
            (input: PlacementPeerReadinessInput) => {
                input.candidates = [candidate(1), { ...candidate(1), peer: 2 }];
            },
        ],
        [
            "self candidate",
            (input: PlacementPeerReadinessInput) => {
                input.observerHash = input.candidates[0].key.hashcode();
            },
        ],
        [
            "invalid peer",
            (input: PlacementPeerReadinessInput) => {
                input.candidates = [candidate(-1)];
            },
        ],
        [
            "not a key",
            (input: PlacementPeerReadinessInput) => {
                input.candidates = [
                    { peer: 1, key: "hash" as unknown as PublicSignKey },
                ];
            },
        ],
        [
            "observer bound",
            (input: PlacementPeerReadinessInput) => {
                input.observerHash = "x".repeat(513);
            },
        ],
        [
            "empty identity",
            (input: PlacementPeerReadinessInput) => {
                input.observerHash = "";
            },
        ],
        [
            "remote bound",
            (input: PlacementPeerReadinessInput) => {
                vi.spyOn(input.candidates[1].key, "hashcode").mockReturnValue(
                    "x".repeat(513)
                );
            },
        ],
        [
            "duplicate plane",
            (input: PlacementPeerReadinessInput) => {
                input.logs = [input.logs[0], input.logs[0]];
            },
        ],
        [
            "too many planes",
            (input: PlacementPeerReadinessInput) => {
                input.logs = [...input.logs, input.logs[0]];
            },
        ],
        [
            "invalid plane",
            (input: PlacementPeerReadinessInput) => {
                input.logs = [{ ...input.logs[0], plane: "other" as "chunks" }];
            },
        ],
        [
            "duplicate log",
            (input: PlacementPeerReadinessInput) => {
                input.logs[1].log.address = input.logs[0].log.address;
            },
        ],
        [
            "address bound",
            (input: PlacementPeerReadinessInput) => {
                input.logs[1].log.address = "x".repeat(513);
            },
        ],
        [
            "commit bound",
            (input: PlacementPeerReadinessInput) => {
                input.logs = [
                    { ...input.logs[0], committedEntryHash: "x".repeat(513) },
                ];
            },
        ],
        [
            "commit on both planes",
            (input: PlacementPeerReadinessInput) => {
                input.logs = input.logs.map((log) => ({
                    ...log,
                    committedEntryHash: "hash",
                }));
            },
        ],
    ] as const)("rejects %s before any inspection", async (_name, alter) => {
        const { input, chunks, metadata } = fixture();
        alter(input);
        await expect(capturePlacementPeerReadiness(input)).rejects.toThrow();
        expect(chunks.getPersistedReceiptPeerReadiness).not.toHaveBeenCalled();
        expect(
            metadata.getPersistedReceiptPeerReadiness
        ).not.toHaveBeenCalled();
    });

    it("admits exactly five candidates and two planes at the string limit", async () => {
        const { input, chunks, metadata } = fixture();
        input.candidates = Array.from({ length: 5 }, (_, i) =>
            candidate(i + 1)
        );
        input.observerHash = "o".repeat(512);
        chunks.address = "c".repeat(512);
        metadata.address = "m".repeat(512);
        input.logs = input.logs.map((log) => ({
            ...log,
            ...(log.plane === "chunks"
                ? { committedEntryHash: "h".repeat(512) }
                : {}),
        }));
        expect(await capturePlacementPeerReadiness(input)).toHaveLength(10);
        expect(chunks.getPersistedReceiptPeerReadiness).toHaveBeenCalledTimes(
            5
        );
        expect(metadata.getPersistedReceiptPeerReadiness).toHaveBeenCalledTimes(
            5
        );
    });

    it("retains synchronous, undefined and malformed rejections without discarding other results", async () => {
        const { input, chunks, metadata } = fixture();
        const trap = vi.fn(() => {
            throw new Error("must not invoke");
        });
        const malformed = Object.defineProperties(
            {},
            { message: { get: trap }, toString: { value: trap } }
        );
        chunks.getPersistedReceiptPeerReadiness
            .mockImplementationOnce(() => {
                throw undefined;
            })
            .mockRejectedValueOnce(malformed);
        const records = await capturePlacementPeerReadiness(input);
        expect(records.map(({ status }) => status)).toEqual([
            "rejected",
            "fulfilled",
            "rejected",
            "fulfilled",
        ]);
        expect(records[0]).toMatchObject({ error: { message: "undefined" } });
        expect(records[2]).toMatchObject({
            error: { message: "[object]", truncated: ["message:unreadable"] },
        });
        expect(metadata.getPersistedReceiptPeerReadiness).toHaveBeenCalledTimes(
            2
        );
        expect(trap).not.toHaveBeenCalled();
        expect(() => JSON.stringify(records)).not.toThrow();
    });

    it("owns deferred inspections until all settle even after another rejects", async () => {
        const { input, chunks, metadata } = fixture();
        input.candidates = [candidate(1)];
        const slow = deferred<PersistedReceiptPeerReadiness>();
        chunks.getPersistedReceiptPeerReadiness.mockReturnValueOnce(
            slow.promise
        );
        metadata.getPersistedReceiptPeerReadiness.mockRejectedValueOnce(
            new Error("fast failure")
        );
        let done = false;
        const capture = capturePlacementPeerReadiness(input).then((value) => {
            done = true;
            return value;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(done).toBe(false);
        expect(
            metadata.getPersistedReceiptPeerReadiness
        ).toHaveBeenCalledOnce();
        slow.resolve(ready());
        const records = await capture;
        expect(done).toBe(true);
        expect(records.map(({ status }) => status)).toEqual([
            "fulfilled",
            "rejected",
        ]);
    });

    it("records invocation/result times separately and detaches public snapshots", async () => {
        const { input, chunks } = fixture();
        input.candidates = [candidate(1)];
        input.logs = [input.logs[0]];
        const snapshot = ready();
        chunks.getPersistedReceiptPeerReadiness.mockResolvedValueOnce(snapshot);
        input.now = vi
            .fn()
            .mockReturnValueOnce(12.5)
            .mockReturnValueOnce(16.75);
        const [record] = await capturePlacementPeerReadiness(input);
        expect(record).toMatchObject({
            invocationAtMs: 12.5,
            resultAtMs: 16.75,
            elapsedMs: 4.25,
            snapshot,
        });
        if (record.status !== "fulfilled")
            throw new Error("unexpected rejected record");
        expect(record.snapshot).not.toBe(snapshot);
        expect(JSON.parse(JSON.stringify(record.snapshot))).toEqual(snapshot);
    });

    it("waits for every issued inspection before surfacing an injected clock fault", async () => {
        const { input, chunks, metadata } = fixture();
        input.candidates = [candidate(1)];
        const slow = deferred<PersistedReceiptPeerReadiness>();
        chunks.getPersistedReceiptPeerReadiness.mockReturnValueOnce(
            slow.promise
        );
        let ticks = 0;
        input.now = () => (++ticks === 3 ? NaN : ticks);
        let done = false;
        const capture = capturePlacementPeerReadiness(input).catch((error) => {
            done = true;
            return error;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(
            metadata.getPersistedReceiptPeerReadiness
        ).toHaveBeenCalledOnce();
        expect(done).toBe(false);
        slow.resolve(ready());
        expect(await capture).toBeInstanceOf(AggregateError);
        expect(done).toBe(true);
    });
});
