import { afterEach, describe, expect, it } from "vitest";
import { NamingEvent, SharedFileSystem } from "../index.js";
import { parkNextRowQuery } from "./cache-race-park.js";

const naming = (
    id: string,
    parentId = "dir:left",
    name = "target.txt",
    revision = 1
) =>
    new NamingEvent({
        id: `naming:${id}`,
        nodeId: `file:${id}`,
        parentId,
        name,
        createdAt: BigInt(revision),
        causalDepth: BigInt(revision),
        parentNamingIds: [],
        authorKey: "test-author",
        machineLabel: "point-cache-races",
    });

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();
const programs: any[] = [];

// The backing index is deliberately synchronous until queryRows' snapshot is
// returned. parkNextRowQuery then holds that exact snapshot across the event.
// No scheduler sleeps, polling, or retries determine which state is observed.
const harness = (initial: NamingEvent[] = []) => {
    const program: any = new SharedFileSystem();
    programs.push(program);
    const index = new Map(initial.map((row) => [row.id, row]));
    const queries: Array<Record<string, string>> = [];
    program.queryRows = async (query: any[]) => {
        const predicates = Object.fromEntries(
            query.map((clause) => [
                Array.isArray(clause.key) ? clause.key.join(".") : clause.key,
                clause.value,
            ])
        );
        queries.push(predicates);
        expect(predicates.kind).toBe("naming");
        return [...index.values()].filter((row: any) =>
            Object.entries(predicates).every(
                ([key, value]) => key === "kind" || row[key] === value
            )
        );
    };
    // Overlay retirement's persistence/arming effects are unrelated to the
    // cache admission proof and would require opening a real Peerbit node.
    program.writeBootstrapState = async () => {};
    program.startQuiescenceChecker = () => {};
    const put = (row: NamingEvent) => {
        index.set(row.id, row);
        program.applyCacheChanges([row], []);
    };
    return { program, index, queries, put };
};

afterEach(() => {
    for (const program of programs.splice(0)) program.clearBootstrapTimers();
});

describe("shared fs bounded exact-slot cache races", () => {
    it.each([
        ["out", "dir:left", "other.txt"],
        ["out", "dir:right", "target.txt"],
        ["in", "dir:left", "other.txt"],
        ["in", "dir:right", "target.txt"],
    ])(
        "rejects a parked same-ID move %s through %s/%s without a reverse placement",
        async (direction, destinationParent, destinationName) => {
            const original = naming("moving");
            const { program, queries, put } = harness([original]);
            const moved = naming(
                "moving",
                destinationParent,
                destinationName,
                2
            );
            const target = direction === "out" ? original : moved;
            expect(program.slotCandidateCache.snapshot().reverse).toBe(0);
            const { parkedReached, release } = parkNextRowQuery(program);
            const stale = program.slotRows(target.parentId, target.name);
            await parkedReached;
            try {
                put(moved);
            } finally {
                release();
            }
            await stale;

            // A pre-event caller may return its snapshot. It must not turn
            // that snapshot into the complete history for later callers.
            const current = await program.slotRows(
                target.parentId,
                target.name
            );
            expect(ids(current)).toEqual(direction === "out" ? [] : [moved.id]);
            expect(queries).toHaveLength(2);
            expect(queries[0]).toEqual({
                kind: "naming",
                parentId: target.parentId,
                name: target.name,
            });
        }
    );

    it("does not join a pre-event snapshot when a later caller starts after the event", async () => {
        const { program, queries, put } = harness();
        const { parkedReached, release } = parkNextRowQuery(program);
        const stale = program.slotRows("dir:left", "target.txt");
        await parkedReached;
        const arrived = naming("arrived");
        put(arrived);
        const fresh = program.slotRows("dir:left", "target.txt");
        try {
            // Allow the async cache-entry wrapper to reach its backing query;
            // the first query remains blocked on the explicit release gate.
            await Promise.resolve();
            expect(queries).toHaveLength(2);
        } finally {
            release();
        }
        await stale;
        expect(ids(await fresh)).toEqual([arrived.id]);
    });

    it("does not treat an arrival into an unknown slot as its complete history", async () => {
        const historical = naming("historical", "dir:left", "unknown.txt");
        const { program, queries, put } = harness([historical]);
        expect(await program.slotRows("dir:left", "known-empty.txt")).toEqual(
            []
        );
        const arrived = naming("arrived", "dir:left", "unknown.txt", 2);
        put(arrived);
        expect(ids(await program.slotRows("dir:left", "unknown.txt"))).toEqual([
            arrived.id,
            historical.id,
        ]);
        expect(queries).toHaveLength(2);
        expect(queries[1].name).toBe("unknown.txt");
    });

    it("updates an already complete negative slot without another index query", async () => {
        const { program, queries, put } = harness();
        expect(await program.slotRows("dir:left", "target.txt")).toEqual([]);
        const arrived = naming("arrived");
        put(arrived);
        expect(ids(await program.slotRows("dir:left", "target.txt"))).toEqual([
            arrived.id,
        ]);
        expect(queries).toHaveLength(1);
    });

    it.each([true, false])(
        "unions overlay data over a cached negative and rejects parked fills on retirement (%s)",
        async (verified) => {
            const { program, queries } = harness();
            expect(await program.slotRows("dir:left", "target.txt")).toEqual(
                []
            );
            program.bootstrapPhase = "fetching";
            const overlay = naming("overlay");
            program.installOverlayDoc(overlay);
            expect(await program.slotRows("dir:left", "target.txt")).toEqual(
                []
            );
            program.bootstrapPhase = "overlay-active";
            expect(
                ids(await program.slotRows("dir:left", "target.txt"))
            ).toEqual([overlay.id]);
            expect(queries).toHaveLength(1);
            expect(program.slotCandidateCache.snapshot().reverse).toBe(0);

            const { parkedReached, release } = parkNextRowQuery(program);
            const stale = program.slotRows("dir:left", "other.txt");
            await parkedReached;
            try {
                program.retireOverlay(verified, program.openGeneration);
            } finally {
                release();
            }
            await stale;
            expect(await program.slotRows("dir:left", "target.txt")).toEqual(
                []
            );
            expect(await program.slotRows("dir:left", "other.txt")).toEqual([]);
            expect(queries).toHaveLength(4);
            expect(program.slotCandidateCache.snapshot().reverse).toBe(0);
        }
    );

    it("enumerates every real history after warming only a partial parent", async () => {
        const initial = [
            naming("first", "dir:left", "first.txt"),
            naming("second", "dir:left", "second.txt"),
            naming("third", "dir:left", "third.txt"),
        ];
        const { program, queries } = harness(initial);
        expect(ids(await program.slotRows("dir:left", "first.txt"))).toEqual([
            initial[0].id,
        ]);
        expect(await program.slotRows("dir:left", "absent.txt")).toEqual([]);
        expect(queries).toHaveLength(2);
        expect(ids(await program.sweepRows("dir:left"))).toEqual(ids(initial));
        expect(queries).toHaveLength(3);
        expect(queries[2]).toEqual({ kind: "naming", parentId: "dir:left" });
        expect(ids(await program.slotRows("dir:left", "third.txt"))).toEqual([
            initial[2].id,
        ]);
        expect(queries).toHaveLength(3);
    });

    it("does not publish a complete parent from a sweep that overlaps an unknown-slot arrival", async () => {
        const first = naming("first", "dir:left", "first.txt");
        const second = naming("second", "dir:left", "second.txt");
        const { program, queries, put } = harness([first, second]);
        await program.slotRows("dir:left", "first.txt");
        const { parkedReached, release } = parkNextRowQuery(program);
        const sweep = program.sweepRows("dir:left");
        await parkedReached;
        const arrived = naming("arrived", "dir:left", "arrived.txt");
        try {
            put(arrived);
        } finally {
            release();
        }
        await sweep;
        expect(program.slotCandidateCache.snapshot().completeParents).toBe(0);
        expect(ids(await program.slotRows("dir:left", "arrived.txt"))).toEqual([
            arrived.id,
        ]);
        expect(queries).toHaveLength(3);
        expect(ids(await program.sweepRows("dir:left"))).toEqual(
            ids([first, second, arrived])
        );
        expect(queries).toHaveLength(4);
    });

    it("deduplicates concurrent same-slot queries but returns independent arrays", async () => {
        const row = naming("existing");
        const { program, queries } = harness([row]);
        const { parkedReached, release } = parkNextRowQuery(program);
        const pending = [program.slotRows("dir:left", "target.txt")];
        await parkedReached;
        for (let index = 0; index < 12; index++)
            pending.push(program.slotRows("dir:left", "target.txt"));
        try {
            await Promise.resolve();
            expect(queries).toHaveLength(1);
        } finally {
            release();
        }
        const results = await Promise.all(pending);
        expect(results.every((rows) => ids(rows).join() === row.id)).toBe(true);
        results[0].length = 0;
        expect(ids(results[1])).toEqual([row.id]);
        expect(ids(await program.slotRows("dir:left", "target.txt"))).toEqual([
            row.id,
        ]);
        expect(queries).toHaveLength(1);
    });

    it("clears rejected pending queries so the next caller can retry normally", async () => {
        const row = naming("existing");
        const { program, queries } = harness([row]);
        const realQuery = program.queryRows;
        let fail!: (error: Error) => void;
        let reached!: () => void;
        const gate = new Promise<never>((_, reject) => {
            fail = reject;
        });
        const started = new Promise<void>((resolve) => {
            reached = resolve;
        });
        program.queryRows = async (query: unknown) => {
            program.queryRows = realQuery;
            await realQuery(query);
            reached();
            return gate;
        };
        const first = program.slotRows("dir:left", "target.txt");
        await started;
        const second = program.slotRows("dir:left", "target.txt");
        const settled = Promise.allSettled([first, second]);
        fail(new Error("injected index read failure"));
        const results = await settled;
        expect(results.every((result) => result.status === "rejected")).toBe(
            true
        );
        expect(queries).toHaveLength(1);
        expect(ids(await program.slotRows("dir:left", "target.txt"))).toEqual([
            row.id,
        ]);
        expect(queries).toHaveLength(2);
    });

    it("waits at the distinct-fill cap and still deduplicates the queued slot", async () => {
        const first = naming("first", "dir:left", "first.txt");
        const second = naming("second", "dir:left", "second.txt");
        const { program, queries } = harness([first, second]);
        program.slotCandidateCache = new program.slotCandidateCache.constructor(
            { maxInFlight: 1 }
        );
        const { parkedReached, release } = parkNextRowQuery(program);
        const active = program.slotRows("dir:left", "first.txt");
        await parkedReached;
        const waiting = [
            program.slotRows("dir:left", "second.txt"),
            program.slotRows("dir:left", "second.txt"),
        ];
        try {
            await Promise.resolve();
            expect(queries).toHaveLength(1);
            expect(program.slotCandidateCache.snapshot().inFlight).toBe(1);
        } finally {
            release();
        }
        expect(ids(await active)).toEqual([first.id]);
        for (const rows of await Promise.all(waiting))
            expect(ids(rows)).toEqual([second.id]);
        expect(queries).toHaveLength(2);
        expect(program.slotCandidateCache.snapshot().inFlight).toBe(0);
    });

    it("cannot let an old generation's finalizer clear a replacement pending query", async () => {
        const original = naming("old");
        const { program, index, queries } = harness([original]);
        const previousCache = program.slotCandidateCache;
        const firstGate = parkNextRowQuery(program);
        const oldFill = program.slotRows("dir:left", "target.txt");
        await firstGate.parkedReached;

        // Model the exact generation and helper replacement performed by
        // open. The separate cache-race-slot suite exercises real close/open.
        program.openGeneration++;
        program.slotCandidateCache = new previousCache.constructor();
        const currentCache = program.slotCandidateCache;
        index.clear();
        const current = naming("new");
        index.set(current.id, current);
        const secondGate = parkNextRowQuery(program);
        const currentFill = program.slotRows("dir:left", "target.txt");
        await secondGate.parkedReached;
        try {
            firstGate.release();
            await oldFill;
            expect(currentCache.snapshot().inFlight).toBe(1);
            const joined = program.slotRows("dir:left", "target.txt");
            await Promise.resolve();
            expect(queries).toHaveLength(2);
            secondGate.release();
            expect(ids(await currentFill)).toEqual([current.id]);
            expect(ids(await joined)).toEqual([current.id]);
            expect(currentCache.snapshot().inFlight).toBe(0);
        } finally {
            firstGate.release();
            secondGate.release();
        }
    });

    it("preserves eviction and reverse cleanup while another exact-slot fill is parked", async () => {
        const warm = naming("warm", "dir:left", "warm.txt");
        const cold = naming("cold", "dir:left", "cold.txt");
        const { program, queries } = harness([warm, cold]);
        expect(ids(await program.slotRows("dir:left", "warm.txt"))).toEqual([
            warm.id,
        ]);
        const cache = program.slotCandidateCache;
        expect(cache.snapshot().reverse).toBe(1);
        const { parkedReached, release } = parkNextRowQuery(program);
        const pending = program.slotRows("dir:left", "cold.txt");
        await parkedReached;
        try {
            cache.evictSlot("dir:left", "warm.txt");
            expect(cache.snapshot().reverse).toBe(0);
        } finally {
            release();
        }
        expect(ids(await pending)).toEqual([cold.id]);
        const before = queries.length;
        expect(ids(await program.slotRows("dir:left", "warm.txt"))).toEqual([
            warm.id,
        ]);
        expect(queries).toHaveLength(before + 1);
        expect(cache.snapshot().inFlight).toBe(0);
        expect(ids(await program.sweepRows("dir:left"))).toEqual(
            ids([warm, cold])
        );
    });

    it("does not restore directory completeness after a history update evicts a sibling slot", async () => {
        const target = naming("target", "dir:left", "target.txt");
        const sibling = naming("sibling", "dir:left", "sibling.txt");
        const third = naming("third", "dir:left", "third.txt");
        const { program, queries, put } = harness([target, sibling, third]);
        program.slotCandidateCache = new program.slotCandidateCache.constructor(
            {
                maxRows: 3,
            }
        );
        await program.sweepRows("dir:left");
        expect(program.slotCandidateCache.snapshot().completeParents).toBe(1);
        // Touch parent and target after the full fill. A sibling is now the
        // eviction victim when the target history grows by one row.
        await program.slotRows("dir:left", "target.txt");
        const collision = naming("collision", "dir:left", "target.txt", 2);
        put(collision);
        expect(program.slotCandidateCache.snapshot()).toMatchObject({
            parents: 1,
            completeParents: 0,
            rows: 3,
            reverse: 3,
        });
        const before = queries.length;
        expect(ids(await program.slotRows("dir:left", "sibling.txt"))).toEqual([
            sibling.id,
        ]);
        expect(queries).toHaveLength(before + 1);
    });

    it.each([{ maxSlots: 1 }, { maxEstimatedBytes: 1024 }])(
        "invalidates a complete empty parent when an arriving slot cannot fit (%j)",
        async (limits) => {
            const { program, queries, put } = harness();
            program.slotCandidateCache =
                new program.slotCandidateCache.constructor(limits);
            expect(await program.sweepRows("dir:left")).toEqual([]);
            expect(program.slotCandidateCache.snapshot().completeParents).toBe(
                1
            );
            const arrived = naming("oversized");
            arrived.machineLabel = "x".repeat(2_000);
            put(arrived);
            expect(program.slotCandidateCache.snapshot().completeParents).toBe(
                0
            );
            // Admission limits bound retention; they cannot prove absence
            // or truncate the history returned from the backing index.
            expect(
                ids(await program.slotRows("dir:left", "target.txt"))
            ).toEqual([arrived.id]);
            expect(queries).toHaveLength(2);
            expect(program.slotCandidateCache.snapshot().rows).toBe(0);
        }
    );
});
