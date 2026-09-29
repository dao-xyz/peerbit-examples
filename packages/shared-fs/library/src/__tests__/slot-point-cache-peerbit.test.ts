import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forcePointTier } from "./cache-race-park.js";
import {
    NamingEvent,
    ROOT_NODE_ID,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

/** Resolves once the program has applied a matching change event. */
const nextChange = (program: any, matches: (detail: any) => boolean) =>
    new Promise<void>((resolve) => {
        const listener = (event: any) => {
            if (!matches(event?.detail ?? {})) return;
            program.entries.events.removeEventListener("change", listener);
            resolve();
        };
        program.entries.events.addEventListener("change", listener);
    });

type Predicates = Record<string, string | undefined>;

/** Records the StringMatch predicates of every row query. */
const recordQueries = (program: any) => {
    const queries: Predicates[] = [];
    const queryRows = program.queryRows.bind(program);
    program.queryRows = async (query: any[]) => {
        queries.push(
            Object.fromEntries(
                query
                    .filter((clause) => clause.key !== undefined)
                    .map((clause) => [
                        [clause.key].flat().join("."),
                        clause.value,
                    ])
            )
        );
        return queryRows(query);
    };
    const queryRowsUpTo = program.queryRowsUpTo.bind(program);
    program.queryRowsUpTo = async (query: any[], limit: number) => {
        queries.push({
            ...Object.fromEntries(
                query
                    .filter((clause) => clause.key !== undefined)
                    .map((clause) => [
                        [clause.key].flat().join("."),
                        clause.value,
                    ])
            ),
            bounded: String(limit),
        });
        return queryRowsUpTo(query, limit);
    };
    return queries;
};

describe("shared fs slot point cache (real index)", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;
    let undoPointTier: () => void;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "slot-point",
            // No genesis manifest: publishing it reads /.artifactignore,
            // which would warm the root's whole-directory tier before
            // forcePointTier below.
            snapshot: { disabled: true },
        });
        // Most cases target the point tier; the width-gate case undoes this.
        undoPointTier = forcePointTier(fs.program);
    });

    afterEach(async () => {
        try {
            await peer.stop();
        } catch (error) {
            if (
                !(
                    error instanceof TypeError &&
                    error.message.includes("clearAll")
                )
            ) {
                throw error;
            }
        }
    });

    it("serves stat and absence from a listed directory with zero row queries", async () => {
        await fs.mkdir("/dir");
        await fs.writeBatch(
            Array.from({ length: 50 }, (_, index) => ({
                path: `/dir/f-${index}.txt`,
                content: `v${index}`,
            }))
        );
        const program: any = fs.program;
        program.slotSweepCache.clear();
        program.slotPointCache.clear();
        expect(await fs.list("/dir")).toHaveLength(50);
        const dirId = (await fs.stat("/dir"))!.nodeId;
        expect(program.slotSweepCache.has(dirId)).toBe(true);

        const pointBefore = program.slotPointCache.snapshot();
        const queriesBefore = program.rowQueries;
        for (const index of [0, 25, 49]) {
            expect((await fs.stat(`/dir/f-${index}.txt`))?.name).toBe(
                `f-${index}.txt`
            );
        }
        expect(await fs.stat("/dir/missing.txt")).toBeUndefined();
        expect(program.rowQueries).toBe(queriesBefore);
        // The listing answered; no point slot was filled for its children.
        expect(program.slotPointCache.snapshot()).toEqual(pointBefore);
    });

    it("stats an unlisted directory with one exact-slot query and no sweep, then from the point cache", async () => {
        await fs.mkdir("/wide");
        await fs.writeBatch(
            Array.from({ length: 200 }, (_, index) => ({
                path: `/wide/entry-${String(index).padStart(3, "0")}.txt`,
                content: `value ${index}`,
            }))
        );
        const program: any = fs.program;
        const wideId = (await fs.stat("/wide"))!.nodeId;
        program.slotSweepCache.clear();
        program.slotPointCache.clear();
        program.namingRowCache.clear();
        program.versionRowCache.clear();
        // Known wide (as a >2,048-row directory would be after one bounded
        // read), so lookups take the exact-slot path under test here.
        program.slotPointCache.markWide(ROOT_NODE_ID);
        program.slotPointCache.markWide(wideId);
        const queries = recordQueries(program);

        expect((await fs.stat("/wide/entry-100.txt"))?.name).toBe(
            "entry-100.txt"
        );
        const underWide = queries.filter((q) => q.parentId === wideId);
        expect(underWide).toEqual([
            { parentId: wideId, name: "entry-100.txt" },
        ]);
        expect(queries.filter((q) => q.parentId === ROOT_NODE_ID)).toEqual([
            { parentId: ROOT_NODE_ID, name: "wide" },
        ]);

        queries.length = 0;
        for (let index = 0; index < 25; index++) {
            expect(await fs.stat("/wide/entry-100.txt")).toBeDefined();
            expect(await fs.stat("/wide/absent.txt")).toBeUndefined();
        }
        // One cold negative, then nothing.
        expect(queries).toEqual([{ parentId: wideId, name: "absent.txt" }]);
        expect(program.slotSweepCache.size).toBe(0);
        expect(program.slotPointCache.snapshot()).toMatchObject({
            parents: 2,
            slots: 3,
            rows: 2,
        });
    });

    it("reads a narrow unlisted directory whole and never issues an exact-slot query", async () => {
        await fs.mkdir("/narrow");
        await fs.writeBatch(
            Array.from({ length: 50 }, (_, index) => ({
                path: `/narrow/entry-${index}.txt`,
                content: `value ${index}`,
            }))
        );
        undoPointTier();
        const program: any = fs.program;
        const narrowId = (await fs.stat("/narrow"))!.nodeId;
        program.slotSweepCache.clear();
        program.slotPointCache.clear();
        const queries = recordQueries(program);

        expect((await fs.stat("/narrow/entry-7.txt"))?.name).toBe(
            "entry-7.txt"
        );
        expect(await fs.stat("/narrow/absent.txt")).toBeUndefined();
        await fs.writeFile("/narrow/new.txt", "new");
        expect(queries.filter((q) => q.parentId === narrowId)).toEqual([
            { kind: "naming", parentId: narrowId, bounded: "2048" },
        ]);
        // No (parentId, name) query shape at all: the planner never creates
        // those indexes for a filesystem without wide directories.
        expect(queries.filter((q) => q.name !== undefined)).toEqual([]);
        expect(program.slotPointCache.isWide(narrowId)).toBe(false);
    });
    it("moves a same-id Documents replacement out of its old name", async () => {
        await fs.writeFile("/before.txt", "content");
        const originalInfo = (await fs.stat("/before.txt"))!;
        const program: any = fs.program;
        const original = (await program.namingStateForNode(originalInfo.nodeId))
            .winner;

        // Warm both point slots before bypassing the append-only public API.
        // Documents reports this replacement as an added row, so the cache
        // must relocate the existing id.
        expect(
            (await program.slotRows(ROOT_NODE_ID, "before.txt")).map(
                (row: any) => row.id
            )
        ).toContain(original.id);
        expect(await program.slotRows(ROOT_NODE_ID, "after.txt")).toEqual([]);
        const replaced = nextChange(program, (detail) =>
            (detail.added ?? []).some((value: any) => value?.id === original.id)
        );
        await program.entries.put(
            new NamingEvent({
                id: original.id,
                nodeId: original.nodeId,
                parentId: original.parentId,
                name: "after.txt",
                deleted: original.deleted,
                causalDepth: original.causalDepth,
                parentNamingIds: original.parentNamingIds,
                createdAt: original.createdAt + 1n,
                authorKey: original.authorKey,
                machineLabel: original.machineLabel,
                changesetId: original.changesetId,
            })
        );
        await replaced;

        expect(
            program.slotPointCache.getSlot(ROOT_NODE_ID, "before.txt")
        ).toBeUndefined();
        expect(
            (await program.slotRows(ROOT_NODE_ID, "after.txt")).map(
                (row: any) => row.id
            )
        ).toEqual([original.id]);
        expect(
            (await program.slotRows(ROOT_NODE_ID, "before.txt")).some(
                (row: any) => row.id === original.id
            )
        ).toBe(false);
        expect(await fs.stat("/before.txt")).toBeUndefined();
        expect((await fs.stat("/after.txt"))?.nodeId).toBe(originalInfo.nodeId);
        expect(decode(await fs.readFile("/after.txt"))).toBe("content");
    });

    it("moves a same-id Documents replacement out of its old parent", async () => {
        await fs.mkdir("/left");
        await fs.mkdir("/right");
        await fs.writeFile("/left/moved.txt", "content");
        const right = (await fs.stat("/right"))!;
        const left = (await fs.stat("/left"))!;
        const originalInfo = (await fs.stat("/left/moved.txt"))!;
        const program: any = fs.program;
        const original = (await program.namingStateForNode(originalInfo.nodeId))
            .winner;
        // Exercise the point tier: both directories count as wide, so no
        // listing answers these slots.
        program.slotSweepCache.clear();
        program.slotPointCache.markWide(left.nodeId);
        program.slotPointCache.markWide(right.nodeId);

        expect(
            (await program.slotRows(left.nodeId, "moved.txt")).map(
                (row: any) => row.id
            )
        ).toContain(original.id);
        expect(await program.slotRows(right.nodeId, "arrived.txt")).toEqual([]);
        const replaced = nextChange(program, (detail) =>
            (detail.added ?? []).some((value: any) => value?.id === original.id)
        );
        await program.entries.put(
            new NamingEvent({
                id: original.id,
                nodeId: original.nodeId,
                parentId: right.nodeId,
                name: "arrived.txt",
                deleted: original.deleted,
                causalDepth: original.causalDepth,
                parentNamingIds: original.parentNamingIds,
                createdAt: original.createdAt + 1n,
                authorKey: original.authorKey,
                machineLabel: original.machineLabel,
                changesetId: original.changesetId,
            })
        );
        await replaced;

        expect(
            program.slotPointCache.getSlot(left.nodeId, "moved.txt")
        ).toBeUndefined();
        expect(
            (await program.slotRows(right.nodeId, "arrived.txt")).map(
                (row: any) => row.id
            )
        ).toEqual([original.id]);
        expect(
            (await program.slotRows(left.nodeId, "moved.txt")).some(
                (row: any) => row.id === original.id
            )
        ).toBe(false);
        expect(await fs.stat("/left/moved.txt")).toBeUndefined();
        expect((await fs.stat("/right/arrived.txt"))?.nodeId).toBe(
            originalInfo.nodeId
        );
        expect(decode(await fs.readFile("/right/arrived.txt"))).toBe("content");
    });

    it("retains every claimant history through delete, restore, and move", async () => {
        await fs.writeFile("/note.txt", "first life");
        const first = (await fs.stat("/note.txt"))!;
        await fs.rm("/note.txt");
        await fs.writeFile("/note.txt", "second life");
        const second = (await fs.stat("/note.txt"))!;

        await fs.program.resolveNamingConflict(first.nodeId, {
            type: "restore",
        });
        const duplicate = (await fs.namingConflicts()).find(
            (conflict) =>
                conflict.type === "duplicate-name" &&
                conflict.path === "/note.txt"
        );
        expect(duplicate).toBeDefined();
        expect(
            new Set([duplicate!.nodeId, ...duplicate!.shadowedNodeIds!])
        ).toEqual(new Set([first.nodeId, second.nodeId]));

        const shadowed = duplicate!.shadowedNodeIds![0];
        await fs.program.resolveNamingConflict(shadowed, {
            type: "move",
            to: "/note-restored.txt",
        });

        expect(await fs.namingConflicts()).toEqual([]);
        expect(
            new Set([
                decode(await fs.readFile("/note.txt")),
                decode(await fs.readFile("/note-restored.txt")),
            ])
        ).toEqual(new Set(["first life", "second life"]));
    });

    it("reads versions and applies rename and delete identically through either tier", async () => {
        await fs.mkdir("/docs");
        await fs.writeFile("/docs/a.txt", "a1");
        const a2 = await fs.writeFile("/docs/a.txt", "a2");
        await fs.writeFile("/docs/b.txt", "b1");
        await fs.writeFile("/docs/c.txt", "c1");
        const program: any = fs.program;
        const docsId = (await fs.stat("/docs"))!.nodeId;
        const pointTier = () => {
            program.slotSweepCache.clear();
        };
        const listingTier = async () => {
            await fs.list("/docs");
            expect(program.slotSweepCache.has(docsId)).toBe(true);
        };
        const paths = [
            "/docs/a.txt",
            "/docs/b.txt",
            "/docs/b2.txt",
            "/docs/c.txt",
            "/docs/renamed.txt",
            "/docs/missing.txt",
        ];
        const observe = async () => {
            const view: Record<string, unknown> = {};
            for (const path of paths) {
                const info = await fs.stat(path);
                const read = await fs.readFileWithVersion(path);
                const exact = await fs.readFileWithVersion(path, {
                    mode: "exact",
                });
                view[path] = info && {
                    nodeId: info.nodeId,
                    name: info.name,
                    conflict: info.conflict,
                    versionId: read?.versionId,
                    exactVersionId: exact?.versionId,
                    bytes: decode(read?.bytes),
                };
            }
            return view;
        };
        const both = async () => {
            pointTier();
            const point = await observe();
            expect(program.slotSweepCache.has(docsId)).toBe(false);
            await listingTier();
            const listed = await observe();
            expect(listed).toEqual(point);
            return point;
        };

        const initial = await both();
        expect(initial["/docs/a.txt"]).toMatchObject({
            versionId: a2.id,
            exactVersionId: a2.id,
            bytes: "a2",
        });
        const aNode = (initial["/docs/a.txt"] as any).nodeId;

        // Mutate through the point tier, then through the listing tier.
        pointTier();
        await fs.rename("/docs/a.txt", "/docs/renamed.txt");
        await fs.rm("/docs/c.txt");
        await listingTier();
        await fs.rename("/docs/b.txt", "/docs/b2.txt");

        const after = await both();
        expect(after["/docs/a.txt"]).toBeUndefined();
        expect(after["/docs/b.txt"]).toBeUndefined();
        expect(after["/docs/c.txt"]).toBeUndefined();
        expect(after["/docs/renamed.txt"]).toMatchObject({
            nodeId: aNode,
            versionId: a2.id,
            bytes: "a2",
        });
        expect(after["/docs/b2.txt"]).toMatchObject({ bytes: "b1" });
        expect((await fs.list("/docs")).map((entry) => entry.name)).toEqual([
            "b2.txt",
            "renamed.txt",
        ]);
    });

    it("unions exact overlay slots and clears both caches on either retirement", async () => {
        const program: any = fs.program;
        program.bootstrapPhase = "fetching";
        program.bootstrapVerified = false;
        // Warm a negative REAL-index slot first. Overlay installation does
        // not bump real-index epochs, so the later positive result proves
        // overlay rows are unioned dynamically rather than cached.
        expect(
            await program.slotResolution(ROOT_NODE_ID, "overlay-only")
        ).toBeUndefined();
        program.installOverlayDoc(
            new NamingEvent({
                id: "naming:overlay-only",
                nodeId: "dir:overlay-only",
                parentId: ROOT_NODE_ID,
                name: "overlay-only",
                causalDepth: 1n,
                parentNamingIds: [],
                createdAt: 1n,
                authorKey: "overlay-author",
                machineLabel: "overlay-machine",
            })
        );

        // Installation during fetching is not visible until the complete
        // overlay switches on atomically.
        expect(
            await program.slotResolution(ROOT_NODE_ID, "overlay-only")
        ).toBeUndefined();
        program.bootstrapPhase = "overlay-active";
        expect(
            (await program.slotResolution(ROOT_NODE_ID, "overlay-only"))?.nodeId
        ).toBe("dir:overlay-only");
        await fs.list("/");
        expect(program.slotSweepCache.has(ROOT_NODE_ID)).toBe(true);

        program.retireOverlay(true, program.openGeneration);
        expect(program.overlaySweep.size).toBe(0);
        expect(program.slotPointCache.snapshot().entries).toBe(0);
        expect(program.slotSweepCache.size).toBe(0);
        expect(
            await program.slotResolution(ROOT_NODE_ID, "overlay-only")
        ).toBeUndefined();

        program.bootstrapPhase = "overlay-active";
        program.installOverlayDoc(
            new NamingEvent({
                id: "naming:overlay-timeout",
                nodeId: "dir:overlay-timeout",
                parentId: ROOT_NODE_ID,
                name: "overlay-timeout",
                causalDepth: 1n,
                parentNamingIds: [],
                createdAt: 2n,
                authorKey: "overlay-author",
                machineLabel: "overlay-machine",
            })
        );
        expect(
            (await program.slotResolution(ROOT_NODE_ID, "overlay-timeout"))
                ?.nodeId
        ).toBe("dir:overlay-timeout");
        program.retireOverlay(false, program.openGeneration);
        program.clearBootstrapTimers();
        expect(program.overlaySweep.size).toBe(0);
        expect(program.slotPointCache.snapshot().entries).toBe(0);
        expect(await fs.stat("/overlay-timeout")).toBeUndefined();
    });

    it("releases both slot caches on close and starts empty after same-program reopen", async () => {
        await fs.writeFile("/persisted.txt", "persisted");
        expect(await fs.stat("/persisted.txt")).toBeDefined();
        const program: any = fs.program;
        const previousPoint = program.slotPointCache;
        expect(previousPoint.snapshot().entries).toBeGreaterThan(0);
        expect(previousPoint.snapshot().reverse).toBeGreaterThan(0);
        await fs.list("/");
        const previousSweeps = program.slotSweepCache;
        expect(previousSweeps.size).toBeGreaterThan(0);

        await program.close();
        expect(program.slotPointCache).not.toBe(previousPoint);
        expect(program.slotPointCache.snapshot().entries).toBe(0);
        expect(program.slotSweepCache.size).toBe(0);

        const reopened = await (peer as any).open(program, {
            existing: "reuse",
            args: {
                machineLabel: "slot-point-reopen",
                addressOpen: true,
                bootstrap: false,
                snapshot: { disabled: true },
                gc: false,
            },
        });
        expect(reopened).toBe(program);
        expect(program.slotPointCache).not.toBe(previousPoint);
        expect(program.slotPointCache.snapshot()).toMatchObject({
            entries: 0,
            reverse: 0,
        });
        expect(program.slotSweepCache).not.toBe(previousSweeps);
        expect(program.slotSweepCache.size).toBe(0);
        expect(decode(await fs.readFile("/persisted.txt"))).toBe("persisted");
    });
});
