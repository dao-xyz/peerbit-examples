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

        program.installSlotSweep(
            "dir:wide",
            rows,
            program.slotSweepCache,
            program.slotPlacementById
        );

        // Operation count, not a machine-dependent timing threshold. The
        // former per-row findIndex needs quadratic identity reads.
        expect(identityReads).toBeLessThan(count * 12);
        expect(
            program.slotSweepCache.get("dir:wide").get("shared.txt")
        ).toHaveLength(count);
        expect(program.slotPlacementById.size).toBe(count);
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
        program.installSlotSweep(
            "dir:wide",
            rows,
            program.slotSweepCache,
            program.slotPlacementById
        );
        const bucket = program.slotSweepCache.get("dir:wide");
        expect([...bucket.keys()]).toEqual([
            "first",
            "second",
            "fifth",
            "third",
            "sixth",
        ]);
        expect(bucket.get("first")).toEqual([rows[5], rows[4]]);
        expect(bucket.get("second")).toBe(rows[3]);
        expect(bucket.get("third")).toBe(rows[9]);
        expect(bucket.get("sixth")).toBe(rows[10]);
        expect(program.slotPlacementById.size).toBe(6);
        expect(program.slotPlacementById.get("a")).toEqual({
            parentId: "dir:wide",
            name: "second",
        });

        // Replacement into another cached parent must still relocate the
        // existing id and remove its old singleton name bucket.
        const moved = { ...row("a", "moved", 3), parentId: "dir:other" };
        program.installSlotSweep(
            "dir:other",
            [moved],
            program.slotSweepCache,
            program.slotPlacementById
        );
        expect(bucket.has("second")).toBe(false);
        expect(program.slotPlacementById.get("a")).toEqual({
            parentId: "dir:other",
            name: "moved",
        });
        program.deleteSlotSweep("dir:wide");
        expect(program.slotPlacementById.size).toBe(1);
        program.deleteSlotSweep("dir:other");
        expect(program.slotPlacementById.size).toBe(0);
    });
});
