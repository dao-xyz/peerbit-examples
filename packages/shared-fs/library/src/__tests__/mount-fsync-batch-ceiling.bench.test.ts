import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Peerbit } from "peerbit";
import { describe, expect, it } from "vitest";
import {
    createSharedFsMountBackend,
    openSharedFs,
    type SharedFsHandle,
    type SharedFsMountBackendTarget,
} from "../index.js";

const enabled = process.env.PEERBIT_SHARED_FS_FSYNC_BATCH_CEILING_BENCH === "1";
const manualDescribe = enabled ? describe : describe.skip;
const ITEM_COUNTS = [2, 8, 32] as const;
const SAMPLES = 15;
const WARMUPS = 3;
const PAYLOAD_BYTES = 4 * 1024;
const repositoryRoot = fileURLToPath(
    new URL("../../../../../", import.meta.url)
);

type DocumentCounters = {
    putCalls: number;
    putManyCalls: number;
    putManyItems: number;
};

type Sample = {
    durationMs: number;
    writeFileCalls: number;
    writeBatchCalls: number;
    exactExpectedNodeGuards: number;
    explicitOpenedBaseBindings: number;
    document: DocumentCounters;
    newVersions: number;
    conflictHeads: number;
};

type ModeResult = {
    mode: "exact-mounted-fences" | "unsafe-writeBatch-ceiling";
    itemCount: number;
    payloadBytes: number;
    samples: Sample[];
    summary: {
        p50Ms: number;
        p95Ms: number;
        p50ItemsPerSecond: number;
    };
    semantics: {
        independentCompletionSignals: number;
        exactExpectedNodeGuards: number;
        explicitOpenedBaseBindings: number;
        equivalentToMountedFsync: boolean;
    };
};

const percentile = (values: number[], fraction: number) =>
    [...values].sort((left, right) => left - right)[
        Math.max(0, Math.ceil(values.length * fraction) - 1)
    ];

const payload = (turn: number, index: number) => {
    const bytes = new Uint8Array(PAYLOAD_BYTES);
    let state = (0x9e3779b9 ^ (turn + 1) ^ ((index + 1) << 16)) >>> 0;
    for (let offset = 0; offset < bytes.byteLength; offset++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        bytes[offset] = state & 0xff;
    }
    return bytes;
};

const targetFor = (
    fs: SharedFsHandle,
    onWriteFile: (
        options: Parameters<SharedFsMountBackendTarget["writeFile"]>[2]
    ) => void
): SharedFsMountBackendTarget => ({
    mountWriteSemantics: () => fs.mountWriteSemantics(),
    mountReadSemantics: () => fs.mountReadSemantics(),
    readVersionForMount: (path, versionId) =>
        fs.readVersionForMount(path, versionId),
    readFile: (path) => fs.readFile(path),
    readVersion: (path, versionId) => fs.readVersion(path, versionId),
    writeFile: (path, source, options) => {
        onWriteFile(options);
        return fs.writeFile(path, source, options);
    },
    mkdir: (path) => fs.mkdir(path),
    rm: (path) => fs.rm(path),
    rename: (from, to) => fs.rename(from, to),
    list: (path) => fs.list(path),
    versions: (path) => fs.versions(path),
    conflicts: (path, options) => fs.conflicts(path, options),
    stat: (path) => fs.stat(path),
    bootstrapStatus: () => fs.bootstrapStatus(),
});

const instrumentDocuments = (fs: SharedFsHandle) => {
    const documents = fs.program.entries;
    const originalPut = documents.put.bind(documents);
    const originalPutMany = documents.putMany.bind(documents);
    const counters: DocumentCounters = {
        putCalls: 0,
        putManyCalls: 0,
        putManyItems: 0,
    };
    documents.put = (async (...args: Parameters<typeof documents.put>) => {
        counters.putCalls++;
        return originalPut(...args);
    }) as typeof documents.put;
    documents.putMany = (async (
        ...args: Parameters<typeof documents.putMany>
    ) => {
        counters.putManyCalls++;
        counters.putManyItems += args[0].length;
        return originalPutMany(...args);
    }) as typeof documents.putMany;
    return {
        counters,
        reset() {
            counters.putCalls = 0;
            counters.putManyCalls = 0;
            counters.putManyItems = 0;
        },
        restore() {
            documents.put = originalPut;
            documents.putMany = originalPutMany;
        },
    };
};

const verifyTurn = async (
    fs: SharedFsHandle,
    paths: string[],
    expected: Uint8Array[],
    versionsBefore: number[]
) => {
    let newVersions = 0;
    let conflictHeads = 0;
    for (let index = 0; index < paths.length; index++) {
        expect(await fs.readFile(paths[index])).toEqual(expected[index]);
        const versions = await fs.versions(paths[index]);
        newVersions += versions.length - versionsBefore[index];
        conflictHeads += Math.max(
            0,
            versions.filter((version) => version.head).length - 1
        );
    }
    return { newVersions, conflictHeads };
};

const runMode = async (
    mode: ModeResult["mode"],
    itemCount: number
): Promise<ModeResult> => {
    const directory = await mkdtemp(
        join(tmpdir(), "peerbit-fsync-batch-ceiling-")
    );
    const peer = await Peerbit.create({ directory });
    const fs = await openSharedFs({
        peerbit: peer,
        machineLabel: `fsync-batch-ceiling-${mode}-${itemCount}`,
        gc: false,
    });
    const paths = Array.from(
        { length: itemCount },
        (_, index) => `/file-${String(index).padStart(3, "0")}.bin`
    );
    await fs.writeBatch(
        paths.map((path, index) => ({ path, content: payload(-1, index) }))
    );
    const instrumentation = instrumentDocuments(fs);
    let writeFileCalls = 0;
    let writeBatchCalls = 0;
    let exactExpectedNodeGuards = 0;
    let explicitOpenedBaseBindings = 0;
    const backend = createSharedFsMountBackend(
        targetFor(fs, (options) => {
            writeFileCalls++;
            if (typeof options?.expectedNodeId === "string") {
                exactExpectedNodeGuards++;
            }
            if (
                options?.baseVersionIds?.length === 1 &&
                typeof options.baseVersionIds[0] === "string"
            ) {
                explicitOpenedBaseBindings++;
            }
        }),
        { writeFileInput: "immutable-borrowed" }
    );
    const samples: Sample[] = [];
    try {
        for (let turn = 0; turn < WARMUPS + SAMPLES; turn++) {
            const expected = paths.map((_path, index) => payload(turn, index));
            const versionsBefore = await Promise.all(
                paths.map(async (path) => (await fs.versions(path)).length)
            );
            writeFileCalls = 0;
            writeBatchCalls = 0;
            exactExpectedNodeGuards = 0;
            explicitOpenedBaseBindings = 0;
            instrumentation.reset();

            let started: bigint;
            let durationMs: number;
            if (mode === "exact-mounted-fences") {
                const handles = await Promise.all(
                    paths.map((path) =>
                        backend.open(path, { read: true, write: true })
                    )
                );
                try {
                    await Promise.all(
                        handles.map((handle, index) =>
                            backend.write(handle, expected[index], 0)
                        )
                    );
                    started = process.hrtime.bigint();
                    await Promise.all(
                        handles.map((handle) => backend.fsync(handle))
                    );
                    durationMs =
                        Number(process.hrtime.bigint() - started) / 1e6;
                } finally {
                    await Promise.all(
                        handles.map((handle) => backend.release(handle))
                    );
                }
            } else {
                // This is deliberately not routed through the mount backend:
                // writeBatch lacks its exact opened-node/base/head contract.
                // It is only the current lower append-amortization ceiling.
                started = process.hrtime.bigint();
                writeBatchCalls++;
                await fs.writeBatch(
                    paths.map((path, index) => ({
                        path,
                        content: expected[index],
                    }))
                );
                durationMs = Number(process.hrtime.bigint() - started) / 1e6;
            }

            const verified = await verifyTurn(
                fs,
                paths,
                expected,
                versionsBefore
            );
            const sample: Sample = {
                durationMs,
                writeFileCalls,
                writeBatchCalls,
                exactExpectedNodeGuards,
                explicitOpenedBaseBindings,
                document: { ...instrumentation.counters },
                ...verified,
            };
            expect(sample.newVersions).toBe(itemCount);
            expect(sample.conflictHeads).toBe(0);
            if (mode === "exact-mounted-fences") {
                expect(sample.writeFileCalls).toBe(itemCount);
                expect(sample.writeBatchCalls).toBe(0);
                expect(sample.exactExpectedNodeGuards).toBe(itemCount);
                expect(sample.explicitOpenedBaseBindings).toBe(itemCount);
                expect(sample.document.putManyCalls).toBe(0);
            } else {
                expect(sample.writeFileCalls).toBe(0);
                expect(sample.writeBatchCalls).toBe(1);
                expect(sample.exactExpectedNodeGuards).toBe(0);
                expect(sample.explicitOpenedBaseBindings).toBe(0);
                expect(sample.document.putManyCalls).toBe(1);
                expect(sample.document.putManyItems).toBe(itemCount);
            }
            if (turn >= WARMUPS) {
                samples.push(sample);
            }
        }
    } finally {
        instrumentation.restore();
        await peer.stop();
        await rm(directory, { recursive: true, force: true });
    }
    const durations = samples.map((sample) => sample.durationMs);
    const p50Ms = percentile(durations, 0.5);
    const minimumObserved = (
        field: "exactExpectedNodeGuards" | "explicitOpenedBaseBindings"
    ) => Math.min(...samples.map((sample) => Number(sample[field])));
    return {
        mode,
        itemCount,
        payloadBytes: PAYLOAD_BYTES,
        samples,
        summary: {
            p50Ms,
            p95Ms: percentile(durations, 0.95),
            p50ItemsPerSecond: itemCount / (p50Ms / 1_000),
        },
        semantics: {
            independentCompletionSignals:
                mode === "exact-mounted-fences" ? itemCount : 1,
            exactExpectedNodeGuards: minimumObserved("exactExpectedNodeGuards"),
            explicitOpenedBaseBindings: minimumObserved(
                "explicitOpenedBaseBindings"
            ),
            equivalentToMountedFsync: mode === "exact-mounted-fences",
        },
    };
};

const sha256 = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");

const provenance = async () => {
    const urls = [
        new URL(import.meta.url),
        new URL("../mount-backend.ts", import.meta.url),
        new URL("../index.ts", import.meta.url),
        new URL("../../../library/package.json", import.meta.url),
        new URL("../../../../../pnpm-lock.yaml", import.meta.url),
    ];
    const files = await Promise.all(
        urls.map(async (url) => {
            const path = fileURLToPath(url);
            const bytes = await readFile(path);
            return {
                path: relative(repositoryRoot, path).replaceAll("\\", "/"),
                bytes: bytes.byteLength,
                sha256: sha256(bytes),
            };
        })
    );
    files.sort((left, right) => left.path.localeCompare(right.path));
    const combined = createHash("sha256");
    for (const file of files) {
        combined.update(`${file.path}\0${file.bytes}\0${file.sha256}\0`);
    }
    return { files, combinedSha256: combined.digest("hex") };
};

const roundedJson = (value: unknown) =>
    JSON.stringify(value, (_key, entry) =>
        typeof entry === "number" ? Number(entry.toFixed(3)) : entry
    );

manualDescribe("mounted fsync batch ceiling benchmark (manual)", () => {
    it(
        "reports exact independent fences beside the unsafe writeBatch ceiling",
        { timeout: 5 * 60_000 },
        async () => {
            const pairs = [];
            for (const itemCount of ITEM_COUNTS) {
                const exact = await runMode("exact-mounted-fences", itemCount);
                const ceiling = await runMode(
                    "unsafe-writeBatch-ceiling",
                    itemCount
                );
                pairs.push({ itemCount, exact, ceiling });
            }
            const report = {
                schema: "peerbit-shared-fs-fsync-batch-ceiling-v1",
                warning:
                    "writeBatch is an unsafe performance ceiling, not mounted-fsync-equivalent semantics",
                run: {
                    warmups: WARMUPS,
                    samples: SAMPLES,
                    itemCounts: ITEM_COUNTS,
                    payloadBytes: PAYLOAD_BYTES,
                    runtime: {
                        node: process.version,
                        platform: process.platform,
                        arch: process.arch,
                    },
                },
                scope: {
                    includes:
                        "mount-backend exact fence logic, SharedFS hashing/chunk work, and a directory-backed Peerbit local store",
                    timedOperations: {
                        exactMountedFences:
                            "concurrent fsync calls after untimed open and in-memory mount writes",
                        unsafeWriteBatchCeiling:
                            "the complete direct writeBatch call, which has no separate prepare/fence boundary",
                    },
                    excludes: [
                        "FUSE, macFUSE, WinFsp, and native adapter syscalls",
                        "network replication and persisted remote receipts",
                        "a safe batch coordinator implementation",
                    ],
                },
                provenance: await provenance(),
                pairs: pairs.map((pair) => ({
                    ...pair,
                    comparison: {
                        p50CeilingOverExact:
                            pair.ceiling.summary.p50Ms /
                            pair.exact.summary.p50Ms,
                        p50CeilingReductionPercent:
                            (1 -
                                pair.ceiling.summary.p50Ms /
                                    pair.exact.summary.p50Ms) *
                            100,
                    },
                })),
            };
            expect(report.warning).toContain("not mounted-fsync-equivalent");
            console.log(
                "mount-fsync-batch-ceiling-report:",
                roundedJson(report)
            );
        }
    );
});
