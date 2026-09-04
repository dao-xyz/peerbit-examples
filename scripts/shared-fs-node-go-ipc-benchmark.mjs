#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "..");
const NATIVE_ROOT = join(REPOSITORY_ROOT, "packages/shared-fs/native");
const IPC_MODULE = join(
    REPOSITORY_ROOT,
    "packages/shared-fs/library/lib/esm/ipc.js"
);
const SCENARIOS = [
    "getattr",
    "read-4096",
    "write-4096",
    "read-1048576",
    "write-1048576",
];
const MAX_ADAPTER_WIDTH = 16;
const MAX_PARALLELISM = 64;
const CORPUS = "linear-handle-v2:(index*131+size*17+handle*31+29)%256";
const EXPECTED_SCOPE = {
    boundary: "real Go ipcClient pool to real Node createSharedFsIpcServer",
    transport:
        "serialized TCP loopback per retained client connection; concurrent across independent lanes",
    backend:
        "deterministic immediate in-memory benchmark backend with per-handle write state",
    measurement:
        "wall-clock concurrent batch: Go scheduling/encode/write/wait/decode plus Node decode/backend/encode/write",
    verification:
        "distinct paths/handles and complete read/result checks after timers; per-handle write bytes checked by untimed fsync",
    scheduling:
        "work item i uses retained adapter lane i modulo adapterWidth; all lanes negotiate before any warmup or sample",
    excludes: [
        "FUSE/macFUSE/WinFsp",
        "Peerbit and network replication",
        "storage and persistence",
        "durable acknowledgements",
        "mount syscall overhead",
    ],
};
const BENCHMARK_INPUT_FILES = [
    "scripts/shared-fs-node-go-ipc-benchmark.mjs",
    "packages/shared-fs/native/ipc.go",
    "packages/shared-fs/native/ipc_v2.go",
    "packages/shared-fs/native/node_go_ipc_benchmark_test.go",
    "packages/shared-fs/library/lib/esm/ipc.js",
    "packages/shared-fs/library/lib/esm/ipc-v2.js",
    "packages/shared-fs/library/lib/esm/ipc-byte-reader.js",
    "packages/shared-fs/library/lib/esm/mount-backend.js",
];

const readOptional = async (path) => {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "EISDIR") {
            return undefined;
        }
        throw error;
    }
};

// Resolve HEAD directly so the benchmark does not depend on git being in PATH
// and never changes repository state. Worktree common-dir refs are supported.
const readGitCommit = async () => {
    const dotGit = join(REPOSITORY_ROOT, ".git");
    const dotGitContents = await readOptional(dotGit);
    const gitDirectory = dotGitContents?.startsWith("gitdir:")
        ? resolve(
              REPOSITORY_ROOT,
              dotGitContents.slice("gitdir:".length).trim()
          )
        : dotGit;
    const head = (await readOptional(join(gitDirectory, "HEAD")))?.trim();
    if (!head) return undefined;
    if (/^[0-9a-f]{40}$/i.test(head)) return head;
    if (!head.startsWith("ref: ")) return undefined;
    const reference = head.slice("ref: ".length);
    const commonRelative = (
        await readOptional(join(gitDirectory, "commondir"))
    )?.trim();
    const commonDirectory = commonRelative
        ? resolve(gitDirectory, commonRelative)
        : gitDirectory;
    for (const root of [gitDirectory, commonDirectory]) {
        const loose = (await readOptional(join(root, reference)))?.trim();
        if (loose && /^[0-9a-f]{40}$/i.test(loose)) return loose;
    }
    const packed = await readOptional(join(commonDirectory, "packed-refs"));
    const match = packed
        ?.split(/\r?\n/u)
        .find((line) => line.endsWith(` ${reference}`));
    return match?.split(" ", 1)[0];
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

export const parseNodeGoIPCAdapterWidths = (value) => {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error("--adapter-widths requires a comma-separated list");
    }
    const parts = value.split(",");
    if (parts.length > MAX_ADAPTER_WIDTH) {
        throw new Error(
            `--adapter-widths accepts at most ${MAX_ADAPTER_WIDTH} widths`
        );
    }
    const widths = parts.map((part) => {
        if (!/^(?:[1-9]|1[0-6])$/u.test(part)) {
            throw new Error(
                `--adapter-widths entries must be integers from 1 through ${MAX_ADAPTER_WIDTH}`
            );
        }
        return Number(part);
    });
    if (new Set(widths).size !== widths.length) {
        throw new Error("--adapter-widths cannot contain duplicates");
    }
    return widths;
};

export const parseNodeGoIPCArguments = (argv) => {
    const options = {
        samples: 30,
        warmups: 2,
        timeoutMs: 120_000,
        adapterWidths: [1],
        parallelism: 1,
    };
    const seen = new Set();
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--") continue;
        if (seen.has(argument)) {
            throw new Error(`${argument} cannot be specified more than once`);
        }
        seen.add(argument);
        if (argument === "--output") {
            const value = argv[++index];
            if (!value) throw new Error("--output requires a path");
            options.output = resolve(value);
            continue;
        }
        if (argument === "--adapter-widths") {
            options.adapterWidths = parseNodeGoIPCAdapterWidths(argv[++index]);
            continue;
        }
        const definitions = {
            "--samples": ["samples", 1, 1000],
            "--warmups": ["warmups", 0, 100],
            "--timeout-ms": ["timeoutMs", 1, 600_000],
            "--parallelism": ["parallelism", 1, MAX_PARALLELISM],
        };
        const definition = definitions[argument];
        if (!definition) throw new Error(`Unknown argument: ${argument}`);
        const value = argv[++index];
        const parsed = Number(value);
        const [key, minimum, maximum] = definition;
        if (
            !Number.isSafeInteger(parsed) ||
            parsed < minimum ||
            parsed > maximum
        ) {
            throw new Error(
                `${argument} must be an integer from ${minimum} through ${maximum}`
            );
        }
        options[key] = parsed;
    }
    if (Math.max(...options.adapterWidths) > options.parallelism) {
        throw new Error(
            "each --adapter-widths entry must be no greater than --parallelism"
        );
    }
    return options;
};

const expectedByte = (size, handle, index) =>
    (index * 131 + size * 17 + handle * 31 + 29) % 256;

const deterministicPayload = (size, handle) => {
    const payload = Buffer.allocUnsafe(size);
    for (let index = 0; index < size; index += 1) {
        payload[index] = expectedByte(size, handle, index);
    }
    return payload;
};

const createImmediateBackend = (parallelism) => {
    const sizes = new Set([4096, 1 << 20]);
    const payloads = new Map();
    for (let handle = 1; handle <= parallelism; handle += 1) {
        for (const size of sizes) {
            payloads.set(
                `${handle}:${size}`,
                deterministicPayload(size, handle)
            );
        }
    }
    const pendingWrites = new Map();
    const validateHandle = (handle) => {
        if (
            !Number.isSafeInteger(handle) ||
            handle < 1 ||
            handle > parallelism
        ) {
            throw new Error("unexpected logical file handle");
        }
    };
    const unsupported = async () => {
        throw new Error("operation is outside the Node-Go IPC benchmark");
    };
    return {
        async getattr(path) {
            const match = /^\/bench\/file-([1-9][0-9]*)\.bin$/u.exec(path);
            const handle = Number(match?.[1]);
            validateHandle(handle);
            return {
                path,
                kind: "file",
                size: 1 << 20,
                mode: 0o100644,
                mtimeMs: 1,
                ctimeMs: 1,
                nlink: 1,
            };
        },
        readdir: unsupported,
        open: unsupported,
        async read(handle, size, offset) {
            validateHandle(handle);
            const payload = payloads.get(`${handle}:${size}`);
            if (offset !== 0 || !payload) {
                throw new Error("unexpected read request");
            }
            return payload;
        },
        async write(handle, data, offset) {
            validateHandle(handle);
            if (
                offset !== 0 ||
                !payloads.has(`${handle}:${data.byteLength}`) ||
                pendingWrites.has(handle)
            ) {
                throw new Error("unexpected write request");
            }
            pendingWrites.set(handle, data);
            return data.byteLength;
        },
        truncate: unsupported,
        flush: unsupported,
        async fsync(handle) {
            validateHandle(handle);
            const pendingWrite = pendingWrites.get(handle);
            if (!pendingWrite) {
                throw new Error("write verification requested without bytes");
            }
            const expected = payloads.get(
                `${handle}:${pendingWrite.byteLength}`
            );
            const actual = Buffer.isBuffer(pendingWrite)
                ? pendingWrite
                : Buffer.from(
                      pendingWrite.buffer,
                      pendingWrite.byteOffset,
                      pendingWrite.byteLength
                  );
            if (!expected || !actual.equals(expected)) {
                throw new Error(
                    "write payload did not match deterministic corpus"
                );
            }
            pendingWrites.delete(handle);
        },
        release: unsupported,
        mkdir: unsupported,
        rmdir: unsupported,
        rename: unsupported,
        unlink: unsupported,
    };
};

const runChild = (command, args, { cwd, env, timeoutMs }) =>
    new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
            cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const output = { stdout: "", stderr: "" };
        let settled = false;
        let pendingError;
        let timer;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolvePromise(output);
        };
        const append = (key, chunk) => {
            output[key] += chunk.toString("utf8");
            if (output[key].length > 4 * 1024 * 1024) {
                pendingError = new Error(`${command} ${key} exceeded 4 MiB`);
                child.kill();
            }
        };
        child.stdout.on("data", (chunk) => append("stdout", chunk));
        child.stderr.on("data", (chunk) => append("stderr", chunk));
        child.once("error", finish);
        child.once("close", (code, signal) => {
            if (pendingError) return finish(pendingError);
            if (code === 0) return finish();
            finish(
                new Error(
                    `${command} exited with code ${code} signal ${signal ?? "none"}\n${output.stdout}${output.stderr}`
                )
            );
        });
        timer = setTimeout(() => {
            pendingError = new Error(`${command} exceeded ${timeoutMs} ms`);
            child.kill();
        }, timeoutMs);
        timer.unref();
    });

const nodeGoIPCScenarioDefinitions = [
    {
        name: "getattr",
        operation: "getattr",
        direction: "metadata-response",
        logicalBytesPerItem: 0,
    },
    {
        name: "read-4096",
        operation: "read",
        direction: "node-to-go",
        logicalBytesPerItem: 4096,
    },
    {
        name: "write-4096",
        operation: "write",
        direction: "go-to-node",
        logicalBytesPerItem: 4096,
    },
    {
        name: "read-1048576",
        operation: "read",
        direction: "node-to-go",
        logicalBytesPerItem: 1 << 20,
    },
    {
        name: "write-1048576",
        operation: "write",
        direction: "go-to-node",
        logicalBytesPerItem: 1 << 20,
    },
];

const percentile = (sorted, fraction) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];

export const summarizeNodeGoIPCSamples = (
    samples,
    batchItems,
    batchLogicalBytes
) => {
    const durations = samples
        .map(({ durationNs }) => durationNs)
        .sort((left, right) => left - right);
    const p50Ns = percentile(durations, 0.5);
    const summary = {
        count: samples.length,
        minNs: durations[0],
        p50Ns,
        p95Ns: percentile(durations, 0.95),
        maxNs: durations.at(-1),
        meanNs:
            durations.reduce((total, duration) => total + duration, 0) /
            durations.length,
        meanGoAllocBytes:
            samples.reduce((total, sample) => total + sample.goAllocBytes, 0) /
            samples.length,
        meanGoMallocs:
            samples.reduce((total, sample) => total + sample.goMallocs, 0) /
            samples.length,
        p50AggregateItemsPerSecond: batchItems / (p50Ns / 1e9),
    };
    if (batchLogicalBytes > 0) {
        summary.p50AggregateLogicalMiBPerSecond =
            batchLogicalBytes / (1024 * 1024) / (p50Ns / 1e9);
    }
    return summary;
};

const sameJson = (left, right) =>
    JSON.stringify(left) === JSON.stringify(right);

export const validateNodeGoIPCReport = (report, options) => {
    if (
        report?.schemaVersion !== 2 ||
        report.benchmark !== "shared-fs-node-go-ipc-concurrency" ||
        report.protocol !== "binary-v2-raw-bytes" ||
        report.corpus !== CORPUS ||
        !sameJson(report.scope, EXPECTED_SCOPE) ||
        !Array.isArray(report.widths) ||
        !sameJson(report.run?.adapterWidths, options.adapterWidths) ||
        report.run?.workloadParallelism !== options.parallelism ||
        report.run?.samplesPerScenario !== options.samples ||
        report.run?.warmupsPerScenario !== options.warmups ||
        report.run?.clock !== "Go monotonic time.Now/time.Since" ||
        report.run?.percentiles !== "nearest-rank"
    ) {
        throw new Error("Go benchmark produced an unexpected report envelope");
    }
    for (const key of [
        "goVersion",
        "goOs",
        "goArch",
        "nodeVersion",
        "nodePlatform",
        "nodeArch",
        "nodeUvThreadpoolSize",
        "cpuModel",
    ]) {
        if (typeof report.runtime?.[key] !== "string" || !report.runtime[key]) {
            throw new Error(`Go benchmark runtime ${key} is invalid`);
        }
    }
    for (const key of ["goMaxProcs", "goLogicalCpus"]) {
        if (
            !Number.isSafeInteger(report.runtime?.[key]) ||
            report.runtime[key] < 1
        ) {
            throw new Error(`Go benchmark runtime ${key} is invalid`);
        }
    }
    if (report.widths.length !== options.adapterWidths.length) {
        throw new Error("Go benchmark produced an incomplete adapter sweep");
    }
    for (
        let widthIndex = 0;
        widthIndex < report.widths.length;
        widthIndex += 1
    ) {
        const width = report.widths[widthIndex];
        const expectedWidth = options.adapterWidths[widthIndex];
        if (
            width?.adapterWidth !== expectedWidth ||
            width.workloadParallelism !== options.parallelism ||
            !Array.isArray(width.scenarios) ||
            !sameJson(
                width.scenarios.map(({ name }) => name),
                SCENARIOS
            )
        ) {
            throw new Error(`adapter width ${expectedWidth} report is invalid`);
        }
        for (let index = 0; index < width.scenarios.length; index += 1) {
            const scenario = width.scenarios[index];
            const expected = nodeGoIPCScenarioDefinitions[index];
            const batchLogicalBytes =
                expected.logicalBytesPerItem * options.parallelism;
            if (
                scenario.name !== expected.name ||
                scenario.operation !== expected.operation ||
                scenario.direction !== expected.direction ||
                (scenario.logicalBytesPerItem ?? 0) !==
                    expected.logicalBytesPerItem ||
                scenario.batchItems !== options.parallelism ||
                (scenario.batchLogicalBytes ?? 0) !== batchLogicalBytes ||
                !Array.isArray(scenario.samples) ||
                scenario.samples.length !== options.samples
            ) {
                throw new Error(
                    `adapter width ${expectedWidth} ${expected.name} scenario is invalid`
                );
            }
            for (const sample of scenario.samples) {
                if (
                    !Number.isSafeInteger(sample.durationNs) ||
                    sample.durationNs <= 0 ||
                    !Number.isSafeInteger(sample.goAllocBytes) ||
                    sample.goAllocBytes < 0 ||
                    !Number.isSafeInteger(sample.goMallocs) ||
                    sample.goMallocs < 0
                ) {
                    throw new Error(
                        `adapter width ${expectedWidth} ${scenario.name} has an invalid raw sample`
                    );
                }
            }
            const expectedSummary = summarizeNodeGoIPCSamples(
                scenario.samples,
                options.parallelism,
                batchLogicalBytes
            );
            if (!sameJson(scenario.summary, expectedSummary)) {
                throw new Error(
                    `adapter width ${expectedWidth} ${scenario.name} has an invalid summary`
                );
            }
        }
    }
    return report;
};

export const runNodeGoIPCBenchmark = async (options) => {
    const scratch = await mkdtemp(join(tmpdir(), "peerbit-node-go-ipc-"));
    const executable = join(
        scratch,
        process.platform === "win32"
            ? "ipc-benchmark.test.exe"
            : "ipc-benchmark.test"
    );
    const rawReport = join(scratch, "report.json");
    let server;
    try {
        const [lockfile, packageJson, gitCommit, benchmarkInputsSha256] =
            await Promise.all([
                readFile(join(REPOSITORY_ROOT, "pnpm-lock.yaml")),
                readFile(
                    join(
                        REPOSITORY_ROOT,
                        "packages/shared-fs/library/package.json"
                    ),
                    "utf8"
                ),
                readGitCommit(),
                hashBenchmarkInputs(),
            ]);
        // Compilation and Node server startup happen before all timed samples.
        await runChild("go", ["test", "-c", "-o", executable, "."], {
            cwd: NATIVE_ROOT,
            env: process.env,
            timeoutMs: options.timeoutMs,
        });
        const { createSharedFsIpcServer } = await import(
            pathToFileURL(IPC_MODULE)
        );
        server = await createSharedFsIpcServer(
            createImmediateBackend(options.parallelism),
            "tcp://127.0.0.1:0"
        );
        await runChild(
            executable,
            ["-test.run=^TestNodeGoIPCExternalBenchmark$"],
            {
                cwd: NATIVE_ROOT,
                timeoutMs: options.timeoutMs,
                env: {
                    ...process.env,
                    PEERBIT_SHARED_FS_NODE_GO_IPC_ENDPOINT: server.endpoint,
                    PEERBIT_SHARED_FS_NODE_GO_IPC_OUTPUT: rawReport,
                    PEERBIT_SHARED_FS_NODE_GO_IPC_SAMPLES: String(
                        options.samples
                    ),
                    PEERBIT_SHARED_FS_NODE_GO_IPC_WARMUPS: String(
                        options.warmups
                    ),
                    PEERBIT_SHARED_FS_NODE_GO_IPC_ADAPTER_WIDTHS:
                        options.adapterWidths.join(","),
                    PEERBIT_SHARED_FS_NODE_GO_IPC_PARALLELISM: String(
                        options.parallelism
                    ),
                    PEERBIT_SHARED_FS_NODE_VERSION: process.version,
                    PEERBIT_SHARED_FS_NODE_PLATFORM: platform(),
                    PEERBIT_SHARED_FS_NODE_ARCH: arch(),
                    PEERBIT_SHARED_FS_NODE_UV_THREADPOOL_SIZE:
                        process.env.UV_THREADPOOL_SIZE ?? "default",
                    PEERBIT_SHARED_FS_CPU_MODEL: cpus()[0]?.model ?? "unknown",
                },
            }
        );
        const report = validateNodeGoIPCReport(
            JSON.parse(await readFile(rawReport, "utf8")),
            options
        );
        if ((await hashBenchmarkInputs()) !== benchmarkInputsSha256) {
            throw new Error(
                "Benchmark inputs changed while the run was active"
            );
        }
        report.runtime = {
            ...report.runtime,
            osRelease: release(),
            totalMemoryBytes: totalmem(),
            sharedFsPackageVersion: JSON.parse(packageJson).version,
            pnpmLockSha256: createHash("sha256").update(lockfile).digest("hex"),
            gitHeadCommit: gitCommit ?? null,
            benchmarkInputFiles: BENCHMARK_INPUT_FILES,
            benchmarkInputsSha256,
        };
        report.scope.goAllocationMeasurement =
            "per-batch Go runtime TotalAlloc and Mallocs deltas only; setup, Node, and system allocations are excluded";
        return report;
    } finally {
        await server?.close();
        await rm(scratch, { recursive: true, force: true });
    }
};

const main = async () => {
    const options = parseNodeGoIPCArguments(process.argv.slice(2));
    const report = await runNodeGoIPCBenchmark(options);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) await writeFile(options.output, json, "utf8");
    process.stdout.write(json);
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
