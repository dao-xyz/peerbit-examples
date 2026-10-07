import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClosedError, StringMatch } from "@peerbit/document";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs } from "../index.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Full scans of the local index must not drain in small pages. The sqlite3
 * indexer pages an iterator with LIMIT/OFFSET, so a scan drained in fixed
 * pages re-skips every earlier row on every page: its cost grows with the
 * square of the store, which is what made a reopened large filesystem
 * spend minutes in its first snapshot and GC runs. This pins the cost as a
 * count, not a timing: the rows each read skipped over (its OFFSET) on the
 * filesystem's own index, summed over a cold reopen, a snapshot and a GC
 * plan. Draining in pages of 100 makes that sum quadratic in the file
 * count (8.4k, 32k, 125k skipped rows at 300, 600, 1200 files); index-only
 * scans read in one statement and document scans in pages far larger than
 * this store, so it stays zero. The count assumes the indexer's plain mode:
 * under concurrent writes it re-reads from offset 0 inside a single read,
 * which this test, with no writes during the scans, never enters.
 */
type ScanStats = { reads: number; rows: number; skippedRows: number };

/** One indexer iterator: its whole-kind match, its shape, what it read. */
type Scan = {
    index: object;
    kind?: string;
    shape?: Record<string, unknown>;
    reads: number;
    values: any[];
};

const FILES = 300;

/** The kind a query matches when it is exactly one kind match. */
const wholeKindOf = (query: unknown): string | undefined => {
    const parts = Array.isArray(query) ? query : [query];
    const [only] = parts;
    if (
        parts.length === 1 &&
        only instanceof StringMatch &&
        only.key.join(".") === "kind"
    ) {
        return only.value;
    }
    return undefined;
};

const countIndexReads = (proto: any) => {
    const byIndex = new WeakMap<object, ScanStats>();
    const scans: Scan[] = [];
    const original = proto.iterate;
    proto.iterate = function (this: object, ...args: any[]) {
        let stats = byIndex.get(this);
        if (!stats) {
            stats = { reads: 0, rows: 0, skippedRows: 0 };
            byIndex.set(this, stats);
        }
        const counted = stats;
        const scan: Scan = {
            index: this,
            kind: wholeKindOf(args[0]?.query),
            shape: args[1]?.shape,
            reads: 0,
            values: [],
        };
        scans.push(scan);
        const iterator = original.apply(this, args);
        // In the indexer's plain (non-mutation) mode a read's OFFSET is the
        // number of rows its iterator already returned.
        let returned = 0;
        for (const method of ["next", "all"] as const) {
            const read = iterator[method];
            iterator[method] = async (...readArgs: unknown[]) => {
                counted.reads++;
                scan.reads++;
                counted.skippedRows += returned;
                const rows = await read.apply(iterator, readArgs);
                returned += rows.length;
                counted.rows += rows.length;
                for (const row of rows) scan.values.push(row.value);
                return rows;
            };
        }
        return iterator;
    };
    return {
        of: (index: object): ScanStats => ({
            ...(byIndex.get(index) ?? { reads: 0, rows: 0, skippedRows: 0 }),
        }),
        scans,
        restore: () => {
            proto.iterate = original;
        },
    };
};

const ownerOf = (object: object, method: string) => {
    let proto = Object.getPrototypeOf(object);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, method)) {
        proto = Object.getPrototypeOf(proto);
    }
    if (!proto) throw new Error(`no prototype defines ${method}`);
    return proto;
};

/** How a read ended, in a form one assertion can compare. */
const outcomeOf = (read: Promise<unknown>) =>
    read.then(
        (value) => ({ resolved: value }),
        (error) =>
            error instanceof ClosedError
                ? "ClosedError"
                : { rejected: String(error) }
    );

/** The outcome of each named read, by name. */
const outcomesOf = async (reads: Record<string, Promise<unknown>>) =>
    Object.fromEntries(
        await Promise.all(
            Object.entries(reads).map(
                async ([name, read]) => [name, await outcomeOf(read)] as const
            )
        )
    );

describe("shared fs large reopen scans", () => {
    const peers: Peerbit[] = [];
    const roots: string[] = [];

    afterEach(async () => {
        await stopTestPeers(peers);
        await Promise.all(
            roots
                .splice(0)
                .map((root) => rm(root, { recursive: true, force: true }))
        );
    });

    it("reads every index row once across a cold reopen, a snapshot and a GC plan", async () => {
        const root = await mkdtemp(join(tmpdir(), "shared-fs-reopen-scans-"));
        roots.push(root);
        const directory = join(root, "peer");

        const creatorPeer = await Peerbit.create({ directory });
        peers.push(creatorPeer);
        const creator = await openSharedFs({
            peerbit: creatorPeer,
            machineLabel: "scan-creator",
            gc: false,
        });
        const files = Array.from({ length: FILES }, (_, file) => ({
            path: `/src/d${file % 7}/f${file}.ts`,
            content: `export const value${file} = ${file};\n`,
        }));
        const batch = await creator.writeBatch(files);
        expect(batch.results.filter(Boolean)).toHaveLength(FILES);
        const address = creator.address;
        const indexProto = ownerOf(
            (creator.program as any).entries.index.index,
            "iterate"
        );
        peers.splice(peers.indexOf(creatorPeer), 1);
        await creatorPeer.stop();

        const reads = countIndexReads(indexProto);
        try {
            const peer = await Peerbit.create({ directory });
            peers.push(peer);
            const fs = await openSharedFs({
                peerbit: peer,
                address,
                machineLabel: "scan-reopen",
                gc: false,
            });
            await fs.awaitWriteReady({ timeout: 30_000 });
            const index = (fs.program as any).entries.index.index;
            const indexRows = await index.count({});
            // Every kind holds at least one row per file, so a paged drain
            // of any kind would need several pages.
            expect(indexRows).toBeGreaterThan(3 * FILES);

            const opened = reads.of(index);
            const snapshot = await fs.snapshotWrite();
            expect(snapshot.docs).toBeGreaterThan(BigInt(2 * FILES));
            const afterSnapshot = reads.of(index);
            const gcScansFrom = reads.scans.length;
            const gcReport = await fs.collectGarbage({
                dryRun: true,
                settleMs: 0,
            });
            const afterGc = reads.of(index);
            const gcScans = reads.scans
                .slice(gcScansFrom)
                .filter((scan) => scan.index === index);

            expect(opened.skippedRows).toBe(0);
            expect(afterSnapshot.skippedRows).toBe(0);
            expect(afterGc.skippedRows).toBe(0);
            // Linear: a full scan returns each row once, and the snapshot and
            // the GC plan each scan a few kinds (about 5x today). A guard
            // against a scan per file, not a tight budget: the skipped-row
            // count above is what tells a paged drain apart.
            expect(afterGc.rows).toBeLessThanOrEqual(10 * indexRows);

            // GC reads only arrival bookkeeping from its index-only scans of
            // each kind, so it asks for id and three Context fields, never
            // the reference arrays or the payload columns, in bounded
            // pages. The document scans of naming and file-version rows
            // (through Documents, unshaped) are separate.
            const arrivalScans = gcScans.filter(
                (scan) => scan.kind && scan.shape
            );
            expect(new Set(arrivalScans.map((scan) => scan.kind))).toEqual(
                new Set([
                    "naming",
                    "file-version",
                    "file-chunk",
                    "changeset-manifest",
                ])
            );
            for (const scan of arrivalScans) {
                expect(scan.shape, scan.kind).toEqual({
                    id: true,
                    __context: { modified: true, head: true, size: true },
                });
            }
            for (const kind of ["file-chunk", "changeset-manifest"]) {
                expect(
                    gcScans.filter((scan) => scan.kind === kind && !scan.shape),
                    kind
                ).toEqual([]);
            }
            const arrivalRows = arrivalScans.flatMap((scan) => scan.values);
            expect(arrivalRows.length).toBeGreaterThanOrEqual(3 * FILES);
            for (const row of arrivalRows) {
                expect(typeof row.id).toBe("string");
                expect(typeof row.__context.modified).toBe("bigint");
                expect(typeof row.__context.head).toBe("string");
                expect(typeof row.__context.size).toBe("number");
                expect(row.__context.gid).toBeUndefined();
                expect(row.chunkRefs).toBeUndefined();
                expect(row.causalRefs).toBeUndefined();
            }

            // Scans larger than one read page continue across pages,
            // whether the last page is full (the page divides the kind) or
            // short, and match a single read.
            const program = fs.program as any;
            const scanClass = program.constructor;
            const defaultPages = {
                documents: scanClass.LOCAL_SCAN_PAGE,
                arrival: scanClass.ARRIVAL_SCAN_PAGE,
            };
            const ids = async (kind: string) =>
                (
                    await program.queryDocuments([
                        new StringMatch({ key: "kind", value: kind }),
                    ])
                )
                    .map((doc: { id: string }) => doc.id)
                    .sort();
            const arrivalIds = async (kind: string) =>
                (await program.arrivalRows(kind))
                    .map((row: { id: string }) => row.id)
                    .sort();
            const singleRead = {
                naming: await ids("naming"),
                version: await ids("file-version"),
                chunk: await arrivalIds("file-chunk"),
            };
            const namingCount = singleRead.naming.length;
            const divisor = [4, 2, 3, 5, 7].find(
                (candidate) => namingCount % candidate === 0
            );
            expect(divisor).toBeDefined();
            try {
                for (const page of [namingCount / divisor!, 64]) {
                    scanClass.LOCAL_SCAN_PAGE = page;
                    scanClass.ARRIVAL_SCAN_PAGE = page;
                    const before = reads.of(index).reads;
                    expect(await ids("naming")).toEqual(singleRead.naming);
                    expect(
                        reads.of(index).reads - before
                    ).toBeGreaterThanOrEqual(Math.ceil(namingCount / page));
                    expect(await ids("file-version")).toEqual(
                        singleRead.version
                    );
                    const scansBefore = reads.scans.length;
                    expect(await arrivalIds("naming")).toEqual(
                        singleRead.naming
                    );
                    expect(await arrivalIds("file-chunk")).toEqual(
                        singleRead.chunk
                    );
                    const [namingScan] = reads.scans.slice(scansBefore);
                    expect(namingScan.reads).toBeGreaterThanOrEqual(
                        Math.ceil(namingCount / page)
                    );
                }
                // The GC plan reads the same rows through the pages.
                expect(
                    await fs.collectGarbage({ dryRun: true, settleMs: 0 })
                ).toEqual(gcReport);
            } finally {
                scanClass.LOCAL_SCAN_PAGE = defaultPages.documents;
                scanClass.ARRIVAL_SCAN_PAGE = defaultPages.arrival;
            }

            // The reopen content probe asks each content kind for one row
            // through the kind index, never one Or across the kinds, which
            // the indexer plans as a sorted union of every content row.
            const probeIterates: unknown[] = [];
            const iterate = index.iterate;
            index.iterate = function (this: object, ...args: any[]) {
                probeIterates.push(args[0]?.query);
                return iterate.apply(this, args);
            };
            try {
                expect(await program.hasLocalContentRow()).toBe(true);
            } finally {
                delete index.iterate;
            }
            expect(probeIterates.map(wholeKindOf)).toEqual(["naming"]);
        } finally {
            reads.restore();
        }
    });

    it("the reopen content probe fails closed while the index is closing", async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "probe-closing",
            gc: false,
        });
        await fs.writeFile("/a.txt", "a");
        const program = fs.program as any;
        expect(await program.hasLocalContentRow()).toBe(true);

        // Hold the raw index in its closing state until the probes settle:
        // the window in which it answers every read with no rows.
        const documentIndex = program.entries.index;
        const rawIndex = documentIndex.index;
        const setClosing = rawIndex.setClosing;
        const clearStatements = rawIndex.clearStatements;
        let probes: Promise<PromiseSettledResult<boolean>[]> | undefined;
        rawIndex.setClosing = function (this: any, ...args: unknown[]) {
            const result = setClosing.apply(this, args);
            probes = Promise.allSettled([
                program.hasLocalContentRow(),
                program.preOpenContentProbe({}),
            ]);
            return result;
        };
        rawIndex.clearStatements = async function (
            this: any,
            ...args: unknown[]
        ) {
            await probes;
            return clearStatements.apply(this, args);
        };
        peers.splice(peers.indexOf(peer), 1);
        await peer.stop();

        expect(probes).toBeDefined();
        const [direct, consumer] = await probes!;
        expect(direct.status).toBe("rejected");
        expect((direct as PromiseRejectedResult).reason).toBeInstanceOf(
            ClosedError
        );
        // The pre-open probe counts an unreadable index as content.
        expect(consumer).toEqual({ status: "fulfilled", value: true });
    });

    it("index-only lookups reject with ClosedError while the index is closing", async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "lookup-closing",
            gc: false,
        });
        const changesetId = "closing-turn";
        await fs.writeBatch(
            [
                { path: "/a.txt", content: "a" },
                { path: "/d/b.txt", content: "b" },
            ],
            { changesetId }
        );
        const program = fs.program as any;
        const fileId = (await fs.stat("/a.txt"))!.nodeId;
        expect((await fs.list("/")).map((entry) => entry.name)).toEqual([
            "a.txt",
            "d",
        ]);
        expect(
            (await fs.versionsByChangeset(changesetId)).versions
        ).toHaveLength(2);
        // Cold caches, as after a reopen, so each lookup reads the index.
        program.slotSweepCache.clear();
        program.slotPointCache.clear();
        program.namingRowCache.clear();
        program.versionRowCache.clear();

        // Reads that start while the store is open and return once its raw
        // index is closing: slot, listing, naming, version and changeset
        // reads by their query fields, the arrival scan by its shape.
        const documentIndex = program.entries.index;
        const rawIndex = documentIndex.index;
        const heldKeys = new Set(["parentId", "nodeId", "changesetId"]);
        const holds = (args: any[]) =>
            args[1]?.shape?.__context !== undefined ||
            (Array.isArray(args[0]?.query) &&
                args[0].query.some(
                    (part: unknown) =>
                        part instanceof StringMatch &&
                        heldKeys.has(part.key.join("."))
                ));
        let markClosing!: () => void;
        const closing = new Promise<void>((resolve) => {
            markClosing = resolve;
        });
        // One per read in `inFlight` below.
        const heldReads = 6;
        let held = 0;
        let allHeld!: () => void;
        const reachedAll = new Promise<void>((resolve) => {
            allHeld = resolve;
        });
        const iterate = rawIndex.iterate;
        rawIndex.iterate = function (this: object, ...args: any[]) {
            const iterator = iterate.apply(this, args);
            if (!holds(args)) {
                return iterator;
            }
            let first = true;
            for (const method of ["next", "all"] as const) {
                const read = iterator[method];
                iterator[method] = async (...readArgs: unknown[]) => {
                    if (first) {
                        first = false;
                        if (++held === heldReads) allHeld();
                    }
                    await closing;
                    return read.apply(iterator, readArgs);
                };
            }
            return iterator;
        };
        const inFlight = outcomesOf({
            "stat /a.txt": fs.stat("/a.txt"),
            "list /": fs.list("/"),
            versionsByChangeset: fs.versionsByChangeset(changesetId),
            namingStatesForNodes: program.namingStatesForNodes([fileId]),
            headsForNodes: program.headsForNodes([fileId]),
            "arrivalRows naming": program.arrivalRows("naming"),
        });
        await reachedAll;

        // Hold the raw index in its closing state until every read settles,
        // and start the same reads again once it is closing.
        const setClosing = rawIndex.setClosing;
        const clearStatements = rawIndex.clearStatements;
        let started: ReturnType<typeof outcomesOf> | undefined;
        rawIndex.setClosing = function (this: any, ...args: unknown[]) {
            const result = setClosing.apply(this, args);
            started = outcomesOf({
                "stat /a.txt": fs.stat("/a.txt"),
                "stat /d/b.txt": fs.stat("/d/b.txt"),
                "list /": fs.list("/"),
                "list /d": fs.list("/d"),
                versionsByChangeset: fs.versionsByChangeset(changesetId),
                namingStatesForNodes: program.namingStatesForNodes([fileId]),
                headsForNodes: program.headsForNodes([fileId]),
                "arrivalRows file-chunk": program.arrivalRows("file-chunk"),
            });
            markClosing();
            return result;
        };
        rawIndex.clearStatements = async function (
            this: any,
            ...args: unknown[]
        ) {
            await Promise.all([inFlight, started]);
            return clearStatements.apply(this, args);
        };
        peers.splice(peers.indexOf(peer), 1);
        await peer.stop();

        expect(started).toBeDefined();
        const closedAll = (outcomes: Record<string, unknown>) =>
            Object.fromEntries(
                Object.keys(outcomes).map((name) => [name, "ClosedError"])
            );
        const outcomes = {
            inFlight: await inFlight,
            started: await started!,
        };
        expect(outcomes).toEqual({
            inFlight: closedAll(outcomes.inFlight),
            started: closedAll(outcomes.started),
        });
    });

    it("an index-only lookup that spans a close and reopen rejects with ClosedError", async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "lookup-reopen",
            gc: false,
        });
        await fs.writeFile("/a.txt", "a");
        const program = fs.program as any;
        program.slotSweepCache.clear();
        program.slotPointCache.clear();

        // Hold the lookup's slot read until the store has closed and opened
        // again: its rows may belong to neither open.
        const rawIndex = program.entries.index.index;
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        let reached!: () => void;
        const held = new Promise<void>((resolve) => {
            reached = resolve;
        });
        const iterate = rawIndex.iterate;
        rawIndex.iterate = function (this: object, ...args: any[]) {
            const iterator = iterate.apply(this, args);
            delete rawIndex.iterate;
            for (const method of ["next", "all"] as const) {
                const read = iterator[method];
                iterator[method] = async (...readArgs: unknown[]) => {
                    reached();
                    await released;
                    return read.apply(iterator, readArgs);
                };
            }
            return iterator;
        };
        const lookup = outcomeOf(fs.stat("/a.txt"));
        await held;
        await program.close();
        await (peer as any).open(program, {
            existing: "reuse",
            args: {
                machineLabel: "lookup-reopen",
                addressOpen: true,
                bootstrap: false,
                snapshot: { disabled: true },
                gc: false,
            },
        });
        release();

        expect(await lookup).toBe("ClosedError");
        expect((await fs.stat("/a.txt"))?.name).toBe("a.txt");
    });
});
