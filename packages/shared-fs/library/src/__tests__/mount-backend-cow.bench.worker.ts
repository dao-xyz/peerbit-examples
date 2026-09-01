import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
    createSharedFsMountBackend,
    type SharedFsMountBackendTarget,
} from "../mount-backend.js";

const MEBIBYTE = 1024 * 1024;
const ALLOWED_SIZES_MIB = new Set([4, 64, 256]);
const MODES = new Set(["capable", "fallback"] as const);

type BenchmarkMode = "capable" | "fallback";

type MemorySnapshot = {
    rssBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    maxRssBytes: number;
};

type MemoryDelta = MemorySnapshot;

type CowBenchmarkSample = {
    mode: BenchmarkMode;
    sizeMiB: number;
    sizeBytes: number;
    commitEnterMs: number;
    commitFinalizeMs: number;
    retainedCowWriteMs: number;
    commitEnterMiBPerSecond: number;
    retainedCowWriteMiBPerSecond: number;
    writeFileCalls: number;
    targetHashCalls: number;
    targetHashedBytes: number;
    targetHashMs: number;
    snapshotPreserved: boolean;
    liveMutationPreserved: boolean;
    memory: {
        baseline: MemorySnapshot;
        commitHeld: MemorySnapshot;
        commitSettled: MemorySnapshot;
        afterRetainedCowWrite: MemorySnapshot;
        deltas: {
            commitHeldVsBaseline: MemoryDelta;
            commitSettledVsBaseline: MemoryDelta;
            retainedCowWriteVsCommitSettled: MemoryDelta;
        };
    };
    runtime: {
        node: string;
        platform: NodeJS.Platform;
        arch: string;
    };
};

type WorkerMessage =
    | { type: "result"; sample: CowBenchmarkSample }
    | { type: "fatal"; message: string; stack?: string };

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const forceGc = async () => {
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    assert.equal(
        typeof gc,
        "function",
        "COW benchmark worker must run with --expose-gc"
    );
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
};

const memorySnapshot = (): MemorySnapshot => {
    const memory = process.memoryUsage();
    return {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        // Node reports maxRSS in KiB on every supported platform.
        maxRssBytes: process.resourceUsage().maxRSS * 1024,
    };
};

const memoryDelta = (
    after: MemorySnapshot,
    before: MemorySnapshot
): MemoryDelta => ({
    rssBytes: after.rssBytes - before.rssBytes,
    heapUsedBytes: after.heapUsedBytes - before.heapUsedBytes,
    externalBytes: after.externalBytes - before.externalBytes,
    arrayBuffersBytes: after.arrayBuffersBytes - before.arrayBuffersBytes,
    maxRssBytes: after.maxRssBytes - before.maxRssBytes,
});

const throughputMiBPerSecond = (sizeMiB: number, durationMs: number) =>
    durationMs > 0 ? (sizeMiB * 1000) / durationMs : 0;

const run = async (
    sizeMiB: number,
    mode: BenchmarkMode
): Promise<CowBenchmarkSample> => {
    assert.ok(
        ALLOWED_SIZES_MIB.has(sizeMiB),
        `COW benchmark size must be one of ${[...ALLOWED_SIZES_MIB].join(", ")} MiB`
    );
    assert.ok(MODES.has(mode), `Unknown COW benchmark mode: ${mode}`);
    const sizeBytes = sizeMiB * MEBIBYTE;
    const writeEntered = deferred();
    const writeAllowed = deferred();
    const retainedSnapshots: Uint8Array[] = [];
    let snapshotPreserved = false;
    let writeFileCalls = 0;
    let targetHashCalls = 0;
    let targetHashedBytes = 0;
    let targetHashMs = 0;

    const target: SharedFsMountBackendTarget = {
        ...(mode === "capable"
            ? {
                  mountWriteSemantics: () =>
                      "self-hashed-exact-head-noop-v1" as const,
              }
            : {}),
        readFile: async () => undefined,
        readVersion: async () => undefined,
        stat: async () => undefined,
        writeFile: async (_path, source) => {
            writeFileCalls++;
            assert.equal(
                writeFileCalls,
                1,
                "flush must perform one commit pass"
            );
            assert.ok(
                source instanceof Uint8Array,
                "mount commit must provide byte content"
            );
            const targetHashStartedAt = performance.now();
            const contentHash = createHash("sha256")
                .update(source)
                .digest("base64");
            targetHashMs += performance.now() - targetHashStartedAt;
            targetHashCalls++;
            targetHashedBytes += source.byteLength;
            // Retain the exact source indefinitely, including after this
            // promise resolves, matching SharedFileSystem's chunk-view
            // retention contract.
            retainedSnapshots.push(source);
            writeEntered.resolve();
            await writeAllowed.promise;
            return {
                id: "benchmark-version",
                nodeId: "benchmark-node",
                contentHash,
                ...(mode === "capable"
                    ? { mountWriteOutcome: "created" as const }
                    : {}),
            };
        },
        mkdir: async () => undefined,
        rm: async () => undefined,
        rename: async () => undefined,
        list: async () => [],
        versions: async () => [],
        conflicts: async () => [],
        bootstrapStatus: () => ({ writeReady: true }),
    };

    const backend = createSharedFsMountBackend(target, {
        writeFileInput: "immutable-borrowed",
    });
    const handle = await backend.open("/cow-benchmark.bin", {
        read: true,
        write: true,
        create: true,
        truncate: true,
    });
    // Grow the handle directly so the fixture never retains a second size-N
    // source allocation before the commit measurement begins.
    await backend.truncate(handle, sizeBytes);
    await forceGc();
    const baseline = memorySnapshot();

    const commitStartedAt = performance.now();
    const flushing = backend.flush(handle);
    try {
        await Promise.race([
            writeEntered.promise,
            flushing.then(
                () => {
                    throw new Error(
                        "flush resolved before the fake target observed its snapshot"
                    );
                },
                (error) => Promise.reject(error)
            ),
        ]);
        const commitEnterMs = performance.now() - commitStartedAt;

        // The target deliberately retains the exact commit snapshot here. This
        // distinguishes an eager size-N copy from the borrowed COW fast path.
        assert.equal(retainedSnapshots[0]?.byteLength, sizeBytes);
        await forceGc();
        const commitHeld = memorySnapshot();

        const finalizeStartedAt = performance.now();
        writeAllowed.resolve();
        await flushing;
        const commitFinalizeMs = performance.now() - finalizeStartedAt;
        await forceGc();
        const commitSettled = memorySnapshot();

        // The target still owns the exact commit input after writeFile has
        // resolved. The first later mutation therefore measures the permanent
        // immutable-borrowed detachment, not merely an in-flight overlap.
        const cowWriteStartedAt = performance.now();
        await backend.write(handle, Uint8Array.of(1), 0);
        const retainedCowWriteMs = performance.now() - cowWriteStartedAt;
        await forceGc();
        const afterRetainedCowWrite = memorySnapshot();

        assert.equal(writeFileCalls, 1);
        assert.equal(targetHashCalls, 1);
        assert.equal(targetHashedBytes, sizeBytes);
        const retainedSnapshot = retainedSnapshots[0];
        snapshotPreserved =
            retainedSnapshots.length === 1 &&
            retainedSnapshot?.byteLength === sizeBytes &&
            retainedSnapshot[0] === 0 &&
            retainedSnapshot[retainedSnapshot.byteLength - 1] === 0;
        assert.equal(snapshotPreserved, true);
        const live = await backend.read(handle, 1, 0);
        const liveMutationPreserved = live[0] === 1;
        assert.equal(liveMutationPreserved, true);

        return {
            mode,
            sizeMiB,
            sizeBytes,
            commitEnterMs,
            commitFinalizeMs,
            retainedCowWriteMs,
            commitEnterMiBPerSecond: throughputMiBPerSecond(
                sizeMiB,
                commitEnterMs
            ),
            retainedCowWriteMiBPerSecond: throughputMiBPerSecond(
                sizeMiB,
                retainedCowWriteMs
            ),
            writeFileCalls,
            targetHashCalls,
            targetHashedBytes,
            targetHashMs,
            snapshotPreserved,
            liveMutationPreserved,
            memory: {
                baseline,
                commitHeld,
                commitSettled,
                afterRetainedCowWrite,
                deltas: {
                    commitHeldVsBaseline: memoryDelta(commitHeld, baseline),
                    commitSettledVsBaseline: memoryDelta(
                        commitSettled,
                        baseline
                    ),
                    retainedCowWriteVsCommitSettled: memoryDelta(
                        afterRetainedCowWrite,
                        commitSettled
                    ),
                },
            },
            runtime: {
                node: process.version,
                platform: process.platform,
                arch: process.arch,
            },
        };
    } finally {
        // Make every failure path release the synthetic target gate so a
        // rejected benchmark cannot retain an otherwise idle child process.
        writeAllowed.resolve();
    }
};

const send = (message: WorkerMessage) =>
    new Promise<void>((resolve, reject) => {
        if (!process.send) {
            reject(
                new Error("COW benchmark worker requires a Node IPC channel")
            );
            return;
        }
        process.send(message, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });

const main = async () => {
    const sizeMiB = Number(process.argv[2]);
    const mode = process.argv[3] as BenchmarkMode;
    const sample = await run(sizeMiB, mode);
    await send({ type: "result", sample });
    process.disconnect();
};

main().catch(async (error: unknown) => {
    const normalized =
        error instanceof Error ? error : new Error(String(error));
    try {
        await send({
            type: "fatal",
            message: normalized.message,
            stack: normalized.stack,
        });
    } finally {
        process.exit(1);
    }
});
