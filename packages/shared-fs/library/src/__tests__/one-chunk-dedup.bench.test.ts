import { createHash } from "node:crypto";
import {
    mkdtemp,
    readFile,
    rm,
    writeFile as writeReportFile,
} from "node:fs/promises";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Peerbit } from "peerbit";
import { describe, expect, it } from "vitest";
import {
    createSharedFsMountBackend,
    openSharedFs,
    type SharedFsHandle,
    type SharedFsMountBackend,
    type SharedFsMountBackendTarget,
    type WriteFileOptions,
} from "../index.js";
import {
    scanProcessSoakStateDirectory,
    type ProcessSoakStorageSnapshot,
    type ProcessSoakStorageUsage,
} from "./process-isolated-soak-storage.js";

const enabled = process.env.PEERBIT_SHARED_FS_ONE_CHUNK_DEDUP_BENCH === "1";
const manualDescribe = enabled ? describe : describe.skip;
const SAMPLES = 30;
const WARMUPS = 3;
const CREATE_BYTES = 1024;
const REPLACE_BYTES = 4096;
const MODES = ["verify", "always-touch"] as const;
const PATHS = ["direct", "mount-backend"] as const;
const WORKLOADS = [
    "fresh-create",
    "reused-create",
    "fresh-replace",
    "reused-replace",
] as const;
const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY_ROOT = resolve(HERE, "../..");
const REPOSITORY_ROOT = resolve(LIBRARY_ROOT, "../../..");
const BENCHMARK_INPUT_FILES = [
    "packages/shared-fs/library/src/__tests__/one-chunk-dedup.bench.test.ts",
    "packages/shared-fs/library/src/__tests__/process-isolated-soak-storage.ts",
    "packages/shared-fs/library/src/index.ts",
    "packages/shared-fs/library/src/model.ts",
    "packages/shared-fs/library/src/mount-backend.ts",
    "packages/shared-fs/library/package.json",
] as const;
const PEERBIT_COHORT_PACKAGES = [
    "peerbit",
    "@peerbit/document",
    "@peerbit/shared-log",
    "@peerbit/program",
    "@peerbit/trusted-network",
    "@peerbit/pubsub",
    "@peerbit/blocks",
    "@peerbit/blocks-interface",
] as const;

type BenchmarkMode = (typeof MODES)[number];
type BenchmarkPath = (typeof PATHS)[number];
type BenchmarkWorkload = (typeof WORKLOADS)[number];

type OperationCounters = {
    hasDocumentCalls: number;
    indexGetCalls: number;
    indexIterateCalls: number;
    entriesPutCalls: number;
    uniquePutCalls: number;
    nonUniquePutCalls: number;
    fileChunkPuts: number;
    fileChunkUniquePuts: number;
    fileChunkNonUniquePuts: number;
    fileVersionPuts: number;
    namingPuts: number;
    otherPuts: number;
};

type TimedSample = {
    durationNs: number;
    openNs?: number;
    writeNs?: number;
    fsyncNs?: number;
    releaseNs?: number;
};

type BenchmarkContext = {
    mode: BenchmarkMode;
    stateDirectory: string;
    peer: Peerbit;
    fs: SharedFsHandle;
    backend?: SharedFsMountBackend;
    counters: {
        reset(): void;
        snapshot(): OperationCounters;
        restore(): void;
    };
};

const emptyCounters = (): OperationCounters => ({
    hasDocumentCalls: 0,
    indexGetCalls: 0,
    indexIterateCalls: 0,
    entriesPutCalls: 0,
    uniquePutCalls: 0,
    nonUniquePutCalls: 0,
    fileChunkPuts: 0,
    fileChunkUniquePuts: 0,
    fileChunkNonUniquePuts: 0,
    fileVersionPuts: 0,
    namingPuts: 0,
    otherPuts: 0,
});

const copyCounters = (value: OperationCounters): OperationCounters => ({
    ...value,
});

const counterCategorySums = (counters: OperationCounters) => ({
    uniqueness: counters.uniquePutCalls + counters.nonUniquePutCalls,
    entryKinds:
        counters.fileChunkPuts +
        counters.fileVersionPuts +
        counters.namingPuts +
        counters.otherPuts,
    fileChunkUniqueness:
        counters.fileChunkUniquePuts + counters.fileChunkNonUniquePuts,
});

const installOperationCounters = (fs: SharedFsHandle) => {
    const program = fs.program as any;
    const entries = program.entries as any;
    const index = entries.index as any;
    const originals = {
        hasDocument: program.hasDocument,
        put: entries.put,
        get: index.get,
        iterate: index.iterate,
    };
    let counters = emptyCounters();

    program.hasDocument = async function (...args: unknown[]) {
        counters.hasDocumentCalls++;
        return originals.hasDocument.apply(this, args);
    };
    entries.put = async function (
        value: { kind?: string },
        options?: { unique?: boolean }
    ) {
        counters.entriesPutCalls++;
        if (options?.unique === true) counters.uniquePutCalls++;
        else counters.nonUniquePutCalls++;
        if (value?.kind === "file-chunk") {
            counters.fileChunkPuts++;
            if (options?.unique === true) counters.fileChunkUniquePuts++;
            else counters.fileChunkNonUniquePuts++;
        } else if (value?.kind === "file-version") {
            counters.fileVersionPuts++;
        } else if (value?.kind === "naming") {
            counters.namingPuts++;
        } else {
            counters.otherPuts++;
        }
        return originals.put.apply(this, [value, options]);
    };
    index.get = async function (...args: unknown[]) {
        counters.indexGetCalls++;
        return originals.get.apply(this, args);
    };
    index.iterate = function (...args: unknown[]) {
        counters.indexIterateCalls++;
        return originals.iterate.apply(this, args);
    };

    return {
        reset: () => {
            counters = emptyCounters();
        },
        snapshot: () => copyCounters(counters),
        restore: () => {
            program.hasDocument = originals.hasDocument;
            entries.put = originals.put;
            index.get = originals.get;
            index.iterate = originals.iterate;
        },
    };
};

const dedupForMode = (mode: BenchmarkMode): "verify" | "off" =>
    mode === "verify" ? "verify" : "off";

const stopPeer = async (peer: Peerbit) => {
    try {
        await peer.stop();
    } catch (error) {
        if (
            !(
                error instanceof TypeError &&
                error.message.includes("clearAll") &&
                error.stack?.includes("DocumentIndex.close")
            )
        ) {
            throw error;
        }
    }
};

const combineFailures = (message: string, failures: unknown[]) => {
    if (failures.length === 1) return failures[0];
    return new AggregateError(failures, message);
};

const cleanupContexts = async (contexts: BenchmarkContext[]) => {
    const failures: unknown[] = [];
    for (const context of contexts) {
        try {
            context.counters.restore();
        } catch (error) {
            failures.push(error);
        }
    }
    const stopped = await Promise.allSettled(
        contexts.map((context) => stopPeer(context.peer))
    );
    for (const result of stopped) {
        if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length > 0) {
        throw combineFailures(
            "Failed to clean up benchmark contexts",
            failures
        );
    }
};

const mountTarget = (
    fs: SharedFsHandle,
    mode: BenchmarkMode
): SharedFsMountBackendTarget => ({
    mountWriteSemantics: () => fs.mountWriteSemantics(),
    mountReadSemantics: () => fs.mountReadSemantics(),
    readVersionForMount: (path, versionId) =>
        fs.readVersionForMount(path, versionId),
    mountNamespaceSemantics: () => fs.mountNamespaceSemantics(),
    mutateNamespaceForMount: (mutation) => fs.mutateNamespaceForMount(mutation),
    readFile: (path) => fs.readFile(path),
    readVersion: (path, versionId) => fs.readVersion(path, versionId),
    writeFile: (path, source, options) =>
        fs.writeFile(path, source, {
            ...options,
            dedup: dedupForMode(mode),
        }),
    mkdir: (path) => fs.mkdir(path),
    rm: (path) => fs.rm(path),
    rename: (from, to) => fs.rename(from, to),
    list: (path) => fs.list(path),
    versions: (path) => fs.versions(path),
    conflicts: (path, options) => fs.conflicts(path, options),
    stat: (path) => fs.stat(path),
    bootstrapStatus: () => fs.bootstrapStatus(),
});

const createContext = async (
    root: string,
    path: BenchmarkPath,
    workload: BenchmarkWorkload,
    mode: BenchmarkMode
): Promise<BenchmarkContext> => {
    const stateDirectory = join(root, `${path}-${workload}-${mode}`);
    let peer: Peerbit | undefined;
    let counters: BenchmarkContext["counters"] | undefined;
    try {
        peer = await Peerbit.create({ directory: stateDirectory });
        const fs = await openSharedFs({
            peerbit: peer,
            // Only the dedup mode may differ between the paired programs.
            machineLabel: `${path}-${workload}`,
            bootstrap: false,
            gc: false,
        });
        counters = installOperationCounters(fs);
        const backend =
            path === "mount-backend"
                ? createSharedFsMountBackend(mountTarget(fs, mode), {
                      writeFileInput: "immutable-borrowed",
                  })
                : undefined;
        return { mode, stateDirectory, peer, fs, backend, counters };
    } catch (error) {
        const failures: unknown[] = [error];
        try {
            counters?.restore();
        } catch (cleanupError) {
            failures.push(cleanupError);
        }
        if (peer) {
            try {
                await stopPeer(peer);
            } catch (cleanupError) {
                failures.push(cleanupError);
            }
        }
        throw combineFailures("Failed to create benchmark context", failures);
    }
};

const patternedBytes = (size: number, seed: number) => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index++) {
        bytes[index] = (index * 17 + seed * 29 + (index >>> 4)) % 251;
    }
    return bytes;
};

const readOptionalText = async (path: string) => {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EISDIR") return undefined;
        throw error;
    }
};

// Resolve HEAD directly so the report does not depend on git being in PATH
// and provenance collection remains read-only in ordinary and worktree clones.
const readGitCommit = async () => {
    const dotGit = join(REPOSITORY_ROOT, ".git");
    const dotGitContents = await readOptionalText(dotGit);
    const gitDirectory = dotGitContents?.startsWith("gitdir:")
        ? resolve(
              REPOSITORY_ROOT,
              dotGitContents.slice("gitdir:".length).trim()
          )
        : dotGit;
    const head = (await readOptionalText(join(gitDirectory, "HEAD")))?.trim();
    if (!head) return undefined;
    if (/^[0-9a-f]{40}$/iu.test(head)) return head.toLowerCase();
    if (!head.startsWith("ref: ")) return undefined;
    const reference = head.slice("ref: ".length);
    const commonRelative = (
        await readOptionalText(join(gitDirectory, "commondir"))
    )?.trim();
    const commonDirectory = commonRelative
        ? resolve(gitDirectory, commonRelative)
        : gitDirectory;
    for (const root of [gitDirectory, commonDirectory]) {
        const loose = (await readOptionalText(join(root, reference)))?.trim();
        if (loose && /^[0-9a-f]{40}$/iu.test(loose)) {
            return loose.toLowerCase();
        }
    }
    const packed = await readOptionalText(join(commonDirectory, "packed-refs"));
    const match = packed
        ?.split(/\r?\n/u)
        .find((line) => line.endsWith(` ${reference}`));
    const packedCommit = match?.split(" ", 1)[0];
    return packedCommit && /^[0-9a-f]{40}$/iu.test(packedCommit)
        ? packedCommit.toLowerCase()
        : undefined;
};

const hashBenchmarkInputs = async () => {
    const hash = createHash("sha256");
    for (const relativePath of BENCHMARK_INPUT_FILES) {
        hash.update(relativePath);
        hash.update("\0");
        hash.update(await readFile(join(REPOSITORY_ROOT, relativePath)));
        hash.update("\0");
    }
    return hash.digest("hex");
};

const readPeerbitCohort = async () => {
    const entries = await Promise.all(
        PEERBIT_COHORT_PACKAGES.map(async (packageName) => {
            const packageJson = JSON.parse(
                await readFile(
                    join(
                        LIBRARY_ROOT,
                        "node_modules",
                        ...packageName.split("/"),
                        "package.json"
                    ),
                    "utf8"
                )
            ) as { version?: unknown };
            if (
                typeof packageJson.version !== "string" ||
                packageJson.version.length === 0
            ) {
                throw new Error(`Missing installed version for ${packageName}`);
            }
            return [packageName, packageJson.version] as const;
        })
    );
    return Object.fromEntries(entries) as Record<
        (typeof PEERBIT_COHORT_PACKAGES)[number],
        string
    >;
};

const collectProvenance = async () => {
    const [lockfile, gitHeadCommit, benchmarkInputsSha256, peerbitCohort] =
        await Promise.all([
            readFile(join(REPOSITORY_ROOT, "pnpm-lock.yaml")),
            readGitCommit(),
            hashBenchmarkInputs(),
            readPeerbitCohort(),
        ]);
    return {
        gitHeadCommit: gitHeadCommit ?? null,
        pnpmLockSha256: createHash("sha256").update(lockfile).digest("hex"),
        benchmarkInputFiles: [...BENCHMARK_INPUT_FILES],
        benchmarkInputsSha256,
        peerbitCohort,
        peerbitCohortResolution:
            "versions read from packages/shared-fs/library/node_modules package manifests used by this run",
    };
};

const elapsedNs = (startedAt: bigint) =>
    Number(process.hrtime.bigint() - startedAt);

const time = async (operation: () => Promise<unknown>) => {
    const startedAt = process.hrtime.bigint();
    await operation();
    return elapsedNs(startedAt);
};

const directWrite = (
    context: BenchmarkContext,
    path: string,
    bytes: Uint8Array,
    options: WriteFileOptions = {}
) =>
    context.fs.writeFile(path, bytes, {
        ...options,
        dedup: dedupForMode(context.mode),
    });

const mountedWrite = async (
    backend: SharedFsMountBackend,
    path: string,
    bytes: Uint8Array
): Promise<TimedSample> => {
    const startedAt = process.hrtime.bigint();
    let handle: number | undefined;
    let released = false;
    let failure: unknown;
    let openNs = 0;
    let writeNs = 0;
    let fsyncNs = 0;
    let releaseNs = 0;
    try {
        openNs = await time(async () => {
            handle = await backend.open(path, {
                write: true,
                create: true,
                truncate: true,
            });
        });
        writeNs = await time(async () => {
            await backend.write(handle!, bytes, 0);
        });
        fsyncNs = await time(async () => {
            await backend.fsync(handle!);
        });
        releaseNs = await time(async () => {
            await backend.release(handle!);
        });
        released = true;
    } catch (error) {
        failure = error;
    }
    if (handle !== undefined && !released) {
        try {
            await backend.release(handle);
            released = true;
        } catch (releaseError) {
            if (failure !== undefined) {
                throw combineFailures(
                    "Mounted write and cleanup release both failed",
                    [failure, releaseError]
                );
            }
            throw releaseError;
        }
    }
    if (failure !== undefined) throw failure;
    return {
        durationNs: elapsedNs(startedAt),
        openNs,
        writeNs,
        fsyncNs,
        releaseNs,
    };
};

const executeWrite = async (
    context: BenchmarkContext,
    path: BenchmarkPath,
    filePath: string,
    bytes: Uint8Array
): Promise<TimedSample> => {
    if (path === "mount-backend") {
        return mountedWrite(context.backend!, filePath, bytes);
    }
    const startedAt = process.hrtime.bigint();
    await directWrite(context, filePath, bytes);
    return { durationNs: elapsedNs(startedAt) };
};

const percentile = (values: number[], fraction: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};

const summarizeNumbers = (values: number[]) => ({
    count: values.length,
    minNs: Math.min(...values),
    p50Ns: percentile(values, 0.5),
    p95Ns: percentile(values, 0.95),
    maxNs: Math.max(...values),
    meanNs: values.reduce((sum, value) => sum + value, 0) / values.length,
});

const summarizeSamples = (samples: TimedSample[]) => ({
    duration: summarizeNumbers(samples.map((sample) => sample.durationNs)),
    ...(samples.every((sample) => sample.openNs !== undefined)
        ? {
              phases: {
                  open: summarizeNumbers(
                      samples.map((sample) => sample.openNs!)
                  ),
                  write: summarizeNumbers(
                      samples.map((sample) => sample.writeNs!)
                  ),
                  fsync: summarizeNumbers(
                      samples.map((sample) => sample.fsyncNs!)
                  ),
                  release: summarizeNumbers(
                      samples.map((sample) => sample.releaseNs!)
                  ),
              },
          }
        : {}),
});

const subtractUsage = (
    after: ProcessSoakStorageUsage,
    before: ProcessSoakStorageUsage
): ProcessSoakStorageUsage => ({
    apparentRegularFileBytes:
        after.apparentRegularFileBytes - before.apparentRegularFileBytes,
    allocatedBytes:
        after.allocatedBytes === null || before.allocatedBytes === null
            ? null
            : after.allocatedBytes - before.allocatedBytes,
    regularFileCount: after.regularFileCount - before.regularFileCount,
    directoryCount: after.directoryCount - before.directoryCount,
});

const storageDelta = (
    after: ProcessSoakStorageSnapshot,
    before: ProcessSoakStorageSnapshot
) => subtractUsage(after, before);

const logLength = async (context: BenchmarkContext) =>
    (await (context.fs.program.entries.log as any).log.toArray())
        .length as number;

const setupWorkload = async (
    context: BenchmarkContext,
    workload: BenchmarkWorkload,
    reused: readonly [Uint8Array, Uint8Array]
) => {
    await context.fs.mkdir("/bench");
    if (workload === "reused-create") {
        await context.fs.writeFile("/bench/reused-holder.bin", reused[0], {
            dedup: "verify",
        });
    } else if (workload === "fresh-replace") {
        await context.fs.writeFile(
            "/bench/target.bin",
            patternedBytes(REPLACE_BYTES, 1),
            { dedup: "verify" }
        );
    } else if (workload === "reused-replace") {
        await context.fs.writeFile("/bench/reused-a.bin", reused[0], {
            dedup: "verify",
        });
        await context.fs.writeFile("/bench/reused-b.bin", reused[1], {
            dedup: "verify",
        });
        await context.fs.writeFile("/bench/target.bin", reused[0], {
            dedup: "verify",
        });
    }
};

const workloadInput = (
    workload: BenchmarkWorkload,
    sequenceIndex: number,
    freshPayloads: Uint8Array[],
    reused: readonly [Uint8Array, Uint8Array]
) => {
    if (workload === "fresh-create") {
        return {
            path: `/bench/create-${String(sequenceIndex).padStart(3, "0")}.bin`,
            bytes: freshPayloads[sequenceIndex],
        };
    }
    if (workload === "reused-create") {
        return {
            path: `/bench/create-${String(sequenceIndex).padStart(3, "0")}.bin`,
            bytes: reused[0],
        };
    }
    if (workload === "fresh-replace") {
        return {
            path: "/bench/target.bin",
            bytes: freshPayloads[sequenceIndex],
        };
    }
    return {
        path: "/bench/target.bin",
        // Setup starts at A. B/A/B/A keeps every write non-noop across the
        // warmup-to-measurement boundary while both chunks remain reusable.
        bytes: reused[sequenceIndex % 2 === 0 ? 1 : 0],
    };
};

const fasterPercent = (baselineNs: number, candidateNs: number) =>
    ((baselineNs - candidateNs) / baselineNs) * 100;

const captureLiveState = async (contexts: BenchmarkContext[]) => {
    const storageEntries: [BenchmarkMode, ProcessSoakStorageSnapshot][] = [];
    for (const context of contexts) {
        storageEntries.push([
            context.mode,
            await scanProcessSoakStateDirectory(context.stateDirectory),
        ]);
    }
    const logEntries: [BenchmarkMode, number][] = [];
    for (const context of contexts) {
        logEntries.push([context.mode, await logLength(context)]);
    }
    return {
        storage: Object.fromEntries(storageEntries) as Record<
            BenchmarkMode,
            ProcessSoakStorageSnapshot
        >,
        log: Object.fromEntries(logEntries) as Record<BenchmarkMode, number>,
    };
};

const assertMeasuredInvariants = (
    workload: BenchmarkWorkload,
    counters: Record<BenchmarkMode, OperationCounters>,
    logGrowth: Record<BenchmarkMode, number>
) => {
    const isCreate = workload.endsWith("create");
    const isFresh = workload.startsWith("fresh");
    for (const mode of MODES) {
        const value = counters[mode];
        const sums = counterCategorySums(value);
        expect(sums.uniqueness).toBe(value.entriesPutCalls);
        expect(sums.entryKinds).toBe(value.entriesPutCalls);
        expect(sums.fileChunkUniqueness).toBe(value.fileChunkPuts);

        const expectedChunkPuts =
            mode === "always-touch" || isFresh ? SAMPLES : 0;
        const expectedChunkUniquePuts =
            mode === "verify" && isFresh ? SAMPLES : 0;
        const expectedChunkNonUniquePuts =
            mode === "always-touch" ? SAMPLES : 0;
        const expectedNamingPuts = isCreate ? SAMPLES : 0;
        const expectedEntries =
            SAMPLES + expectedNamingPuts + expectedChunkPuts;
        expect(value.hasDocumentCalls).toBe(
            mode === "verify" ? SAMPLES * 2 : 0
        );
        expect(value.fileChunkPuts).toBe(expectedChunkPuts);
        expect(value.fileChunkUniquePuts).toBe(expectedChunkUniquePuts);
        expect(value.fileChunkNonUniquePuts).toBe(expectedChunkNonUniquePuts);
        expect(value.fileVersionPuts).toBe(SAMPLES);
        expect(value.namingPuts).toBe(expectedNamingPuts);
        expect(value.otherPuts).toBe(0);
        expect(value.entriesPutCalls).toBe(expectedEntries);
        expect(logGrowth[mode]).toBe(expectedEntries);
    }
};

const runPair = async (
    root: string,
    path: BenchmarkPath,
    workload: BenchmarkWorkload
) => {
    const payloadSize = workload.includes("create")
        ? CREATE_BYTES
        : REPLACE_BYTES;
    const freshPayloads = Array.from(
        { length: WARMUPS + SAMPLES },
        (_, index) => patternedBytes(payloadSize, 100 + index)
    );
    const reused = [
        patternedBytes(payloadSize, 10),
        patternedBytes(payloadSize, 20),
    ] as const;
    const contexts: BenchmarkContext[] = [];
    const execute = async () => {
        // Construct serially so a later failure cannot orphan an already-open
        // context behind a rejected Promise.all.
        for (const mode of MODES) {
            contexts.push(await createContext(root, path, workload, mode));
        }
        const byMode = Object.fromEntries(
            contexts.map((context) => [context.mode, context])
        ) as Record<BenchmarkMode, BenchmarkContext>;
        for (const context of contexts) {
            await setupWorkload(context, workload, reused);
        }

        for (let index = 0; index < WARMUPS; index++) {
            const order = index % 2 === 0 ? MODES : [...MODES].reverse();
            for (const mode of order) {
                const input = workloadInput(
                    workload,
                    index,
                    freshPayloads,
                    reused
                );
                await executeWrite(byMode[mode], path, input.path, input.bytes);
            }
        }

        const before = await captureLiveState(contexts);
        for (const context of contexts) context.counters.reset();

        const samples: Record<BenchmarkMode, TimedSample[]> = {
            verify: [],
            "always-touch": [],
        };
        let finalInput: { path: string; bytes: Uint8Array } | undefined;
        for (let index = 0; index < SAMPLES; index++) {
            const sequenceIndex = WARMUPS + index;
            const input = workloadInput(
                workload,
                sequenceIndex,
                freshPayloads,
                reused
            );
            finalInput = input;
            const order = index % 2 === 0 ? MODES : [...MODES].reverse();
            for (const mode of order) {
                samples[mode].push(
                    await executeWrite(
                        byMode[mode],
                        path,
                        input.path,
                        input.bytes
                    )
                );
            }
        }

        const counters = Object.fromEntries(
            contexts.map((context) => [
                context.mode,
                context.counters.snapshot(),
            ])
        ) as Record<BenchmarkMode, OperationCounters>;
        const after = await captureLiveState(contexts);
        const logGrowth = Object.fromEntries(
            MODES.map((mode) => [mode, after.log[mode] - before.log[mode]])
        ) as Record<BenchmarkMode, number>;

        for (const context of contexts) {
            expect(await context.fs.readFile(finalInput!.path)).toEqual(
                finalInput!.bytes
            );
        }
        assertMeasuredInvariants(workload, counters, logGrowth);
        const summaries = {
            verify: summarizeSamples(samples.verify),
            "always-touch": summarizeSamples(samples["always-touch"]),
        };
        return {
            path,
            workload,
            payloadBytes: payloadSize,
            samples: SAMPLES,
            warmups: WARMUPS,
            machineLabel: `${path}-${workload}`,
            scope:
                path === "mount-backend"
                    ? "in-process mount backend; no kernel FUSE/WinFsp or IPC boundary"
                    : "direct SharedFileSystem handle",
            modes: {
                verify: {
                    dedup: "verify",
                    raw: samples.verify,
                    summary: summaries.verify,
                    counters: counters.verify,
                    counterCategorySums: counterCategorySums(counters.verify),
                    log: {
                        beforeEntries: before.log.verify,
                        afterEntries: after.log.verify,
                        growthEntries: logGrowth.verify,
                    },
                    storage: {
                        lifecycle: "live",
                        interpretation:
                            "symmetric live snapshots; allocator, WAL, and checkpoint activity is noisy, so this delta is descriptive only and supports no physical amplification conclusion",
                        beforeLive: before.storage.verify,
                        afterLive: after.storage.verify,
                        observedLiveDelta: storageDelta(
                            after.storage.verify,
                            before.storage.verify
                        ),
                    },
                },
                alwaysTouch: {
                    dedup: "off",
                    raw: samples["always-touch"],
                    summary: summaries["always-touch"],
                    counters: counters["always-touch"],
                    counterCategorySums: counterCategorySums(
                        counters["always-touch"]
                    ),
                    log: {
                        beforeEntries: before.log["always-touch"],
                        afterEntries: after.log["always-touch"],
                        growthEntries: logGrowth["always-touch"],
                    },
                    storage: {
                        lifecycle: "live",
                        interpretation:
                            "symmetric live snapshots; allocator, WAL, and checkpoint activity is noisy, so this delta is descriptive only and supports no physical amplification conclusion",
                        beforeLive: before.storage["always-touch"],
                        afterLive: after.storage["always-touch"],
                        observedLiveDelta: storageDelta(
                            after.storage["always-touch"],
                            before.storage["always-touch"]
                        ),
                    },
                },
            },
            comparison: {
                positiveMeansAlwaysTouchFaster: true,
                p50FasterPercent: fasterPercent(
                    summaries.verify.duration.p50Ns,
                    summaries["always-touch"].duration.p50Ns
                ),
                p95FasterPercent: fasterPercent(
                    summaries.verify.duration.p95Ns,
                    summaries["always-touch"].duration.p95Ns
                ),
            },
        };
    };
    let result: Awaited<ReturnType<typeof execute>>;
    try {
        result = await execute();
    } catch (error) {
        try {
            await cleanupContexts(contexts);
        } catch (cleanupError) {
            throw combineFailures("Benchmark and cleanup both failed", [
                error,
                cleanupError,
            ]);
        }
        throw error;
    }
    await cleanupContexts(contexts);
    return result;
};

describe("one-chunk benchmark mounted lifecycle", () => {
    const backendWithRelease = (
        releaseHandle: (handle: number) => Promise<void>
    ) =>
        ({
            open: async () => 7,
            write: async () => 1,
            fsync: async () => {},
            release: releaseHandle,
        }) as unknown as SharedFsMountBackend;

    it("retries a rejected release while preserving its original error", async () => {
        const original = new Error("injected first release failure");
        let releaseCalls = 0;
        const backend = backendWithRelease(async (handle) => {
            expect(handle).toBe(7);
            releaseCalls++;
            if (releaseCalls === 1) throw original;
        });

        await expect(
            mountedWrite(backend, "/bench/release.bin", new Uint8Array([1]))
        ).rejects.toBe(original);
        expect(releaseCalls).toBe(2);
    });

    it("reports both failures when the cleanup release also rejects", async () => {
        const original = new Error("injected first release failure");
        const cleanup = new Error("injected cleanup release failure");
        let releaseCalls = 0;
        const backend = backendWithRelease(async () => {
            releaseCalls++;
            throw releaseCalls === 1 ? original : cleanup;
        });

        let observed: unknown;
        try {
            await mountedWrite(
                backend,
                "/bench/release.bin",
                new Uint8Array([1])
            );
        } catch (error) {
            observed = error;
        }
        expect(observed).toBeInstanceOf(AggregateError);
        expect((observed as AggregateError).errors).toEqual([
            original,
            cleanup,
        ]);
        expect(releaseCalls).toBe(2);
    });
});

manualDescribe("one-chunk dedup strategy benchmark (manual)", () => {
    it(
        "compares matched verify and always-touch writes without changing defaults",
        { timeout: 15 * 60_000 },
        async () => {
            const provenance = await collectProvenance();
            const startedAt = performance.now();
            const root = await mkdtemp(
                join(tmpdir(), "peerbit-shared-fs-one-chunk-dedup-")
            );
            try {
                const results: Awaited<ReturnType<typeof runPair>>[] = [];
                for (const path of PATHS) {
                    for (const workload of WORKLOADS) {
                        results.push(await runPair(root, path, workload));
                    }
                }
                const report = {
                    benchmark: "shared-fs-one-chunk-dedup-ab-v2",
                    reportOnly: true,
                    productionDefaultsChanged: false,
                    run: {
                        samplesPerMode: SAMPLES,
                        warmupsPerMode: WARMUPS,
                        pairedExecution: true,
                        alternatingModeOrder: true,
                        payloadPreparationTimed: false,
                        provenanceCollectionTimed: false,
                        storageSnapshots:
                            "symmetric live state-directory scans; physical byte deltas are noisy/descriptive and not write-amplification evidence",
                    },
                    runtime: {
                        node: process.version,
                        platform: process.platform,
                        arch: process.arch,
                        osRelease: release(),
                        cpu: cpus()[0]?.model ?? "unknown",
                        totalMemoryBytes: totalmem(),
                    },
                    provenance,
                    durationMs: performance.now() - startedAt,
                    results,
                };
                expect(results).toHaveLength(PATHS.length * WORKLOADS.length);
                expect(
                    results.every(
                        (result) =>
                            result.modes.verify.raw.length === SAMPLES &&
                            result.modes.alwaysTouch.raw.length === SAMPLES
                    )
                ).toBe(true);
                const json = JSON.stringify(report, null, 2);
                const reportPath =
                    process.env.PEERBIT_SHARED_FS_ONE_CHUNK_DEDUP_REPORT;
                if (reportPath) {
                    await writeReportFile(reportPath, `${json}\n`, "utf8");
                }
                console.log(json);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    );
});
