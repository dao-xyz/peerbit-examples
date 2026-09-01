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
const ALLOWED_SIZES_MIB = new Set([4, 64, 256]);
const MODES = new Set(["fallback", "verified"] as const);
const SAMPLES = 5;

type BenchmarkMode = "fallback" | "verified";

type OpenHashBenchmarkSample = {
    mode: BenchmarkMode;
    sizeMiB: number;
    sizeBytes: number;
    samples: number;
    openP50Ms: number;
    targetCopyP50Ms: number;
    targetHashP50Ms: number;
    openP50MiBPerSecond: number;
    legacyReadCalls: number;
    verifiedReadCalls: number;
    targetHashCalls: number;
    targetHashedBytes: number;
    statCalls: number;
    writeFileCalls: number;
    runtime: {
        node: string;
        platform: NodeJS.Platform;
        arch: string;
    };
};

type WorkerMessage =
    | { type: "result"; sample: OpenHashBenchmarkSample }
    | { type: "fatal"; message: string; stack?: string };

const p50 = (values: number[]) => {
    assert.ok(values.length > 0);
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
};

const forceGc = async () => {
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    assert.equal(
        typeof gc,
        "function",
        "open-hash benchmark worker must run with --expose-gc"
    );
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
};

const run = async (
    sizeMiB: number,
    mode: BenchmarkMode
): Promise<OpenHashBenchmarkSample> => {
    assert.ok(
        ALLOWED_SIZES_MIB.has(sizeMiB),
        `Open-hash benchmark size must be one of ${[...ALLOWED_SIZES_MIB].join(", ")} MiB`
    );
    assert.ok(MODES.has(mode), `Unknown open-hash benchmark mode: ${mode}`);
    const sizeBytes = sizeMiB * MEBIBYTE;
    const storedBytes = new Uint8Array(sizeBytes);
    for (let offset = 0; offset < storedBytes.byteLength; offset += 4096) {
        storedBytes[offset] = (offset / 4096) % 251;
    }
    const contentHash = createHash("sha256")
        .update(storedBytes)
        .digest("base64");
    const entry: SharedFsEntryInfo = {
        path: "/open-hash-benchmark.bin",
        nodeId: "file:open-hash-benchmark",
        name: "open-hash-benchmark.bin",
        kind: "file",
        size: BigInt(sizeBytes),
        updatedAt: 1n,
        authorKey: "benchmark",
        machineLabel: "benchmark",
        conflict: false,
        versionId: "version:open-hash-benchmark",
        headVersionIds: ["version:open-hash-benchmark"],
        contentHash,
    };
    const openSamples: number[] = [];
    const targetCopySamples: number[] = [];
    const targetHashSamples: number[] = [];
    let legacyReadCalls = 0;
    let verifiedReadCalls = 0;
    let targetHashCalls = 0;
    let targetHashedBytes = 0;
    let statCalls = 0;
    let writeFileCalls = 0;

    const exactRead = () => {
        const copyStartedAt = performance.now();
        // Models readFileVersion's newly assembled, mount-owned allocation.
        const bytes = storedBytes.slice();
        targetCopySamples.push(performance.now() - copyStartedAt);
        const hashStartedAt = performance.now();
        const observedHash = createHash("sha256")
            .update(bytes)
            .digest("base64");
        targetHashSamples.push(performance.now() - hashStartedAt);
        targetHashCalls++;
        targetHashedBytes += bytes.byteLength;
        assert.equal(observedHash, contentHash);
        return bytes;
    };

    const target: SharedFsMountBackendTarget = {
        ...(mode === "verified"
            ? {
                  mountReadSemantics: () => SHARED_FS_MOUNT_READ_SEMANTICS,
                  readVersionForMount: async (
                      _path: string,
                      versionId: string
                  ) => {
                      verifiedReadCalls++;
                      assert.equal(versionId, entry.versionId);
                      return {
                          bytes: exactRead(),
                          versionId,
                          nodeId: entry.nodeId,
                          contentHash,
                          size: entry.size,
                      };
                  },
              }
            : {}),
        readFile: async () => undefined,
        readVersion: async (_path, versionId) => {
            legacyReadCalls++;
            assert.equal(versionId, entry.versionId);
            return exactRead();
        },
        stat: async () => {
            statCalls++;
            return entry;
        },
        writeFile: async () => {
            writeFileCalls++;
            throw new Error("writable-open benchmark must not commit");
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

    // Warm crypto and allocation paths without including them in the sample.
    const warmHandle = await backend.open(entry.path, {
        read: true,
        write: true,
    });
    await backend.release(warmHandle);
    openSamples.length = 0;
    targetCopySamples.length = 0;
    targetHashSamples.length = 0;
    legacyReadCalls = 0;
    verifiedReadCalls = 0;
    targetHashCalls = 0;
    targetHashedBytes = 0;
    statCalls = 0;
    writeFileCalls = 0;

    for (let sample = 0; sample < SAMPLES; sample++) {
        await forceGc();
        const startedAt = performance.now();
        const handle = await backend.open(entry.path, {
            read: true,
            write: true,
        });
        openSamples.push(performance.now() - startedAt);
        await backend.release(handle);
    }

    assert.equal(targetHashCalls, SAMPLES);
    assert.equal(targetHashedBytes, SAMPLES * sizeBytes);
    assert.equal(statCalls, SAMPLES * 2);
    assert.equal(writeFileCalls, 0);
    assert.equal(legacyReadCalls, mode === "fallback" ? SAMPLES : 0);
    assert.equal(verifiedReadCalls, mode === "verified" ? SAMPLES : 0);

    const openP50Ms = p50(openSamples);
    return {
        mode,
        sizeMiB,
        sizeBytes,
        samples: SAMPLES,
        openP50Ms,
        targetCopyP50Ms: p50(targetCopySamples),
        targetHashP50Ms: p50(targetHashSamples),
        openP50MiBPerSecond: openP50Ms > 0 ? (sizeMiB * 1000) / openP50Ms : 0,
        legacyReadCalls,
        verifiedReadCalls,
        targetHashCalls,
        targetHashedBytes,
        statCalls,
        writeFileCalls,
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
