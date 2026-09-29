#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    DEV_WORKLOAD_MODULE_PATH,
    devWorkloadSampleCounts,
    devWorkloadScenarioNames,
    executeDevWorkload,
    formatDevWorkloadSummaryLines,
} from "./shared-fs-native-mount-benchmark-dev-workload.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "..");
const HARNESS_PATH = fileURLToPath(import.meta.url);
const BINARY_SIZES = [4 << 10, 1 << 20];
const OVERWRITE_BYTES = 4 << 10;
// Overwrite offsets are 4 KiB aligned and seeded across the whole base file;
// the report records how many 512 KiB leaves (v9 chunks) they touched.
const OVERWRITE_OFFSET_SEED_UINT32 = 0x4f1bbcdc;
const OVERWRITE_LEAF_BYTES = 512 << 10;
const CORPUS_SEED_UINT32 = 0x6d2b79f5;
const CORPUS_WORD_STEP_UINT32 = 0x9e3779b9;
const MAX_IMPLEMENTATION_INPUT_FILES = 4096;
const IGNORED_IMPLEMENTATION_DIRECTORIES = new Set([".git", "node_modules"]);
const REQUIRED_IMPLEMENTATION_DETAILS = [
    "adapter.buildTags",
    "adapter.goVersion",
    "mount.runtime",
];
const TARGET_KINDS = new Set(["shared-fs-mount", "local-filesystem-control"]);
const SCHEMA_VERSION = 5;

export const nativeMountBenchmarkCorpus = Object.freeze({
    id: "counter-mix32-v1",
    seedUint32: CORPUS_SEED_UINT32,
    wordStepUint32: CORPUS_WORD_STEP_UINT32,
    wordByteOrder: "little-endian",
});

const integerOptions = {
    "--samples": ["samples", 1, 50],
    "--warmups": ["warmups", 0, 20],
    "--small-files": ["smallFiles", 1, 128],
    "--readdir-entries": ["readdirEntries", 1, 5000],
    "--overwrite-base-bytes": ["overwriteBaseBytes", OVERWRITE_BYTES, 32 << 20],
    "--timeout-ms": ["timeoutMs", 1000, 3_600_000],
};

export const parseNativeMountBenchmarkArguments = (argv) => {
    const options = {
        samples: 5,
        warmups: 1,
        smallFiles: 16,
        readdirEntries: 128,
        overwriteBaseBytes: [4 << 20],
        timeoutMs: 180_000,
        implementationInputs: [],
        implementationDetails: [],
        mountOptions: [],
        targetKind: "shared-fs-mount",
        targetLabel: "caller-supplied mounted path",
        devWorkload: false,
        devGitExecutable: "git",
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--") continue;
        if (argument === "--dev-workload") {
            options.devWorkload = true;
            continue;
        }
        // Test seam: the developer workload's git executable.
        if (argument === "--dev-git-executable") {
            options.devGitExecutable = argv[++index];
            if (!options.devGitExecutable) {
                throw new Error(`${argument} requires a path`);
            }
            continue;
        }
        if (argument === "--mount" || argument === "--output") {
            const value = argv[++index];
            if (!value) throw new Error(`${argument} requires a path`);
            options[argument === "--mount" ? "mount" : "output"] =
                resolve(value);
            continue;
        }
        if (argument === "--target-label") {
            const value = argv[++index];
            if (!value || value.length > 160) {
                throw new Error(
                    "--target-label requires at most 160 characters"
                );
            }
            options.targetLabel = value;
            continue;
        }
        if (argument === "--target-kind") {
            const value = argv[++index];
            if (!TARGET_KINDS.has(value)) {
                throw new Error(
                    "--target-kind must be shared-fs-mount or local-filesystem-control"
                );
            }
            options.targetKind = value;
            continue;
        }
        if (argument === "--implementation-input") {
            const value = argv[++index];
            if (!value) {
                throw new Error(
                    `${argument} requires a file or directory path`
                );
            }
            if (options.implementationInputs.length >= 16) {
                throw new Error(
                    "at most 16 --implementation-input roots are allowed"
                );
            }
            options.implementationInputs.push(resolve(value));
            continue;
        }
        if (argument === "--mount-option") {
            const value = argv[++index];
            if (!value || value.length > 160) {
                throw new Error(
                    "--mount-option requires at most 160 characters"
                );
            }
            if (options.mountOptions.length >= 16) {
                throw new Error("at most 16 --mount-option values are allowed");
            }
            options.mountOptions.push(value);
            continue;
        }
        if (argument === "--implementation-detail") {
            const value = argv[++index];
            const separator = value?.indexOf("=") ?? -1;
            const key = separator > 0 ? value.slice(0, separator) : "";
            const detail = separator > 0 ? value.slice(separator + 1) : "";
            if (
                !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key) ||
                detail.length < 1 ||
                detail.length > 256 ||
                /[\r\n]/u.test(detail)
            ) {
                throw new Error(
                    "--implementation-detail requires key=value with a 1-64 character key and 1-256 character single-line value"
                );
            }
            if (
                options.implementationDetails.some(
                    (existing) => existing.key === key
                )
            ) {
                throw new Error(
                    `duplicate --implementation-detail key: ${key}`
                );
            }
            if (options.implementationDetails.length >= 32) {
                throw new Error(
                    "at most 32 --implementation-detail values are allowed"
                );
            }
            options.implementationDetails.push({ key, value: detail });
            continue;
        }
        const definition = integerOptions[argument];
        if (!definition) throw new Error(`Unknown argument: ${argument}`);
        const [key, minimum, maximum] = definition;
        // An array-valued option takes a comma-separated list.
        const list = Array.isArray(options[key]);
        const text = String(argv[++index]);
        const values = (list ? text.split(",") : [text]).map(Number);
        if (
            values.some(
                (value) =>
                    !Number.isSafeInteger(value) ||
                    value < minimum ||
                    value > maximum
            )
        ) {
            throw new Error(
                `${argument} must be ${list ? "a comma-separated list of integers" : "an integer"} from ${minimum} through ${maximum}`
            );
        }
        options[key] = list
            ? [...new Set(values)].sort((left, right) => left - right)
            : values[0];
    }
    if (!options.mount) throw new Error("--mount is required");
    if (
        options.targetKind === "local-filesystem-control" &&
        options.mountOptions.length > 0
    ) {
        throw new Error(
            "--mount-option cannot be used with a local-filesystem-control target"
        );
    }
    return options;
};

const now = () => process.hrtime.bigint();
const elapsed = (started) => Number(now() - started);

// Pair one wall-clock reading with the monotonic clock once. Every sample
// window is then derived from the same monotonic readings that time it, so
// windows are exactly as long as their durations, never overlap, and can be
// joined with mount-profile records (which use the same Unix-ns anchoring).
const UNIX_ANCHOR_NS = BigInt(
    Math.round((performance.timeOrigin + performance.now()) * 1e6)
);
const MONOTONIC_ANCHOR_NS = now();
const unixNs = (monotonic) =>
    (UNIX_ANCHOR_NS + (monotonic - MONOTONIC_ANCHOR_NS)).toString();
const sampleWindow = (started, ended) => ({
    durationNs: Number(ended - started),
    startedAtUnixNs: unixNs(started),
    endedAtUnixNs: unixNs(ended),
});
const UNIX_NS_PATTERN = /^[1-9][0-9]{0,18}$/u;

const throwIfAborted = (signal) => {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new Error("benchmark aborted");
};

export const mixUint32 = (input) => {
    let value = input >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15;
    value = Math.imul(value, 0x846ca68b);
    value ^= value >>> 16;
    return value >>> 0;
};

/** The 4 KiB-aligned offset of run `index` (warmups first) in a base file. */
export const nativeMountBenchmarkOverwriteOffset = (baseBytes, index) =>
    (mixUint32(
        OVERWRITE_OFFSET_SEED_UINT32 + Math.imul(index, CORPUS_WORD_STEP_UINT32)
    ) %
        Math.floor(baseBytes / OVERWRITE_BYTES)) *
    OVERWRITE_BYTES;

const overwriteOffsets = (samples) => ({
    seedUint32: OVERWRITE_OFFSET_SEED_UINT32,
    leafBytes: OVERWRITE_LEAF_BYTES,
    leavesTouched: new Set(
        samples.map(({ offset }) => Math.floor(offset / OVERWRITE_LEAF_BYTES))
    ).size,
});

export const createNativeMountBenchmarkPayload = (size, variant) => {
    const payload = Buffer.allocUnsafe(size);
    const streamSeed =
        CORPUS_SEED_UINT32 ^
        mixUint32(size) ^
        mixUint32(Math.imul(variant, 0x85ebca6b));
    for (let offset = 0, counter = 0; offset < size; offset += 4, counter++) {
        const word = mixUint32(
            streamSeed + Math.imul(counter, CORPUS_WORD_STEP_UINT32)
        );
        payload[offset] = word & 0xff;
        if (offset + 1 < size) payload[offset + 1] = (word >>> 8) & 0xff;
        if (offset + 2 < size) payload[offset + 2] = (word >>> 16) & 0xff;
        if (offset + 3 < size) payload[offset + 3] = word >>> 24;
    }
    return payload;
};

const deterministicPayload = createNativeMountBenchmarkPayload;

const assertBytes = (actual, expected, label) => {
    if (actual.byteLength !== expected.byteLength || !actual.equals(expected)) {
        throw new Error(`${label} failed deterministic byte validation`);
    }
};

const writeAll = async (handle, bytes, position = 0) => {
    let written = 0;
    while (written < bytes.byteLength) {
        const result = await handle.write(
            bytes,
            written,
            bytes.byteLength - written,
            position + written
        );
        if (result.bytesWritten <= 0) throw new Error("write made no progress");
        written += result.bytesWritten;
    }
};

const readAll = async (handle, bytes, position = 0) => {
    let read = 0;
    while (read < bytes.byteLength) {
        const result = await handle.read(
            bytes,
            read,
            bytes.byteLength - read,
            position + read
        );
        if (result.bytesRead <= 0) {
            throw new Error(`unexpected EOF after ${read} bytes`);
        }
        read += result.bytesRead;
    }
};

const timedHandleOperation = async ({ path, flags, io, sync }) => {
    const totalStarted = now();
    const openStarted = now();
    const handle = await open(path, flags);
    const openNs = elapsed(openStarted);
    let primaryError;
    let ioNs = 0;
    let fsyncNs = 0;
    let closeNs = 0;
    try {
        const ioStarted = now();
        await io(handle);
        ioNs = elapsed(ioStarted);
        if (sync) {
            const fsyncStarted = now();
            await handle.sync();
            fsyncNs = elapsed(fsyncStarted);
        }
    } catch (error) {
        primaryError = error;
    }
    try {
        const closeStarted = now();
        await handle.close();
        closeNs = elapsed(closeStarted);
    } catch (error) {
        if (!primaryError) primaryError = error;
    }
    const totalEnded = now();
    if (primaryError) throw primaryError;
    return {
        ...sampleWindow(totalStarted, totalEnded),
        openNs,
        ioNs,
        fsyncNs,
        closeNs,
    };
};

const durableWrite = (path, bytes, position = 0, flags = "w") =>
    timedHandleOperation({
        path,
        flags,
        sync: true,
        io: (handle) => writeAll(handle, bytes, position),
    });

const timedRead = (path, destination, position = 0) =>
    timedHandleOperation({
        path,
        flags: "r",
        sync: false,
        io: (handle) => readAll(handle, destination, position),
    });

const percentile = (sorted, fraction) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];

const summarize = (samples, logicalBytes = 0, itemCount = 0) => {
    const values = samples
        .map(({ durationNs }) => durationNs)
        .sort((a, b) => a - b);
    const p50Ns = percentile(values, 0.5);
    const summary = {
        count: samples.length,
        minNs: values[0],
        p50Ns,
        p95Ns: percentile(values, 0.95),
        maxNs: values.at(-1),
        meanNs: values.reduce((sum, value) => sum + value, 0) / values.length,
    };
    if (logicalBytes > 0) {
        summary.p50LogicalMiBPerSecond =
            logicalBytes / (1024 * 1024) / (p50Ns / 1e9);
    }
    if (itemCount > 0) {
        summary.p50ItemsPerSecond = itemCount / (p50Ns / 1e9);
    }
    return summary;
};

const displayInputPath = (path) => {
    const relativePath = relative(REPOSITORY_ROOT, path);
    const displayed =
        relativePath && !relativePath.startsWith("..") ? relativePath : path;
    return displayed.replaceAll("\\", "/");
};

const hashFile = async (path) => {
    const metadata = await lstat(path);
    if (!metadata.isFile())
        throw new Error(`benchmark input is not a file: ${path}`);
    const hash = createHash("sha256");
    await new Promise((resolvePromise, reject) => {
        const stream = createReadStream(path);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.once("error", reject);
        stream.once("end", resolvePromise);
    });
    return {
        path: displayInputPath(path),
        sizeBytes: metadata.size,
        sha256: hash.digest("hex"),
    };
};

const listImplementationInputFiles = async (path) => {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
        throw new Error(`benchmark input cannot be a symbolic link: ${path}`);
    }
    if (metadata.isFile()) return [path];
    if (!metadata.isDirectory()) {
        throw new Error(`benchmark input is not a file or directory: ${path}`);
    }
    const files = [];
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    for (const entry of entries) {
        if (
            entry.isDirectory() &&
            IGNORED_IMPLEMENTATION_DIRECTORIES.has(entry.name)
        ) {
            continue;
        }
        const child = join(path, entry.name);
        if (entry.isSymbolicLink()) {
            throw new Error(
                `benchmark input cannot contain a symlink: ${child}`
            );
        }
        files.push(...(await listImplementationInputFiles(child)));
        if (files.length > MAX_IMPLEMENTATION_INPUT_FILES) {
            throw new Error(
                `benchmark inputs exceed ${MAX_IMPLEMENTATION_INPUT_FILES} files`
            );
        }
    }
    return files;
};

const combinedInputSha256 = (files) => {
    const combined = createHash("sha256");
    for (const file of files) {
        combined.update(`${file.path}\0${file.sizeBytes}\0${file.sha256}\0`);
    }
    return combined.digest("hex");
};

const normalizeImplementationDetails = (details = []) => {
    const byKey = new Map(
        REQUIRED_IMPLEMENTATION_DETAILS.map((key) => [key, "unknown"])
    );
    for (const { key, value } of details) byKey.set(key, value);
    return [...byKey]
        .map(([key, value]) => ({ key, value }))
        .sort((left, right) =>
            left.key < right.key ? -1 : left.key > right.key ? 1 : 0
        );
};

export const hashNativeMountBenchmarkInputs = async (additional = []) => {
    const roots = [
        HARNESS_PATH,
        DEV_WORKLOAD_MODULE_PATH,
        join(REPOSITORY_ROOT, "pnpm-lock.yaml"),
        join(REPOSITORY_ROOT, "packages/shared-fs/library/package.json"),
        join(REPOSITORY_ROOT, "packages/shared-fs/cli/package.json"),
        ...additional,
    ];
    const uniqueRoots = [...new Set(roots.map((path) => resolve(path)))].sort();
    const expanded = [];
    for (const root of uniqueRoots) {
        expanded.push(...(await listImplementationInputFiles(root)));
        if (expanded.length > MAX_IMPLEMENTATION_INPUT_FILES) {
            throw new Error(
                `benchmark inputs exceed ${MAX_IMPLEMENTATION_INPUT_FILES} files`
            );
        }
    }
    const uniqueFiles = [
        ...new Set(expanded.map((path) => resolve(path))),
    ].sort();
    // Provenance collection happens outside timed scenarios. Keep it strictly
    // serial so a caller-supplied directory cannot exhaust process or platform
    // file-handle limits by expanding to thousands of simultaneous streams.
    const files = [];
    for (const path of uniqueFiles) files.push(await hashFile(path));
    files.sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    return {
        roots: uniqueRoots.map(displayInputPath).sort(),
        ignoredDirectoryNames: [...IGNORED_IMPLEMENTATION_DIRECTORIES].sort(),
        hashConcurrency: 1,
        files,
        combinedSha256: combinedInputSha256(files),
    };
};

const collect = async (options, signal, run) => {
    const warmupSamples = [];
    const samples = [];
    for (let index = 0; index < options.warmups + options.samples; index += 1) {
        throwIfAborted(signal);
        const sample = await run(index);
        throwIfAborted(signal);
        const warmup = index < options.warmups;
        (warmup ? warmupSamples : samples).push({ ...sample, warmup });
    }
    return { warmupSamples, samples };
};

const readPackageVersion = async (path) =>
    JSON.parse(await readFile(path, "utf8")).version;

const executeWorkload = async (root, options, signal) => {
    const scenarios = [];
    const totalRuns = options.warmups + options.samples;
    const readPayloads = new Map();

    for (const size of BINARY_SIZES) {
        throwIfAborted(signal);
        const payload = deterministicPayload(size, size);
        const path = join(root, `read-${size}.bin`);
        await durableWrite(path, payload);
        readPayloads.set(size, { path, payload });
    }

    const statTarget = readPayloads.get(1 << 20);
    const statSamples = await collect(options, signal, async () => {
        const started = now();
        const result = await stat(statTarget.path);
        const sample = sampleWindow(started, now());
        if (!result.isFile() || result.size !== 1 << 20) {
            throw new Error("stat returned unexpected metadata");
        }
        return sample;
    });
    scenarios.push({
        name: "stat-1048576",
        operation: "stat",
        ...statSamples,
        summary: summarize(statSamples.samples),
    });

    for (const size of BINARY_SIZES) {
        const { path, payload } = readPayloads.get(size);
        const readSamples = await collect(options, signal, async () => {
            const destination = Buffer.allocUnsafe(size);
            const sample = await timedRead(path, destination);
            assertBytes(destination, payload, `${size}-byte read`);
            return sample;
        });
        scenarios.push({
            name: `read-${size}`,
            operation: "read",
            logicalBytes: size,
            semantics: "open/read-exactly/close",
            ...readSamples,
            summary: summarize(readSamples.samples, size),
        });

        const writePath = join(root, `write-${size}.bin`);
        // Keep every timed sample semantically identical even when warmups are
        // disabled: each one truncates and replaces an existing file.
        await durableWrite(writePath, deterministicPayload(size, 9_999));
        const payloads = Array.from({ length: totalRuns }, (_, index) =>
            deterministicPayload(size, 10_000 + index)
        );
        const writeSamples = await collect(options, signal, async (index) => {
            const sample = await durableWrite(writePath, payloads[index]);
            throwIfAborted(signal);
            assertBytes(
                await readFile(writePath),
                payloads[index],
                `${size}-byte write`
            );
            return sample;
        });
        scenarios.push({
            name: `write-${size}`,
            operation: "write",
            logicalBytes: size,
            semantics: "open/truncate/write/fsync/close",
            ...writeSamples,
            summary: summarize(writeSamples.samples, size),
        });
    }

    const smallPayloads = Array.from({ length: totalRuns }, (_, runIndex) =>
        Array.from({ length: options.smallFiles }, (_, fileIndex) =>
            deterministicPayload(
                1024,
                20_000 + runIndex * options.smallFiles + fileIndex
            )
        )
    );
    const smallSamples = await collect(options, signal, async (runIndex) => {
        const directory = join(root, `small-${runIndex}`);
        await mkdir(directory);
        const phaseTotals = { openNs: 0, ioNs: 0, fsyncNs: 0, closeNs: 0 };
        const started = now();
        for (let index = 0; index < options.smallFiles; index += 1) {
            throwIfAborted(signal);
            const sample = await durableWrite(
                join(directory, `file-${String(index).padStart(6, "0")}.bin`),
                smallPayloads[runIndex][index]
            );
            for (const key of Object.keys(phaseTotals))
                phaseTotals[key] += sample[key];
        }
        const sample = { ...sampleWindow(started, now()), ...phaseTotals };
        for (let index = 0; index < options.smallFiles; index += 1) {
            throwIfAborted(signal);
            assertBytes(
                await readFile(
                    join(
                        directory,
                        `file-${String(index).padStart(6, "0")}.bin`
                    )
                ),
                smallPayloads[runIndex][index],
                `small file ${index}`
            );
        }
        await rm(directory, { recursive: true });
        return sample;
    });
    scenarios.push({
        name: `small-files-${options.smallFiles}`,
        operation: "sequential-small-file-write",
        itemCount: options.smallFiles,
        logicalBytes: options.smallFiles * 1024,
        semantics: "per-file open/write/fsync/close",
        ...smallSamples,
        summary: summarize(
            smallSamples.samples,
            options.smallFiles * 1024,
            options.smallFiles
        ),
    });

    const directory = join(root, "readdir");
    await mkdir(directory);
    const expectedNames = Array.from(
        { length: options.readdirEntries },
        (_, index) => `entry-${String(index).padStart(6, "0")}.bin`
    );
    for (const [index, name] of expectedNames.entries()) {
        throwIfAborted(signal);
        await writeFile(
            join(directory, name),
            deterministicPayload(1, 30_000 + index)
        );
    }
    const readdirSamples = await collect(options, signal, async () => {
        const started = now();
        const entries = await readdir(directory, { withFileTypes: true });
        const sample = sampleWindow(started, now());
        // Some FUSE implementations return DT_UNKNOWN when readdir does not
        // carry stat data, so validate exact names without assuming dirent type.
        const names = entries.map((entry) => entry.name).sort();
        if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
            throw new Error("readdir returned an unexpected entry set");
        }
        return sample;
    });
    scenarios.push({
        name: `readdir-${options.readdirEntries}`,
        operation: "readdir",
        itemCount: options.readdirEntries,
        ...readdirSamples,
        summary: summarize(readdirSamples.samples, 0, options.readdirEntries),
    });

    const patches = Array.from({ length: totalRuns }, (_, index) =>
        deterministicPayload(OVERWRITE_BYTES, 50_000 + index)
    );
    for (const baseBytes of options.overwriteBaseBytes) {
        const overwritePath = join(root, `overwrite-${baseBytes}.bin`);
        const expectedBase = deterministicPayload(baseBytes, 40_000);
        await durableWrite(overwritePath, expectedBase);
        const overwriteSamples = await collect(
            options,
            signal,
            async (index) => {
                const offset = nativeMountBenchmarkOverwriteOffset(
                    baseBytes,
                    index
                );
                const sample = await durableWrite(
                    overwritePath,
                    patches[index],
                    offset,
                    "r+"
                );
                patches[index].copy(expectedBase, offset);
                throwIfAborted(signal);
                // Only the written range; the whole file once after the loop.
                const written = Buffer.allocUnsafe(OVERWRITE_BYTES);
                await timedRead(overwritePath, written, offset);
                assertBytes(written, patches[index], "in-place overwrite");
                return { ...sample, offset };
            }
        );
        assertBytes(
            await readFile(overwritePath),
            expectedBase,
            "in-place overwrite"
        );
        scenarios.push({
            name: `overwrite-4096-in-${baseBytes}`,
            operation: "overwrite",
            logicalBytes: OVERWRITE_BYTES,
            baseFileBytes: baseBytes,
            semantics: "open-r+/positional-write/fsync/close",
            offsets: overwriteOffsets(overwriteSamples.samples),
            ...overwriteSamples,
            summary: summarize(overwriteSamples.samples, OVERWRITE_BYTES),
        });
    }

    return scenarios;
};

// Primitives shared with the opt-in developer workload, so its samples use
// the same clock, windows, warmup handling and summaries as the core set.
const devWorkloadHarness = Object.freeze({
    now,
    elapsed,
    sampleWindow,
    collect,
    summarize,
    timedHandleOperation,
    writeAll,
    durableWrite,
    assertBytes,
    throwIfAborted,
});

/** Every planned scenario, including developer-workload ones not measured. */
export const expectedNativeMountBenchmarkScenarioNames = (options) => [
    "stat-1048576",
    "read-4096",
    "write-4096",
    "read-1048576",
    "write-1048576",
    `small-files-${options.smallFiles}`,
    `readdir-${options.readdirEntries}`,
    ...options.overwriteBaseBytes.map((bytes) => `overwrite-4096-in-${bytes}`),
    ...(options.devWorkload ? devWorkloadScenarioNames(options) : []),
];

/** The run options a report was produced with, in CLI option shape. */
export const nativeMountBenchmarkRunOptions = (report) => ({
    samples: report?.run?.samplesPerScenario,
    warmups: report?.run?.warmupsPerScenario,
    smallFiles: report?.run?.smallFilesPerSample,
    readdirEntries: report?.run?.readdirEntries,
    overwriteBaseBytes: report?.run?.overwriteBaseBytes,
    devWorkload: report?.run?.devWorkload === true,
});

export const validateNativeMountBenchmarkReport = (report, options) => {
    const expectedOptions = options ?? nativeMountBenchmarkRunOptions(report);
    if (
        report?.schemaVersion !== SCHEMA_VERSION ||
        report.benchmark !== "shared-fs-native-mount" ||
        JSON.stringify(report.corpus) !==
            JSON.stringify(nativeMountBenchmarkCorpus) ||
        !Array.isArray(report.scenarios) ||
        !Array.isArray(report.inputs?.roots) ||
        !Array.isArray(report.inputs?.files) ||
        report.inputs?.hashConcurrency !== 1 ||
        !/^[0-9a-f]{64}$/u.test(report.inputs?.combinedSha256 ?? "") ||
        !Array.isArray(report.target?.mountOptions) ||
        !TARGET_KINDS.has(report.target?.kind) ||
        (report.target.kind === "local-filesystem-control" &&
            report.target.mountOptions.length > 0) ||
        report.target.mountOptions.some(
            (option) => typeof option !== "string" || option.length > 160
        ) ||
        report.scope?.cacheSemantics?.mode !== "warm/default-platform-caches" ||
        typeof report.scope.cacheSemantics.callbackTraversal !== "string" ||
        report.scope?.performanceGate !== false ||
        typeof report.scope?.implementationDetailSemantics !== "string" ||
        report.run?.concurrency !== 1 ||
        !Array.isArray(report.run.overwriteBaseBytes) ||
        report.run.overwriteBaseBytes.length === 0 ||
        !Array.isArray(report.implementation?.details)
    ) {
        throw new Error("native-mount benchmark report envelope is invalid");
    }
    const implementationDetails = report.implementation.details;
    const implementationKeys = implementationDetails.map(({ key }) => key);
    if (
        implementationDetails.some(
            ({ key, value }) =>
                !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key) ||
                typeof value !== "string" ||
                value.length < 1 ||
                value.length > 256 ||
                /[\r\n]/u.test(value)
        ) ||
        JSON.stringify(implementationKeys) !==
            JSON.stringify([...new Set(implementationKeys)].sort()) ||
        REQUIRED_IMPLEMENTATION_DETAILS.some(
            (required) => !implementationKeys.includes(required)
        )
    ) {
        throw new Error("native-mount implementation details are invalid");
    }
    if (
        options &&
        JSON.stringify(implementationDetails) !==
            JSON.stringify(
                normalizeImplementationDetails(options.implementationDetails)
            )
    ) {
        throw new Error(
            "native-mount implementation details do not match the run options"
        );
    }
    if (
        options &&
        JSON.stringify(report.target.mountOptions) !==
            JSON.stringify(options.mountOptions ?? [])
    ) {
        throw new Error(
            "native-mount mount options do not match the run options"
        );
    }
    if (
        options &&
        report.target.kind !== (options.targetKind ?? "shared-fs-mount")
    ) {
        throw new Error(
            "native-mount target kind does not match the run options"
        );
    }
    const inputRoots = report.inputs.roots;
    if (
        inputRoots.some((root) => typeof root !== "string") ||
        JSON.stringify(inputRoots) !==
            JSON.stringify([...new Set(inputRoots)].sort()) ||
        JSON.stringify(report.inputs.ignoredDirectoryNames) !==
            JSON.stringify([...IGNORED_IMPLEMENTATION_DIRECTORIES].sort())
    ) {
        throw new Error("native-mount benchmark input roots are invalid");
    }
    const inputPaths = report.inputs.files.map(({ path }) => path);
    if (
        JSON.stringify(inputPaths) !==
            JSON.stringify([...new Set(inputPaths)].sort()) ||
        report.inputs.files.some(
            (file) =>
                typeof file.path !== "string" ||
                !Number.isSafeInteger(file.sizeBytes) ||
                file.sizeBytes < 0 ||
                !/^[0-9a-f]{64}$/u.test(file.sha256 ?? "")
        ) ||
        combinedInputSha256(report.inputs.files) !==
            report.inputs.combinedSha256
    ) {
        throw new Error("native-mount benchmark input fingerprint is invalid");
    }
    const names = report.scenarios.map(({ name }) => name);
    if (
        report.run.samplesPerScenario !== expectedOptions.samples ||
        report.run.warmupsPerScenario !== expectedOptions.warmups ||
        report.run.smallFilesPerSample !== expectedOptions.smallFiles ||
        report.run.readdirEntries !== expectedOptions.readdirEntries ||
        JSON.stringify(report.run.overwriteBaseBytes) !==
            JSON.stringify(expectedOptions.overwriteBaseBytes) ||
        report.run.devWorkload !== Boolean(expectedOptions.devWorkload)
    ) {
        throw new Error("native-mount benchmark run options are invalid");
    }
    // Developer-workload scenarios that could not run are listed once each,
    // with a reason, instead of a record.
    const skipped = !expectedOptions.devWorkload
        ? report.devWorkload === null && []
        : Array.isArray(report.devWorkload?.notMeasured) &&
          report.devWorkload.notMeasured.map(({ scenario }) => scenario);
    if (
        !skipped ||
        new Set(skipped).size !== skipped.length ||
        skipped.some(
            (name) => !devWorkloadScenarioNames(expectedOptions).includes(name)
        )
    ) {
        throw new Error("native-mount developer-workload section is invalid");
    }
    const measuredNames = expectedNativeMountBenchmarkScenarioNames(
        expectedOptions
    ).filter((name) => !skipped.includes(name));
    if (JSON.stringify(names) !== JSON.stringify(measuredNames)) {
        throw new Error(`unexpected scenario set: ${names.join(", ")}`);
    }
    let previousEndedAt = -1n;
    for (const scenario of report.scenarios) {
        const expectedCounts = devWorkloadSampleCounts(
            scenario.name,
            expectedOptions
        );
        if (
            scenario.samples?.length !== expectedCounts.samples ||
            scenario.warmupSamples?.length !== expectedCounts.warmups ||
            scenario.summary?.count !== expectedCounts.samples ||
            !Number.isSafeInteger(scenario.summary?.p50Ns) ||
            !Number.isSafeInteger(scenario.summary?.p95Ns)
        ) {
            throw new Error(`${scenario.name} has an incomplete sample set`);
        }
        // Warmups run first, then measured samples; every window is derived
        // from the monotonic readings that time it, so windows are exact and
        // strictly ordered across the whole report.
        const windows = [
            ...scenario.warmupSamples.map((sample) => [sample, true]),
            ...scenario.samples.map((sample) => [sample, false]),
        ];
        for (const [sample, warmup] of windows) {
            if (
                sample.warmup !== warmup ||
                !UNIX_NS_PATTERN.test(sample.startedAtUnixNs ?? "") ||
                !UNIX_NS_PATTERN.test(sample.endedAtUnixNs ?? "")
            ) {
                throw new Error(
                    `${scenario.name} has an invalid sample window`
                );
            }
            const startedAt = BigInt(sample.startedAtUnixNs);
            const endedAt = BigInt(sample.endedAtUnixNs);
            if (
                !Number.isSafeInteger(sample.durationNs) ||
                endedAt - startedAt !== BigInt(sample.durationNs) ||
                startedAt < previousEndedAt
            ) {
                throw new Error(
                    `${scenario.name} has an invalid sample window`
                );
            }
            previousEndedAt = endedAt;
        }
        for (const sample of [...scenario.warmupSamples, ...scenario.samples]) {
            if (
                !Number.isSafeInteger(sample.durationNs) ||
                sample.durationNs <= 0
            ) {
                throw new Error(`${scenario.name} has an invalid raw duration`);
            }
            if (scenario.semantics?.includes("close")) {
                for (const phase of ["openNs", "ioNs", "closeNs"]) {
                    if (
                        !Number.isSafeInteger(sample[phase]) ||
                        sample[phase] < 0
                    ) {
                        throw new Error(
                            `${scenario.name} has an invalid ${phase} phase`
                        );
                    }
                }
            }
            if (
                scenario.semantics?.includes("fsync") &&
                (!Number.isSafeInteger(sample.fsyncNs) || sample.fsyncNs <= 0)
            ) {
                throw new Error(`${scenario.name} has an invalid fsync phase`);
            }
        }
        if (
            scenario.operation === "overwrite" &&
            ([...scenario.warmupSamples, ...scenario.samples].some(
                (sample, index) =>
                    sample.offset !==
                    nativeMountBenchmarkOverwriteOffset(
                        scenario.baseFileBytes,
                        index
                    )
            ) ||
                JSON.stringify(scenario.offsets) !==
                    JSON.stringify(overwriteOffsets(scenario.samples)))
        ) {
            throw new Error(`${scenario.name} has invalid overwrite offsets`);
        }
        const expectedSummary = summarize(
            scenario.samples,
            scenario.logicalBytes,
            scenario.itemCount
        );
        for (const [key, value] of Object.entries(expectedSummary)) {
            if (scenario.summary[key] !== value) {
                throw new Error(
                    `${scenario.name} has an invalid ${key} summary`
                );
            }
        }
    }
    return report;
};

const formatDuration = (ns) =>
    ns >= 1e9 ? `${(ns / 1e9).toFixed(2)} s` : `${(ns / 1e6).toFixed(3)} ms`;

export const formatNativeMountBenchmarkSummary = (report) => {
    const implementation = Object.fromEntries(
        report.implementation.details.map(({ key, value }) => [key, value])
    );
    const lines = [
        "## Shared FS filesystem-path benchmark",
        "",
        `Target: ${report.target.label}`,
        `Target kind: ${report.target.kind}`,
        `Mount options: ${report.target.mountOptions.length > 0 ? report.target.mountOptions.join(" ") : "none reported"}`,
        `Implementation: tags=${implementation["adapter.buildTags"]}; ${implementation["adapter.goVersion"]}; mount=${implementation["mount.runtime"]}`,
        `Cache: ${report.scope.cacheSemantics.mode}; ${report.scope.cacheSemantics.callbackTraversal}`,
        "",
        "| Scenario | p50 | p95 | p50 logical throughput |",
        "| --- | ---: | ---: | ---: |",
    ];
    for (const scenario of report.scenarios) {
        const throughput = scenario.summary.p50LogicalMiBPerSecond;
        lines.push(
            `| ${scenario.name} | ${formatDuration(scenario.summary.p50Ns)} | ${formatDuration(scenario.summary.p95Ns)} | ${throughput == null ? "—" : `${throughput.toFixed(2)} MiB/s`} |`
        );
    }
    lines.push(
        "",
        ...report.scenarios
            .filter(({ offsets }) => offsets)
            .map(
                ({ name, baseFileBytes, offsets }) =>
                    `- ${name}: offsets from seed ${offsets.seedUint32} touched ${offsets.leavesTouched} of ${Math.ceil(baseFileBytes / offsets.leafBytes)} ${offsets.leafBytes >> 10} KiB leaves.`
            )
    );
    lines.push(...formatDevWorkloadSummaryLines(report));
    lines.push(
        "",
        "Report-only: no performance threshold was applied. Local fsync completion does not prove remote persisted delivery.",
        ""
    );
    return lines.join("\n");
};

/**
 * One table for a mounted report and its same-runner local-disk control, with
 * the mount/control p50 ratio for every planned scenario.
 */
export const formatNativeMountBenchmarkComparison = (mount, control) => {
    validateNativeMountBenchmarkReport(mount);
    validateNativeMountBenchmarkReport(control);
    if (
        mount.target.kind !== "shared-fs-mount" ||
        control.target.kind !== "local-filesystem-control"
    ) {
        throw new Error(
            "a comparison needs a shared-fs-mount report and a local-filesystem-control report"
        );
    }
    const options = nativeMountBenchmarkRunOptions(mount);
    if (
        JSON.stringify(options) !==
        JSON.stringify(nativeMountBenchmarkRunOptions(control))
    ) {
        throw new Error(
            "mount and control reports were run with different options"
        );
    }
    const measured = (report) =>
        new Map(report.scenarios.map((scenario) => [scenario.name, scenario]));
    const [mountScenarios, controlScenarios] = [
        measured(mount),
        measured(control),
    ];
    const cell = (scenario, key) =>
        scenario ? formatDuration(scenario.summary[key]) : "not measured";
    const lines = [
        "## Shared FS mount vs local filesystem control (same runner)",
        "",
        `Mount: ${mount.target.label}. Control: ${control.target.label}.`,
        "",
        "| Scenario | Mount p50 | Control p50 | Mount/control p50 | Mount p95 | Control p95 |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ];
    for (const name of expectedNativeMountBenchmarkScenarioNames(options)) {
        const onMount = mountScenarios.get(name);
        const onControl = controlScenarios.get(name);
        const ratio =
            onMount && onControl
                ? `${(onMount.summary.p50Ns / onControl.summary.p50Ns).toFixed(1)}×`
                : "—";
        lines.push(
            `| ${name} | ${cell(onMount, "p50Ns")} | ${cell(onControl, "p50Ns")} | ${ratio} | ${cell(onMount, "p95Ns")} | ${cell(onControl, "p95Ns")} |`
        );
    }
    lines.push(
        "",
        "Ratios compare p50s measured on one runner. Report-only: no threshold is applied. Each report's summary lists why a scenario was not measured.",
        ""
    );
    return lines.join("\n");
};

export const runNativeMountBenchmark = async (options) => {
    const mountMetadata = await stat(options.mount);
    if (!mountMetadata.isDirectory()) {
        throw new Error(
            `benchmark target is not a directory: ${options.mount}`
        );
    }
    const inputsBefore = await hashNativeMountBenchmarkInputs(
        options.implementationInputs
    );
    const startedAt = new Date().toISOString();
    const root = join(
        options.mount,
        `peerbit-native-mount-benchmark-${randomUUID()}`
    );
    await mkdir(root);
    const controller = new AbortController();
    let timeout;
    let scenarios;
    let devWorkload = null;
    let workloadError;
    try {
        timeout = setTimeout(
            () =>
                controller.abort(
                    new Error(`benchmark exceeded ${options.timeoutMs} ms`)
                ),
            options.timeoutMs
        );
        timeout.unref();
        scenarios = await executeWorkload(root, options, controller.signal);
        if (options.devWorkload) {
            const result = await executeDevWorkload(
                root,
                options,
                controller.signal,
                devWorkloadHarness
            );
            scenarios.push(...result.scenarios);
            devWorkload = result.section;
        }
    } catch (error) {
        workloadError = error;
    } finally {
        clearTimeout(timeout);
    }
    let cleanupError;
    try {
        // executeWorkload has stopped before cleanup begins, so removing the
        // UUID-owned directory cannot race a still-running benchmark task.
        await rm(root, { recursive: true, force: true });
    } catch (error) {
        cleanupError = error;
    }
    if (workloadError && cleanupError) {
        const message = (error) =>
            error instanceof Error ? error.message : String(error);
        throw new AggregateError(
            [workloadError, cleanupError],
            `benchmark failed (${message(workloadError)}); owned-directory cleanup also failed (${message(cleanupError)})`
        );
    }
    if (workloadError) throw workloadError;
    if (cleanupError) throw cleanupError;
    const inputsAfter = await hashNativeMountBenchmarkInputs(
        options.implementationInputs
    );
    if (inputsAfter.combinedSha256 !== inputsBefore.combinedSha256) {
        throw new Error("benchmark inputs changed while the run was active");
    }
    const [libraryVersion, cliVersion] = await Promise.all([
        readPackageVersion(
            join(REPOSITORY_ROOT, "packages/shared-fs/library/package.json")
        ),
        readPackageVersion(
            join(REPOSITORY_ROOT, "packages/shared-fs/cli/package.json")
        ),
    ]);
    return validateNativeMountBenchmarkReport(
        {
            schemaVersion: SCHEMA_VERSION,
            benchmark: "shared-fs-native-mount",
            corpus: nativeMountBenchmarkCorpus,
            target: {
                kind: options.targetKind ?? "shared-fs-mount",
                label: options.targetLabel,
                path: options.mount,
                mountOptions: options.mountOptions ?? [],
                mountOptionsVerification:
                    (options.targetKind ?? "shared-fs-mount") ===
                    "local-filesystem-control"
                        ? "not applicable; the local control has no mount options"
                        : "caller supplied; the harness does not inspect the active mount",
                verification:
                    "caller supplied; the harness does not independently prove the filesystem implementation",
            },
            scope: {
                boundary:
                    "Node filesystem APIs through the supplied filesystem path, including open/read/write/fsync/close",
                writeCompletion:
                    "every timed write calls FileHandle.sync before close; this proves only the supplied filesystem path's local fsync contract",
                cacheSemantics: {
                    mode: "warm/default-platform-caches",
                    controls:
                        "the harness neither evicts kernel/application caches nor requests direct I/O",
                    callbackTraversal:
                        (options.targetKind ?? "shared-fs-mount") ===
                        "local-filesystem-control"
                            ? "kernel and storage request counts are not instrumented for the local control"
                            : "userspace callbacks are not instrumented; cached reads and metadata calls might not reach them",
                },
                implementationDetailSemantics:
                    (options.targetKind ?? "shared-fs-mount") ===
                    "local-filesystem-control"
                        ? "adapter and mount details identify the paired Shared FS comparison; they are not on the timed local-control path"
                        : "adapter and mount details describe the timed Shared FS path",
                excludes: [
                    "remote replica acknowledgement and persisted-delivery durability",
                    "multi-peer propagation and conflict convergence",
                    "independent verification of the supplied mount technology",
                ],
                performanceGate: false,
            },
            run: {
                startedAt,
                clock: "process.hrtime.bigint monotonic durations",
                sampleWindows:
                    "startedAtUnixNs/endedAtUnixNs bracket each timed operation (decimal Unix nanoseconds from one wall-clock anchor plus the monotonic clock); warmupSamples precede samples and are excluded from summaries",
                percentiles: "nearest-rank",
                warmupsPerScenario: options.warmups,
                samplesPerScenario: options.samples,
                concurrency: 1,
                timeoutMs: options.timeoutMs,
                timeoutSemantics:
                    "workload timeout is cooperative at filesystem-operation boundaries after initial provenance hashing; the standalone CLI wall-clock deadline starts before hashing, includes report publication, and exits after timeout plus five seconds if work stalls",
                smallFilesPerSample: options.smallFiles,
                readdirEntries: options.readdirEntries,
                overwriteBaseBytes: options.overwriteBaseBytes,
                devWorkload: options.devWorkload,
            },
            runtime: {
                nodeVersion: process.version,
                platform: platform(),
                architecture: arch(),
                osRelease: release(),
                cpuModel: cpus()[0]?.model ?? "unknown",
                totalMemoryBytes: totalmem(),
                sharedFsLibraryVersion: libraryVersion,
                sharedFsCliVersion: cliVersion,
            },
            implementation: {
                details: normalizeImplementationDetails(
                    options.implementationDetails
                ),
            },
            inputs: inputsBefore,
            devWorkload,
            scenarios,
        },
        options
    );
};

export const writeNativeMountBenchmarkReport = async (
    output,
    report,
    options
) => {
    validateNativeMountBenchmarkReport(report, options);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const temporary = join(
        dirname(output),
        `.${basename(output)}.${process.pid}.${randomUUID()}.tmp`
    );
    try {
        const handle = await open(temporary, "wx");
        try {
            await handle.writeFile(json, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, output);
    } finally {
        await rm(temporary, { force: true });
    }
};

const main = async () => {
    const options = parseNativeMountBenchmarkArguments(process.argv.slice(2));
    // Bound the entire standalone command, including provenance hashing,
    // owned-directory cleanup, atomic report publication, and stdout flushing.
    // The workload also has its own cooperative timeout at operation boundaries.
    const hardTimeout = setTimeout(() => {
        process.stderr.write(
            "native-mount benchmark command exceeded its hard deadline\n"
        );
        process.exit(124);
    }, options.timeoutMs + 5000);
    try {
        const report = await runNativeMountBenchmark(options);
        const json = `${JSON.stringify(report, null, 2)}\n`;
        if (options.output) {
            await writeNativeMountBenchmarkReport(
                options.output,
                report,
                options
            );
        }
        await new Promise((resolvePromise, reject) => {
            process.stdout.write(json, "utf8", (error) => {
                if (error) reject(error);
                else resolvePromise();
            });
        });
    } finally {
        clearTimeout(hardTimeout);
    }
};

if (
    process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
    main().catch((error) => {
        process.stderr.write(
            `${error instanceof Error ? error.stack : String(error)}\n`
        );
        process.exitCode = 1;
    });
}
