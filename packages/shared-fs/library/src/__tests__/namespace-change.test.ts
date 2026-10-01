import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    FileVersion,
    NamingEvent,
    ROOT_NODE_ID,
    openSharedFs,
    type IgnoreAwareFs,
    type SharedFsHandle,
    type SharedFsNamespaceChange,
} from "../index.js";

const crafted = { createdAt: 1n, authorKey: "feed", machineLabel: "feed" };

/** A replicated-looking naming event, put straight into the store. */
const namingEvent = (properties: {
    id: string;
    nodeId: string;
    parentId: string;
    name: string;
    parentNamingIds?: string[];
    causalDepth?: bigint;
    deleted?: boolean;
}) =>
    new NamingEvent({
        ...crafted,
        ...properties,
        causalDepth: properties.causalDepth ?? 1n,
    });

const fileVersion = (id: string, nodeId: string, parents: string[] = []) =>
    new FileVersion({
        ...crafted,
        id,
        nodeId,
        parentVersionIds: parents,
        causalDepth: BigInt(parents.length + 1),
        contentHash: `hash-${id}`,
        size: 0,
        mode: 0o100644,
        mtime: 1,
        chunkIds: [],
    });

/**
 * Counts the Map entries the namespace feed iterates while it judges each
 * change: copying or scanning a node's rows counts every row it visits.
 */
const countFeedMapEntries = (program: any) => {
    const prototype = Map.prototype as any;
    const methods: (string | symbol)[] = [
        "entries",
        "keys",
        "values",
        Symbol.iterator,
    ];
    const originals = methods.map((method) => prototype[method]);
    let counting = false;
    let entries = 0;
    methods.forEach((method, i) => {
        prototype[method] = function (this: Map<unknown, unknown>) {
            const iterator = originals[i].call(this);
            if (!counting) {
                return iterator;
            }
            return {
                next() {
                    const step = iterator.next();
                    if (!step.done) entries++;
                    return step;
                },
                [Symbol.iterator]() {
                    return this;
                },
            };
        };
    });
    const judge = program.namespaceChangeOf.bind(program);
    vi.spyOn(program, "namespaceChangeOf").mockImplementation(
        (...args: unknown[]) => {
            counting = true;
            try {
                return judge(...args);
            } finally {
                counting = false;
            }
        }
    );
    return {
        take: () => {
            const counted = entries;
            entries = 0;
            return counted;
        },
        restore: () => {
            methods.forEach((method, i) => (prototype[method] = originals[i]));
        },
    };
};

describe("shared fs namespace-change feed", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;
    let now: number;
    let batches: SharedFsNamespaceChange[];

    const naming = () => batches.flatMap((batch) => batch.naming);
    const take = () => batches.splice(0);

    beforeEach(async () => {
        now = Date.now();
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "namespace-feed",
            clock: () => now,
        });
        batches = [];
        fs.onNamespaceChange((change) => batches.push(change));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await peer.stop();
    });

    it("reports the slot of each mkdir, create, symlink, rm and rmdir once", async () => {
        await fs.mkdir("/d");
        const d = (await fs.stat("/d"))!;
        expect(naming()).toEqual([
            expect.objectContaining({
                nodeId: d.nodeId,
                parentId: ROOT_NODE_ID,
                name: "d",
                deleted: false,
                removed: false,
                supersedes: false,
            }),
        ]);
        expect(d.parentId).toBe(ROOT_NODE_ID);
        take();

        await fs.writeFile("/d/f.txt", "f");
        const f = (await fs.stat("/d/f.txt"))!;
        expect(f.parentId).toBe(d.nodeId);
        expect(naming()).toEqual([
            expect.objectContaining({
                nodeId: f.nodeId,
                parentId: d.nodeId,
                name: "f.txt",
                supersedes: false,
            }),
        ]);
        // A brand-new node's first version cannot prove an unforked history.
        expect(batches.some((batch) => batch.versionForkOrMerge)).toBe(true);
        // Local writes reach the caches twice; each id is reported once.
        const ids = batches.flatMap((batch) => batch.naming.map((i) => i.id));
        expect(new Set(ids).size).toBe(ids.length);
        take();

        await fs.writeFile("/d/link", "f.txt", { mode: 0o120000 });
        expect(naming()).toEqual([
            expect.objectContaining({ parentId: d.nodeId, name: "link" }),
        ]);
        take();

        await fs.rm("/d/f.txt");
        expect(naming()).toEqual([
            expect.objectContaining({
                nodeId: f.nodeId,
                parentId: d.nodeId,
                name: "f.txt",
                deleted: true,
                supersedes: true,
                head: true,
            }),
        ]);
        await fs.rm("/d/link");
        take();

        await fs.rm("/d");
        expect(naming()).toEqual([
            expect.objectContaining({
                nodeId: d.nodeId,
                parentId: ROOT_NODE_ID,
                deleted: true,
            }),
        ]);
    });

    it("reports a cross-directory rename and a rename-over", async () => {
        await fs.mkdir("/a");
        await fs.mkdir("/b");
        await fs.writeFile("/a/x.txt", "x");
        await fs.writeFile("/b/y.txt", "y");
        const [b, x, y] = await Promise.all(
            ["/b", "/a/x.txt", "/b/y.txt"].map(
                async (path) => (await fs.stat(path))!
            )
        );
        await fs.list("/a");
        take();

        await fs.rename("/a/x.txt", "/b/x.txt");
        expect(naming()).toEqual([
            expect.objectContaining({
                nodeId: x.nodeId,
                parentId: b.nodeId,
                name: "x.txt",
                deleted: false,
                supersedes: true,
                head: true,
            }),
        ]);
        expect(batches.some((batch) => batch.versionForkOrMerge)).toBe(false);
        take();

        // Replacing y tombstones its node, then moves x onto the name.
        await fs.rename("/b/x.txt", "/b/y.txt");
        expect(naming()).toEqual([
            expect.objectContaining({
                nodeId: y.nodeId,
                parentId: b.nodeId,
                deleted: true,
            }),
            expect.objectContaining({
                nodeId: x.nodeId,
                parentId: b.nodeId,
                name: "y.txt",
                deleted: false,
            }),
        ]);
    });

    it("reports every child a directory merge moves and the source tombstone", async () => {
        await fs.mkdir("/shared");
        const target = (await fs.stat("/shared"))!;
        await fs.writeFile("/shared/from-target.txt", "target");
        await fs.rename("/shared", "/held");
        await fs.mkdir("/shared");
        const source = (await fs.stat("/shared"))!;
        await fs.writeFile("/shared/from-source.txt", "source");
        const moved = (await fs.stat("/shared/from-source.txt"))!;
        await fs.resolveNamingConflict(target.nodeId, {
            type: "move",
            to: "/shared",
        });
        const expectedConflicts = (await fs.namingConflicts()).filter(
            (conflict) =>
                conflict.nodeId === source.nodeId ||
                conflict.shadowedNodeIds?.includes(source.nodeId)
        );
        take();

        await fs.resolveNamingConflict(
            source.nodeId,
            { type: "merge-directory" },
            { expectedConflicts }
        );
        expect(naming()).toEqual([
            expect.objectContaining({
                nodeId: moved.nodeId,
                parentId: target.nodeId,
                name: "from-source.txt",
                supersedes: true,
            }),
            expect.objectContaining({
                nodeId: source.nodeId,
                deleted: true,
            }),
        ]);
    });

    it("reports nothing for an overwrite and flags forks and merges", async () => {
        const v1 = await fs.writeFile("/f.txt", "v1");
        await fs.stat("/f.txt"); // warm version rows
        take();

        await fs.writeFile("/f.txt", "v2");
        expect(take()).toEqual([]);

        // A version whose parents miss a current head forks the file.
        await fs.writeFile("/f.txt", "concurrent", { baseVersionIds: [v1.id] });
        expect(take()).toEqual([
            {
                naming: [],
                moves: [],
                firstContent: [],
                contentLost: [],
                versionForkOrMerge: true,
                reset: false,
            },
        ]);
        // The next ordinary write merges both heads.
        await fs.writeFile("/f.txt", "merged");
        expect(take()).toEqual([
            expect.objectContaining({ naming: [], versionForkOrMerge: true }),
        ]);
    });

    it("marks a superseded ancestor that arrives after its descendant as no head", async () => {
        await fs.writeFile("/n.txt", "n");
        const [created] = naming();
        const e1 = namingEvent({
            id: "naming:feed-e1",
            nodeId: created.nodeId,
            parentId: ROOT_NODE_ID,
            name: "n1.txt",
            parentNamingIds: [created.id],
            causalDepth: 2n,
        });
        const e2 = namingEvent({
            id: "naming:feed-e2",
            nodeId: created.nodeId,
            parentId: ROOT_NODE_ID,
            name: "n2.txt",
            parentNamingIds: [e1.id],
            causalDepth: 3n,
        });
        await fs.program.entries.put(e2, { unique: true });
        expect(await fs.stat("/n2.txt")).toBeDefined(); // warms the rows
        take();

        await fs.program.entries.put(e1, { unique: true });
        expect(naming()).toEqual([
            expect.objectContaining({ id: e1.id, head: false }),
        ]);
    });

    it("reports GC-compacted naming rows as non-heads", async () => {
        await fs.writeFile("/chain.txt", "v");
        await fs.rename("/chain.txt", "/chain-b.txt");
        await fs.rename("/chain-b.txt", "/chain-c.txt");
        expect(await fs.stat("/chain-c.txt")).toBeDefined(); // warms the rows
        take();
        now += 60_000;

        const report = await fs.collectGarbage({
            settleMs: 0,
            chunkSweep: "immediate",
            nowMs: now,
            namingGraceMs: 0,
            namingHeadStabilityMs: 0,
        });
        expect(report.compactedNamingEvents).toBe(2);
        // One removal per change: the first drops the warm bucket, and the
        // kept rows still prove the second a non-head.
        const removals = batches.filter((batch) =>
            batch.naming.some((item) => item.removed)
        );
        expect(removals).toHaveLength(2);
        const removed = naming().filter((item) => item.removed);
        expect(removed.map((item) => item.head)).toEqual([false, false]);
    });

    it("judges each added or removed row against its node's heads, not its history", async () => {
        const program = fs.program as any;
        const history = 1_000;
        const items = 100;
        const base = await fs.writeFile("/log.txt", "base");
        const { nodeId } = (await fs.stat("/log.txt"))!; // warm rows
        const created = (await program.resolvePath("/log.txt")).winner;
        // Long version and naming histories, applied as the caches apply
        // replicated documents: writes in place, renames back and forth.
        const versions = [base.id];
        const version = () => {
            const next = fileVersion(`version:log-${versions.length}`, nodeId, [
                versions.at(-1)!,
            ]);
            versions.push(next.id);
            return next;
        };
        const names = [created];
        const rename = () => {
            const next = namingEvent({
                id: `naming:log-${names.length}`,
                nodeId,
                parentId: ROOT_NODE_ID,
                name: `log-${names.length % 2}.txt`,
                parentNamingIds: [names.at(-1)!.id],
                causalDepth: names.at(-1)!.causalDepth + 1n,
            });
            names.push(next);
            return next;
        };
        const oldest: (FileVersion | NamingEvent)[] = [
            await program.getDocument(base.id),
            await program.getDocument(created.id),
        ];
        for (let i = 0; i < history; i++) {
            const applied = [version(), rename()];
            oldest.push(...applied);
            program.applyCacheChanges(applied, []);
        }
        take();
        const entries = countFeedMapEntries(program);
        try {
            for (let i = 0; i < items; i++) {
                program.applyCacheChanges([version()], []);
            }
            // A version extending the only head forks nothing.
            expect(take()).toEqual([]);
            for (let i = 0; i < items; i++) {
                program.applyCacheChanges([rename()], []);
            }
            expect(take()).toHaveLength(items);
            // A collector retires the oldest rows first, one per change.
            for (const document of oldest.slice(0, items)) {
                program.applyCacheChanges([], [document]);
            }
            const retired = take();
            expect(retired).toHaveLength(items);
            expect(
                retired.flatMap((batch) => batch.naming.map((i) => i.head))
            ).toEqual(Array(items / 2).fill(false));
            expect(retired.flatMap((batch) => batch.contentLost)).toEqual([]);
            expect(retired.flatMap((batch) => batch.moves)).toEqual([]);
            // The first removal of each node copies its history once (the
            // cache's map may be held by a reader); otherwise each item costs
            // a few entries. Judging items against their histories would
            // visit about items x history entries.
            expect(entries.take()).toBeLessThan(3 * history);

            // Still exact: a sibling of the head forks the file.
            program.applyCacheChanges(
                [fileVersion("version:log-fork", nodeId, [versions.at(-2)!])],
                []
            );
            expect(take()).toEqual([
                expect.objectContaining({ versionForkOrMerge: true }),
            ]);
        } finally {
            entries.restore();
        }
    });

    it("attributes first content to the parent a listing saw the hidden node in", async () => {
        await fs.mkdir("/d");
        const d = (await fs.stat("/d"))!;
        const nodeId = "file:feed-late";
        await fs.program.entries.put(
            namingEvent({
                id: "naming:feed-late",
                nodeId,
                parentId: d.nodeId,
                name: "late.txt",
            }),
            { unique: true }
        );
        // A file without content is hidden from the listing.
        expect(await fs.list("/d")).toEqual([]);
        take();

        // v2 arrives before its parent v1: still the first content.
        await fs.program.entries.put(
            fileVersion("version:feed-late-2", nodeId, ["version:feed-late-1"]),
            { unique: true }
        );
        expect(batches.flatMap((batch) => batch.firstContent)).toEqual([
            { nodeId, parentIds: [d.nodeId] },
        ]);
        expect((await fs.list("/d")).map((entry) => entry.name)).toEqual([
            "late.txt",
        ]);
        take();

        await fs.program.entries.put(
            fileVersion("version:feed-late-1", nodeId),
            { unique: true }
        );
        expect(batches.flatMap((batch) => batch.firstContent)).toEqual([]);
    });

    it("looks up first content in one query once a listing's bucket was evicted", async () => {
        const program = fs.program as any;
        await fs.mkdir("/d");
        const d = (await fs.stat("/d"))!;
        const nodeId = "file:feed-evicted";
        await fs.program.entries.put(
            namingEvent({
                id: "naming:feed-evicted",
                nodeId,
                parentId: d.nodeId,
                name: "evicted.txt",
            }),
            { unique: true }
        );
        // The listing shows the hidden node's directory without it.
        expect(await fs.list("/d")).toEqual([]);
        expect(program.namingRowCache.has(nodeId)).toBe(true);

        // A cache bound evicts the bucket the listing warmed.
        const limit = program.constructor.CACHE_NODE_LIMIT;
        program.constructor.CACHE_NODE_LIMIT = 0;
        try {
            while (program.namingRowCache.has(nodeId)) {
                program.boundCache(program.namingRowCache);
            }
        } finally {
            program.constructor.CACHE_NODE_LIMIT = limit;
        }
        const attributed = new Promise<SharedFsNamespaceChange>((resolve) => {
            const off = fs.onNamespaceChange((change) => {
                if (change.firstContent.length > 0) {
                    off();
                    resolve(change);
                }
            });
        });
        const queries = program.rowQueries;

        await fs.program.entries.put(
            fileVersion("version:feed-evicted", nodeId),
            {
                unique: true,
            }
        );
        expect((await attributed).firstContent).toEqual([
            { nodeId, parentIds: [d.nodeId] },
        ]);
        expect(program.rowQueries - queries).toBe(1);
    });

    it("looks up first content once a listing skipped installing the hidden node's rows", async () => {
        const program = fs.program as any;
        await fs.mkdir("/d");
        const d = (await fs.stat("/d"))!;
        const nodeId = "file:feed-skipped";
        await fs.program.entries.put(
            namingEvent({
                id: "naming:feed-skipped",
                nodeId,
                parentId: d.nodeId,
                name: "skipped.txt",
            }),
            { unique: true }
        );
        program.namingRowCache.delete(nodeId);
        // A change for the node lands while the listing's fill is in flight:
        // the fill serves its rows but skips installing them.
        const queryRows = program.queryRows.bind(program);
        const spy = vi
            .spyOn(program, "queryRows")
            .mockImplementation(async (query: unknown) => {
                const rows = await queryRows(query);
                program.bumpEpoch(nodeId);
                return rows;
            });
        expect(await fs.list("/d")).toEqual([]);
        spy.mockRestore();
        expect(program.namingRowCache.has(nodeId)).toBe(false);
        const attributed = new Promise<SharedFsNamespaceChange>((resolve) => {
            const off = fs.onNamespaceChange((change) => {
                if (change.firstContent.length > 0) {
                    off();
                    resolve(change);
                }
            });
        });

        await fs.program.entries.put(
            fileVersion("version:feed-skipped", nodeId),
            { unique: true }
        );
        expect((await attributed).firstContent).toEqual([
            { nodeId, parentIds: [d.nodeId] },
        ]);
    });

    it("never looks up new files after evictions and epoch churn", async () => {
        const program = fs.program as any;
        // Every feed query goes through the attribution lookup.
        const attribute = vi.spyOn(program, "attributeNamespace");

        // Temp-file churn and listings overflow every cache bound: listed
        // and deleted nodes' buckets are evicted, and fills skip installs.
        const limit = program.constructor.CACHE_NODE_LIMIT;
        program.constructor.CACHE_NODE_LIMIT = 30;
        try {
            await fs.mkdir("/tmp");
            for (let i = 0; i < 60; i++) {
                await fs.writeFile(`/tmp/t-${i}.txt`, "t");
                await fs.list("/tmp");
                await fs.rm(`/tmp/t-${i}.txt`);
            }
            for (let i = 0; i < 100; i++) program.bumpEpoch(`churn-${i}`);
        } finally {
            program.constructor.CACHE_NODE_LIMIT = limit;
        }
        // None of them could be hidden in a listing.
        expect(program.namespaceUnsettled.size).toBe(0);

        await fs.mkdir("/after");
        for (let i = 0; i < 40; i++) {
            await fs.writeFile(`/after/file-${i}.txt`, "x");
        }
        expect(attribute).not.toHaveBeenCalled();
    });

    it("finds every placement of a hidden node that moves after its rows were evicted", async () => {
        const program = fs.program as any;
        for (const path of ["/d1", "/d2"]) await fs.mkdir(path);
        const [d1, d2] = [(await fs.stat("/d1"))!, (await fs.stat("/d2"))!];
        const nodeId = "file:feed-hidden-mover";
        const placed = namingEvent({
            id: "naming:feed-hidden-placed",
            nodeId,
            parentId: d1.nodeId,
            name: "x",
        });
        await fs.program.entries.put(placed, { unique: true });
        expect(await fs.list("/d1")).toEqual([]);
        const limit = program.constructor.CACHE_NODE_LIMIT;
        program.constructor.CACHE_NODE_LIMIT = 0;
        try {
            while (program.namingRowCache.has(nodeId)) {
                program.boundCache(program.namingRowCache);
            }
        } finally {
            program.constructor.CACHE_NODE_LIMIT = limit;
        }
        const attributed = new Promise<SharedFsNamespaceChange>((resolve) => {
            const off = fs.onNamespaceChange((change) => {
                if (change.moves.length > 0) {
                    off();
                    resolve(change);
                }
            });
        });

        await fs.program.entries.put(
            namingEvent({
                id: "naming:feed-hidden-moved",
                nodeId,
                parentId: d2.nodeId,
                name: "x",
                parentNamingIds: [placed.id],
                causalDepth: 2n,
            }),
            { unique: true }
        );
        expect((await attributed).moves).toEqual(
            expect.arrayContaining([
                { nodeId, from: { parentId: d1.nodeId, name: "x" } },
            ])
        );
    });

    it("flags sibling versions delivered in one change as a fork", async () => {
        const program = fs.program as any;
        const base = await fs.writeFile("/c.txt", "base");
        const { nodeId } = (await fs.stat("/c.txt"))!; // warm version rows
        const sibling = (id: string, parents: string[]) =>
            new FileVersion({
                ...crafted,
                id,
                nodeId,
                parentVersionIds: parents,
                causalDepth: 2n,
                contentHash: `hash-${id}`,
                size: 0,
                mode: 0o100644,
                mtime: 1,
                chunkIds: [],
            });
        // One sync delivers documents in one change event.
        const deliver = async (...values: FileVersion[]) => {
            const listener = program.changeListener;
            program.entries.events.removeEventListener("change", listener);
            try {
                for (const value of values) {
                    await program.entries.put(value, { unique: true });
                }
            } finally {
                program.entries.events.addEventListener("change", listener);
            }
            take();
            listener({ detail: { added: values, removed: [] } });
            return take();
        };

        // A linear chain is no fork.
        const v2 = sibling("version:feed-chain-2", [base.id]);
        const v3 = sibling("version:feed-chain-3", [v2.id]);
        expect(await deliver(v2, v3)).toEqual([]);

        const left = sibling("version:feed-left", [v3.id]);
        const right = sibling("version:feed-right", [v3.id]);
        expect(await deliver(left, right)).toEqual([
            expect.objectContaining({ versionForkOrMerge: true }),
        ]);
        expect(
            (await fs.conflicts()).map((conflict) => conflict.nodeId)
        ).toEqual([nodeId]);
    });

    it("reports the slot a hidden slot winner leaves", async () => {
        for (const path of ["/d1", "/d2"]) await fs.mkdir(path);
        await fs.writeFile("/d1/x", "m");
        const [d1, d2] = [(await fs.stat("/d1"))!, (await fs.stat("/d2"))!];
        const nodeId = "file:!feed-hidden";
        // Another writer's same-name create wins the slot (its id sorts
        // first) before its content arrives, hiding x.
        const claim = namingEvent({
            id: "naming:!feed-claim",
            nodeId,
            parentId: d1.nodeId,
            name: "x",
        });
        await fs.program.entries.put(claim, { unique: true });
        expect(await fs.list("/d1")).toEqual([]);
        take();

        // It moves on before its content arrives: d1 shows x again, though
        // the event names only d2.
        await fs.program.entries.put(
            namingEvent({
                id: "naming:!feed-moved",
                nodeId,
                parentId: d2.nodeId,
                name: "x",
                parentNamingIds: [claim.id],
                causalDepth: 2n,
            }),
            { unique: true }
        );
        expect(batches.flatMap((batch) => batch.moves)).toEqual([
            {
                nodeId,
                from: { parentId: d1.nodeId, name: "x" },
                to: { parentId: d2.nodeId, name: "x" },
            },
        ]);
        expect((await fs.list("/d1")).map((entry) => entry.name)).toEqual([
            "x",
        ]);
    });

    it("reports the placement a removed winning head re-exposes", async () => {
        const program = fs.program as any;
        for (const path of ["/d0", "/d1", "/d2"]) await fs.mkdir(path);
        await fs.writeFile("/d0/h.txt", "h");
        const created = (await program.resolvePath("/d0/h.txt")).winner;
        const [d1, d2] = [(await fs.stat("/d1"))!, (await fs.stat("/d2"))!];
        const shallow = namingEvent({
            id: "naming:feed-shallow",
            nodeId: created.nodeId,
            parentId: d2.nodeId,
            name: "h.txt",
            parentNamingIds: [created.id],
            causalDepth: created.causalDepth + 1n,
        });
        const deep = namingEvent({
            id: "naming:feed-deep",
            nodeId: created.nodeId,
            parentId: d1.nodeId,
            name: "h.txt",
            parentNamingIds: [created.id],
            causalDepth: created.causalDepth + 2n,
        });
        await fs.program.entries.put(shallow, { unique: true });
        await fs.program.entries.put(deep, { unique: true });
        expect((await fs.list("/d1")).map((entry) => entry.name)).toEqual([
            "h.txt",
        ]);
        take();

        // A collector elsewhere deletes the winning head before its
        // successor arrives (Guard D disarmed, as while unverified).
        program.guardArmed = false;
        await fs.program.entries.del(deep.id);
        expect(naming()).toEqual([
            expect.objectContaining({ id: deep.id, removed: true, head: true }),
        ]);
        expect(batches.flatMap((batch) => batch.moves)).toEqual([
            {
                nodeId: created.nodeId,
                from: { parentId: d1.nodeId, name: "h.txt" },
                to: { parentId: d2.nodeId, name: "h.txt" },
            },
        ]);
        expect((await fs.list("/d2")).map((entry) => entry.name)).toEqual([
            "h.txt",
        ]);
    });

    it("reports a file whose last version left the index, and its return", async () => {
        const program = fs.program as any;
        await fs.mkdir("/d");
        const d = (await fs.stat("/d"))!;
        const written = await fs.writeFile("/d/v.txt", "v1");
        const { nodeId } = (await fs.stat("/d/v.txt"))!; // warm rows
        const removed = await program.getDocument(written.id);
        take();

        // A remote delete arrives before the successor version.
        program.guardArmed = false;
        await fs.program.entries.del(written.id);
        expect(batches.flatMap((batch) => batch.contentLost)).toEqual([nodeId]);
        expect(await fs.list("/d")).toEqual([]);
        take();

        await fs.program.entries.put(removed, { unique: true });
        expect(batches.flatMap((batch) => batch.firstContent)).toEqual([
            { nodeId, parentIds: [d.nodeId] },
        ]);
    });

    it("reports no lost content when GC compacts old versions", async () => {
        await fs.writeFile("/kept.txt", "v1");
        await fs.writeFile("/kept.txt", "v2");
        await fs.writeFile("/kept.txt", "v3");
        expect(await fs.stat("/kept.txt")).toBeDefined(); // warms the rows
        take();
        now += 40 * 24 * 60 * 60 * 1000;

        const report = await fs.collectGarbage({
            settleMs: 0,
            chunkSweep: "immediate",
            // GC always keeps the head, so v1 and v2 retire. A keep count of
            // 1 would keep one of them at random: the three writes can share
            // a millisecond, and version ids break the createdAt tie.
            keepVersions: 0,
            nowMs: now,
        });
        expect(report.retiredVersions).toBe(2);
        // One removal per change: the first drops the warm bucket, and the
        // kept rows prove the second leaves content behind.
        expect(
            batches.filter((batch) => batch.versionForkOrMerge)
        ).toHaveLength(2);
        expect(batches.flatMap((batch) => batch.contentLost)).toEqual([]);
    });

    it("never edits a row map the cache handed out when GC removes rows", async () => {
        const program = fs.program as any;
        await fs.writeFile("/held.txt", "v1");
        await fs.writeFile("/held.txt", "v2");
        await fs.writeFile("/held.txt", "v3");
        const { nodeId } = (await fs.stat("/held.txt"))!;
        // A reader (readFile's history walk) may hold the warm bucket across
        // awaits while the collector removes rows.
        const held: Map<string, unknown> = program.versionRowCache.get(nodeId);
        expect(held.size).toBe(3);
        now += 40 * 24 * 60 * 60 * 1000;

        const report = await fs.collectGarbage({
            settleMs: 0,
            chunkSweep: "immediate",
            keepVersions: 0,
            nowMs: now,
        });
        expect(report.retiredVersions).toBe(2);
        expect(held.size).toBe(3);
        expect(batches.flatMap((batch) => batch.contentLost)).toEqual([]);
    });

    it("emits a reset when the bootstrap overlay retires, verified or not", async () => {
        const reset = {
            naming: [],
            moves: [],
            firstContent: [],
            contentLost: [],
            versionForkOrMerge: false,
            reset: true,
        };
        (fs.program as any).retireOverlay(true);
        expect(take()).toEqual([reset]);
        // A timed-out overlay leaves unproven documents out of the view.
        (fs.program as any).retireOverlay(false);
        expect(take()).toEqual([reset]);
    });

    it("stops reporting after unsubscribe and on close", async () => {
        const seen: SharedFsNamespaceChange[] = [];
        const off = fs.onNamespaceChange((change) => seen.push(change));
        await fs.mkdir("/one");
        off();
        await fs.mkdir("/two");
        expect(
            seen.flatMap((batch) => batch.naming.map((i) => i.name))
        ).toEqual(["one"]);
        expect(naming().map((item) => item.name)).toEqual(["one", "two"]);
        // A throwing subscriber cannot break cache maintenance.
        fs.onNamespaceChange(() => {
            throw new Error("subscriber failure");
        });
        await fs.mkdir("/three");
        expect((await fs.list("/")).map((entry) => entry.name)).toContain(
            "three"
        );
        await fs.program.close();
        expect((fs.program as any).namespaceListeners.size).toBe(0);
    });
});

describe("artifact-ignore namespace feed", () => {
    let peer: Peerbit;

    afterEach(async () => {
        await peer.stop();
    });

    it("emits a reset when the handle's ignore rules change", async () => {
        peer = await Peerbit.create();
        const fs = (await openSharedFs({
            peerbit: peer,
            machineLabel: "ignore-feed",
            ignore: {},
        })) as IgnoreAwareFs;
        await fs.mkdir("/logs");
        const reset = new Promise<void>((resolve) => {
            const off = fs.onNamespaceChange((change) => {
                if (change.reset) {
                    off();
                    resolve();
                }
            });
        });

        await fs.writeFile("/.artifactignore", "logs/\n");
        await reset;
        expect(fs.ignoreCheck("/logs/app.log").ignored).toBe(true);
    });
});
