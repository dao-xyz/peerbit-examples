import { describe, expect, it } from "vitest";
import { SharedFileSystem } from "../index.js";
import {
    BoundedSlotCandidateCache,
    type SlotNamingRow,
} from "../slot-candidate-cache.js";

const row = (id: number): SlotNamingRow => ({
    id: `naming:${id}`,
    nodeId: `file:${id}`,
    parentId: "dir:wide",
    name: "shared.txt",
    deleted: false,
    causalDepth: 1n,
    createdAt: BigInt(id),
    parentNamingIds: [],
});

describe("shared fs retained slot cache bounds", () => {
    it("bounds streams of negative slots and their parent metadata", () => {
        const cache = new BoundedSlotCandidateCache({
            maxSlots: 8,
            maxRows: 8,
            maxEstimatedBytes: 4_096,
        });
        for (let i = 0; i < 128; i++) {
            cache.installSlot(`dir:${i % 3}`, `missing-${i}`, []);
            const state = cache.snapshot();
            expect(state.entries).toBeLessThanOrEqual(8);
            expect(state.estimatedBytes).toBeLessThanOrEqual(4_096);
            expect(state.rows).toBe(0);
            expect(state.reverse).toBe(0);
        }
        expect(cache.getSlot("dir:0", "missing-0")).toBeUndefined();
        expect(cache.getSlot("dir:1", "missing-127")).toEqual([]);
        cache.clear();
        expect(cache.snapshot()).toMatchObject({
            parents: 0,
            slots: 0,
            rows: 0,
            estimatedBytes: 0,
            reverse: 0,
        });
    });

    it("evicts a known history when one live replacement exceeds its byte budget", () => {
        const cache = new BoundedSlotCandidateCache({
            maxEstimatedBytes: 2_048,
        });
        const original = row(0);
        expect(
            cache.installSlot(original.parentId, original.name, [original])
        ).toBe(true);
        cache.applyAdded({
            ...original,
            authorKey: "a".repeat(2_048),
            parentNamingIds: ["p".repeat(2_048)],
        });
        expect(cache.getSlot(original.parentId, original.name)).toBeUndefined();
        expect(cache.snapshot()).toMatchObject({
            rows: 0,
            reverse: 0,
            estimatedBytes: 0,
        });
    });

    it("retains no partial history when row admission overflows", () => {
        const cache = new BoundedSlotCandidateCache({ maxRows: 3 });
        cache.installSlot("dir:wide", "shared.txt", [row(0), row(1), row(2)]);
        cache.applyAdded(row(3));
        expect(cache.getSlot("dir:wide", "shared.txt")).toBeUndefined();
        expect(cache.snapshot().rows).toBe(0);
        expect(cache.snapshot().reverse).toBe(0);
    });

    it("returns all 100k candidates and a winner beyond the cache admission limit", async () => {
        const program: any = new SharedFileSystem();
        const count = 100_000;
        const rows = Array.from({ length: count }, (_, i) => row(i));
        rows[count - 1].causalDepth = 2n;
        program.queryRows = async () => rows;
        let examinedCandidates = 0;
        program.namingStatesForNodes = async (nodeIds: string[]) => {
            examinedCandidates = nodeIds.length;
            return new Map(
                nodeIds.map((id) => {
                    const winner = rows[Number(id.slice("file:".length))];
                    return [id, { nodeId: id, winner }];
                })
            );
        };
        const result = await program.slotResolution("dir:wide", "shared.txt");
        expect(examinedCandidates).toBe(count);
        expect(result.nodeId).toBe(`file:${count - 1}`);
        expect(result.shadowed).toHaveLength(count - 1);
        expect(program.slotCandidateRowsExamined).toBe(count);
        expect(program.slotCandidateCache.snapshot()).toMatchObject({
            slots: 0,
            rows: 0,
            reverse: 0,
        });
    });

    it("invalidates a moved source history once instead of repeatedly filtering it", () => {
        const cache = new BoundedSlotCandidateCache();
        let sourceIdentityReads = 0;
        const source = Array.from({ length: 2_000 }, (_, i) => ({
            ...row(i),
            get id() {
                sourceIdentityReads++;
                return `naming:${i}`;
            },
        }));
        cache.installSlot("dir:wide", "shared.txt", source);
        const moved = source.map((entry) => ({
            ...entry,
            parentId: "dir:other",
        }));
        sourceIdentityReads = 0;
        cache.installSlot("dir:other", "shared.txt", moved);
        expect(sourceIdentityReads).toBeLessThan(source.length * 2);
        expect(cache.getSlot("dir:wide", "shared.txt")).toBeUndefined();
        expect(cache.getSlot("dir:other", "shared.txt")).toHaveLength(
            source.length
        );
        expect(cache.snapshot().reverse).toBe(source.length);
    });
});
