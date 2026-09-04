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
const CORPUS = "linear-v1:(index*131+size*17+29)%256";
const BENCHMARK_INPUT_FILES = [
    "scripts/shared-fs-node-go-ipc-benchmark.mjs",
    "packages/shared-fs/native/ipc.go",
    "packages/shared-fs/native/node_go_ipc_benchmark_test.go",
    "packages/shared-fs/library/lib/esm/ipc.js",
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

export const parseNodeGoIPCArguments = (argv) => {
    const options = { samples: 30, warmups: 2, timeoutMs: 120_000 };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--") continue;
        if (argument === "--output") {
            const value = argv[++index];
            if (!value) throw new Error("--output requires a path");
            options.output = resolve(value);
            continue;
        }
        const definitions = {
            "--samples": ["samples", 1, 1000],
            "--warmups": ["warmups", 0, 100],
            "--timeout-ms": ["timeoutMs", 1, 600_000],
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
    return options;
};

const expectedByte = (size, index) => (index * 131 + size * 17 + 29) % 256;

const deterministicPayload = (size) => {
    const payload = Buffer.allocUnsafe(size);
    for (let index = 0; index < size; index += 1) {
        payload[index] = expectedByte(size, index);
    }
    return payload;
};

const createImmediateBackend = () => {
    const payloads = new Map(
        [4096, 1 << 20].map((size) => [size, deterministicPayload(size)])
    );
    let pendingWrite;
    const unsupported = async () => {
        throw new Error("operation is outside the Node-Go IPC benchmark");
    };
    return {
        async getattr(path) {
            if (path !== "/bench/file.bin") throw new Error("unexpected path");
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
            if (handle !== 1 || offset !== 0 || !payloads.has(size)) {
                throw new Error("unexpected read request");
            }
            return payloads.get(size);
        },
        async write(handle, data, offset) {
            if (
                handle !== 1 ||
                offset !== 0 ||
                !payloads.has(data.byteLength)
            ) {
                throw new Error("unexpected write request");
            }
            pendingWrite = data;
            return data.byteLength;
        },
        truncate: unsupported,
        flush: unsupported,
        async fsync(handle) {
            if (handle !== 1 || !pendingWrite) {
                throw new Error("write verification requested without bytes");
            }
            const expected = payloads.get(pendingWrite.byteLength);
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
            pendingWrite = undefined;
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

export const validateNodeGoIPCReport = (report, expectedSamples) => {
    if (
        report?.schemaVersion !== 1 ||
        report.benchmark !== "shared-fs-node-go-ipc" ||
        report.protocol !== "jsonl-v1-base64" ||
        report.corpus !== CORPUS ||
        !Array.isArray(report.scenarios)
    ) {
        throw new Error("Go benchmark produced an unexpected report envelope");
    }
    const names = report.scenarios.map(({ name }) => name);
    if (JSON.stringify(names) !== JSON.stringify(SCENARIOS)) {
        throw new Error(`Unexpected benchmark scenarios: ${names.join(", ")}`);
    }
    for (const scenario of report.scenarios) {
        if (
            !Array.isArray(scenario.samples) ||
            scenario.samples.length !== expectedSamples ||
            scenario.summary?.count !== expectedSamples
        ) {
            throw new Error(`${scenario.name} has an incomplete sample set`);
        }
        for (const sample of scenario.samples) {
            if (
                !Number.isSafeInteger(sample.durationNs) ||
                sample.durationNs <= 0 ||
                !Number.isSafeInteger(sample.goAllocBytes) ||
                !Number.isSafeInteger(sample.goMallocs)
            ) {
                throw new Error(`${scenario.name} has an invalid raw sample`);
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
            createImmediateBackend(),
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
                    PEERBIT_SHARED_FS_NODE_VERSION: process.version,
                    PEERBIT_SHARED_FS_NODE_PLATFORM: platform(),
                    PEERBIT_SHARED_FS_NODE_ARCH: arch(),
                    PEERBIT_SHARED_FS_CPU_MODEL: cpus()[0]?.model ?? "unknown",
                },
            }
        );
        const report = validateNodeGoIPCReport(
            JSON.parse(await readFile(rawReport, "utf8")),
            options.samples
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
            "per-request Go runtime TotalAlloc and Mallocs deltas only; Node and system allocations are excluded";
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
