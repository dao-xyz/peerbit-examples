import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Peerbit } from "peerbit";
import {
    DEFAULT_FILE_CHUNK_SIZE,
    SHARED_FS_MOUNT_RANGE_READ_SEMANTICS,
    SHARED_FS_MOUNT_READ_SEMANTICS,
    createSharedFsMountBackend,
    openSharedFs,
    type SharedFsHandle,
    type SharedFsMountBackendTarget,
} from "../index.js";

const MEBIBYTE = 1024 * 1024;
const READ_SIZE = 4096;
const READS = 16;
const ALLOWED_SIZES_MIB = new Set([16, 64, 256]);
const MODES = new Set(["eager", "lazy"] as const);

type BenchmarkMode = "eager" | "lazy";

type Phase = {
    p50Ms: number;
    p95Ms: number;
    totalMs: number;
    fetchedChunks: number;
    fetchedBytes: number;
};

type LazyRangeBenchmarkSample = {
    mode: BenchmarkMode;
    sizeMiB: number;
    sizeBytes: number;
    reads: number;
    readSize: number;
    logicalReadBytes: number;
    openMs: number;
    openFetchedChunks: number;
    openFetchedBytes: number;
    cold: Phase;
    warm: Phase;
    runtime: {
        node: string;
        platform: NodeJS.Platform;
        arch: string;
    };
};

type WorkerMessage =
    | { type: "result"; sample: LazyRangeBenchmarkSample }
    | { type: "fatal"; message: string; stack?: string };

const percentile = (values: number[], ratio: number) => {
    assert.ok(values.length > 0);
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
};

const shuffledChunkIndexes = (count: number) => {
    const indexes = Array.from({ length: count }, (_, index) => index);
    let random = 0x5f3759df;
    for (let index = indexes.length - 1; index > 0; index--) {
        random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
        const swap = random % (index + 1);
        [indexes[index], indexes[swap]] = [indexes[swap], indexes[index]];
    }
    return indexes;
};

const targetFor = (
    fs: SharedFsHandle,
    mode: BenchmarkMode
): SharedFsMountBackendTarget => ({
    mountReadSemantics: () => SHARED_FS_MOUNT_READ_SEMANTICS,
    readVersionForMount: (path, versionId) =>
        fs.readVersionForMount(path, versionId),
    ...(mode === "lazy"
        ? {
              mountRangeReadSemantics: () =>
                  SHARED_FS_MOUNT_RANGE_READ_SEMANTICS,
              openVersionRangeForMount: (path: string, versionId: string) =>
                  fs.openVersionRangeForMount(path, versionId),
          }
        : {}),
    readFile: (path) => fs.readFile(path),
    readVersion: (path, versionId) => fs.readVersion(path, versionId),
    writeFile: (path, source, options) => fs.writeFile(path, source, options),
    mkdir: (path) => fs.mkdir(path),
    rm: (path) => fs.rm(path),
    rename: (from, to) => fs.rename(from, to),
    list: (path) => fs.list(path),
    versions: (path) => fs.versions(path),
    conflicts: (path, options) => fs.conflicts(path, options),
    stat: (path) => fs.stat(path),
    bootstrapStatus: () => fs.bootstrapStatus(),
});

const run = async (
    sizeMiB: number,
    mode: BenchmarkMode
): Promise<LazyRangeBenchmarkSample> => {
    assert.ok(
        ALLOWED_SIZES_MIB.has(sizeMiB),
        `Lazy-range benchmark size must be one of ${[...ALLOWED_SIZES_MIB].join(
            ", "
        )} MiB`
    );
    assert.ok(MODES.has(mode), `Unknown lazy-range benchmark mode: ${mode}`);
    const peer = await Peerbit.create();
    try {
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: `lazy-range-benchmark-${mode}`,
        });
        const sizeBytes = sizeMiB * MEBIBYTE;
        const bytes = new Uint8Array(sizeBytes);
        const chunkCount = sizeBytes / DEFAULT_FILE_CHUNK_SIZE;
        assert.ok(Number.isInteger(chunkCount) && chunkCount >= READS);
        // Keep generation cheap while making every fixed chunk distinct.
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < chunkCount; index++) {
            view.setUint32(index * DEFAULT_FILE_CHUNK_SIZE, index, true);
        }
        const path = "/lazy-range-benchmark.bin";
        await fs.writeFile(path, bytes);

        const program = fs.program as any;
        const originalFetch = program.fetchChunk.bind(program);
        let fetchedChunks = 0;
        let fetchedBytes = 0;
        program.fetchChunk = async (
            id: string,
            normalizedPath: string,
            ownBytes?: boolean
        ) => {
            const chunk = await originalFetch(id, normalizedPath, ownBytes);
            fetchedChunks++;
            fetchedBytes += chunk.bytes.byteLength;
            return chunk;
        };

        const backend = createSharedFsMountBackend(targetFor(fs, mode));
        const openStartedAt = performance.now();
        const handle = await backend.open(path, { read: true });
        const openMs = performance.now() - openStartedAt;
        const openFetchedChunks = fetchedChunks;
        const openFetchedBytes = fetchedBytes;

        const offsets = shuffledChunkIndexes(chunkCount)
            .slice(0, READS)
            .map((chunkIndex) => {
                const withinChunk =
                    (chunkIndex * 7_919 + 113) %
                    (DEFAULT_FILE_CHUNK_SIZE - READ_SIZE);
                return chunkIndex * DEFAULT_FILE_CHUNK_SIZE + withinChunk;
            });

        const measure = async (): Promise<Phase> => {
            const beforeChunks = fetchedChunks;
            const beforeBytes = fetchedBytes;
            const samples: number[] = [];
            const phaseStartedAt = performance.now();
            for (const offset of offsets) {
                const startedAt = performance.now();
                const actual = await backend.read(handle, READ_SIZE, offset);
                samples.push(performance.now() - startedAt);
                assert.deepEqual(
                    actual,
                    bytes.subarray(offset, offset + READ_SIZE)
                );
            }
            return {
                p50Ms: percentile(samples, 0.5),
                p95Ms: percentile(samples, 0.95),
                totalMs: performance.now() - phaseStartedAt,
                fetchedChunks: fetchedChunks - beforeChunks,
                fetchedBytes: fetchedBytes - beforeBytes,
            };
        };

        const cold = await measure();
        const warm = await measure();
        await backend.release(handle);

        return {
            mode,
            sizeMiB,
            sizeBytes,
            reads: READS,
            readSize: READ_SIZE,
            logicalReadBytes: READS * READ_SIZE,
            openMs,
            openFetchedChunks,
            openFetchedBytes,
            cold,
            warm,
            runtime: {
                node: process.version,
                platform: process.platform,
                arch: process.arch,
            },
        };
    } finally {
        await peer.stop();
    }
};

const send = (message: WorkerMessage) => {
    if (typeof process.send === "function") process.send(message);
};

const sizeMiB = Number(process.argv[2]);
const mode = process.argv[3] as BenchmarkMode;
run(sizeMiB, mode).then(
    (sample) => {
        send({ type: "result", sample });
        process.exitCode = 0;
    },
    (error: unknown) => {
        const normalized =
            error instanceof Error ? error : new Error(String(error));
        send({
            type: "fatal",
            message: normalized.message,
            stack: normalized.stack,
        });
        process.exitCode = 1;
    }
);
