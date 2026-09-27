import { afterEach, describe, expect, it } from "vitest";
import { NamingEvent, SharedFileSystem } from "../index.js";
import { forcePointTier, parkNextRowQuery } from "./cache-race-park.js";

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
const harness = (
    initial: NamingEvent[] = [],
    // Point-path tests treat every directory as wide; width-gate tests opt in.
    { widthGate = false }: { widthGate?: boolean } = {}
) => {
    const program: any = new SharedFileSystem();
    programs.push(program);
    const index = new Map(initial.map((row) => [row.id, row]));
    const queries: Array<Record<string, string>> = [];
    program.queryRows = async (query: any[]) => {
        const predicates = Object.fromEntries(
            query.map((clause) => [[clause.key].flat().join("."), clause.value])
        );
        queries.push(predicates);
        // Directory sweeps filter by kind; exact-slot queries rely on only
        // naming rows carrying parentId/name.
        if (predicates.name === undefined) {
            expect(predicates.kind).toBe("naming");
        } else {
            expect(predicates.kind).toBeUndefined();
        }
        return [...index.values()].filter((row: any) =>
            Object.entries(predicates).every(
                ([key, value]) => key === "kind" || row[key] === value
            )
        );
    };
    // Bounded reads go through queryRows so recording and parking see them.
    program.queryRowsUpTo = async (query: any[], limit: number) => {
        const rows = await program.queryRows(query);
        return {
            rows: rows.slice(0, limit + 1),
            complete: rows.length <= limit,
        };
    };
    if (!widthGate) {
        forcePointTier(program);
    }
    // Overlay retirement's persistence/arming effects are unrelated to the
    // cache admission proof and would require opening a real Peerbit node.
    program.writeBootstrapState = async () => {};
    program.startQuiescenceChecker = () => {};
    const put = (row: NamingEvent) => {
        index.set(row.id, row);
        program.applyCacheChanges([row], []);
    };
    const slotQueries = (parentId: string) =>
        queries.filter((q) => q.parentId === parentId && q.name !== undefined);
    const sweepQueries = (parentId: string) =>
        queries.filter((q) => q.parentId === parentId && q.name === undefined);
    return { program, index, queries, put, slotQueries, sweepQueries };
};

afterEach(() => {
    for (const program of programs.splice(0)) program.clearBootstrapTimers();
});

describe("shared fs slot point cache races", () => {
    it.each([
        ["out", "dir:left", "other.txt"],
        ["in", "dir:left", "other.txt"],
        ["in", "dir:right", "target.txt"],
    ])(
        "rejects a parked fill when a same-ID move %s through %s/%s bumps its directory",
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
            // that snapshot into the cached history for later callers.
            const current = await program.slotRows(
                target.parentId,
                target.name
            );
            expect(ids(current)).toEqual(direction === "out" ? [] : [moved.id]);
            expect(queries).toHaveLength(2);
            expect(queries[0]).toEqual({
                parentId: target.parentId,
                name: target.name,
            });
        }
    );

    it("tolerates a stale extra from a cross-directory move and evicts it on the next placement", async () => {
        // The move bumps only dir:right, so the parked dir:left fill passes
        // its per-directory fence and installs the moved row as an extra
        // candidate, exactly like a stale row left in a directory sweep.
        const original = naming("moving");
        const { program, queries, put } = harness([original]);
        const moved = naming("moving", "dir:right", "target.txt", 2);
        const { parkedReached, release } = parkNextRowQuery(program);
        const stale = program.slotRows("dir:left", "target.txt");
        await parkedReached;
        try {
            put(moved);
        } finally {
            release();
        }
        expect(ids(await stale)).toEqual([original.id]);
        const cache = program.slotPointCache;
        expect(ids(cache.getSlot("dir:left", "target.txt"))).toEqual([
            original.id,
        ]);

        // Harmless: the candidate's current winner is elsewhere, so no
        // consumer resolves the old slot to it.
        expect(
            await program.slotResolution("dir:left", "target.txt")
        ).toBeUndefined();
        expect(
            (await program.slotResolution("dir:right", "target.txt"))?.nodeId
        ).toBe(moved.nodeId);
        // Filling the destination relocated the id and evicted the source.
        expect(cache.getSlot("dir:left", "target.txt")).toBeUndefined();
        expect(ids(await program.slotRows("dir:left", "target.txt"))).toEqual(
            []
        );
        expect(
            queries
                .filter((q) => q.name === "target.txt")
                .map((q) => q.parentId)
        ).toEqual(["dir:left", "dir:right", "dir:left"]);
    });

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

    it("updates a cached negative slot without another index query", async () => {
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
            program.installOverlayDoc(naming("sibling", "dir:left", "x.txt"));
            expect(await program.slotRows("dir:left", "target.txt")).toEqual(
                []
            );
            program.bootstrapPhase = "overlay-active";
            expect(
                ids(await program.slotRows("dir:left", "target.txt"))
            ).toEqual([overlay.id]);
            expect(queries).toHaveLength(1);
            expect(program.slotPointCache.snapshot().reverse).toBe(0);

            const { parkedReached, release } = parkNextRowQuery(program);
            const stale = program.slotRows("dir:left", "other.txt");
            await parkedReached;
            const retiredCache = program.slotPointCache;
            try {
                program.retireOverlay(verified, program.openGeneration);
            } finally {
                release();
            }
            await stale;
            expect(program.slotPointCache).not.toBe(retiredCache);
            expect(program.slotPointCache.snapshot().entries).toBe(0);
            expect(await program.slotRows("dir:left", "target.txt")).toEqual(
                []
            );
            expect(await program.slotRows("dir:left", "other.txt")).toEqual([]);
            expect(queries).toHaveLength(4);
            expect(program.slotPointCache.snapshot().reverse).toBe(0);
        }
    );

    it("answers slots, including absence, from a cached sweep with zero queries", async () => {
        const initial = [
            naming("first", "dir:left", "first.txt"),
            naming("second", "dir:left", "second.txt"),
            naming("third", "dir:left", "third.txt"),
        ];
        const { program, queries, put } = harness(initial);
        expect(ids(await program.slotRows("dir:left", "first.txt"))).toEqual([
            initial[0].id,
        ]);
        expect(await program.slotRows("dir:left", "absent.txt")).toEqual([]);
        expect(queries).toHaveLength(2);
        expect(ids(await program.sweepRows("dir:left"))).toEqual(ids(initial));
        expect(queries).toHaveLength(3);
        expect(queries[2]).toEqual({ kind: "naming", parentId: "dir:left" });
        // Arrivals keep both the sweep and the cached point slot current.
        const arrived = naming("arrived", "dir:left", "absent.txt", 2);
        put(arrived);
        const pointBefore = program.slotPointCache.snapshot();

        expect(ids(await program.slotRows("dir:left", "third.txt"))).toEqual([
            initial[2].id,
        ]);
        expect(await program.slotRows("dir:left", "missing.txt")).toEqual([]);
        expect(ids(await program.slotRows("dir:left", "absent.txt"))).toEqual([
            arrived.id,
        ]);
        expect(queries).toHaveLength(3);
        // Lookups served by the sweep never fill point slots.
        expect(program.slotPointCache.snapshot()).toEqual(pointBefore);
    });

    it("an unlisted directory costs one exact-slot query per slot, then none", async () => {
        const initial = Array.from({ length: 50 }, (_, i) =>
            naming(`entry-${i}`, "dir:wide", `entry-${i}.txt`)
        );
        const { program, queries, slotQueries, sweepQueries } =
            harness(initial);
        expect(ids(await program.slotRows("dir:wide", "entry-25.txt"))).toEqual(
            [initial[25].id]
        );
        expect(await program.slotRows("dir:wide", "absent.txt")).toEqual([]);
        expect(slotQueries("dir:wide")).toEqual([
            { parentId: "dir:wide", name: "entry-25.txt" },
            { parentId: "dir:wide", name: "absent.txt" },
        ]);
        for (let i = 0; i < 10; i++) {
            await program.slotRows("dir:wide", "entry-25.txt");
            await program.slotRows("dir:wide", "absent.txt");
        }
        expect(queries).toHaveLength(2);
        expect(sweepQueries("dir:wide")).toHaveLength(0);
        expect(program.slotSweepCache.has("dir:wide")).toBe(false);
        expect(program.slotPointCache.snapshot()).toMatchObject({
            parents: 1,
            slots: 2,
            rows: 1,
        });
    });

    it("does not install a sweep that overlaps an arrival; point lookups still see it", async () => {
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
        expect(program.slotSweepCache.has("dir:left")).toBe(false);
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
        expect(program.slotPointCache.snapshot().inFlight).toBe(0);
        expect(ids(await program.slotRows("dir:left", "target.txt"))).toEqual([
            row.id,
        ]);
        expect(queries).toHaveLength(2);
    });

    it("waits at the distinct-fill cap and still deduplicates the queued slot", async () => {
        const first = naming("first", "dir:left", "first.txt");
        const second = naming("second", "dir:left", "second.txt");
        const { program, queries } = harness([first, second]);
        program.slotPointCache = new program.slotPointCache.constructor({
            maxInFlight: 1,
        });
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
            expect(program.slotPointCache.snapshot().inFlight).toBe(1);
        } finally {
            release();
        }
        expect(ids(await active)).toEqual([first.id]);
        for (const rows of await Promise.all(waiting))
            expect(ids(rows)).toEqual([second.id]);
        expect(queries).toHaveLength(2);
        expect(program.slotPointCache.snapshot().inFlight).toBe(0);
    });

    it("cannot let an old generation's fill or finalizer touch a replacement cache", async () => {
        const original = naming("old");
        const { program, index, queries } = harness([original]);
        const previousCache = program.slotPointCache;
        const firstGate = parkNextRowQuery(program);
        const oldFill = program.slotRows("dir:left", "target.txt");
        await firstGate.parkedReached;

        // Model the exact generation and helper replacement performed by
        // open. The cache-race-slot suite exercises real close/open.
        program.openGeneration++;
        program.slotPointCache = new previousCache.constructor();
        const currentCache = program.slotPointCache;
        index.clear();
        const current = naming("new");
        index.set(current.id, current);
        const secondGate = parkNextRowQuery(program);
        const currentFill = program.slotRows("dir:left", "target.txt");
        await secondGate.parkedReached;
        try {
            firstGate.release();
            expect(ids(await oldFill)).toEqual([original.id]);
            expect(previousCache.snapshot().entries).toBe(0);
            expect(currentCache.snapshot().inFlight).toBe(1);
            const joined = program.slotRows("dir:left", "target.txt");
            await Promise.resolve();
            expect(queries).toHaveLength(2);
            secondGate.release();
            expect(ids(await currentFill)).toEqual([current.id]);
            expect(ids(await joined)).toEqual([current.id]);
            expect(currentCache.snapshot().inFlight).toBe(0);
            expect(ids(currentCache.getSlot("dir:left", "target.txt"))).toEqual(
                [current.id]
            );
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
        const cache = program.slotPointCache;
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
        expect(cache.snapshot()).toMatchObject({
            inFlight: 0,
            slots: 2,
            reverse: 2,
        });
        expect(ids(await program.sweepRows("dir:left"))).toEqual(
            ids([warm, cold])
        );
    });

    it.each([{ maxSlots: 1 }, { maxEstimatedBytes: 1024 }])(
        "re-reads a slot whose arrival cannot be retained (%j)",
        async (limits) => {
            const { program, queries, put } = harness();
            program.slotPointCache = new program.slotPointCache.constructor(
                limits
            );
            expect(await program.slotRows("dir:left", "target.txt")).toEqual(
                []
            );
            const arrived = naming("oversized");
            arrived.machineLabel = "x".repeat(2_000);
            put(arrived);
            // Admission limits bound retention; they cannot prove absence
            // or truncate the history returned from the backing index.
            expect(
                ids(await program.slotRows("dir:left", "target.txt"))
            ).toEqual([arrived.id]);
            expect(queries).toHaveLength(2);
            expect(program.slotPointCache.snapshot().rows).toBe(0);
        }
    );

    it("does not let a directory sweep that spans a cache replacement repopulate it", async () => {
        const existing = naming("present");
        const { program } = harness([existing]);
        const { parkedReached, release } = parkNextRowQuery(program);
        const sweep = program.sweepRows("dir:left");
        await parkedReached;
        // close()/open()/overlay retirement swap in a fresh map; no slot
        // epoch changes, so only the map identity fences the stale fill.
        const replacement = new Map();
        program.slotSweepCache = replacement;
        release();
        expect(ids(await sweep)).toEqual([existing.id]);
        expect(program.slotSweepCache).toBe(replacement);
        expect(replacement.has("dir:left")).toBe(false);
    });

    it("reads and caches a narrow unlisted directory whole, with no slot query", async () => {
        const present = naming("present", "dir:left", "name-7.txt");
        const { program, slotQueries, sweepQueries } = harness([present], {
            widthGate: true,
        });
        expect(ids(await program.slotRows("dir:left", "name-7.txt"))).toEqual([
            present.id,
        ]);
        expect(await program.slotRows("dir:left", "absent.txt")).toEqual([]);
        expect(sweepQueries("dir:left")).toHaveLength(1);
        expect(slotQueries("dir:left")).toHaveLength(0);
        expect(program.slotSweepCache.has("dir:left")).toBe(true);
        expect(program.slotPointCache.isWide("dir:left")).toBe(false);
    });

    it("serves a directory proven wide by the bounded read with exact-slot queries", async () => {
        const rows = [0, 1, 2].map((i) =>
            naming(`entry-${i}`, "dir:left", `name-${i}.txt`)
        );
        const { program, slotQueries, sweepQueries } = harness(rows, {
            widthGate: true,
        });
        program.slotPointCache = new program.slotPointCache.constructor({
            wideDirectoryRows: 2,
        });
        expect(ids(await program.slotRows("dir:left", "name-1.txt"))).toEqual([
            rows[1].id,
        ]);
        expect(sweepQueries("dir:left")).toHaveLength(1);
        expect(slotQueries("dir:left")).toHaveLength(1);
        expect(program.slotSweepCache.has("dir:left")).toBe(false);
        expect(program.slotPointCache.isWide("dir:left")).toBe(true);
        // Known wide: later lookups go straight to exact-slot queries.
        expect(ids(await program.slotRows("dir:left", "name-2.txt"))).toEqual([
            rows[2].id,
        ]);
        expect(sweepQueries("dir:left")).toHaveLength(1);
        expect(slotQueries("dir:left")).toHaveLength(2);
    });

    it("remembers a directory as wide after a full listing of it", async () => {
        const rows = [0, 1, 2].map((i) =>
            naming(`entry-${i}`, "dir:left", `name-${i}.txt`)
        );
        const { program } = harness(rows, { widthGate: true });
        program.slotPointCache = new program.slotPointCache.constructor({
            wideDirectoryRows: 2,
        });
        expect(await program.sweepRows("dir:left")).toHaveLength(3);
        expect(program.slotPointCache.isWide("dir:left")).toBe(true);
    });
});
