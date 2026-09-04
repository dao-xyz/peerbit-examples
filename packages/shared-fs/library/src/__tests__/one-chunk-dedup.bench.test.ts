import { mkdtemp, rm, writeFile as writeReportFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
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

type BenchmarkMode = (typeof MODES)[number];
type BenchmarkPath = (typeof PATHS)[number];
type BenchmarkWorkload = (typeof WORKLOADS)[number];

type OperationCounters = {
    hasDocumentCalls: number;
    indexGetCalls: number;
    indexIterateCalls: number;
    entriesPutCalls: number;
    uniquePutCalls: number;
    linkedPutCalls: number;
    fileChunkPuts: number;
    fileChunkUniquePuts: number;
    fileChunkLinkedPuts: number;
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
    linkedPutCalls: 0,
    fileChunkPuts: 0,
    fileChunkUniquePuts: 0,
    fileChunkLinkedPuts: 0,
    fileVersionPuts: 0,
    namingPuts: 0,
    otherPuts: 0,
});

const copyCounters = (value: OperationCounters): OperationCounters => ({
    ...value,
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
        else counters.linkedPutCalls++;
        if (value?.kind === "file-chunk") {
            counters.fileChunkPuts++;
            if (options?.unique === true) counters.fileChunkUniquePuts++;
            else counters.fileChunkLinkedPuts++;
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
    const peer = await Peerbit.create({ directory: stateDirectory });
    const fs = await openSharedFs({
        peerbit: peer,
        machineLabel: `${path}-${workload}-${mode}`,
        bootstrap: false,
        gc: false,
    });
    const counters = installOperationCounters(fs);
    const backend =
        path === "mount-backend"
            ? createSharedFsMountBackend(mountTarget(fs, mode), {
                  writeFileInput: "immutable-borrowed",
              })
            : undefined;
    return { mode, stateDirectory, peer, fs, backend, counters };
};

const patternedBytes = (size: number, seed: number) => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index++) {
        bytes[index] = (index * 17 + seed * 29 + (index >>> 4)) % 251;
    }
    return bytes;
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
    const openNs = await time(async () => {
        handle = await backend.open(path, {
            write: true,
            create: true,
            truncate: true,
        });
    });
    const writeNs = await time(async () => {
        await backend.write(handle!, bytes, 0);
    });
    const fsyncNs = await time(async () => {
        await backend.fsync(handle!);
    });
    const releaseNs = await time(async () => {
        await backend.release(handle!);
    });
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
    const contexts = await Promise.all(
        MODES.map((mode) => createContext(root, path, workload, mode))
    );
    const byMode = Object.fromEntries(
        contexts.map((context) => [context.mode, context])
    ) as Record<BenchmarkMode, BenchmarkContext>;
    try {
        await Promise.all(
            contexts.map((context) => setupWorkload(context, workload, reused))
        );

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

        const storageBeforeEntries = await Promise.all(
            contexts.map(async (context) => [
                context.mode,
                await scanProcessSoakStateDirectory(context.stateDirectory),
            ])
        );
        const storageBefore = Object.fromEntries(
            storageBeforeEntries
        ) as Record<BenchmarkMode, ProcessSoakStorageSnapshot>;
        const logBeforeEntries = await Promise.all(
            contexts.map(async (context) => [
                context.mode,
                await logLength(context),
            ])
        );
        const logBefore = Object.fromEntries(logBeforeEntries) as Record<
            BenchmarkMode,
            number
        >;
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
        const [storageAfterEntries, logAfterEntries] = await Promise.all([
            Promise.all(
                contexts.map(async (context) => [
                    context.mode,
                    await scanProcessSoakStateDirectory(context.stateDirectory),
                ])
            ),
            Promise.all(
                contexts.map(async (context) => [
                    context.mode,
                    await logLength(context),
                ])
            ),
        ]);
        const storageAfter = Object.fromEntries(storageAfterEntries) as Record<
            BenchmarkMode,
            ProcessSoakStorageSnapshot
        >;
        const logAfter = Object.fromEntries(logAfterEntries) as Record<
            BenchmarkMode,
            number
        >;

        for (const context of contexts) {
            expect(await context.fs.readFile(finalInput!.path)).toEqual(
                finalInput!.bytes
            );
        }
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
                    log: {
                        beforeEntries: logBefore.verify,
                        afterEntries: logAfter.verify,
                        growthEntries: logAfter.verify - logBefore.verify,
                    },
                    storage: {
                        before: storageBefore.verify,
                        after: storageAfter.verify,
                        growth: storageDelta(
                            storageAfter.verify,
                            storageBefore.verify
                        ),
                    },
                },
                alwaysTouch: {
                    dedup: "off",
                    raw: samples["always-touch"],
                    summary: summaries["always-touch"],
                    counters: counters["always-touch"],
                    log: {
                        beforeEntries: logBefore["always-touch"],
                        afterEntries: logAfter["always-touch"],
                        growthEntries:
                            logAfter["always-touch"] -
                            logBefore["always-touch"],
                    },
                    storage: {
                        before: storageBefore["always-touch"],
                        after: storageAfter["always-touch"],
                        growth: storageDelta(
                            storageAfter["always-touch"],
                            storageBefore["always-touch"]
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
    } finally {
        for (const context of contexts) context.counters.restore();
        await Promise.all(
            contexts.map((context) => context.peer.stop().catch(() => {}))
        );
    }
};

manualDescribe("one-chunk dedup strategy benchmark (manual)", () => {
    it(
        "compares matched verify and always-touch writes without changing defaults",
        { timeout: 15 * 60_000 },
        async () => {
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
                    benchmark: "shared-fs-one-chunk-dedup-ab-v1",
                    reportOnly: true,
                    productionDefaultsChanged: false,
                    run: {
                        samplesPerMode: SAMPLES,
                        warmupsPerMode: WARMUPS,
                        pairedExecution: true,
                        alternatingModeOrder: true,
                        payloadPreparationTimed: false,
                    },
                    runtime: {
                        node: process.version,
                        platform: process.platform,
                        arch: process.arch,
                        cpu: cpus()[0]?.model ?? "unknown",
                    },
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
