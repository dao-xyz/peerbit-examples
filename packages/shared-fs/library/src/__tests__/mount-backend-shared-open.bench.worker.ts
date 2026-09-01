import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
    SHARED_FS_MOUNT_READ_SEMANTICS,
    createSharedFsMountBackend,
    type SharedFsEntryInfo,
    type SharedFsMountBackendTarget,
} from "../index.js";

const MEBIBYTE = 1024 * 1024;
const SIZE_MIB = 64;
const SIZE_BYTES = SIZE_MIB * MEBIBYTE;
const ALLOWED_HANDLE_COUNTS = new Set([1, 8]);

type MemorySnapshot = {
    rssBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
};

type SharedOpenBenchmarkSample = {
    handles: number;
    sizeMiB: number;
    sizeBytes: number;
    openMs: number;
    verifiedCopyMs: number;
    verifiedHashMs: number;
    verifiedReadCalls: number;
    targetHashCalls: number;
    targetHashedBytes: number;
    readFileCalls: number;
    readVersionCalls: number;
    statCalls: number;
    writeFileCalls: number;
    memory: {
        baseline: MemorySnapshot;
        retained: MemorySnapshot;
        afterRelease: MemorySnapshot;
        retainedDeltaArrayBuffersBytes: number;
        afterReleaseDeltaArrayBuffersBytes: number;
    };
    runtime: {
        node: string;
        platform: NodeJS.Platform;
        arch: string;
    };
};

type WorkerMessage =
    | { type: "result"; sample: SharedOpenBenchmarkSample }
    | { type: "fatal"; message: string; stack?: string };

const forceGc = async () => {
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    assert.equal(
        typeof gc,
        "function",
        "shared-open benchmark worker must run with --expose-gc"
    );
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
};

const memorySnapshot = (): MemorySnapshot => {
    const memory = process.memoryUsage();
    return {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
    };
};

const run = async (handleCount: number): Promise<SharedOpenBenchmarkSample> => {
    assert.ok(
        ALLOWED_HANDLE_COUNTS.has(handleCount),
        `Shared-open benchmark handle count must be one of ${[
            ...ALLOWED_HANDLE_COUNTS,
        ].join(", ")}`
    );

    const storedBytes = new Uint8Array(SIZE_BYTES);
    for (let offset = 0; offset < storedBytes.byteLength; offset += 4096) {
        storedBytes[offset] = (offset / 4096) % 251;
    }
    const contentHash = createHash("sha256")
        .update(storedBytes)
        .digest("base64");
    const entry: SharedFsEntryInfo = {
        path: "/shared-open-benchmark.bin",
        nodeId: "file:shared-open-benchmark",
        name: "shared-open-benchmark.bin",
        kind: "file",
        size: BigInt(SIZE_BYTES),
        updatedAt: 1n,
        authorKey: "benchmark",
        machineLabel: "benchmark",
        conflict: false,
        versionId: "version:shared-open-benchmark",
        headVersionIds: ["version:shared-open-benchmark"],
        contentHash,
    };
    let verifiedReadCalls = 0;
    let targetHashCalls = 0;
    let targetHashedBytes = 0;
    let verifiedCopyMs = 0;
    let verifiedHashMs = 0;
    let readFileCalls = 0;
    let readVersionCalls = 0;
    let statCalls = 0;
    let writeFileCalls = 0;

    const target: SharedFsMountBackendTarget = {
        mountReadSemantics: () => SHARED_FS_MOUNT_READ_SEMANTICS,
        readVersionForMount: async (_path, versionId) => {
            verifiedReadCalls++;
            assert.equal(versionId, entry.versionId);
            const copyStartedAt = performance.now();
            const bytes = storedBytes.slice();
            verifiedCopyMs += performance.now() - copyStartedAt;
            const hashStartedAt = performance.now();
            const observedHash = createHash("sha256")
                .update(bytes)
                .digest("base64");
            verifiedHashMs += performance.now() - hashStartedAt;
            targetHashCalls++;
            targetHashedBytes += bytes.byteLength;
            assert.equal(observedHash, contentHash);
            return {
                bytes,
                versionId,
                nodeId: entry.nodeId,
                contentHash,
                size: entry.size,
            };
        },
        readFile: async () => {
            readFileCalls++;
            throw new Error("verified shared opens must not use readFile");
        },
        readVersion: async () => {
            readVersionCalls++;
            throw new Error("verified shared opens must not use readVersion");
        },
        stat: async () => {
            statCalls++;
            return entry;
        },
        writeFile: async () => {
            writeFileCalls++;
            throw new Error("read-only shared opens must not commit");
        },
        mkdir: async () => undefined,
        rm: async () => undefined,
        rename: async () => undefined,
        list: async () => [entry],
        versions: async () => [],
        conflicts: async () => [],
        bootstrapStatus: () => ({ writeReady: true }),
    };
    const backend = createSharedFsMountBackend(target);

    await forceGc();
    const baseline = memorySnapshot();
    const openStartedAt = performance.now();
    const handles = await Promise.all(
        Array.from({ length: handleCount }, () =>
            backend.open(entry.path, { read: true })
        )
    );
    const openMs = performance.now() - openStartedAt;
    await forceGc();
    const retained = memorySnapshot();

    for (const handle of handles) {
        const firstByte = await backend.read(handle, 1, 0);
        assert.equal(firstByte.byteLength, 1);
        assert.equal(firstByte[0], storedBytes[0]);
    }
    await Promise.all(handles.map((handle) => backend.release(handle)));
    await forceGc();
    const afterRelease = memorySnapshot();

    assert.equal(verifiedReadCalls, 1);
    assert.equal(targetHashCalls, 1);
    assert.equal(targetHashedBytes, SIZE_BYTES);
    assert.equal(readFileCalls, 0);
    assert.equal(readVersionCalls, 0);
    assert.equal(statCalls, handleCount + 1);
    assert.equal(writeFileCalls, 0);

    return {
        handles: handleCount,
        sizeMiB: SIZE_MIB,
        sizeBytes: SIZE_BYTES,
        openMs,
        verifiedCopyMs,
        verifiedHashMs,
        verifiedReadCalls,
        targetHashCalls,
        targetHashedBytes,
        readFileCalls,
        readVersionCalls,
        statCalls,
        writeFileCalls,
        memory: {
            baseline,
            retained,
            afterRelease,
            retainedDeltaArrayBuffersBytes:
                retained.arrayBuffersBytes - baseline.arrayBuffersBytes,
            afterReleaseDeltaArrayBuffersBytes:
                afterRelease.arrayBuffersBytes - baseline.arrayBuffersBytes,
        },
        runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
        },
    };
};

const send = (message: WorkerMessage) => {
    if (typeof process.send === "function") {
        process.send(message);
    }
};

const handleCount = Number(process.argv[2]);
run(handleCount).then(
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
