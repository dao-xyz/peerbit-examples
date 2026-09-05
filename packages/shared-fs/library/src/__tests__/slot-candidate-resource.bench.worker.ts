/**
 * Manual, fresh-process disk-index/cache resource probe. This bypasses
 * Documents writes, authentication, replication, file bytes, and mounts.
 * Run each case in a separate node --expose-gc --import tsx process.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { create } from "@peerbit/indexer-sqlite3";
import {
    IndexableSharedFsEntry,
    NamingEvent,
    SharedFileSystem,
} from "../index.js";

const width = Number(process.argv[2] ?? 100_000);
const sameName = process.argv[3] === "same-name";
assert(Number.isInteger(width) && width >= 100 && width <= 100_000);
assert([undefined, "unique", "same-name"].includes(process.argv[3]));
assert(global.gc, "run with --expose-gc");
const parentId = "dir:resource-wide";
const targetName = sameName ? "shared.txt" : "entry-000000.txt";
const directory = await mkdtemp(join(tmpdir(), "shared-fs-slot-resource-"));
const indices = await create(directory);
const program: any = new SharedFileSystem();
const samples: Record<string, unknown> = {};
const peaks: Record<string, number> = {};
const memory = () => {
    const { heapUsed, heapTotal, rss, external, arrayBuffers } =
        process.memoryUsage();
    return { heapUsed, heapTotal, rss, external, arrayBuffers };
};
const samplePeak = () => {
    for (const [key, value] of Object.entries(memory())) {
        peaks[key] = Math.max(peaks[key] ?? 0, value);
    }
};
const gc = async () => {
    for (let i = 0; i < 3; i++) {
        global.gc!();
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
};
const checkpoint = async (name: string) => {
    const beforeGc = memory();
    samplePeak();
    await gc();
    samples[name] = { beforeGc, afterGc: memory() };
};
const quantiles = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
    return {
        count: sorted.length,
        p50Ms: at(0.5),
        p95Ms: at(0.95),
        p99Ms: at(0.99),
    };
};
const cardinalities = () => {
    let names = 0;
    let rows = 0;
    for (const bucket of program.slotSweepCache.values()) {
        names += bucket.size;
        for (const value of bucket.values()) {
            rows += Array.isArray(value) ? value.length : 1;
        }
    }
    return {
        parents: program.slotSweepCache.size,
        names,
        rows,
        reverse: program.slotPlacementById.size,
    };
};
const event = (i: number, options: { parent?: string; name?: string } = {}) =>
    new NamingEvent({
        id: `naming:resource-${i}`,
        nodeId: `file:resource-${i}`,
        parentId: options.parent ?? parentId,
        name:
            options.name ??
            (sameName
                ? "shared.txt"
                : `entry-${String(i).padStart(6, "0")}.txt`),
        deleted: false,
        causalDepth: 1n,
        parentNamingIds: [],
        createdAt: BigInt(i + 1),
        authorKey: "resource-author",
        machineLabel: "resource-machine",
    });
const directoryBytes = async (path: string): Promise<number> => {
    let total = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        total += entry.isDirectory()
            ? await directoryBytes(child)
            : (await stat(child)).size;
    }
    return total;
};
const versions = Object.fromEntries(
    await Promise.all(
        [
            "peerbit",
            "@peerbit/document",
            "@peerbit/shared-log",
            "@peerbit/indexer-sqlite3",
        ].map(async (name) => [
            name,
            JSON.parse(
                await readFile(
                    new URL(
                        `../../node_modules/${name}/package.json`,
                        import.meta.url
                    ),
                    "utf8"
                )
            ).version,
        ])
    )
);
const lockfileSha256 = createHash("sha256")
    .update(
        await readFile(
            new URL("../../../../../pnpm-lock.yaml", import.meta.url)
        )
    )
    .digest("hex");
const cacheSourceSha256 = createHash("sha256")
    .update(await readFile(new URL("../index.ts", import.meta.url)))
    .digest("hex");

try {
    await indices.start();
    let index = await indices.init({
        schema: IndexableSharedFsEntry,
        indexBy: ["id"],
    });
    const setupStarted = performance.now();
    for (let i = 0; i < width; i++) {
        await index.put(new IndexableSharedFsEntry(event(i)));
        if ((i + 1) % 10_000 === 0) {
            console.error(
                JSON.stringify({
                    phase: "seed-index",
                    rows: i + 1,
                    ms: performance.now() - setupStarted,
                })
            );
        }
    }
    // Reopen the persisted index before measurement; this does not clear
    // the operating-system page cache, so "cold" always means cache-cold.
    await indices.stop();
    await indices.start();
    index = await indices.init({
        schema: IndexableSharedFsEntry,
        indexBy: ["id"],
    });
    assert.equal(await index.count(), width);
    const setupMs = performance.now() - setupStarted;
    let rowQueries = 0;
    let mutateDuringQuery = false;
    let mutationIndex = width;
    program.queryRows = async (query: unknown) => {
        rowQueries++;
        const rows = (await index.iterate({ query: query as any }).all()).map(
            (result) => result.value
        );
        samplePeak();
        if (mutateDuringQuery) {
            // Snapshot has been read. Complete an unrelated index write
            // before the awaiting sweep can publish that snapshot.
            const arrival = event(mutationIndex++, { parent: "dir:unrelated" });
            await index.put(new IndexableSharedFsEntry(arrival));
            program.applyCacheChanges([arrival], []);
        }
        return rows;
    };
    const install = program.installSlotSweep.bind(program);
    const installSamples: number[] = [];
    program.installSlotSweep = (...args: unknown[]) => {
        samplePeak();
        const started = performance.now();
        const result = install(...args);
        installSamples.push(performance.now() - started);
        console.error(
            JSON.stringify({
                phase: "install",
                width,
                sameName,
                ms: installSamples.at(-1),
            })
        );
        samplePeak();
        return result;
    };

    await checkpoint("empty");
    // Previous implementation control: the same normalized NamingLike
    // rows retained in one id-keyed map, with no name/reverse index.
    const instrumentedInstall = program.installSlotSweep;
    program.installSlotSweep = () => {};
    let baselineRows: any[] | undefined = await program.sweepRows(parentId);
    let oldIdMap: Map<string, unknown> | undefined = new Map(
        baselineRows.map((row) => [row.id, row])
    );
    baselineRows = undefined;
    assert.equal(oldIdMap.size, width);
    await checkpoint("oldIdMapControl");
    oldIdMap = undefined;
    program.installSlotSweep = instrumentedInstall;
    await checkpoint("controlReleased");

    let started = performance.now();
    assert.equal(
        (await program.slotRows(parentId, targetName)).length,
        sameName ? width : 1
    );
    const coldHitMs = performance.now() - started;
    const filled = cardinalities();
    assert.deepEqual(filled, {
        parents: 1,
        names: sameName ? 1 : width,
        rows: width,
        reverse: width,
    });
    await checkpoint("filled");
    const warmHit: number[] = [];
    const warmMiss: number[] = [];
    let random = 0x12345678;
    for (let i = 0; i < 500; i++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const name = sameName
            ? targetName
            : `entry-${String(random % width).padStart(6, "0")}.txt`;
        started = performance.now();
        assert.equal(
            (await program.slotRows(parentId, name)).length,
            sameName ? width : 1
        );
        warmHit.push(performance.now() - started);
        started = performance.now();
        assert.equal(
            (await program.slotRows(parentId, `absent-${i}`)).length,
            0
        );
        warmMiss.push(performance.now() - started);
    }
    started = performance.now();
    assert.equal((await program.sweepRows(parentId)).length, width);
    const warmFullListMs = performance.now() - started;
    program.deleteSlotSweep(parentId);
    assert.deepEqual(cardinalities(), {
        parents: 0,
        names: 0,
        rows: 0,
        reverse: 0,
    });
    await checkpoint("deleted");
    started = performance.now();
    assert.equal((await program.slotRows(parentId, "absent-cold")).length, 0);
    const coldMissMs = performance.now() - started;
    await checkpoint("refilled");

    // Force the actual default 50k-parent eviction threshold. Empty parent
    // buckets isolate retention of the wide parent and its reverse entries.
    for (let i = 0; i < 50_000; i++) {
        program.slotSweepCache.set(`dir:eviction-${i}`, new Map());
    }
    program.boundSlotSweepCache();
    assert.equal(program.slotSweepCache.has(parentId), false);
    assert.equal(program.slotPlacementById.size, 0);
    const evicted = cardinalities();
    program.slotSweepCache.clear();
    await checkpoint("evictedAndCleared");

    // Three concurrent unrelated arrivals must discard all three fills.
    // This deliberately exposes repeated O(width) cold reads, without
    // weakening the same-id-move correctness fence.
    const mutationSamples: number[] = [];
    mutateDuringQuery = true;
    const mutationQueryStart = rowQueries;
    for (let i = 0; i < 3; i++) {
        started = performance.now();
        assert.equal(
            (await program.slotRows(parentId, targetName)).length,
            sameName ? width : 1
        );
        mutationSamples.push(performance.now() - started);
        assert.equal(program.slotSweepCache.has(parentId), false);
        assert.equal(program.slotPlacementById.size, 0);
    }
    mutateDuringQuery = false;
    assert.equal(rowQueries - mutationQueryStart, 3);
    await checkpoint("discardedFills");
    started = performance.now();
    assert.equal((await program.sweepRows(parentId)).length, width);
    const coldFullListMs = performance.now() - started;
    assert.equal(program.slotSweepCache.has(parentId), true);
    program.deleteSlotSweep(parentId);
    await checkpoint("finalReleased");

    console.log(
        JSON.stringify({
            scope: "disk-backed Peerbit SQLite index and actual slot cache; no Documents writes, replication, mounts, or OS cache eviction",
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            versions,
            lockfileSha256,
            cacheSourceSha256,
            width,
            case: sameName ? "same-name" : "unique",
            setupMs,
            diskBytes: await directoryBytes(directory),
            timings: {
                coldHitMs,
                coldMissMs,
                warmHit: quantiles(warmHit),
                warmMiss: quantiles(warmMiss),
                warmFullListMs,
                coldFullListMs,
                installMs: installSamples,
                concurrentUnrelatedMutationMs: mutationSamples,
            },
            cardinalities: { filled, evicted, final: cardinalities() },
            rowQueries,
            samples,
            observedPeaks: peaks,
            peakCaveat:
                "synchronous transient allocations between sampling points may exceed observed peaks",
        })
    );
} finally {
    await indices.stop();
    await rm(directory, { recursive: true, force: true });
}
