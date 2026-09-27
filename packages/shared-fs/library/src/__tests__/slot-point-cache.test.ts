import { describe, expect, it } from "vitest";
import { SharedFileSystem } from "../index.js";
import {
    BoundedSlotPointCache,
    type SlotNamingRow,
} from "../slot-point-cache.js";

const row = (
    id: number | string,
    parentId = "dir:wide",
    name = "shared.txt"
): SlotNamingRow => ({
    id: `naming:${id}`,
    nodeId: `file:${id}`,
    parentId,
    name,
    deleted: false,
    causalDepth: 1n,
    createdAt: typeof id === "number" ? BigInt(id) : 1n,
    parentNamingIds: [],
});

const ids = (rows: SlotNamingRow[] | undefined) => rows?.map((r) => r.id);

describe("shared fs bounded slot point cache", () => {
    it("bounds streams of negative slots and their parent metadata", () => {
        const cache = new BoundedSlotPointCache({
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
        const cache = new BoundedSlotPointCache({ maxEstimatedBytes: 2_048 });
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
        const cache = new BoundedSlotPointCache({ maxRows: 3 });
        cache.installSlot("dir:wide", "shared.txt", [row(0), row(1), row(2)]);
        cache.applyAdded(row(3));
        expect(cache.getSlot("dir:wide", "shared.txt")).toBeUndefined();
        expect(cache.snapshot().rows).toBe(0);
        expect(cache.snapshot().reverse).toBe(0);
    });

    it.each([
        ["rows", { maxRows: 4 }, 5, 0],
        ["bytes", { maxEstimatedBytes: 4_096 }, 1, 8_192],
    ])(
        "rejects an oversized %s fill without evicting or relocating anything",
        (_label, limits, count, padding) => {
            const cache = new BoundedSlotPointCache(limits);
            const warm = row("warm", "dir:warm", "warm.txt");
            const moved = row(0, "dir:old", "old.txt");
            expect(cache.installSlot("dir:warm", "warm.txt", [warm])).toBe(
                true
            );
            expect(cache.installSlot("dir:old", "old.txt", [moved])).toBe(true);
            expect(cache.installSlot("dir:wide", "shared.txt", [])).toBe(true);
            const before = cache.snapshot();

            // The oversized history includes an id another slot claims and
            // replaces an existing cached negative. Rejection happens first.
            const oversized = Array.from({ length: count }, (_, i) => ({
                ...row(i),
                machineLabel: "m".repeat(padding / 2),
            }));
            expect(cache.installSlot("dir:wide", "shared.txt", oversized)).toBe(
                false
            );
            expect(cache.snapshot()).toEqual(before);
            expect(ids(cache.getSlot("dir:warm", "warm.txt"))).toEqual([
                warm.id,
            ]);
            expect(ids(cache.getSlot("dir:old", "old.txt"))).toEqual([
                moved.id,
            ]);
            expect(cache.getSlot("dir:wide", "shared.txt")).toEqual([]);
        }
    );

    it("returns all 100k candidates and a winner beyond the cache admission limit", async () => {
        const program: any = new SharedFileSystem();
        const count = 100_000;
        const rows = Array.from({ length: count }, (_, i) => row(i));
        rows[count - 1].causalDepth = 2n;
        const queries: string[][] = [];
        program.queryRows = async (query: any[]) => {
            queries.push(query.map((clause) => [clause.key].flat().join(".")));
            return rows;
        };
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
        expect(queries).toEqual([["parentId", "name"]]);
        expect(examinedCandidates).toBe(count);
        expect(result.nodeId).toBe(`file:${count - 1}`);
        expect(result.shadowed).toHaveLength(count - 1);
        expect(program.slotPointCache.snapshot()).toMatchObject({
            slots: 0,
            rows: 0,
            reverse: 0,
        });
        expect(program.slotSweepCache.size).toBe(0);
    });

    it("invalidates a moved source history once instead of repeatedly filtering it", () => {
        const cache = new BoundedSlotPointCache();
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

    it("bounds identity work for a large same-name history", () => {
        const cache = new BoundedSlotPointCache();
        let identityReads = 0;
        const count = 2_000;
        const rows = Array.from({ length: count }, (_, index) => ({
            ...row(index),
            get id() {
                identityReads++;
                return `naming:${index}`;
            },
        }));
        cache.installSlot("dir:wide", "shared.txt", rows);
        // Operation count, not a machine-dependent timing threshold.
        expect(identityReads).toBeLessThan(count * 12);
        expect(cache.getSlot("dir:wide", "shared.txt")).toHaveLength(count);
        expect(cache.snapshot().reverse).toBe(count);
    });

    it("keeps a duplicate id at its first position with its last value", () => {
        const cache = new BoundedSlotPointCache();
        const first = row("a");
        const second = row("b");
        const replaced = { ...row("a"), createdAt: 2n };
        cache.installSlot("dir:wide", "shared.txt", [first, second, replaced]);
        expect(cache.getSlot("dir:wide", "shared.txt")).toEqual([
            replaced,
            second,
        ]);
        expect(cache.snapshot()).toMatchObject({ rows: 2, reverse: 2 });
    });

    it("keeps both slots exact across a same-id relocation", () => {
        const cache = new BoundedSlotPointCache();
        const moving = row("x", "dir:left", "a.txt");
        const staying = row("y", "dir:left", "a.txt");
        const resident = row("z", "dir:right", "b.txt");
        cache.installSlot("dir:left", "a.txt", [moving, staying]);
        cache.installSlot("dir:right", "b.txt", [resident]);
        cache.installSlot("dir:left", "other.txt", []);

        const moved = { ...moving, parentId: "dir:right", name: "b.txt" };
        cache.applyAdded(moved);
        // The source is dropped whole, never edited: its next read is an
        // exact index query. Its sibling slot in the same parent survives.
        expect(cache.getSlot("dir:left", "a.txt")).toBeUndefined();
        expect(cache.getSlot("dir:left", "other.txt")).toEqual([]);
        expect(ids(cache.getSlot("dir:right", "b.txt"))).toEqual([
            resident.id,
            moving.id,
        ]);
        expect(cache.getSlot("dir:right", "b.txt")![1]).toBe(moved);
        expect(cache.snapshot()).toMatchObject({ rows: 2, reverse: 2 });

        // What the index now returns for the source slot.
        cache.installSlot("dir:left", "a.txt", [staying]);
        expect(ids(cache.getSlot("dir:left", "a.txt"))).toEqual([staying.id]);
        expect(cache.snapshot()).toMatchObject({ rows: 3, reverse: 3 });

        // A move into an unknown slot only drops the source.
        cache.applyAdded({ ...staying, parentId: "dir:new", name: "c.txt" });
        expect(cache.getSlot("dir:left", "a.txt")).toBeUndefined();
        expect(cache.getSlot("dir:new", "c.txt")).toBeUndefined();
        expect(cache.snapshot()).toMatchObject({ rows: 2, reverse: 2 });
    });

    it("updates cached slots on arrival and drops them on removal", () => {
        const cache = new BoundedSlotPointCache();
        cache.installSlot("dir:left", "a.txt", []);
        const arrived = row("a", "dir:left", "a.txt");
        cache.applyAdded(arrived);
        expect(cache.getSlot("dir:left", "a.txt")).toEqual([arrived]);
        // Idempotent re-delivery (local write, then the change event).
        cache.applyAdded(arrived);
        expect(cache.snapshot()).toMatchObject({ rows: 1, reverse: 1 });
        // An arrival into an unknown slot is not its complete history.
        cache.applyAdded(row("b", "dir:left", "b.txt"));
        expect(cache.getSlot("dir:left", "b.txt")).toBeUndefined();

        cache.applyRemoved(arrived);
        expect(cache.getSlot("dir:left", "a.txt")).toBeUndefined();
        expect(cache.snapshot()).toMatchObject({
            parents: 0,
            slots: 0,
            rows: 0,
            reverse: 0,
            estimatedBytes: 0,
        });
    });

    it("evicts the least recently read slot first", () => {
        const cache = new BoundedSlotPointCache({ maxSlots: 4 });
        cache.installSlot("dir:p", "a", []);
        cache.installSlot("dir:p", "b", []);
        cache.installSlot("dir:p", "c", []);
        expect(cache.snapshot().entries).toBe(4);
        cache.getSlot("dir:p", "a");
        cache.installSlot("dir:p", "d", []);
        expect(cache.getSlot("dir:p", "b")).toBeUndefined();
        expect(cache.getSlot("dir:p", "a")).toEqual([]);
        expect(cache.getSlot("dir:p", "c")).toEqual([]);
        expect(cache.getSlot("dir:p", "d")).toEqual([]);
        expect(cache.snapshot().entries).toBe(4);
    });

    it("counts point queries per directory within a bounded map", () => {
        const cache = new BoundedSlotPointCache({
            maxSlots: 4,
            pointQueriesBeforeSweep: 2,
        });
        expect(cache.shouldSweepInstead("dir:a")).toBe(false);
        expect(cache.shouldSweepInstead("dir:a")).toBe(false);
        expect(cache.shouldSweepInstead("dir:a")).toBe(true);
        // The allowance restarts after a sweep.
        expect(cache.shouldSweepInstead("dir:a")).toBe(false);
        for (let i = 0; i < 100; i++) {
            cache.shouldSweepInstead(`dir:${i}`);
        }
        expect((cache as any).pointQueries.size).toBeLessThanOrEqual(4);
    });

    it("admits queued fills in FIFO order within the in-flight bound", async () => {
        const cache = new BoundedSlotPointCache({ maxInFlight: 2 });
        const started: string[] = [];
        const releases = new Map<string, () => void>();
        let inFlight = 0;
        let maxSeen = 0;
        const fill = (name: string) => async () => {
            started.push(name);
            inFlight++;
            maxSeen = Math.max(maxSeen, inFlight);
            await new Promise<void>((resolve) => releases.set(name, resolve));
            inFlight--;
            return [];
        };
        const names = Array.from({ length: 200 }, (_, i) => `n-${i}`);
        const all = names.map((name) =>
            cache.runSlotFill("dir:p", name, "s", fill(name))
        );
        // Release fills one at a time as they start; each completion must
        // admit exactly the next queued caller.
        for (let i = 0; i < names.length; i++) {
            while (!releases.has(names[i])) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            releases.get(names[i])!();
        }
        await Promise.all(all);
        expect(started).toEqual(names);
        expect(maxSeen).toBeLessThanOrEqual(2);
        expect(cache.snapshot().inFlight).toBe(0);
    });

    it("passes a wakeup on when a woken caller joins an identical fill", async () => {
        const cache = new BoundedSlotPointCache({ maxInFlight: 2 });
        const gates = new Map<string, () => void>();
        const started: string[] = [];
        const fill = (label: string) => async () => {
            started.push(label);
            await new Promise<void>((resolve) => gates.set(label, resolve));
            return [];
        };
        const tick = () => new Promise((resolve) => setImmediate(resolve));
        const a = cache.runSlotFill("dir:p", "a", "s", fill("a"));
        const d = cache.runSlotFill("dir:p", "d", "s", fill("d"));
        const b1 = cache.runSlotFill("dir:p", "b", "s", fill("b1"));
        const b2 = cache.runSlotFill("dir:p", "b", "s", fill("b2"));
        const e = cache.runSlotFill("dir:p", "e", "s", fill("e"));
        await tick();
        expect(started).toEqual(["a", "d"]);
        gates.get("a")!();
        await a;
        await tick();
        expect(started).toEqual(["a", "d", "b1"]);
        // d's completion wakes b2, which joins b1's fill without using the
        // freed slot and must hand the wakeup to e.
        gates.get("d")!();
        await d;
        await tick();
        expect(started).toEqual(["a", "d", "b1", "e"]);
        gates.get("b1")!();
        gates.get("e")!();
        await Promise.all([b1, b2, e]);
        expect(started).not.toContain("b2");
    });
});
