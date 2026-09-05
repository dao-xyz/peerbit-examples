/** Manual fresh-process SQLite/index-cache probe; no public filesystem or network IO. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rm,
    stat,
} from "node:fs/promises";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
const program: any = new SharedFileSystem();
const modern = Boolean(program.slotCandidateCache);
const memory = () => {
    const { heapUsed, heapTotal, rss, external, arrayBuffers } =
        process.memoryUsage();
    return { heapUsed, heapTotal, rss, external, arrayBuffers };
};
const checkpoints: Record<string, unknown> = {};
const peaks: Record<string, number> = {};
const samplePeak = () => {
    for (const [key, value] of Object.entries(memory()))
        peaks[key] = Math.max(peaks[key] ?? 0, value);
};
const checkpoint = async (name: string) => {
    const beforeGc = memory();
    samplePeak();
    for (let i = 0; i < 3; i++) {
        global.gc!();
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    checkpoints[name] = { beforeGc, afterGc: memory() };
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
const snapshot = () => {
    if (modern) return program.slotCandidateCache.snapshot();
    let slots = 0;
    let rows = 0;
    for (const bucket of program.slotSweepCache.values()) {
        slots += bucket.size;
        for (const value of bucket.values())
            rows += Array.isArray(value) ? value.length : 1;
    }
    return {
        parents: program.slotSweepCache.size,
        completeParents: program.slotSweepCache.size,
        slots,
        rows,
        estimatedBytes: null,
        reverse: program.slotPlacementById.size,
        inFlight: 0,
    };
};
const clear = () => {
    if (modern) program.slotCandidateCache.clear();
    else
        for (const parent of program.slotSweepCache.keys())
            program.deleteSlotSweep(parent);
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
const hashFile = async (relative: string) =>
    createHash("sha256")
        .update(await readFile(new URL(relative, import.meta.url)))
        .digest("hex");
// Use Node's import condition and the actual importing module's ancestry.
// Looking only at a nearby package.json cannot identify duplicate Borsh copies.
const resolveImports = (names: string[], fromDirectory: string) =>
    JSON.parse(
        execFileSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                "process.stdout.write(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(name => [name, import.meta.resolve(name)]))))",
                JSON.stringify(names),
            ],
            { cwd: fromDirectory, encoding: "utf8" }
        )
    ) as Record<string, string>;
const moduleProvenance = async (name: string, resolvedUrl: string) => {
    const entry = await realpath(fileURLToPath(resolvedUrl));
    let directory = dirname(entry);
    while (directory) {
        try {
            const bytes = await readFile(join(directory, "package.json"));
            const json = JSON.parse(bytes.toString());
            if (json.name === name)
                return {
                    name,
                    version: json.version as string,
                    moduleUrl: resolvedUrl,
                    entry,
                    entrySha256: createHash("sha256")
                        .update(await readFile(entry))
                        .digest("hex"),
                    packageJsonSha256: createHash("sha256")
                        .update(bytes)
                        .digest("hex"),
                };
        } catch (error: any) {
            if (error.code !== "ENOENT") throw error;
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    throw new Error(`Could not identify resolved package ${name}: ${entry}`);
};
const sourceImports = resolveImports(
    [
        "peerbit",
        "@peerbit/document",
        "@peerbit/shared-log",
        "@peerbit/indexer-sqlite3",
        "@dao-xyz/borsh",
        "@peerbit/crypto",
    ],
    dirname(fileURLToPath(import.meta.url))
);
const indexerImports = resolveImports(
    ["@dao-xyz/borsh", "@peerbit/crypto"],
    dirname(fileURLToPath(sourceImports["@peerbit/indexer-sqlite3"]))
);
const provenanceOf = async (imports: Record<string, string>) =>
    Object.fromEntries(
        await Promise.all(
            Object.entries(imports).map(async ([name, url]) => [
                name,
                await moduleProvenance(name, url),
            ])
        )
    );
const resolvedModules = {
    source: await provenanceOf(sourceImports),
    indexer: await provenanceOf(indexerImports),
};
assert.equal(
    resolvedModules.source["@dao-xyz/borsh"].moduleUrl,
    resolvedModules.indexer["@dao-xyz/borsh"].moduleUrl,
    "source and SQLite indexer must import the same Borsh module URL"
);
assert.equal(
    resolvedModules.source["@dao-xyz/borsh"].entry,
    resolvedModules.indexer["@dao-xyz/borsh"].entry,
    "source and SQLite indexer must resolve the same Borsh module instance"
);
const versions = Object.fromEntries(
    Object.entries(resolvedModules.source).map(([name, value]) => [
        name,
        value.version,
    ])
);
const inputHashes: Record<string, string> = {
    lockfile: await hashFile("../../../../../pnpm-lock.yaml"),
    worker: await hashFile("./slot-candidate-resource.bench.worker.ts"),
    cacheIntegration: await hashFile("../index.ts"),
};
if (modern) inputHashes.cache = await hashFile("../slot-candidate-cache.ts");
const directory = await mkdtemp(join(tmpdir(), "shared-fs-slot-resource-"));
let indices: Awaited<ReturnType<typeof create>> | undefined;
try {
    indices = await create(directory);
    await indices.start();
    let index = await indices.init({
        schema: IndexableSharedFsEntry,
        indexBy: ["id"],
    });
    const setupStarted = performance.now();
    for (let i = 0; i < width; i++) {
        await index.put(new IndexableSharedFsEntry(event(i)));
        if ((i + 1) % 10_000 === 0)
            console.error(JSON.stringify({ phase: "seed-index", rows: i + 1 }));
    }
    await indices.stop();
    await indices.start();
    index = await indices.init({
        schema: IndexableSharedFsEntry,
        indexBy: ["id"],
    });
    assert.equal(await index.count(), width);
    const setupMs = performance.now() - setupStarted;
    const queries: Record<
        string,
        { queries: number; returnedRows: number; maxRows: number }
    > = {};
    const sqlSamples = new Map<string, { sql: string; bindings: unknown[] }>();
    let phase = "initial";
    let activeQuery = false;
    let capturedQuerySql = false;
    let mutateDuringQuery = false;
    let nextId = width;
    const createdIds = new Map<string, string>();
    const database = (index as any).properties.db;
    const prepare = database.prepare.bind(database);
    database.prepare = async (sql: string, id?: string) => {
        const statement = await prepare(sql, id);
        if (!activeQuery || !/^\s*select\b/iu.test(sql)) return statement;
        return new Proxy(statement, {
            get(target, key) {
                if (key === "all")
                    return (...args: any[]) => {
                        if (!capturedQuerySql) {
                            capturedQuerySql = true;
                            if (!sqlSamples.has(sql) && sqlSamples.size < 4)
                                sqlSamples.set(sql, {
                                    sql,
                                    bindings: args[0] ?? [],
                                });
                        }
                        return target.all(...args);
                    };
                const value = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    };
    program.queryRows = async (query: unknown) => {
        activeQuery = true;
        capturedQuerySql = false;
        let rows: any[];
        try {
            rows = (await index.iterate({ query: query as any }).all()).map(
                (result) => result.value
            );
        } finally {
            activeQuery = false;
        }
        const counts = (queries[phase] ??= {
            queries: 0,
            returnedRows: 0,
            maxRows: 0,
        });
        counts.queries++;
        counts.returnedRows += rows.length;
        counts.maxRows = Math.max(counts.maxRows, rows.length);
        samplePeak();
        if (mutateDuringQuery) {
            const arrival = event(nextId++, { parent: "dir:unrelated" });
            await index.put(new IndexableSharedFsEntry(arrival));
            program.applyCacheChanges([arrival], []);
        }
        return rows;
    };
    const verifyIdentities = (
        rows: any[],
        expectedIds: Iterable<string>,
        name?: string
    ) => {
        const actual = new Set<string>();
        for (const row of rows) {
            assert.equal(row.parentId, parentId);
            if (name !== undefined) assert.equal(row.name, name);
            assert.equal(typeof row.id, "string");
            assert.match(row.id, /^naming:resource-\d+$/u);
            assert.equal(row.nodeId, row.id.replace("naming:", "file:"));
            assert(!actual.has(row.id), `duplicate candidate ${row.id}`);
            actual.add(row.id);
        }
        let expectedCount = 0;
        for (const id of expectedIds) {
            assert(actual.has(id), `missing candidate ${id}`);
            expectedCount++;
        }
        assert.equal(
            actual.size,
            expectedCount,
            "unexpected candidate identity"
        );
    };
    const fixtureIds = function* () {
        for (let i = 0; i < width; i++) yield `naming:resource-${i}`;
    };
    const expectedPointIds = (name: string): Iterable<string> => {
        if (name === targetName)
            return sameName ? fixtureIds() : ["naming:resource-0"];
        const id = createdIds.get(name);
        return id === undefined ? [] : [id];
    };
    const timedPoint = async (name: string, expected: number) => {
        const started = performance.now();
        const rows = await program.slotRows(parentId, name);
        const duration = performance.now() - started;
        assert.equal(rows.length, expected);
        verifyIdentities(rows, expectedPointIds(name), name);
        return duration;
    };
    const cacheStates: Record<string, unknown> = {};
    await checkpoint("empty");
    phase = "firstColdHit";
    const firstColdHitMs = await timedPoint(targetName, sameName ? width : 1);
    cacheStates.afterFirstHit = snapshot();
    if (modern) assert.equal(queries[phase].returnedRows, sameName ? width : 1);
    await checkpoint("firstColdHit");
    phase = "repeatedSameHit";
    const repeatedSameHit = [];
    for (let i = 0; i < (sameName ? 3 : 100); i++)
        repeatedSameHit.push(
            await timedPoint(targetName, sameName ? width : 1)
        );
    clear();
    await checkpoint("cleared");
    phase = "firstColdMiss";
    const firstColdMissMs = await timedPoint("absent-cold", 0);
    if (modern) assert.equal(queries[phase].returnedRows, 0);
    phase = "repeatedSameMiss";
    const repeatedSameMiss = [];
    for (let i = 0; i < 100; i++)
        repeatedSameMiss.push(await timedPoint("absent-cold", 0));
    cacheStates.afterNegative = snapshot();
    clear();
    phase = "unrelatedMutation";
    mutateDuringQuery = true;
    const mutationMs = [];
    for (let i = 0; i < 3; i++) {
        mutationMs.push(await timedPoint(targetName, sameName ? width : 1));
        assert.equal(snapshot().rows, 0);
        assert.equal(snapshot().reverse, 0);
    }
    mutateDuringQuery = false;
    assert.equal(queries[phase].queries, 3);
    await checkpoint("discardedFills");
    phase = "createIndexStream";
    const createStreamMs = [];
    for (let i = 0; i < 100; i++) {
        const name = `created-${i}`;
        const started = performance.now();
        const before = await program.slotRows(parentId, name);
        const arrival = event(nextId++, { name });
        await index.put(new IndexableSharedFsEntry(arrival));
        program.applyCacheChanges([arrival], []);
        const after = await program.slotRows(parentId, name);
        createStreamMs.push(performance.now() - started);
        createdIds.set(name, arrival.id);
        verifyIdentities(before, [], name);
        verifyIdentities(after, [arrival.id], name);
    }
    cacheStates.afterCreates = snapshot();
    if (modern) assert.equal(queries[phase].queries, 100);
    await checkpoint("createStream");
    phase = "fullSweepAfterPartial";
    let fullSweepMs: number;
    {
        const fullSweepStarted = performance.now();
        const rows = await program.sweepRows(parentId);
        fullSweepMs = performance.now() - fullSweepStarted;
        assert.equal(rows.length, width + 100);
        verifyIdentities(
            rows,
            (function* () {
                yield* fixtureIds();
                yield* createdIds.values();
            })()
        );
        for (const row of rows) {
            const number = Number(row.id.slice("naming:resource-".length));
            const expectedName =
                number < width
                    ? sameName
                        ? "shared.txt"
                        : `entry-${String(number).padStart(6, "0")}.txt`
                    : [...createdIds].find(([, id]) => id === row.id)?.[0];
            assert.equal(row.name, expectedName);
        }
    }
    cacheStates.afterFullSweep = snapshot();
    await checkpoint("fullSweep");
    clear();
    let smallBoundControl: unknown = null;
    if (modern) {
        const original = program.slotCandidateCache;
        program.slotCandidateCache = new original.constructor({
            maxSlots: 32,
            maxRows: 64,
            maxEstimatedBytes: 32 * 1024,
            maxInFlight: 4,
        });
        phase = "boundedNegativeControl";
        try {
            for (let i = 0; i < 128; i++) {
                assert.equal(
                    (await program.slotRows(parentId, `bounded-absent-${i}`))
                        .length,
                    0
                );
                const state = snapshot();
                assert(state.entries <= 32);
                assert(state.slots <= 32);
                assert(state.rows <= 64);
                assert(state.estimatedBytes <= 32 * 1024);
            }
            smallBoundControl = snapshot();
        } finally {
            clear();
            program.slotCandidateCache = original;
        }
    }
    clear();
    await checkpoint("finalReleased");
    cacheStates.final = snapshot();
    for (const key of ["parents", "slots", "rows", "reverse", "inFlight"])
        assert.equal(snapshot()[key], 0);
    // Explain actual captured statements after timed work; do not guess SQL
    // or warm a new index before measuring the first query.
    database.prepare = prepare;
    const queryPlans = [];
    for (const sample of sqlSamples.values()) {
        const statement = await prepare(`EXPLAIN QUERY PLAN ${sample.sql}`);
        queryPlans.push({
            ...sample,
            plan: await statement.all(sample.bindings),
        });
    }
    assert(queryPlans.length > 0);
    console.log(
        JSON.stringify(
            {
                schema: "shared-fs-slot-resource-v2",
                scope: "real disk-backed SQLite index plus actual candidate cache; no Documents, public fs.stat/list/writeFile, authentication, replication, mounts, or OS page-cache eviction",
                caveats: [
                    "first cold query includes lazy SQLite planning/index creation; subsequent queries may reuse it",
                    "timings include light SQL/row-count instrumentation; EXPLAIN runs outside all timers",
                    "same-name oversized histories remain complete but may be uncached; repeated hits need not be warm",
                    "create stream writes naming index rows, not files or persisted delivery receipts",
                    "memory endpoints and sampled peaks are not absolute peaks; RSS can remain after GC",
                    "small-bound control overrides cache limits; other measurements use defaults",
                    "candidate parent/name/identity/uniqueness validation runs after each timer; full enumeration checks the exact fixture and created set, excluding unrelated arrivals",
                    "resolved module entries describe executed dependencies; the lockfile hash does not prove that the installed graph matches it",
                ],
                platform: process.platform,
                arch: process.arch,
                node: process.version,
                osRelease: release(),
                cpu: cpus()[0]?.model ?? null,
                logicalCpus: cpus().length,
                totalMemoryBytes: totalmem(),
                versions,
                resolvedModules,
                inputHashes,
                width,
                case: sameName ? "same-name" : "unique",
                implementation: modern ? "bounded-slot" : "legacy-parent-sweep",
                setupMs,
                diskBytes: await directoryBytes(directory),
                timings: {
                    firstColdHitMs,
                    firstColdMissMs,
                    repeatedSameHit: quantiles(repeatedSameHit),
                    repeatedSameMiss: quantiles(repeatedSameMiss),
                    unrelatedMutationMs: mutationMs,
                    createIndexStream: quantiles(createStreamMs),
                    fullSweepMs,
                },
                queries,
                queryPlans,
                cacheStates,
                smallBoundControl,
                checkpoints,
                observedPeaks: peaks,
            },
            (_key, value) =>
                typeof value === "bigint" ? value.toString() : value
        )
    );
} finally {
    await indices?.stop();
    await rm(directory, { recursive: true, force: true });
}
