import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SharedFileSystem } from "../index.js";
import type {
    SegmentLedgerCrashCheckpoint,
    SegmentLedgerCrashScenario,
    SegmentLedgerCrashWorkerMessage,
} from "./segment-ledger-crash.protocol.js";

const WAIT_TIMEOUT_MS = process.env.CI ? 60_000 : 30_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const workerPath = fileURLToPath(
    new URL("./segment-ledger-crash.worker.ts", import.meta.url)
);

type RunningWorker = {
    child: ChildProcess;
    closed: Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
    }>;
    diagnostics(): string;
};

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
    scenario: SegmentLedgerCrashScenario,
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
        closed: new Promise((resolve) =>
            child.once("close", (code, signal) => resolve({ code, signal }))
        ),
        diagnostics: () => output.trim(),
    };
};

const waitForCheckpoint = (
    worker: RunningWorker,
    scenario: SegmentLedgerCrashScenario
) => {
    const checkpoint = new Promise<SegmentLedgerCrashCheckpoint>(
        (resolve, reject) => {
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
                const message = raw as SegmentLedgerCrashWorkerMessage;
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
                    resolve(message);
                }
            };
            const onError = (error: Error) =>
                fail(`Crash worker process error: ${error.message}`);
            const onClose = (
                code: number | null,
                signal: NodeJS.Signals | null
            ) =>
                fail(
                    `Crash worker exited before checkpoint (code=${String(code)}, signal=${String(signal)})`
                );
            child.on("message", onMessage);
            child.once("error", onError);
            child.once("close", onClose);
        }
    );
    return withTimeout(
        checkpoint,
        WAIT_TIMEOUT_MS,
        `Timed out waiting for ${scenario} crash checkpoint`
    );
};

const killAbruptly = async (worker: RunningWorker) => {
    expect(worker.child.kill("SIGKILL")).toBe(true);
    const result = await withTimeout(
        worker.closed,
        30_000,
        "Segment-ledger crash worker did not close after SIGKILL"
    );
    if (process.platform !== "win32") {
        expect(result.signal).toBe("SIGKILL");
    }
};

const ledger = (cids: string[], generation: number) => ({
    v: 1,
    generation,
    current: null,
    retired: cids.map((cid, index) => ({
        cids: [{ cid, bytes: cid.length }],
        retiredAtMs: index + 1,
        snapshotSeq: `${index + 1}`,
    })),
});

const ledgerCids = (value: any) =>
    value.retired
        .flatMap((generation: any) => generation.cids)
        .map((entry: any) => entry.cid)
        .sort();

const recoveryProgram = (
    ledgerPath: string,
    runtime: Record<string, unknown> = {}
) => {
    const program: any = new SharedFileSystem();
    program.segmentLedgerPath = async () => ledgerPath;
    program.setSegmentLedgerRuntimeForTest(runtime);
    return program;
};

describe("snapshot segment ledger process-crash recovery", () => {
    const workers = new Set<RunningWorker>();
    const temporaryDirectories = new Set<string>();

    afterEach(async () => {
        await Promise.all(
            [...workers].map(async (worker) => {
                if (
                    worker.child.exitCode === null &&
                    worker.child.signalCode === null
                ) {
                    worker.child.kill("SIGKILL");
                }
                await withTimeout(
                    worker.closed,
                    30_000,
                    "Segment-ledger crash worker cleanup timed out"
                );
                workers.delete(worker);
            })
        );
        await Promise.all(
            [...temporaryDirectories].map(async (directory) => {
                await rm(directory, {
                    recursive: true,
                    force: true,
                    maxRetries: 5,
                    retryDelay: 100,
                });
                temporaryDirectories.delete(directory);
            })
        );
    });

    const crashAt = async (scenario: SegmentLedgerCrashScenario) => {
        const root = await mkdtemp(join(tmpdir(), "sfs-segment-ledger-crash-"));
        temporaryDirectories.add(root);
        const worker = startWorker(scenario, root);
        workers.add(worker);
        const checkpoint = await waitForCheckpoint(worker, scenario);
        await killAbruptly(worker);
        workers.delete(worker);
        return checkpoint;
    };

    it("ignores a durable orphan candidate and claims the fixed lock immediately", async () => {
        const checkpoint = await crashAt("lock-candidate-durable");
        expect(await stat(checkpoint.artifactPath)).toBeDefined();
        await expect(
            stat(`${checkpoint.ledgerPath}.lock`)
        ).rejects.toMatchObject({ code: "ENOENT" });

        const recovery = recoveryProgram(checkpoint.ledgerPath);
        const release = await recovery.acquireSegmentLedgerLock(
            checkpoint.ledgerPath
        );
        await release();
        expect(
            (await readdir(dirname(checkpoint.ledgerPath))).some((name) =>
                name.includes(".candidate-")
            )
        ).toBe(true);
    });

    it("keeps the old ledger authoritative after a temp-durable crash", async () => {
        const checkpoint = await crashAt("ledger-temp-durable");
        const before = JSON.parse(
            await readFile(checkpoint.ledgerPath, "utf8")
        );
        expect(before.generation).toBe(1);
        expect(ledgerCids(before)).toEqual(["baseline"]);
        expect(await stat(checkpoint.artifactPath)).toBeDefined();

        const ownerPath = join(`${checkpoint.ledgerPath}.lock`, "owner.json");
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        const ownerStat = await stat(ownerPath);
        const lastOwnedAtMs = Math.max(owner.createdAtMs, ownerStat.mtimeMs);
        const earlyWallNow = lastOwnedAtMs + 20_000;
        let earlyMonotonicNow = 0;
        const earlyRetry = recoveryProgram(checkpoint.ledgerPath, {
            wallClockMs: () => earlyWallNow,
            monotonicMs: () => earlyMonotonicNow,
            isProcessAlive: () => false,
            waitForRetry: async () => {
                earlyMonotonicNow += 5_000;
            },
        });
        await expect(
            earlyRetry.saveSegmentLedgerCas(
                1,
                ledger(["baseline", "too-early"], 1)
            )
        ).rejects.toMatchObject({ code: "EIO" });
        expect(
            ledgerCids(
                JSON.parse(await readFile(checkpoint.ledgerPath, "utf8"))
            )
        ).toEqual(["baseline"]);

        const recovery = recoveryProgram(checkpoint.ledgerPath, {
            wallClockMs: () => lastOwnedAtMs + 30_000,
            isProcessAlive: () => false,
        });
        await expect(
            recovery.saveSegmentLedgerCas(
                1,
                ledger(["baseline", "recovery"], 1)
            )
        ).resolves.toBe(true);
        const after = JSON.parse(await readFile(checkpoint.ledgerPath, "utf8"));
        expect(after.generation).toBe(2);
        expect(ledgerCids(after)).toEqual(["baseline", "recovery"]);
    });

    it("preserves a directory-durable replacement and merges the next writer", async () => {
        const checkpoint = await crashAt("ledger-directory-durable");
        const committed = JSON.parse(
            await readFile(checkpoint.ledgerPath, "utf8")
        );
        expect(committed.generation).toBe(2);
        expect(ledgerCids(committed)).toEqual(["baseline", "crash-write"]);

        const ownerPath = join(`${checkpoint.ledgerPath}.lock`, "owner.json");
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        const ownerStat = await stat(ownerPath);
        const recovery = recoveryProgram(checkpoint.ledgerPath, {
            wallClockMs: () =>
                Math.max(owner.createdAtMs, ownerStat.mtimeMs) + 30_000,
            isProcessAlive: () => false,
        });
        await expect(
            recovery.saveSegmentLedgerCas(
                1,
                ledger(["baseline", "recovery"], 1)
            )
        ).resolves.toBe(true);
        const after = JSON.parse(await readFile(checkpoint.ledgerPath, "utf8"));
        expect(after.generation).toBe(3);
        expect(ledgerCids(after)).toEqual([
            "baseline",
            "crash-write",
            "recovery",
        ]);
    });

    it("leaves the fixed name free after a release-detached crash", async () => {
        const checkpoint = await crashAt("lock-release-detached");
        await expect(
            stat(`${checkpoint.ledgerPath}.lock`)
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(await stat(checkpoint.artifactPath)).toBeDefined();
        const committed = JSON.parse(
            await readFile(checkpoint.ledgerPath, "utf8")
        );
        expect(committed.generation).toBe(2);

        const recovery = recoveryProgram(checkpoint.ledgerPath);
        await expect(
            recovery.saveSegmentLedgerCas(
                2,
                ledger(["baseline", "crash-write", "recovery"], 2)
            )
        ).resolves.toBe(true);
        const after = JSON.parse(await readFile(checkpoint.ledgerPath, "utf8"));
        expect(after.generation).toBe(3);
        expect(ledgerCids(after)).toEqual([
            "baseline",
            "crash-write",
            "recovery",
        ]);
        expect(await stat(checkpoint.artifactPath)).toBeDefined();
    });
});
