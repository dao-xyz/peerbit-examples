#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
    createSharedFsIpcServer,
    createSharedFsMountBackend,
} from "../packages/shared-fs/library/lib/esm/index.js";
import { mountExternalNativeAdapter } from "../packages/shared-fs/cli/lib/esm/external-native-adapter.js";
import { runMountReadinessLifecycle } from "../packages/shared-fs/cli/lib/esm/mount-readiness.js";

const parseArguments = (argv) => {
    const parsed = {};
    for (let index = 0; index < argv.length; index += 2) {
        const option = argv[index];
        const value = argv[index + 1];
        if (!option?.startsWith("--") || value == null) {
            throw new Error(
                "Usage: shared-fs-readable-first-native-smoke.mjs --adapter <path> --mountpoint <path>"
            );
        }
        parsed[option.slice(2)] = value;
    }
    if (!parsed.adapter || !parsed.mountpoint) {
        throw new Error(
            "Both --adapter and --mountpoint are required for the readable-first native smoke."
        );
    }
    return parsed;
};

const deferred = () => {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const waitForGate = (gate, { timeout, signal }, description) =>
    new Promise((resolve, reject) => {
        let settled = false;
        const finish = (failed, error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            if (failed) reject(error);
            else resolve();
        };
        const onAbort = () =>
            finish(
                true,
                signal.reason ?? new Error(`${description} was aborted`)
            );
        const timer = setTimeout(() => {
            finish(
                true,
                Object.assign(
                    new Error(`Timed out waiting for ${description}`),
                    {
                        code: "ETIMEDOUT",
                    }
                )
            );
        }, timeout);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }
        void gate.then(
            () => finish(false),
            (error) => finish(true, error)
        );
    });

const withTimeout = async (operation, description, timeoutMs = 20_000) => {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                `Timed out waiting for ${description} after ${timeoutMs} ms`
                            )
                        ),
                    timeoutMs
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

const normalize = (value) => {
    const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
};

const entry = (entryPath, kind, size = 0n) => ({
    path: entryPath,
    nodeId: `native-smoke:${entryPath}`,
    name: path.posix.basename(entryPath),
    kind,
    size,
    updatedAt: BigInt(Date.now()),
    authorKey: "native-smoke",
    machineLabel: "native-smoke",
    conflict: false,
    ...(kind === "file"
        ? {
              versionId: "native-smoke:seed:v1",
              headVersionIds: ["native-smoke:seed:v1"],
          }
        : {}),
});

const { adapter, mountpoint } = parseArguments(process.argv.slice(2));
// WinFsp cannot preserve FUSE EAGAIN. The external adapter uses ENOLCK there,
// which WinFsp and Node/libuv expose as the retryable EBUSY instead.
const expectedBlockedCode = process.platform === "win32" ? "EBUSY" : "EAGAIN";
const seedBytes = new TextEncoder().encode("readable before write readiness");
const entries = new Map([
    ["/seed.txt", entry("/seed.txt", "file", BigInt(seedBytes.byteLength))],
]);
let writeReady = false;
let mkdirCalls = 0;

const target = {
    bootstrapStatus: () => ({
        phase: writeReady ? "converged" : "overlay-active",
        writeReady,
    }),
    readFile: async (filePath) =>
        normalize(filePath) === "/seed.txt" ? seedBytes.slice() : undefined,
    readVersion: async (filePath, versionId) =>
        normalize(filePath) === "/seed.txt" &&
        versionId === "native-smoke:seed:v1"
            ? seedBytes.slice()
            : undefined,
    writeFile: async () => {
        throw new Error("The readable-first native smoke does not write files");
    },
    mkdir: async (directoryPath) => {
        mkdirCalls++;
        const normalized = normalize(directoryPath);
        entries.set(normalized, entry(normalized, "directory"));
    },
    rm: async (entryPath) => {
        entries.delete(normalize(entryPath));
    },
    rename: async () => {
        throw new Error(
            "The readable-first native smoke does not rename paths"
        );
    },
    list: async (directoryPath = "/") => {
        const normalized = normalize(directoryPath);
        return [...entries.values()].filter(
            (candidate) => path.posix.dirname(candidate.path) === normalized
        );
    },
    versions: async () => [],
    conflicts: async () => [],
    stat: async (entryPath) => entries.get(normalize(entryPath)),
};

const readiness = deferred();
const shutdown = deferred();
const pending = deferred();
const writable = deferred();
const requestShutdown = () => shutdown.resolve();
process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);
let server;
let mounted;
let adapterChild;

const lifecycle = runMountReadinessLifecycle({
    readableFirst: true,
    timeoutMs: 60_000,
    isWriteReady: () => writeReady,
    awaitWriteReady: (options) =>
        waitForGate(readiness.promise, options, "write readiness"),
    awaitReadable: async () => {},
    mount: async () => {
        const backend = createSharedFsMountBackend(target);
        server = await createSharedFsIpcServer(backend, "tcp://127.0.0.1:0");
        mounted = await mountExternalNativeAdapter(
            adapter,
            server.endpoint,
            mountpoint,
            {
                spawnAdapter: (...args) => {
                    adapterChild = spawn(...args);
                    return adapterChild;
                },
            }
        );
    },
    waitForShutdown: (signal) =>
        waitForGate(shutdown.promise, { timeout: 60_000, signal }, "shutdown"),
    cleanup: async () => {
        const failures = [];
        try {
            await mounted?.unmount();
        } catch (error) {
            failures.push(error);
        }
        try {
            await server?.close();
        } catch (error) {
            failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(
                failures,
                "Readable-first native smoke cleanup failed"
            );
        }
    },
    onMounted: (ready) => {
        if (ready) {
            throw new Error(
                "Readable-first native smoke unexpectedly mounted writable"
            );
        }
    },
    onWritePending: () => pending.resolve(),
    onWriteReady: () => writable.resolve(),
});

let primaryFailure;
try {
    await withTimeout(
        pending.promise,
        "the native mount to enter read-only mode"
    );

    const seedPath = path.join(mountpoint, "seed.txt");
    const contents = await withTimeout(
        readFile(seedPath, "utf8"),
        "the early native read syscall"
    );
    if (contents !== "readable before write readiness") {
        throw new Error(
            `Unexpected early native read: ${JSON.stringify(contents)}`
        );
    }

    const blockedPath = path.join(mountpoint, "blocked-before-ready");
    let blockedError;
    try {
        await withTimeout(
            mkdir(blockedPath),
            "the early native mkdir syscall to return"
        );
    } catch (error) {
        blockedError = error;
    }
    if (blockedError?.code !== expectedBlockedCode) {
        const received =
            blockedError == null
                ? "success"
                : (blockedError.code ??
                  `${blockedError.name}: ${blockedError.message}`);
        throw new Error(
            `Expected early native mkdir to fail with ${expectedBlockedCode}, received ${received}`,
            { cause: blockedError }
        );
    }
    if (mkdirCalls !== 0) {
        throw new Error(
            `Blocked native mutation reached the target ${mkdirCalls} time(s)`
        );
    }

    writeReady = true;
    readiness.resolve();
    await withTimeout(writable.promise, "the native mount to become writable");

    const writablePath = path.join(mountpoint, "created-after-ready");
    await withTimeout(
        mkdir(writablePath),
        "the post-readiness native mkdir syscall"
    );
    const created = await withTimeout(
        stat(writablePath),
        "the post-readiness native stat syscall"
    );
    if (!created.isDirectory() || mkdirCalls !== 1) {
        throw new Error(
            `Post-readiness native mkdir was not committed exactly once (calls=${mkdirCalls})`
        );
    }
} catch (error) {
    primaryFailure = error;
} finally {
    // Never open the write gate merely to tear the smoke down: a timed-out
    // kernel request could otherwise cross the gate while cleanup is running.
    shutdown.resolve();
}

let lifecycleFailure;
try {
    await withTimeout(lifecycle, "readable-first native mount cleanup", 30_000);
} catch (error) {
    lifecycleFailure = error;
}

if (
    adapterChild &&
    adapterChild.pid != null &&
    adapterChild.exitCode == null &&
    adapterChild.signalCode == null
) {
    const stillRunning = new Error(
        `Native adapter process ${adapterChild.pid ?? "unknown"} remained alive after readable-first cleanup; awaiting wrapper process-tree teardown`
    );
    lifecycleFailure = lifecycleFailure
        ? new AggregateError(
              [lifecycleFailure, stillRunning],
              "Readable-first cleanup left its native adapter running"
          )
        : stillRunning;
    console.error(lifecycleFailure);
    // Throwing now would let Node orphan the child. Both native wrappers own a
    // bounded process-tree fallback, so remain its parent until it exits or the
    // wrapper terminates the complete tree.
    await new Promise((resolve) => {
        const onExit = () => resolve();
        adapterChild.once("exit", onExit);
        // The process can exit between the state check above and listener
        // registration. Re-check after subscribing so that event cannot be
        // missed and leave the smoke waiting for its outer watchdog.
        if (adapterChild.exitCode != null || adapterChild.signalCode != null) {
            adapterChild.off("exit", onExit);
            resolve();
        }
    });
}
process.off("SIGINT", requestShutdown);
process.off("SIGTERM", requestShutdown);

if (primaryFailure && lifecycleFailure) {
    throw new AggregateError(
        [primaryFailure, lifecycleFailure],
        "Readable-first native smoke and cleanup both failed"
    );
}
if (primaryFailure) throw primaryFailure;
if (lifecycleFailure) throw lifecycleFailure;

console.log(
    `Readable-first native smoke passed: early read, ${expectedBlockedCode} write gate, writable transition, and cleanup.`
);
