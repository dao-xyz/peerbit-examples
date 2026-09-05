#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIBRARY = join(REPOSITORY, "packages/shared-fs/library");
const MIB = 1024 * 1024;
const IO_BYTES = MIB;
const LEAVES_KIB = [64, 256, 512];
export const MERKLE_BENCHMARK_CASES = [
    "random-overwrite-4096",
    "boundary-overwrite-4096",
    "append-4096",
    "truncate",
    "regrow-zero",
    "sequential-write",
    "sequential-read",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseMerkleBenchmarkArguments(argv) {
    const options = {
        sizesMiB: [4, 64],
        leavesKiB: [...LEAVES_KIB],
        cases: [...MERKLE_BENCHMARK_CASES],
        samples: 3,
        warmups: 1,
        store: "map",
    };
    const seen = new Set();
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        if (flag === "--") continue;
        if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
        seen.add(flag);
        const value = argv[++index];
        if (!value) throw new Error(`Missing value: ${flag}`);
        if (flag === "--store") options.store = value;
        else if (flag === "--cases") options.cases = value.split(",");
        else if (["--sizes-mib", "--leaves-kib"].includes(flag)) {
            if (!/^\d+(,\d+)*$/u.test(value))
                throw new Error(`Invalid ${flag}`);
            options[flag === "--sizes-mib" ? "sizesMiB" : "leavesKiB"] = value
                .split(",")
                .map(Number);
        } else if (["--samples", "--warmups"].includes(flag)) {
            if (!/^\d+$/u.test(value)) throw new Error(`Invalid ${flag}`);
            options[flag.slice(2)] = Number(value);
        } else throw new Error(`Unknown option: ${flag}`);
    }
    assert(
        ["map", "disk"].includes(options.store),
        "store must be map or disk"
    );
    for (const key of ["sizesMiB", "leavesKiB", "cases"]) {
        assert(options[key].length > 0, `${key} must not be empty`);
        assert.equal(
            new Set(options[key]).size,
            options[key].length,
            `${key} duplicates`
        );
    }
    assert(options.sizesMiB.length <= 8, "At most eight file sizes");
    assert(
        options.sizesMiB.every(
            (n) => Number.isSafeInteger(n) && n >= 1 && n <= 1024
        ),
        "sizes must be 1..1024 MiB"
    );
    assert(
        options.leavesKiB.every((n) => LEAVES_KIB.includes(n)),
        "leaves must be 64,256,512 KiB"
    );
    assert(
        options.cases.every((name) => MERKLE_BENCHMARK_CASES.includes(name)),
        "unknown case"
    );
    assert(
        Number.isSafeInteger(options.samples) &&
            options.samples >= 1 &&
            options.samples <= 30,
        "samples must be 1..30"
    );
    assert(
        Number.isSafeInteger(options.warmups) &&
            options.warmups >= 0 &&
            options.warmups <= 5,
        "warmups must be 0..5"
    );
    assert(
        options.store !== "map" || Math.max(...options.sizesMiB) <= 128,
        "Map fixtures are capped at 128 MiB; use --store disk for larger files"
    );
    return options;
}

// Position-addressable corpus. No full-file oracle buffer is allocated. The
// high position bits participate in every byte; leaves do not repeat at 256 B.
export function merkleBenchmarkBytes(offset, length, seed = 0x51f15e) {
    const bytes = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index++) {
        let word = (offset + index) ^ seed;
        word = Math.imul(word ^ (word >>> 16), 0x45d9f3b);
        word = Math.imul(word ^ (word >>> 16), 0x45d9f3b);
        bytes[index] = (word ^ (word >>> 16)) & 255;
    }
    return bytes;
}

export async function verifyMerkleBenchmarkFile(read, size, expected) {
    const hash = createHash("sha256");
    let verifiedBytes = 0;
    for (let offset = 0; offset < size; offset += IO_BYTES) {
        const length = Math.min(IO_BYTES, size - offset);
        const actual = await read(offset, length);
        assert.equal(actual.byteLength, length, `short read at ${offset}`);
        assert.equal(
            Buffer.compare(Buffer.from(actual), expected(offset, length)),
            0,
            `wrong bytes at ${offset}`
        );
        hash.update(actual);
        verifiedBytes += length;
    }
    assert.equal((await read(size, 1)).byteLength, 0, "bytes beyond EOF");
    return { verifiedBytes, sha256: hash.digest("hex") };
}

const expectedRange = (size, retainedBytes, patch) => (offset, length) => {
    assert(offset + length <= size);
    const bytes = Buffer.alloc(length);
    if (offset < retainedBytes) {
        merkleBenchmarkBytes(
            offset,
            Math.min(length, retainedBytes - offset)
        ).copy(bytes);
    }
    if (patch) {
        const start = Math.max(offset, patch.offset);
        const end = Math.min(
            offset + length,
            patch.offset + patch.bytes.length
        );
        if (end > start)
            bytes.set(
                patch.bytes.subarray(start - patch.offset, end - patch.offset),
                start - offset
            );
    }
    return bytes;
};

async function packageProvenance(name, resolvedUrl) {
    const entry = await realpath(fileURLToPath(resolvedUrl));
    let directory = dirname(entry);
    while (directory) {
        try {
            const json = JSON.parse(
                await readFile(join(directory, "package.json"), "utf8")
            );
            if (json.name === name)
                return {
                    name,
                    version: json.version,
                    resolvedEntry: entry,
                    entrySha256: sha256(await readFile(entry)),
                };
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        const parent = dirname(directory);
        if (parent === directory)
            throw new Error(`Could not identify resolved ${name}`);
        directory = parent;
    }
}

async function loadRuntime() {
    // Resolve with the import condition and the same module ancestry as the
    // compiled Merkle code. require.resolve would reject import-only packages,
    // and resolving from this script could select a different root dependency.
    const resolved = JSON.parse(
        execFileSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                'process.stdout.write(JSON.stringify(Object.fromEntries(["@peerbit/crypto", "@dao-xyz/borsh"].map(name => [name, import.meta.resolve(name)]))))',
            ],
            { cwd: join(LIBRARY, "lib/esm"), encoding: "utf8" }
        )
    );
    const moduleNames = [
        "merkle-v1",
        "merkle-patch-builder-v1",
        "merkle-read-session-v1",
    ];
    const modules = await Promise.all(
        moduleNames.map(
            (name) =>
                import(pathToFileURL(join(LIBRARY, `lib/esm/${name}.js`)).href)
        )
    );
    const borsh = await import(resolved["@dao-xyz/borsh"]);
    const files = [
        "scripts/shared-fs-merkle-benchmark.mjs",
        ...[...moduleNames, "merkle-wire-v1"].flatMap((name) => [
            `packages/shared-fs/library/src/${name}.ts`,
            `packages/shared-fs/library/lib/esm/${name}.js`,
        ]),
    ];
    const inputSha256 = Object.fromEntries(
        await Promise.all(
            files.map(async (path) => [
                path,
                sha256(await readFile(join(REPOSITORY, path))),
            ])
        )
    );
    return {
        ...Object.assign({}, ...modules),
        borsh,
        provenance: {
            node: process.version,
            platform: platform(),
            architecture: arch(),
            osRelease: release(),
            cpu: cpus()[0]?.model ?? null,
            logicalCpus: cpus().length,
            totalMemoryBytes: totalmem(),
            exposedGc: typeof global.gc === "function",
            pnpmLockSha256: sha256(
                await readFile(join(REPOSITORY, "pnpm-lock.yaml"))
            ),
            resolvedPackages: await Promise.all(
                ["@peerbit/crypto", "@dao-xyz/borsh"].map((name) =>
                    packageProvenance(name, resolved[name])
                )
            ),
            dependencyNote:
                "Resolved package entries are the executed dependencies. The lockfile hash is recorded separately and is not proof that installed dependencies match it.",
            inputSha256,
        },
    };
}

// Both modes encode/decode the same Borsh block bytes. Disk mode uses ordinary
// buffered readFile/writeFile: no fsync, database, network or durability receipt.
class Blocks {
    constructor(runtime, mode, directory, fallback) {
        this.runtime = runtime;
        this.mode = mode;
        this.directory = directory;
        this.fallback = fallback;
        this.blocks = new Map();
        this.counts = {
            loads: 0,
            puts: 0,
            bytesRead: 0,
            bytesWritten: 0,
            storedBlocks: 0,
            dataBlocks: 0,
        };
    }
    static async create(runtime, mode, fallback) {
        const directory =
            mode === "disk"
                ? await mkdtemp(join(tmpdir(), "shared-fs-merkle-bench-"))
                : undefined;
        return new Blocks(runtime, mode, directory, fallback);
    }
    async encoded(id) {
        if (this.mode === "map")
            return this.blocks.get(id) ?? this.fallback?.encoded(id);
        try {
            return await readFile(join(this.directory, id.replace(":", "-")));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            return this.fallback?.encoded(id);
        }
    }
    async load(reference) {
        this.counts.loads++;
        const id =
            reference.kind === "data"
                ? this.runtime.merkleDataIdFromHashV1(reference.hash)
                : this.runtime.merkleTreeIdFromHashV1(reference.hash);
        const bytes = await this.encoded(id);
        if (!bytes) return undefined;
        this.counts.bytesRead += bytes.byteLength;
        return this.runtime.borsh.deserialize(
            bytes,
            this.runtime.MerkleContentEntryV1
        );
    }
    async put(block) {
        this.counts.puts++;
        const bytes = Buffer.from(this.runtime.borsh.serialize(block));
        if (this.mode === "map") {
            if (this.blocks.has(block.id)) return;
            this.blocks.set(block.id, bytes);
        } else {
            try {
                await writeFile(
                    join(this.directory, block.id.replace(":", "-")),
                    bytes,
                    { flag: "wx" }
                );
            } catch (error) {
                if (error.code === "EEXIST") return;
                throw error;
            }
        }
        this.counts.bytesWritten += bytes.byteLength;
        this.counts.storedBlocks++;
        if (block instanceof this.runtime.MerkleDataBlockV1)
            this.counts.dataBlocks++;
    }
    async close() {
        this.blocks.clear();
        if (this.directory)
            await rm(this.directory, { recursive: true, force: true });
    }
}

async function createFixture(runtime, store, size, leafSize) {
    let hashes = [];
    for (let offset = 0; offset < size; offset += leafSize) {
        const block = new runtime.MerkleDataBlockV1({
            bytes: merkleBenchmarkBytes(
                offset,
                Math.min(leafSize, size - offset)
            ),
        });
        await store.put(block);
        hashes.push(runtime.merkleDataHashV1(block.bytes));
    }
    assert.equal(
        store.counts.dataBlocks,
        Math.ceil(size / leafSize),
        "fixture leaves unexpectedly deduplicated"
    );
    const rootLevel = runtime.merkleRootLevelV1(size, leafSize);
    for (let level = 1; level <= rootLevel; level++) {
        const parents = [];
        for (
            let offset = 0;
            offset < hashes.length;
            offset += runtime.MERKLE_V1_FANOUT
        ) {
            const children = hashes.slice(
                offset,
                offset + runtime.MERKLE_V1_FANOUT
            );
            const block = new runtime.MerkleTreeBlockV1({
                level,
                bitmap: runtime.merkleV1BitmapFromSlots(
                    children.map((_, slot) => slot)
                ),
                children,
            });
            await store.put(block);
            parents.push(
                runtime.merkleTreeHashV1(level, block.bitmap, block.children)
            );
        }
        hashes = parents;
    }
    return { size: BigInt(size), leafSize, rootLevel, rootHash: hashes[0] };
}

async function build(runtime, root, store, options) {
    const before = { ...store.counts };
    const builder = new runtime.MerklePatchBuilderV1({
        root,
        source: store,
        sink: store,
    });
    const start = performance.now();
    let result;
    try {
        result = await builder.build(options);
    } finally {
        builder.close();
    }
    const durationMs = performance.now() - start;
    assert.equal(result.stats.phase, "complete");
    assert.equal(result.stats.buildCalls, 1);
    assert.equal(
        result.stats.patchBytes,
        (options.patches ?? []).reduce(
            (sum, patch) => sum + patch.bytes.length,
            0
        )
    );
    assert.equal(result.stats.sourceFetches, store.counts.loads - before.loads);
    assert.equal(result.stats.sinkPuts, store.counts.puts - before.puts);
    return { root: result.root, durationMs, counters: result.stats };
}

async function sample(runtime, options, base, baseStore, scenario, iteration) {
    const store = await Blocks.create(runtime, options.store, baseStore);
    const fileBytes = Number(base.size);
    const cut = fileBytes - Math.floor(fileBytes / 3) - 37;
    const operations = [];
    let root = base;
    let size = fileBytes;
    let retained = fileBytes;
    let patch;
    try {
        if (scenario === "regrow-zero") {
            root = (await build(runtime, root, store, { size: cut })).root;
            retained = cut;
        }
        // Measurements are endpoints, not peak RSS or allocation measurements.
        global.gc?.();
        const memoryBefore = process.memoryUsage();
        const storeBefore = { ...store.counts };
        if (scenario === "sequential-write") {
            root = { size: 0n, leafSize: base.leafSize, rootLevel: 0 };
            for (let offset = 0; offset < fileBytes; offset += IO_BYTES) {
                const bytes = merkleBenchmarkBytes(
                    offset,
                    Math.min(IO_BYTES, fileBytes - offset)
                );
                const operation = await build(runtime, root, store, {
                    patches: [{ offset, bytes }],
                });
                operations.push(operation);
                root = operation.root;
            }
        } else if (scenario !== "sequential-read") {
            if (scenario.endsWith("overwrite-4096")) {
                const offset = scenario.startsWith("boundary")
                    ? 512 * 1024 - 2048
                    : (Math.imul(iteration + 193, 2654435761) >>> 0) %
                      (fileBytes - 4096 + 1);
                patch = {
                    offset,
                    bytes: merkleBenchmarkBytes(0, 4096, 0xa0b0 + iteration),
                };
            } else if (scenario === "append-4096") {
                patch = {
                    offset: fileBytes,
                    bytes: merkleBenchmarkBytes(0, 4096, 0xa0b0 + iteration),
                };
                size += patch.bytes.length;
            } else if (scenario === "truncate") size = retained = cut;
            const operation = await build(runtime, root, store, {
                size,
                patches: patch ? [patch] : [],
            });
            operations.push(operation);
            root = operation.root;
        }
        const builderStoreCounts = Object.fromEntries(
            Object.entries(store.counts).map(([key, value]) => [
                key,
                value - storeBefore[key],
            ])
        );
        assert.equal(Number(root.size), size);
        const expected = expectedRange(size, retained, patch);
        const reader = new runtime.MerkleReadSessionV1({
            root,
            source: store,
            maxReadBytes: IO_BYTES,
            cache: {
                treeEntries: 128,
                treeBytes: 2 * MIB,
                dataEntries: 2,
                dataBytes: MIB,
            },
        });
        let readDurationMs = 0;
        let verification;
        let readCounters;
        const loadsBeforeRead = store.counts.loads;
        const memoryAfterOperation = process.memoryUsage();
        try {
            verification = await verifyMerkleBenchmarkFile(
                async (offset, length) => {
                    const start = performance.now();
                    const bytes = await reader.read(offset, length);
                    readDurationMs += performance.now() - start;
                    return bytes;
                },
                size,
                expected
            );
            readCounters = reader.stats();
            assert.equal(readCounters.outputBytes, size);
            assert.equal(
                readCounters.sourceFetches,
                store.counts.loads - loadsBeforeRead
            );
        } finally {
            reader.close();
        }
        const durationMs =
            scenario === "sequential-read"
                ? readDurationMs
                : operations.reduce(
                      (sum, operation) => sum + operation.durationMs,
                      0
                  );
        return {
            type: "sample",
            fileBytes,
            leafBytes: base.leafSize,
            scenario,
            iteration,
            durationMs,
            patchOffset: patch?.offset ?? null,
            rootHash: root.rootHash
                ? Buffer.from(root.rootHash).toString("hex")
                : null,
            resultBytes: size,
            verification,
            operations: operations.map(({ durationMs, counters }) => ({
                durationMs,
                counters,
            })),
            builderStoreCounts,
            readCounters,
            memoryBefore,
            memoryAfterOperation:
                scenario === "sequential-read"
                    ? process.memoryUsage()
                    : memoryAfterOperation,
        };
    } finally {
        await store.close();
    }
}

export function summarizeMerkleBenchmark(options, samples) {
    const expectedCount =
        options.sizesMiB.length *
        options.leavesKiB.length *
        options.cases.length *
        options.samples;
    assert.equal(
        samples.length,
        expectedCount,
        "incomplete or excessive sample count"
    );
    const summaries = [];
    for (const size of options.sizesMiB)
        for (const leaf of options.leavesKiB)
            for (const scenario of options.cases) {
                const values = samples.filter(
                    (sample) =>
                        sample.fileBytes === size * MIB &&
                        sample.leafBytes === leaf * 1024 &&
                        sample.scenario === scenario
                );
                assert.equal(
                    values.length,
                    options.samples,
                    `incomplete cell: ${size}/${leaf}/${scenario}`
                );
                assert.equal(
                    new Set(values.map((sample) => sample.iteration)).size,
                    options.samples,
                    "duplicate sample iteration"
                );
                for (const value of values) {
                    assert(
                        Number.isInteger(value.iteration) &&
                            value.iteration >= 0 &&
                            value.iteration < options.samples,
                        "unexpected iteration"
                    );
                    assert(
                        Number.isFinite(value.durationMs) &&
                            value.durationMs >= 0,
                        "invalid duration"
                    );
                    assert.equal(
                        value.verification?.verifiedBytes,
                        value.resultBytes,
                        "unverified bytes"
                    );
                    assert(
                        /^[a-f0-9]{64}$/u.test(value.verification.sha256),
                        "missing verified digest"
                    );
                }
                const times = values
                    .map((sample) => sample.durationMs)
                    .sort((a, b) => a - b);
                const percentile = (p) =>
                    times[Math.max(0, Math.ceil(times.length * p) - 1)];
                summaries.push({
                    fileBytes: size * MIB,
                    leafBytes: leaf * 1024,
                    scenario,
                    count: times.length,
                    p50Ms: percentile(0.5),
                    p95Ms: percentile(0.95),
                    p99Ms: percentile(0.99),
                    minMs: times[0],
                    maxMs: times.at(-1),
                });
            }
    return summaries;
}

export async function runMerkleBenchmark(
    options,
    emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
) {
    const runtime = await loadRuntime();
    emit({
        type: "header",
        schema: "shared-fs-merkle-algorithm-benchmark-v1",
        startedAt: new Date().toISOString(),
        options,
        provenance: runtime.provenance,
        scope: {
            boundary:
                "experimental MerklePatchBuilderV1 and MerkleReadSessionV1 with canonical Borsh Map/disk blocks",
            timing: "sum of individual build/close or read awaits; each sample uses a new builder/read session; input generation, full byte verification, corpus creation and cleanup are outside timers",
            storage:
                options.store === "map"
                    ? "encoded blocks in a process-local Map"
                    : "ordinary buffered local readFile/writeFile, one block per file, without fsync",
            cache: "fresh verified reader cache per sample; process and operating-system caches are uncontrolled; this is not a cold-cache result",
            order: "single process, sequential file sizes, leaves, cases; warmups immediately precede measured samples",
            corpus: "position-mix32-v1, base seed 0x51f15e, distinct data-leaf count asserted",
            verification:
                "complete streamed byte comparison against independent corpus/patch/truncate/zero model and exact EOF after every sample; builder/read/store counters cross-checked",
            memory: "process.memoryUsage endpoints only; optional exposed GC before sample; includes base fixture; no peak or allocation claim",
            excludes: [
                "flat v9 comparison",
                "Documents publication",
                "mount/FUSE/IPC",
                "network replication",
                "persisted receipts",
                "fsync durability",
                "leases/GC/reclamation",
                "production leaf-size selection",
            ],
        },
    });
    const samples = [];
    for (const size of options.sizesMiB)
        for (const leaf of options.leavesKiB) {
            const store = await Blocks.create(runtime, options.store);
            try {
                const root = await createFixture(
                    runtime,
                    store,
                    size * MIB,
                    leaf * 1024
                );
                emit({
                    type: "fixture",
                    fileBytes: size * MIB,
                    leafBytes: leaf * 1024,
                    storeCounts: { ...store.counts },
                    rootHash: Buffer.from(root.rootHash).toString("hex"),
                });
                for (const scenario of options.cases) {
                    for (
                        let index = -options.warmups;
                        index < options.samples;
                        index++
                    ) {
                        const result = await sample(
                            runtime,
                            options,
                            root,
                            store,
                            scenario,
                            index
                        );
                        emit({ ...result, warmup: index < 0 });
                        if (index >= 0) samples.push(result);
                    }
                }
            } finally {
                await store.close();
            }
        }
    const summaries = summarizeMerkleBenchmark(options, samples);
    emit({
        type: "complete",
        finishedAt: new Date().toISOString(),
        measuredSamples: samples.length,
        summaries,
    });
    return summaries;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
    try {
        await runMerkleBenchmark(
            parseMerkleBenchmarkArguments(process.argv.slice(2))
        );
    } catch (error) {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exitCode = 1;
    }
}
