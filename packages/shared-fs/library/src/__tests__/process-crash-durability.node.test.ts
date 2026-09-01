import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { decodePublicSignKey, openSharedFs } from "../index.js";
import type {
    MultiWriterProcessCrashCheckpoint,
    ProcessCrashCheckpoint,
    ProcessCrashWorkerMessage,
} from "./process-crash-durability.protocol.js";
import { patternedBytes } from "./process-crash-durability.protocol.js";

const WAIT_TIMEOUT_MS = process.env.CI ? 240_000 : 90_000;
const TEST_TIMEOUT_MS = process.env.CI ? 360_000 : 180_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const workerPath = fileURLToPath(
    new URL("./process-crash-durability.worker.ts", import.meta.url)
);

type RunningWorker = {
    child: ChildProcess;
    closed: Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
    }>;
    diagnostics(): string;
};

const bytesEqual = (left: Uint8Array | undefined, right: Uint8Array) =>
    !!left && Buffer.from(left).equals(Buffer.from(right));

const withTimeout = <T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
) =>
    new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });

const startWorker = (
    scenario: ProcessCrashCheckpoint["scenario"],
    root: string
): RunningWorker => {
    const child = fork(workerPath, [scenario, root], {
        execArgv: ["--enable-source-maps", "--import", "tsx"],
        env: { ...process.env, NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
    });
    let output = "";
    const append = (chunk: unknown) => {
        output += Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : String(chunk);
        if (output.length > MAX_DIAGNOSTIC_BYTES) {
            output = output.slice(-MAX_DIAGNOSTIC_BYTES);
        }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    return {
        child,
        // Register at spawn time so cleanup can always wait for descriptor
        // closure, including the narrow exit-before-cleanup case on Windows.
        closed: new Promise((resolve) =>
            child.once("close", (code, signal) => resolve({ code, signal }))
        ),
        diagnostics: () => output.trim(),
    };
};

const waitForCheckpoint = async <
    Scenario extends ProcessCrashCheckpoint["scenario"],
>(
    worker: RunningWorker,
    scenario: Scenario
): Promise<Extract<ProcessCrashCheckpoint, { scenario: Scenario }>> => {
    const checkpoint = new Promise<
        Extract<ProcessCrashCheckpoint, { scenario: Scenario }>
    >((resolve, reject) => {
        const child = worker.child;
        const cleanup = () => {
            child.off("message", onMessage);
            child.off("error", onError);
            child.off("close", onClose);
        };
        const fail = (message: string) => {
            cleanup();
            const diagnostics = worker.diagnostics();
            reject(
                new Error(
                    diagnostics
                        ? `${message}\nWorker output:\n${diagnostics}`
                        : message
                )
            );
        };
        const onMessage = (raw: unknown) => {
            const message = raw as ProcessCrashWorkerMessage;
            if (message?.type === "fatal") {
                fail(
                    `Crash worker failed: ${message.message}${
                        message.stack ? `\n${message.stack}` : ""
                    }`
                );
                return;
            }
            if (
                message?.type === "checkpoint" &&
                message.scenario === scenario
            ) {
                cleanup();
                resolve(
                    message as Extract<
                        ProcessCrashCheckpoint,
                        { scenario: Scenario }
                    >
                );
            }
        };
        const onError = (error: Error) =>
            fail(`Crash worker process error: ${error.message}`);
        const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
            fail(
                `Crash worker exited before checkpoint (code=${String(code)}, signal=${String(signal)})`
            );
        child.on("message", onMessage);
        child.once("error", onError);
        child.once("close", onClose);
    });
    return withTimeout(
        checkpoint,
        WAIT_TIMEOUT_MS,
        `Timed out waiting for ${scenario} crash checkpoint`
    );
};

const killAbruptly = async (worker: RunningWorker) => {
    const child = worker.child;
    expect(child.kill("SIGKILL")).toBe(true);
    const result = await withTimeout(
        worker.closed,
        30_000,
        "Crash worker did not close after SIGKILL"
    );
    if (process.platform !== "win32") {
        expect(result.signal).toBe("SIGKILL");
    }
    return result;
};

// Cleanup is part of this harness's isolation guarantee. Do not suppress the
// historical DocumentIndex `clearAll` teardown race: Peerbit.stop() performs
// storage, indexer, and libp2p shutdown only after program shutdown succeeds,
// so swallowing that rejection could leave resources live while the backing
// directory is removed. Failed peers remain tracked and are retried by
// afterEach; directory cleanup proceeds only after every stop has succeeded.
const stopPeer = (peer: Peerbit) => peer.stop();

const verifyOfflineCustodian = async (
    checkpoint: MultiWriterProcessCrashCheckpoint,
    peer: Peerbit,
    expectedIdentity: string
) => {
    expect(peer.identity.publicKey.hashcode()).toBe(expectedIdentity);
    const fs = await openSharedFs({
        peerbit: peer,
        address: checkpoint.address,
        machineLabel: `offline-after-sigkill-${expectedIdentity.slice(0, 8)}`,
        replicate: false,
        bootstrap: false,
        remoteChunkFetch: false,
        gc: false,
    });
    expect(fs.accessControlled).toBe(true);
    for (const publicKey of checkpoint.publicKeys) {
        expect(await fs.isTrustedWriter(decodePublicSignKey(publicKey))).toBe(
            true
        );
    }
    for (const file of checkpoint.files) {
        expect(
            bytesEqual(
                await fs.readFile(file.path),
                patternedBytes(file.seed, file.length)
            )
        ).toBe(true);
    }

    const status = await fs.awaitChangeset(checkpoint.changeset.id, {
        manifestId: checkpoint.changeset.manifestId,
        timeoutMs: WAIT_TIMEOUT_MS,
    });
    expect(status).toMatchObject({
        complete: true,
        verdict: "complete",
        expected: checkpoint.changeset.memberCount,
        arrived: checkpoint.changeset.memberCount,
    });

    const conflicts = await fs.conflicts(checkpoint.conflict.path);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].versions.map((version) => version.id).sort()).toEqual(
        checkpoint.conflict.heads.map((head) => head.versionId).sort()
    );
    for (const head of checkpoint.conflict.heads) {
        expect(
            bytesEqual(
                await fs.readVersion(checkpoint.conflict.path, head.versionId),
                patternedBytes(head.seed, head.length)
            )
        ).toBe(true);
    }
};

describe("shared fs process-crash durability", () => {
    const workers = new Set<RunningWorker>();
    const peers = new Set<Peerbit>();
    const temporaryDirectories = new Set<string>();

    afterEach(async () => {
        const workerStops = await Promise.allSettled(
            [...workers].map(async (worker) => {
                const child = worker.child;
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill("SIGKILL");
                }
                await withTimeout(
                    worker.closed,
                    30_000,
                    "Crash worker cleanup timed out"
                );
                workers.delete(worker);
            })
        );
        const failedWorkerStop = workerStops.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        );
        const stopped = await Promise.allSettled(
            [...peers].map(async (peer) => {
                await stopPeer(peer);
                peers.delete(peer);
            })
        );
        const failedStop = stopped.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        );
        // Never remove a backing directory until every process and in-process
        // Peerbit instance that could own it has confirmed closure.
        if (failedWorkerStop) throw failedWorkerStop.reason;
        if (failedStop) throw failedStop.reason;
        const removed = await Promise.allSettled(
            [...temporaryDirectories].map((directory) =>
                rm(directory, { recursive: true, force: true })
            )
        );
        const failedRemoval = removed.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        );
        if (failedRemoval) throw failedRemoval.reason;
        temporaryDirectories.clear();
    });

    it(
        "recovers a mounted write after fsync without release or graceful shutdown",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
            const root = await mkdtemp(
                join(tmpdir(), "peerbit-shared-fs-fsync-sigkill-")
            );
            temporaryDirectories.add(root);
            const worker = startWorker("fsync", root);
            workers.add(worker);
            const checkpoint = await waitForCheckpoint(worker, "fsync");
            await killAbruptly(worker);
            workers.delete(worker);

            const reopenStartedAt = performance.now();
            const peer = await Peerbit.create({
                directory: join(root, "local-fsync"),
            });
            peers.add(peer);
            expect(peer.identity.publicKey.hashcode()).toBe(
                checkpoint.identity
            );
            const fs = await openSharedFs({
                peerbit: peer,
                address: checkpoint.address,
                machineLabel: "offline-fsync-reopen",
                replicate: false,
                bootstrap: false,
                remoteChunkFetch: false,
                gc: false,
            });
            expect(
                bytesEqual(
                    await fs.readFile(checkpoint.file.path),
                    patternedBytes(checkpoint.file.seed, checkpoint.file.length)
                )
            ).toBe(true);
            const reopenMs = performance.now() - reopenStartedAt;
            console.log(
                "process-crash-fsync:",
                JSON.stringify({
                    payloadBytes: checkpoint.file.length,
                    fsyncMs: Number(checkpoint.fsyncMs.toFixed(1)),
                    offlineReopenMs: Number(reopenMs.toFixed(1)),
                })
            );
            await stopPeer(peer);
            peers.delete(peer);
        }
    );

    it(
        "reopens both acknowledged custodians after every replica is killed and the source is deleted",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
            const root = await mkdtemp(
                join(tmpdir(), "peerbit-shared-fs-disposal-sigkill-")
            );
            temporaryDirectories.add(root);
            const worker = startWorker("multi-writer-disposal", root);
            workers.add(worker);
            const checkpoint = await waitForCheckpoint(
                worker,
                "multi-writer-disposal"
            );
            expect(checkpoint.disposal).toMatchObject({
                safeToDispose: true,
                guarantee: "persisted-per-entry",
                minAcksPerEntry: 2,
                empty: false,
            });
            expect(checkpoint.disposal.entryCount).toBeGreaterThan(0);
            expect(checkpoint.disposal.entries.chunks).toBeGreaterThan(1);
            expect(checkpoint.disposal.entries.versions).toBeGreaterThan(1);
            expect(checkpoint.disposal.entries.naming).toBeGreaterThan(1);
            expect(checkpoint.disposal.entries.trust).toBeGreaterThan(1);

            await killAbruptly(worker);
            workers.delete(worker);
            // This is the disposable writer whose minAcks=2 barrier named the
            // other two replicas as the only possible remote quorum.
            await rm(join(root, "disposable-writer"), {
                recursive: true,
                force: true,
            });

            const reopenTimesMs: number[] = [];
            for (const [index, directoryName] of [
                "owner",
                "writer-two",
            ].entries()) {
                const startedAt = performance.now();
                const peer = await Peerbit.create({
                    directory: join(root, directoryName),
                });
                peers.add(peer);
                await verifyOfflineCustodian(
                    checkpoint,
                    peer,
                    checkpoint.identities[index]
                );
                reopenTimesMs.push(performance.now() - startedAt);
                await stopPeer(peer);
                peers.delete(peer);
            }

            console.log(
                "process-crash-disposal:",
                JSON.stringify({
                    ...checkpoint.timings,
                    entryCount: checkpoint.disposal.entryCount,
                    receiptBatches: checkpoint.disposal.receiptBatches,
                    offlineCustodianReopenMs: reopenTimesMs.map((value) =>
                        Number(value.toFixed(1))
                    ),
                })
            );
        }
    );
});
