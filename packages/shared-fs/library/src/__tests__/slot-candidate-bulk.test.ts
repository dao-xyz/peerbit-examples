import { describe, expect, it } from "vitest";
import { SharedFileSystem } from "../index.js";

const row = (id: string, name: string, revision = 1) => ({
    id,
    nodeId: `file:${id}`,
    parentId: "dir:wide",
    name,
    deleted: false,
    causalDepth: 1n,
    createdAt: BigInt(revision),
    parentNamingIds: [],
});

describe("shared fs bulk slot cache installation", () => {
    it("bounds identity work for a large same-name history", () => {
        const program: any = new SharedFileSystem();
        let identityReads = 0;
        const count = 2_000;
        const rows = Array.from({ length: count }, (_, index) => ({
            ...row(`naming:${index}`, "shared.txt"),
            get id() {
                identityReads++;
                return `naming:${index}`;
            },
        }));

        program.installSlotSweep("dir:wide", rows);

        // Operation count, not a machine-dependent timing threshold. The
        // former per-row findIndex needs quadratic identity reads.
        expect(identityReads).toBeLessThan(count * 12);
        expect(
            program.slotCandidateCache.getSlot("dir:wide", "shared.txt")
        ).toHaveLength(count);
        expect(program.slotCandidateCache.snapshot().reverse).toBe(count);
    });

    it("preserves replacement positions and name reinsertion order", () => {
        const program: any = new SharedFileSystem();
        const rows = [
            row("a", "first"),
            row("b", "first"),
            row("c", "second"),
            row("a", "second", 2),
            row("d", "first"),
            row("b", "first", 2),
            row("e", "third"),
            row("e", "fourth", 2),
            row("f", "fifth"),
            row("e", "third", 3),
            row("c", "sixth", 2),
        ];
        program.installSlotSweep("dir:wide", rows);
        const cache = program.slotCandidateCache;
        expect([
            ...new Set(cache.getSweep("dir:wide").map((row: any) => row.name)),
        ]).toEqual(["first", "second", "fifth", "third", "sixth"]);
        expect(cache.getSlot("dir:wide", "first")).toEqual([rows[5], rows[4]]);
        expect(cache.getSlot("dir:wide", "second")).toEqual([rows[3]]);
        expect(cache.getSlot("dir:wide", "third")).toEqual([rows[9]]);
        expect(cache.getSlot("dir:wide", "sixth")).toEqual([rows[10]]);
        expect(cache.snapshot().reverse).toBe(6);

        // Replacement into another cached parent must still relocate the
        // existing id and remove its old singleton name bucket.
        const moved = { ...row("a", "moved", 3), parentId: "dir:other" };
        program.installSlotSweep("dir:other", [moved]);
        // The source slot is now unknown, not a cached absence: a new read
        // must fetch its complete current history from the index.
        expect(cache.getSlot("dir:wide", "second")).toBeUndefined();
        expect(cache.getSweep("dir:wide")).toBeUndefined();
        expect(cache.getSlot("dir:other", "moved")).toEqual([moved]);
        cache.evictParent("dir:wide");
        expect(cache.snapshot().reverse).toBe(1);
        cache.evictParent("dir:other");
        expect(cache.snapshot().reverse).toBe(0);
    });
});
