import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
    ProcessSoakBatchResult,
    ProcessSoakContentLedger,
    ProcessSoakConflictWriteResult,
    ProcessSoakEditorFsyncCheckpointResult,
    ProcessSoakEditorResult,
    ProcessSoakFileExpectation,
    ProcessSoakGcResult,
    ProcessSoakMetrics,
    ProcessSoakMemoryCalibration,
    ProcessSoakMemorySnapshot,
    ProcessSoakMountRenameResult,
    ProcessSoakNetworkStatus,
    ProcessSoakOpenResult,
    ProcessSoakReadyMessage,
    ProcessSoakRequestedGcMetricsResult,
    ProcessSoakRuntimeMetrics,
    ProcessSoakShutdownResult,
    ProcessSoakSnapshotWriteResult,
    ProcessSoakStoragePhaseName,
    ProcessSoakStoragePhaseReport,
    ProcessSoakTreeExpectation,
    ProcessSoakVerifyResult,
    ProcessSoakWorkerCommand,
    ProcessSoakWorkerMessage,
} from "./process-isolated-soak.bench.protocol.js";
import { createProcessSoakGeneratedContent } from "./process-isolated-soak.bench.payload.js";
import {
    aggregateProcessSoakStorageSnapshots,
    scanProcessSoakStateDirectory,
} from "./process-isolated-soak-storage.js";

const soakEnabled = process.env.PEERBIT_SHARED_FS_PROCESS_ISOLATED_SOAK === "1";
const longChurnEnabled =
    process.env.PEERBIT_SHARED_FS_PROCESS_LONG_CHURN === "1";
const manualDescribe =
    soakEnabled || longChurnEnabled ? describe : describe.skip;
const soakIt = soakEnabled ? it : it.skip;
const longChurnIt = longChurnEnabled ? it : it.skip;
const COMMAND_TIMEOUT_MS = process.env.CI ? 240_000 : 180_000;
const RESPONSE_MARGIN_MS = 15_000;
const REQUEST_TIMEOUT_MS = COMMAND_TIMEOUT_MS + RESPONSE_MARGIN_MS;
const TEST_TIMEOUT_MS = 30 * 60_000;
const LONG_CHURN_TEST_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const workerPath = fileURLToPath(
    new URL("./process-isolated-soak.bench.worker.ts", import.meta.url)
);

type CommandInput<T> = T extends { requestId: string }
    ? Omit<T, "requestId">
    : never;
type ProcessSoakCommandInput = CommandInput<ProcessSoakWorkerCommand>;

type RunningWorker = {
    index: number;
    generation: number;
    directory: string;
    networkMode: "online" | "offline";
    child: ChildProcess;
    ready: Promise<ProcessSoakReadyMessage>;
    closed: Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
    }>;
    request<T>(
        command: ProcessSoakCommandInput,
        timeoutMs?: number
    ): Promise<T>;
    diagnostics(): string;
    hasClosed(): boolean;
};

type ProcessSoakStopResult = {
    code: number | null;
    signal: NodeJS.Signals | null;
    shutdown?: ProcessSoakShutdownResult;
};

type CapturedProcessSoakShutdownResult = Extract<
    ProcessSoakShutdownResult,
    { captured: true }
>;

let nextWorkerGeneration = 0;

const configuredRounds = () => {
    const rounds = Number(
        process.env.PEERBIT_SHARED_FS_PROCESS_ISOLATED_SOAK_ROUNDS ?? 30
    );
    if (
        !Number.isInteger(rounds) ||
        (rounds !== 1 && (rounds < 10 || rounds > 200))
    ) {
        throw new Error(
            "PEERBIT_SHARED_FS_PROCESS_ISOLATED_SOAK_ROUNDS must be 1 for a harness smoke or an integer from 10 through 200"
        );
    }
    return rounds;
};

const configuredPayloadBytes = () => {
    const bytes = Number(
        process.env.PEERBIT_SHARED_FS_PROCESS_ISOLATED_SOAK_PAYLOAD_BYTES ??
            4_096
    );
    if (!Number.isInteger(bytes) || bytes < 256 || bytes > 1024 * 1024) {
        throw new Error(
            "PEERBIT_SHARED_FS_PROCESS_ISOLATED_SOAK_PAYLOAD_BYTES must be an integer from 256 through 1048576"
        );
    }
    return bytes;
};

const configuredLongChurnInteger = (
    name: string,
    fallback: number,
    options: { smoke: number; minimum: number; maximum: number }
) => {
    const value = Number(process.env[name] ?? fallback);
    if (
        !Number.isInteger(value) ||
        (value !== options.smoke &&
            (value < options.minimum || value > options.maximum))
    ) {
        throw new Error(
            `${name} must be ${options.smoke} for a harness smoke or an integer from ${options.minimum} through ${options.maximum}`
        );
    }
    return value;
};

const configuredLongChurnJoins = () =>
    configuredLongChurnInteger(
        "PEERBIT_SHARED_FS_PROCESS_LONG_CHURN_JOINS",
        10,
        {
            smoke: 1,
            minimum: 10,
            maximum: 20,
        }
    );

const configuredLongChurnRounds = () =>
    configuredLongChurnInteger(
        "PEERBIT_SHARED_FS_PROCESS_LONG_CHURN_ROUNDS",
        10,
        { smoke: 1, minimum: 10, maximum: 200 }
    );

const configuredLongChurnHotVersions = () =>
    configuredLongChurnInteger(
        "PEERBIT_SHARED_FS_PROCESS_LONG_CHURN_HOT_VERSIONS",
        15,
        { smoke: 5, minimum: 15, maximum: 100 }
    );

const configuredLongChurnPayloadBytes = () => {
    const bytes = Number(
        process.env.PEERBIT_SHARED_FS_PROCESS_LONG_CHURN_PAYLOAD_BYTES ?? 4_096
    );
    if (!Number.isInteger(bytes) || bytes < 256 || bytes > 1024 * 1024) {
        throw new Error(
            "PEERBIT_SHARED_FS_PROCESS_LONG_CHURN_PAYLOAD_BYTES must be an integer from 256 through 1048576"
        );
    }
    return bytes;
};

const percentile = (values: number[], ratio: number) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
};

const distribution = (values: number[]) => ({
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Math.max(...values),
});

const requiredSharedLogOpenProfileNames = [
    "sharedLog.open.localState",
    "sharedLog.open.blockStore",
    "sharedLog.open.remoteBlocks",
    "sharedLog.open.lowerLog",
    "sharedLog.open.rpcSubscriptions",
    "sharedLog.open.providerAndOwnership",
    "sharedLog.open.replication",
    "sharedLog.open.synchronizer",
    "sharedLog.open.total",
] as const;

const isReportedSharedLogOpenProfile = (name: string) =>
    name.startsWith("sharedLog.open.") ||
    name === "sharedLog.blocks.resolveProviders";

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
    index: number,
    directory: string,
    options: { offline?: boolean } = {}
): RunningWorker => {
    const networkMode = options.offline ? "offline" : "online";
    const generation = ++nextWorkerGeneration;
    const child = fork(
        workerPath,
        [String(index), directory, networkMode, String(generation)],
        {
            execArgv: [
                "--expose-gc",
                "--enable-source-maps",
                "--import",
                "tsx",
            ],
            env: { ...process.env, NODE_ENV: "test" },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        }
    );
    let output = "";
    let nextRequest = 0;
    let readySettled = false;
    const pending = new Map<
        string,
        {
            resolve(value: unknown): void;
            reject(error: Error): void;
            timer: NodeJS.Timeout;
        }
    >();
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

    let resolveReady!: (message: ProcessSoakReadyMessage) => void;
    let rejectReady!: (error: Error) => void;
    const rawReady = new Promise<ProcessSoakReadyMessage>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    const diagnostics = () => output.trim();
    const decoratedError = (message: string, stack?: string) => {
        const captured = diagnostics();
        const error = new Error(
            captured ? `${message}\nWorker output:\n${captured}` : message
        );
        if (stack) error.stack = `${error.stack}\nWorker stack:\n${stack}`;
        return error;
    };
    const failReady = (error: Error) => {
        if (readySettled) return;
        readySettled = true;
        rejectReady(error);
    };
    const failPending = (error: Error) => {
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        pending.clear();
    };

    let resolveClosed!: (value: {
        code: number | null;
        signal: NodeJS.Signals | null;
    }) => void;
    const closed = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
    }>((resolve) => {
        resolveClosed = resolve;
    });
    let closeConfirmed = false;
    child.once("close", (code, signal) => {
        closeConfirmed = true;
        resolveClosed({ code, signal });
        const error = decoratedError(
            `Process soak worker ${index} closed (code=${String(code)}, signal=${String(signal)})`
        );
        failReady(error);
        failPending(error);
    });
    child.once("error", (error) => {
        const decorated = decoratedError(
            `Process soak worker ${index} failed: ${error.message}`
        );
        failReady(decorated);
        failPending(decorated);
    });
    child.on("message", (raw: unknown) => {
        const message = raw as ProcessSoakWorkerMessage;
        if (message?.type === "ready") {
            if (!readySettled) {
                readySettled = true;
                resolveReady(message);
            }
            return;
        }
        if (message?.type === "fatal") {
            const error = decoratedError(
                `Process soak worker ${index} failed: ${message.message}`,
                message.stack
            );
            failReady(error);
            failPending(error);
            return;
        }
        if (message?.type !== "response") return;
        const request = pending.get(message.requestId);
        if (!request) return;
        pending.delete(message.requestId);
        clearTimeout(request.timer);
        if (message.ok) {
            request.resolve(message.value);
        } else {
            request.reject(
                decoratedError(
                    `Process soak worker ${index} command failed: ${message.error.message}`,
                    message.error.stack
                )
            );
        }
    });

    const ready = withTimeout(
        rawReady,
        REQUEST_TIMEOUT_MS,
        `Timed out waiting for process soak worker ${index}`
    ).catch((error) => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
        }
        throw error;
    });

    const running: RunningWorker = {
        index,
        generation,
        directory,
        networkMode,
        child,
        ready,
        closed,
        diagnostics,
        hasClosed: () => closeConfirmed,
        request<T>(
            command: ProcessSoakCommandInput,
            timeoutMs = REQUEST_TIMEOUT_MS
        ) {
            if (child.exitCode !== null || child.signalCode !== null) {
                return Promise.reject(
                    decoratedError(
                        `Process soak worker ${index} is not running`
                    )
                );
            }
            const requestId = `${index}-${++nextRequest}`;
            return new Promise<T>((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(requestId);
                    if (child.exitCode === null && child.signalCode === null) {
                        child.kill("SIGKILL");
                    }
                    reject(
                        decoratedError(
                            `Process soak worker ${index} command ${command.type} timed out after ${timeoutMs} ms`
                        )
                    );
                }, timeoutMs);
                pending.set(requestId, {
                    resolve: (value) => resolve(value as T),
                    reject,
                    timer,
                });
                child.send({ ...command, requestId }, (error) => {
                    if (!error) return;
                    const request = pending.get(requestId);
                    if (!request) return;
                    pending.delete(requestId);
                    clearTimeout(request.timer);
                    reject(
                        decoratedError(
                            `Could not send ${command.type} to process soak worker ${index}: ${error.message}`
                        )
                    );
                });
            });
        },
    };
    return running;
};

const isRunning = (worker: RunningWorker) =>
    worker.child.exitCode === null && worker.child.signalCode === null;

const stopWorker = async (
    worker: RunningWorker,
    options: { captureMetrics?: boolean; requestGcAfterStop?: boolean } = {}
): Promise<ProcessSoakStopResult> => {
    if (!isRunning(worker)) return worker.closed;
    let shutdown: ProcessSoakShutdownResult;
    try {
        shutdown = await worker.request<ProcessSoakShutdownResult>(
            {
                type: "shutdown",
                captureMetrics: options.captureMetrics,
                requestGcAfterStop: options.requestGcAfterStop,
            },
            options.requestGcAfterStop ? REQUEST_TIMEOUT_MS : 30_000
        );
    } catch (error) {
        if (isRunning(worker)) worker.child.kill("SIGKILL");
        await withTimeout(
            worker.closed,
            30_000,
            `Process soak worker ${worker.index} did not close after failed shutdown`
        );
        throw error;
    }
    const closed = await withTimeout(
        worker.closed,
        30_000,
        `Process soak worker ${worker.index} did not close after shutdown`
    );
    return { ...closed, shutdown };
};

const killWorker = async (worker: RunningWorker) => {
    if (!isRunning(worker)) return worker.closed;
    expect(worker.child.kill("SIGKILL")).toBe(true);
    const closed = await withTimeout(
        worker.closed,
        30_000,
        `Process soak worker ${worker.index} did not close after SIGKILL`
    );
    if (process.platform !== "win32") expect(closed.signal).toBe("SIGKILL");
    return closed;
};

const dialAddress = (ready: ProcessSoakReadyMessage) => {
    const address = ready.addresses.find(
        (candidate) => !candidate.includes("/p2p-circuit")
    );
    if (!address) {
        throw new Error(`Worker ${ready.worker} reported no dialable address`);
    }
    return address;
};

const processForWorker = async (
    worker: RunningWorker
): Promise<ProcessSoakReadyMessage["process"]> => {
    const ready = await worker.ready;
    expect(ready.process).toEqual({
        worker: worker.index,
        generation: worker.generation,
        pid: worker.child.pid,
        identity: ready.identity,
        networkMode: worker.networkMode,
    });
    return ready.process;
};

const openStoragePhase = async (
    phase: ProcessSoakStoragePhaseName,
    workers: RunningWorker[],
    metrics: ProcessSoakMetrics[]
): Promise<ProcessSoakStoragePhaseReport> => {
    expect(metrics).toHaveLength(workers.length);
    const expectedProcesses = await Promise.all(
        workers.map((worker) => processForWorker(worker))
    );
    const samples = metrics.map((sample, index) => {
        expect(sample.process).toEqual(expectedProcesses[index]);
        return {
            process: sample.process,
            stateDirectory: workers[index].directory,
            storage: sample.storage,
        };
    });
    return {
        phase,
        lifecycle: "worker-open",
        samples,
        fleet: aggregateProcessSoakStorageSnapshots(
            samples.map((sample) => sample.storage)
        ),
    };
};

const closedStoragePhase = async (
    phase: ProcessSoakStoragePhaseName,
    workers: RunningWorker[],
    stops: ProcessSoakStopResult[]
): Promise<ProcessSoakStoragePhaseReport> => {
    expect(stops).toHaveLength(workers.length);
    const samples = await Promise.all(
        workers.map(async (worker, index) => {
            expect(stops[index].code).toBe(0);
            expect(stops[index].signal).toBeNull();
            expect(worker.hasClosed()).toBe(true);
            return {
                process: await processForWorker(worker),
                stateDirectory: worker.directory,
                storage: await scanProcessSoakStateDirectory(worker.directory),
            };
        })
    );
    return {
        phase,
        lifecycle: "parent-after-confirmed-clean-close",
        samples,
        fleet: aggregateProcessSoakStorageSnapshots(
            samples.map((sample) => sample.storage)
        ),
    };
};

const expectedContentBytes = (
    content: ProcessSoakFileExpectation["content"]
) =>
    typeof content === "string"
        ? Buffer.byteLength(content)
        : Buffer.byteLength(content.prefix) + content.bytes;

const contentLedger = (
    baseline: { operations: number; bytes: number },
    total: { operations: number; bytes: number },
    finalFiles: Iterable<ProcessSoakFileExpectation>
): ProcessSoakContentLedger => {
    expect(total.operations).toBeGreaterThanOrEqual(baseline.operations);
    expect(total.bytes).toBeGreaterThanOrEqual(baseline.bytes);
    const files = [...finalFiles];
    return {
        submitted: {
            baseline,
            measured: {
                operations: total.operations - baseline.operations,
                bytes: total.bytes - baseline.bytes,
            },
            total,
        },
        finalVisible: {
            files: files.length,
            bytes: files.reduce(
                (sum, file) => sum + expectedContentBytes(file.content),
                0
            ),
        },
    };
};

const storageGrowth = (
    from: ProcessSoakStoragePhaseReport,
    to: ProcessSoakStoragePhaseReport,
    replicaCount: number,
    measuredSubmittedBytes: number
) => {
    const ratios = (fleetBytes: number | null) => ({
        fleetBytes,
        fleetPerMeasuredSubmittedContentByte:
            fleetBytes === null || measuredSubmittedBytes === 0
                ? null
                : fleetBytes / measuredSubmittedBytes,
        perReplicaEquivalentPerMeasuredSubmittedContentByte:
            fleetBytes === null || measuredSubmittedBytes === 0
                ? null
                : fleetBytes / replicaCount / measuredSubmittedBytes,
    });
    const allocatedGrowthBytes =
        from.fleet.allocatedBytes === null || to.fleet.allocatedBytes === null
            ? null
            : to.fleet.allocatedBytes - from.fleet.allocatedBytes;
    return {
        from: from.phase,
        to: to.phase,
        apparentRegularFileBytes: ratios(
            to.fleet.apparentRegularFileBytes -
                from.fleet.apparentRegularFileBytes
        ),
        allocatedRegularFileBlockBytes: ratios(allocatedGrowthBytes),
    };
};

const memoryCalibrationReport = (
    ready: ProcessSoakReadyMessage[],
    opens: ProcessSoakOpenResult[]
): Array<{
    process: ProcessSoakReadyMessage["process"];
    calibration: ProcessSoakMemoryCalibration;
}> => {
    expect(opens).toHaveLength(ready.length);
    const fields = [
        "rssBytes",
        "heapTotalBytes",
        "heapUsedBytes",
        "externalBytes",
        "arrayBuffersBytes",
    ] as const satisfies ReadonlyArray<keyof ProcessSoakMemorySnapshot>;
    const expectDelta = (
        current: ProcessSoakMemorySnapshot,
        previous: ProcessSoakMemorySnapshot,
        delta: ProcessSoakMemorySnapshot
    ) => {
        for (const field of fields) {
            expect(delta[field]).toBe(current[field] - previous[field]);
        }
    };
    return opens.map((open, index) => {
        const initial = ready[index].memoryCalibration;
        const calibration = open.memoryCalibration;
        expect(initial.samples.sharedFsOpened).toBeUndefined();
        expect(initial.deltas.sharedFsOpenedMinusPeerCreated).toBeUndefined();
        expect({
            harnessLoaded: calibration.samples.harnessLoaded,
            productModulesLoaded: calibration.samples.productModulesLoaded,
            peerCreated: calibration.samples.peerCreated,
        }).toEqual(initial.samples);
        const opened = calibration.samples.sharedFsOpened;
        const openedDelta = calibration.deltas.sharedFsOpenedMinusPeerCreated;
        expect(opened).toBeDefined();
        expect(openedDelta).toBeDefined();
        for (const sample of [
            calibration.samples.harnessLoaded,
            calibration.samples.productModulesLoaded,
            calibration.samples.peerCreated,
            opened!,
        ]) {
            for (const field of fields) {
                expect(Number.isFinite(sample[field])).toBe(true);
                expect(sample[field]).toBeGreaterThanOrEqual(0);
            }
        }
        expectDelta(
            calibration.samples.productModulesLoaded,
            calibration.samples.harnessLoaded,
            calibration.deltas.productModulesLoadedMinusHarnessLoaded
        );
        expectDelta(
            calibration.samples.peerCreated,
            calibration.samples.productModulesLoaded,
            calibration.deltas.peerCreatedMinusProductModulesLoaded
        );
        expectDelta(opened!, calibration.samples.peerCreated, openedDelta!);
        return {
            process: ready[index].process,
            calibration,
        };
    });
};

const validateRuntimeMetric = async (
    worker: RunningWorker,
    sample: ProcessSoakRuntimeMetrics
) => {
    const ready = await worker.ready;
    expect(sample.process).toEqual({
        worker: worker.index,
        generation: worker.generation,
        pid: worker.child.pid,
        identity: ready.identity,
        networkMode: worker.networkMode,
    });
    for (const value of [
        sample.rssBytes,
        sample.maxRssBytes,
        sample.heapTotalBytes,
        sample.heapUsedBytes,
        sample.externalBytes,
        sample.arrayBuffersBytes,
        sample.userCpuMicros,
        sample.systemCpuMicros,
        sample.fsReadOps,
        sample.fsWriteOps,
    ]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(sample.process.pid).toBeGreaterThan(0);
    expect(sample.heapUsedBytes).toBeLessThanOrEqual(sample.heapTotalBytes);
};

const validateRuntimeMetrics = async (
    workers: RunningWorker[],
    samples: ProcessSoakRuntimeMetrics[]
) => {
    expect(samples).toHaveLength(workers.length);
    await Promise.all(
        samples.map((sample, index) =>
            validateRuntimeMetric(workers[index], sample)
        )
    );
    expect(new Set(samples.map((sample) => sample.process.pid)).size).toBe(
        workers.length
    );
};

const captureRuntimeMetrics = async (workers: RunningWorker[]) => {
    const samples = await Promise.all(
        workers.map((worker) =>
            worker.request<ProcessSoakRuntimeMetrics>({
                type: "runtime-metrics",
            })
        )
    );
    await validateRuntimeMetrics(workers, samples);
    return samples;
};

const captureRequestedGcRuntimeMetrics = async (workers: RunningWorker[]) => {
    const results = await Promise.all(
        workers.map((worker) =>
            worker.request<ProcessSoakRequestedGcMetricsResult>({
                type: "requested-gc-runtime-metrics",
            })
        )
    );
    await validateRuntimeMetrics(
        workers,
        results.map((result) => result.metrics)
    );
    for (const result of results) {
        expect(Number.isFinite(result.settleWallMs)).toBe(true);
        expect(result.settleWallMs).toBeGreaterThanOrEqual(0);
    }
    return results;
};

const aggregateFleetMemory = (metrics: ProcessSoakRuntimeMetrics[]) => ({
    processCount: metrics.length,
    processes: metrics.map((sample) => sample.process),
    sumCurrentRssBytes: metrics.reduce(
        (total, sample) => total + sample.rssBytes,
        0
    ),
    sumProcessLifetimeMaxRssBytes: metrics.reduce(
        (total, sample) => total + sample.maxRssBytes,
        0
    ),
    sumHeapTotalBytes: metrics.reduce(
        (total, sample) => total + sample.heapTotalBytes,
        0
    ),
    sumHeapUsedBytes: metrics.reduce(
        (total, sample) => total + sample.heapUsedBytes,
        0
    ),
    sumExternalBytes: metrics.reduce(
        (total, sample) => total + sample.externalBytes,
        0
    ),
    sumArrayBuffersBytes: metrics.reduce(
        (total, sample) => total + sample.arrayBuffersBytes,
        0
    ),
});

const validateShutdownResult = async (
    worker: RunningWorker,
    result: ProcessSoakStopResult
): Promise<CapturedProcessSoakShutdownResult> => {
    expect(result.code).toBe(0);
    expect(result.shutdown).toBeDefined();
    const shutdown = result.shutdown!;
    expect(shutdown.captured).toBe(true);
    if (!shutdown.captured) {
        throw new Error("Expected captured shutdown metrics");
    }
    const samples = [
        shutdown.beforeClose,
        shutdown.afterFsClose,
        shutdown.afterPeerStop,
    ];
    expect(shutdown.afterStopRequestedGc).toBeDefined();
    expect(shutdown.gcSettleWallMs).toBeTypeOf("number");
    samples.push(shutdown.afterStopRequestedGc!);
    const gcSettleWallMs = shutdown.gcSettleWallMs!;
    expect(Number.isFinite(gcSettleWallMs)).toBe(true);
    expect(gcSettleWallMs).toBeGreaterThanOrEqual(0);
    await Promise.all(
        samples.map((sample) => validateRuntimeMetric(worker, sample))
    );
    return shutdown;
};

const withoutStorage = ({
    storage: _storage,
    ...runtime
}: ProcessSoakMetrics): ProcessSoakRuntimeMetrics => runtime;

const treeFromFiles = (
    files: Iterable<ProcessSoakFileExpectation>
): ProcessSoakTreeExpectation[] => {
    const tree = new Map<string, "directory" | "file">();
    for (const file of files) {
        const segments = file.path.split("/").filter(Boolean);
        for (let index = 1; index < segments.length; index++) {
            tree.set(`/${segments.slice(0, index).join("/")}`, "directory");
        }
        tree.set(file.path, "file");
    }
    return [...tree]
        .map(([path, kind]) => ({ path, kind }))
        .sort((left, right) => left.path.localeCompare(right.path));
};

manualDescribe("process-isolated Shared FS multi-writer soak (manual)", () => {
    const activeWorkers = new Set<RunningWorker>();
    const temporaryDirectories = new Set<string>();

    afterEach(async () => {
        const workers = [...activeWorkers];
        const stopped = await Promise.allSettled(
            workers.map((worker) => stopWorker(worker))
        );
        for (const worker of workers) {
            if (worker.hasClosed()) activeWorkers.delete(worker);
        }
        const unclosed = workers.filter((worker) => !worker.hasClosed());
        if (unclosed.length > 0) {
            throw new Error(
                `Refusing to remove process-soak state while workers ${unclosed
                    .map((worker) => worker.index)
                    .join(", ")} have not confirmed close`
            );
        }
        const failedStop = stopped.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        );
        const removed = await Promise.allSettled(
            [...temporaryDirectories].map((directory) =>
                rm(directory, { recursive: true, force: true })
            )
        );
        const directories = [...temporaryDirectories];
        removed.forEach((result, index) => {
            if (result.status === "fulfilled") {
                temporaryDirectories.delete(directories[index]);
            }
        });
        const failedRemoval = removed.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected"
        );
        if (failedRemoval) throw failedRemoval.reason;
        if (failedStop) throw failedStop.reason;
    });

    soakIt(
        "measures separate durable processes through edits, partition healing, GC, SIGKILL, and warm reopen",
        { timeout: TEST_TIMEOUT_MS },
        async () => {
            const rounds = configuredRounds();
            const payloadBytes = configuredPayloadBytes();
            const root = await mkdtemp(
                join(tmpdir(), "peerbit-shared-fs-process-soak-")
            );
            temporaryDirectories.add(root);
            const directories = Array.from({ length: 3 }, (_, index) =>
                join(root, `peer-${index}`)
            );
            let workers = directories.map((directory, index) => {
                const worker = startWorker(index, directory);
                activeWorkers.add(worker);
                return worker;
            });
            let ready = await Promise.all(
                workers.map((worker) => worker.ready)
            );
            const baselineReady = [...ready];
            expect(new Set(ready.map((message) => message.identity)).size).toBe(
                3
            );

            await workers[0].request({
                type: "dial",
                addresses: [dialAddress(ready[1]), dialAddress(ready[2])],
            });
            await workers[1].request({
                type: "dial",
                addresses: [dialAddress(ready[2])],
            });

            const ownerOpen = await workers[0].request<ProcessSoakOpenResult>({
                type: "open",
                machineLabel: "process-soak-owner",
                timeoutMs: COMMAND_TIMEOUT_MS,
            });
            expect(ownerOpen.gcScheduled).toBe(true);
            await workers[0].request({
                type: "authorize",
                publicKeys: ready.slice(1).map((message) => message.publicKey),
            });
            const seed = await workers[0].request<ProcessSoakBatchResult>({
                type: "write-batch",
                changesetId: "process-soak-seed",
                entries: [
                    { path: "/seed.txt", content: "process-isolated-ready" },
                    ...ready.map((_, index) => ({
                        path: `/writers/writer-${index}/seed.txt`,
                        content: `writer ${index}`,
                    })),
                ],
            });
            const replicaOpens = await Promise.all(
                workers.slice(1).map((worker, offset) =>
                    worker.request<ProcessSoakOpenResult>({
                        type: "open",
                        address: ownerOpen.address,
                        machineLabel: `process-soak-writer-${offset + 1}`,
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );
            for (const opened of replicaOpens) {
                expect(opened.gcScheduled).toBe(true);
            }
            const trustedPublicKeys = ready.map((message) => message.publicKey);
            const seedFiles = [
                { path: "/seed.txt", content: "process-isolated-ready" },
                ...ready.map((_, index) => ({
                    path: `/writers/writer-${index}/seed.txt`,
                    content: `writer ${index}`,
                })),
            ];
            const startupMemoryCalibration = memoryCalibrationReport(
                baselineReady,
                [ownerOpen, ...replicaOpens]
            );
            await Promise.all(
                workers.map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        changesets: [seed.changeset],
                        files: seedFiles,
                        trustedPublicKeys,
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );

            const baselineMetrics = await Promise.all(
                workers.map((worker) =>
                    worker.request<ProcessSoakMetrics>({ type: "metrics" })
                )
            );
            await validateRuntimeMetrics(
                workers,
                baselineMetrics.map(withoutStorage)
            );
            const baselineStorage = await openStoragePhase(
                "baseline-open",
                workers,
                baselineMetrics
            );
            const phaseRuntimeMetrics: Record<
                string,
                ProcessSoakRuntimeMetrics[]
            > = {
                baseline: baselineMetrics.map(withoutStorage),
            };
            const expected = new Map<string, ProcessSoakFileExpectation>(
                seedFiles.map((file) => [file.path, file])
            );
            const absent = new Set<string>();
            const localCommitSamples: number[] = [];
            const allPeersAdmittedSamples: number[] = [];
            const allPeersReadableSamples: number[] = [];
            const baselineSubmittedContent = {
                operations: seedFiles.length,
                bytes: seedFiles.reduce(
                    (total, file) => total + expectedContentBytes(file.content),
                    0
                ),
            };
            let logicalContentBytesWritten = baselineSubmittedContent.bytes;
            let logicalWriteOperations = baselineSubmittedContent.operations;

            for (let round = 0; round < rounds; round++) {
                const entries = workers.map((_, writer) => {
                    const hotPath = `/writers/writer-${writer}/hot.bin`;
                    const historyPath = `/writers/writer-${writer}/history/round-${round}.bin`;
                    const scratchPath = `/writers/writer-${writer}/scratch-${round}.txt`;
                    const hotPayload = createProcessSoakGeneratedContent(
                        `round=${round};writer=${writer};hot;`,
                        `hot:${round}:${writer}`,
                        payloadBytes
                    );
                    const historyPayload = createProcessSoakGeneratedContent(
                        `round=${round};writer=${writer};history;`,
                        `history:${round}:${writer}`,
                        payloadBytes
                    );
                    const scratch = `round=${round};writer=${writer};scratch`;
                    expected.set(hotPath, {
                        path: hotPath,
                        content: hotPayload.expectation,
                    });
                    expected.set(historyPath, {
                        path: historyPath,
                        content: historyPayload.expectation,
                    });
                    expected.set(scratchPath, {
                        path: scratchPath,
                        content: scratch,
                    });
                    absent.delete(scratchPath);
                    const batch: Array<
                        | { path: string; content: string }
                        | { path: string; delete: true }
                    > = [
                        { path: hotPath, content: hotPayload.content },
                        { path: historyPath, content: historyPayload.content },
                        { path: scratchPath, content: scratch },
                    ];
                    if (round > 0) {
                        const prior = `/writers/writer-${writer}/scratch-${round - 1}.txt`;
                        batch.push({ path: prior, delete: true });
                        expected.delete(prior);
                        absent.add(prior);
                    }
                    return batch;
                });
                const roundStartedAt = performance.now();
                const commits = await Promise.all(
                    workers.map((worker, writer) =>
                        worker.request<ProcessSoakBatchResult>({
                            type: "write-batch",
                            changesetId: `process-soak-${round}-${writer}`,
                            entries: entries[writer],
                        })
                    )
                );
                for (const entry of entries.flat()) {
                    if ("content" in entry) {
                        logicalContentBytesWritten += Buffer.byteLength(
                            entry.content
                        );
                        logicalWriteOperations++;
                    }
                }
                localCommitSamples.push(
                    ...commits.map((commit) => commit.localCommitMs)
                );
                const roundFiles = entries.flatMap((batch) =>
                    batch.flatMap((entry) =>
                        "content" in entry ? [expected.get(entry.path)!] : []
                    )
                );
                const roundAbsent = entries.flatMap((batch) =>
                    batch.flatMap((entry) =>
                        "delete" in entry ? [entry.path] : []
                    )
                );
                await Promise.all(
                    workers.map((worker) =>
                        worker.request<ProcessSoakVerifyResult>({
                            type: "verify",
                            changesets: commits.map(
                                (commit) => commit.changeset
                            ),
                            timeoutMs: COMMAND_TIMEOUT_MS,
                        })
                    )
                );
                const allPeersAdmittedMs = performance.now() - roundStartedAt;
                allPeersAdmittedSamples.push(allPeersAdmittedMs);
                await Promise.all(
                    workers.map((worker) =>
                        worker.request<ProcessSoakVerifyResult>({
                            type: "verify",
                            files: roundFiles,
                            absentPaths: roundAbsent,
                            timeoutMs: COMMAND_TIMEOUT_MS,
                        })
                    )
                );
                const allPeersReadableMs = performance.now() - roundStartedAt;
                allPeersReadableSamples.push(allPeersReadableMs);
                const roundReport = {
                    round: round + 1,
                    localCommitMs: commits.map(
                        (commit) => commit.localCommitMs
                    ),
                    allPeersAdmittedMs,
                    allPeersReadableMs,
                    operations: entries.reduce(
                        (total, batch) => total + batch.length,
                        0
                    ),
                };
                console.log(
                    "process-isolated-soak-round:",
                    JSON.stringify(roundReport, (_key, value) =>
                        typeof value === "number"
                            ? Number(value.toFixed(1))
                            : value
                    )
                );
            }
            phaseRuntimeMetrics.afterRounds =
                await captureRuntimeMetrics(workers);

            const editorFiles = workers.map((_, writer) => {
                const payload = createProcessSoakGeneratedContent(
                    `editor=${writer};`,
                    `editor:${writer}`,
                    payloadBytes
                );
                return {
                    tempPath: `/writers/writer-${writer}/.editor-${writer}.tmp`,
                    path: `/writers/writer-${writer}/editor-current.txt`,
                    ...payload,
                };
            });
            const editorSeedFiles = editorFiles.map((file, writer) => ({
                path: file.path,
                content: `editor-base=${writer}`,
            }));
            const editorSeed = await workers[0].request<ProcessSoakBatchResult>(
                {
                    type: "write-batch",
                    changesetId: "process-soak-editor-base",
                    entries: editorSeedFiles,
                }
            );
            for (const file of editorSeedFiles) {
                logicalContentBytesWritten += Buffer.byteLength(file.content);
                logicalWriteOperations++;
            }
            await Promise.all(
                workers.map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        changesets: [editorSeed.changeset],
                        files: editorSeedFiles,
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );
            const editorStartedAt = performance.now();
            const editorResults = await Promise.all(
                workers.map((worker, writer) =>
                    worker.request<ProcessSoakEditorResult>({
                        type: "editor-save",
                        tempPath: editorFiles[writer].tempPath,
                        path: editorFiles[writer].path,
                        content: editorFiles[writer].content,
                    })
                )
            );
            for (const result of editorResults) {
                expect(result.targetNodeId).toBe(result.tempNodeId);
                expect(result.targetNodeId).not.toBe(result.replacedNodeId);
            }
            for (const file of editorFiles) {
                expected.set(file.path, {
                    path: file.path,
                    content: file.expectation,
                });
                absent.add(file.tempPath);
                logicalContentBytesWritten += Buffer.byteLength(file.content);
                logicalWriteOperations++;
            }
            await Promise.all(
                workers.map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        files: editorFiles.map(({ path, expectation }) => ({
                            path,
                            content: expectation,
                        })),
                        absentPaths: editorFiles.map((file) => file.tempPath),
                        noNamingConflicts: editorFiles.map((file) => file.path),
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );
            const editorAllPeersReadableMs =
                performance.now() - editorStartedAt;
            phaseRuntimeMetrics.afterEditor =
                await captureRuntimeMetrics(workers);

            const partitionBaseContent = "partition-base";
            const base = await workers[0].request<ProcessSoakBatchResult>({
                type: "write-batch",
                changesetId: "process-soak-conflict-base",
                entries: [
                    { path: "/contested.txt", content: "base" },
                    {
                        path: "/partitioned.txt",
                        content: partitionBaseContent,
                    },
                ],
            });
            logicalContentBytesWritten +=
                Buffer.byteLength("base") +
                Buffer.byteLength(partitionBaseContent);
            logicalWriteOperations += 2;
            const baseVersionId = base.versionIds[0];
            const partitionBaseVersionId = base.versionIds[1];
            expect(baseVersionId).toBeTypeOf("string");
            expect(partitionBaseVersionId).toBeTypeOf("string");
            await Promise.all(
                workers.map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        changesets: [base.changeset],
                        files: [
                            { path: "/contested.txt", content: "base" },
                            {
                                path: "/partitioned.txt",
                                content: partitionBaseContent,
                            },
                        ],
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );
            expected.set("/partitioned.txt", {
                path: "/partitioned.txt",
                content: partitionBaseContent,
            });
            const conflictPayloads = workers.map((_, writer) =>
                createProcessSoakGeneratedContent(
                    `conflict-writer=${writer};`,
                    `conflict:${writer}`,
                    payloadBytes
                )
            );
            const conflictContents = conflictPayloads.map(
                (payload) => payload.content
            );
            const conflictStartedAt = performance.now();
            const conflictWrites = await Promise.all(
                workers.map((worker, writer) =>
                    worker.request<ProcessSoakConflictWriteResult>({
                        type: "write-conflict",
                        path: "/contested.txt",
                        content: conflictContents[writer],
                        baseVersionIds: [baseVersionId!],
                    })
                )
            );
            for (const content of conflictContents) {
                logicalContentBytesWritten += Buffer.byteLength(content);
                logicalWriteOperations++;
            }
            const conflictHeads = conflictWrites.map((result, writer) => ({
                versionId: result.versionId,
                content: conflictPayloads[writer].expectation,
            }));
            const conflictVerifications = await Promise.all(
                workers.map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        conflict: {
                            mode: "heads",
                            path: "/contested.txt",
                            heads: conflictHeads,
                        },
                        noNamingConflicts: ["/contested.txt"],
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );
            expect(
                new Set(
                    conflictVerifications.map(
                        (verification) => verification.visibleConflictHash
                    )
                ).size
            ).toBe(1);
            const allPeersConflictVisibleMs =
                performance.now() - conflictStartedAt;
            const selectedHead = conflictHeads[2];
            const resolveStartedAt = performance.now();
            const resolveCommit = await workers[0].request<{
                localCommitMs: number;
            }>({
                type: "resolve-conflict",
                path: "/contested.txt",
                versionId: selectedHead.versionId,
            });
            await Promise.all(
                workers.map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        files: [
                            {
                                path: "/contested.txt",
                                content: selectedHead.content,
                            },
                        ],
                        conflict: {
                            mode: "resolved",
                            path: "/contested.txt",
                        },
                        noNamingConflicts: ["/contested.txt"],
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );
            const allPeersConflictResolvedMs =
                performance.now() - resolveStartedAt;
            expected.set("/contested.txt", {
                path: "/contested.txt",
                content: selectedHead.content,
            });
            phaseRuntimeMetrics.afterConnectedConflictResolution =
                await captureRuntimeMetrics(workers);

            const killedReady = ready[2];
            const killedWorker = workers[2];
            const killStartedAt = performance.now();
            await killWorker(killedWorker);
            activeWorkers.delete(killedWorker);
            const killToCloseMs = performance.now() - killStartedAt;
            const restartStartedAt = performance.now();
            const offlineRestarted = startWorker(2, directories[2], {
                offline: true,
            });
            activeWorkers.add(offlineRestarted);
            const offlineRestartedReady = await offlineRestarted.ready;
            const peerRecreateMs = performance.now() - restartStartedAt;
            expect(offlineRestartedReady.identity).toBe(killedReady.identity);
            expect(offlineRestartedReady.addresses).toEqual([]);
            const offlineNetworkBeforeOpen =
                await offlineRestarted.request<ProcessSoakNetworkStatus>({
                    type: "network-status",
                });
            expect(offlineNetworkBeforeOpen).toEqual({
                connectionCount: 0,
                remotePeers: [],
            });
            const offlineReopen =
                await offlineRestarted.request<ProcessSoakOpenResult>({
                    type: "open",
                    address: ownerOpen.address,
                    machineLabel: "process-soak-writer-2-restarted",
                    timeoutMs: COMMAND_TIMEOUT_MS,
                });
            expect(offlineReopen.identity).toBe(killedReady.identity);
            expect(offlineReopen.gcScheduled).toBe(true);
            expect(offlineReopen.writeReadinessSource).toBe("remote-settled");
            const offlineAuditStartedAt = performance.now();
            await offlineRestarted.request<ProcessSoakVerifyResult>({
                type: "verify",
                files: [...expected.values()],
                absentPaths: [...absent],
                trustedPublicKeys,
                conflict: {
                    mode: "resolved",
                    path: "/contested.txt",
                },
                noNamingConflicts: [
                    "/contested.txt",
                    ...editorFiles.map((file) => file.path),
                ],
                exactTree: treeFromFiles(expected.values()),
                timeoutMs: COMMAND_TIMEOUT_MS,
            });
            const offlineAuditMs = performance.now() - offlineAuditStartedAt;
            const offlineNetworkBeforeDivergence =
                await offlineRestarted.request<ProcessSoakNetworkStatus>({
                    type: "network-status",
                });
            expect(offlineNetworkBeforeDivergence).toEqual({
                connectionCount: 0,
                remotePeers: [],
            });

            const partitionPayloads = [
                createProcessSoakGeneratedContent(
                    "partition=online;",
                    "partition:online",
                    payloadBytes
                ),
                createProcessSoakGeneratedContent(
                    "partition=offline;",
                    "partition:offline",
                    payloadBytes
                ),
            ];
            const partitionDivergentStartedAt = performance.now();
            const [partitionOnlineWrite, partitionOfflineWrite] =
                await Promise.all([
                    workers[0].request<ProcessSoakConflictWriteResult>({
                        type: "write-conflict",
                        path: "/partitioned.txt",
                        content: partitionPayloads[0].content,
                        baseVersionIds: [partitionBaseVersionId!],
                    }),
                    offlineRestarted.request<ProcessSoakConflictWriteResult>({
                        type: "write-conflict",
                        path: "/partitioned.txt",
                        content: partitionPayloads[1].content,
                        baseVersionIds: [partitionBaseVersionId!],
                    }),
                ]);
            const partitionHeads = [
                {
                    versionId: partitionOnlineWrite.versionId,
                    content: partitionPayloads[0].expectation,
                    parentVersionIds: [partitionBaseVersionId!],
                },
                {
                    versionId: partitionOfflineWrite.versionId,
                    content: partitionPayloads[1].expectation,
                    parentVersionIds: [partitionBaseVersionId!],
                },
            ];
            expect(
                new Set(partitionHeads.map((head) => head.versionId)).size
            ).toBe(2);
            for (const payload of partitionPayloads) {
                logicalContentBytesWritten += Buffer.byteLength(
                    payload.content
                );
                logicalWriteOperations++;
            }
            const partitionSplitVerifyStartedAt = performance.now();
            const [onlineSplitVerifications, offlineSplitVerification] =
                await Promise.all([
                    Promise.all(
                        workers.slice(0, 2).map((worker) =>
                            worker.request<ProcessSoakVerifyResult>({
                                type: "verify",
                                conflict: {
                                    mode: "version-heads",
                                    path: "/partitioned.txt",
                                    heads: [partitionHeads[0]],
                                },
                                noNamingConflicts: ["/partitioned.txt"],
                                timeoutMs: COMMAND_TIMEOUT_MS,
                            })
                        )
                    ),
                    offlineRestarted.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        conflict: {
                            mode: "version-heads",
                            path: "/partitioned.txt",
                            heads: [partitionHeads[1]],
                        },
                        noNamingConflicts: ["/partitioned.txt"],
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    }),
                ]);
            expect(
                onlineSplitVerifications.map(
                    (verification) => verification.visibleConflictHash
                )
            ).toEqual([
                partitionPayloads[0].expectation.sha256,
                partitionPayloads[0].expectation.sha256,
            ]);
            expect(offlineSplitVerification.visibleConflictHash).toBe(
                partitionPayloads[1].expectation.sha256
            );
            const offlineNetworkAfterDivergence =
                await offlineRestarted.request<ProcessSoakNetworkStatus>({
                    type: "network-status",
                });
            expect(offlineNetworkAfterDivergence).toEqual({
                connectionCount: 0,
                remotePeers: [],
            });
            const partitionSplitVerifiedMs =
                performance.now() - partitionSplitVerifyStartedAt;
            phaseRuntimeMetrics.partitionedOnlineComponent =
                await captureRuntimeMetrics(workers.slice(0, 2));
            phaseRuntimeMetrics.partitionedOfflineComponent =
                await captureRuntimeMetrics([offlineRestarted]);

            const postRestartPayload = createProcessSoakGeneratedContent(
                "post-restart;",
                "post-restart",
                payloadBytes
            );
            const postRestartStartedAt = performance.now();
            const postRestart =
                await offlineRestarted.request<ProcessSoakBatchResult>({
                    type: "write-batch",
                    changesetId: "process-soak-post-restart",
                    entries: [
                        {
                            path: "/writers/writer-2/post-restart.txt",
                            content: postRestartPayload.content,
                        },
                    ],
                });
            expected.set("/writers/writer-2/post-restart.txt", {
                path: "/writers/writer-2/post-restart.txt",
                content: postRestartPayload.expectation,
            });
            logicalContentBytesWritten += Buffer.byteLength(
                postRestartPayload.content
            );
            logicalWriteOperations++;
            await offlineRestarted.request<ProcessSoakVerifyResult>({
                type: "verify",
                changesets: [postRestart.changeset],
                files: [
                    {
                        path: "/writers/writer-2/post-restart.txt",
                        content: postRestartPayload.expectation,
                    },
                ],
                exactTree: treeFromFiles(expected.values()),
                timeoutMs: COMMAND_TIMEOUT_MS,
            });
            const offlineStop = await stopWorker(offlineRestarted);
            expect(offlineStop.code).toBe(0);
            expect(offlineStop.shutdown).toEqual({ captured: false });
            activeWorkers.delete(offlineRestarted);

            const networkRestartStartedAt = performance.now();
            const restarted = startWorker(2, directories[2]);
            activeWorkers.add(restarted);
            const restartedReady = await restarted.ready;
            const networkPeerRecreateMs =
                performance.now() - networkRestartStartedAt;
            expect(restartedReady.identity).toBe(killedReady.identity);
            const networkReopen =
                await restarted.request<ProcessSoakOpenResult>({
                    type: "open",
                    address: ownerOpen.address,
                    machineLabel: "process-soak-writer-2-reconnected",
                    timeoutMs: COMMAND_TIMEOUT_MS,
                });
            expect(networkReopen.identity).toBe(killedReady.identity);
            expect(networkReopen.writeReadinessSource).toBe("remote-settled");
            await restarted.request({
                type: "dial",
                addresses: [dialAddress(ready[0]), dialAddress(ready[1])],
            });
            workers = [workers[0], workers[1], restarted];
            ready = [ready[0], ready[1], restartedReady];
            const partitionHealVerifications = await Promise.all(
                workers.map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        changesets: [postRestart.changeset],
                        files: [
                            {
                                path: "/writers/writer-2/post-restart.txt",
                                content: postRestartPayload.expectation,
                            },
                        ],
                        conflict: {
                            mode: "version-heads",
                            path: "/partitioned.txt",
                            heads: partitionHeads,
                        },
                        noNamingConflicts: ["/partitioned.txt"],
                        exactTree: treeFromFiles(expected.values()),
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );
            expect(
                new Set(
                    partitionHealVerifications.map(
                        (verification) => verification.visibleConflictHash
                    )
                ).size
            ).toBe(1);
            expect(partitionHeads.map((head) => head.content.sha256)).toContain(
                partitionHealVerifications[0].visibleConflictHash
            );
            const partitionRestartToVisibleMs =
                performance.now() - networkRestartStartedAt;
            const partitionDivergentToVisibleMs =
                performance.now() - partitionDivergentStartedAt;
            const postRestartAllPeersReadableMs =
                performance.now() - postRestartStartedAt;
            phaseRuntimeMetrics.afterPartitionHeal =
                await captureRuntimeMetrics(workers);

            const selectedPartitionHead = partitionHeads[1];
            const partitionResolveStartedAt = performance.now();
            const partitionResolve = await workers[0].request<{
                localCommitMs: number;
            }>({
                type: "resolve-conflict",
                path: "/partitioned.txt",
                versionId: selectedPartitionHead.versionId,
            });
            expected.set("/partitioned.txt", {
                path: "/partitioned.txt",
                content: selectedPartitionHead.content,
            });
            await Promise.all(
                workers.map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        files: [expected.get("/partitioned.txt")!],
                        conflict: {
                            mode: "resolved",
                            path: "/partitioned.txt",
                        },
                        noNamingConflicts: ["/partitioned.txt"],
                        exactTree: treeFromFiles(expected.values()),
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );
            const partitionAllPeersResolvedMs =
                performance.now() - partitionResolveStartedAt;
            phaseRuntimeMetrics.afterPartitionResolution =
                await captureRuntimeMetrics(workers);

            const gc = await workers[0].request<ProcessSoakGcResult>({
                type: "collect-garbage",
            });
            expect(gc.report).toEqual({
                dryRun: false,
                healedChunks: 0,
                damagedNodeIds: [],
                retiredVersions: 0,
                compactedNamingEvents: 0,
                purgedNodes: 0,
                deletedChunks: 0,
                reclaimedChunkBytes: "0",
                chunkCandidatesRecorded: 0,
                purgeCandidatesRecorded: 0,
                conflictedNodes: 0,
                cutRecoveries: 0,
                manifestsRetired: 0,
                segmentBlocksDeleted: 0,
                reclaimedSegmentBytes: "0",
                warnings: [],
            });
            await Promise.all(
                workers.map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        files: [...expected.values()],
                        absentPaths: [...absent],
                        trustedPublicKeys,
                        conflict: {
                            mode: "resolved",
                            path: "/contested.txt",
                        },
                        noNamingConflicts: [
                            "/contested.txt",
                            "/partitioned.txt",
                            ...editorFiles.map((file) => file.path),
                        ],
                        exactTree: treeFromFiles(expected.values()),
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );
            await Promise.all(
                workers.map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        conflict: {
                            mode: "resolved",
                            path: "/partitioned.txt",
                        },
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );
            phaseRuntimeMetrics.afterGc = await captureRuntimeMetrics(workers);

            const finalNetworkWorker = workers[2];
            const finalNetworkStop = await stopWorker(finalNetworkWorker);
            expect(finalNetworkStop.code).toBe(0);
            expect(finalNetworkStop.shutdown).toEqual({ captured: false });
            activeWorkers.delete(finalNetworkWorker);
            const finalOfflineRestartStartedAt = performance.now();
            const finalOffline = startWorker(2, directories[2], {
                offline: true,
            });
            activeWorkers.add(finalOffline);
            const finalOfflineReady = await finalOffline.ready;
            const finalOfflinePeerRecreateMs =
                performance.now() - finalOfflineRestartStartedAt;
            expect(finalOfflineReady.identity).toBe(killedReady.identity);
            expect(finalOfflineReady.addresses).toEqual([]);
            const finalOfflineNetworkBeforeOpen =
                await finalOffline.request<ProcessSoakNetworkStatus>({
                    type: "network-status",
                });
            expect(finalOfflineNetworkBeforeOpen).toEqual({
                connectionCount: 0,
                remotePeers: [],
            });
            const finalOfflineOpen =
                await finalOffline.request<ProcessSoakOpenResult>({
                    type: "open",
                    address: ownerOpen.address,
                    machineLabel: "process-soak-writer-2-final-offline",
                    timeoutMs: COMMAND_TIMEOUT_MS,
                });
            expect(finalOfflineOpen.identity).toBe(killedReady.identity);
            expect(finalOfflineOpen.gcScheduled).toBe(true);
            expect(finalOfflineOpen.writeReadinessSource).toBe(
                "remote-settled"
            );
            workers = [workers[0], workers[1], finalOffline];
            phaseRuntimeMetrics.beforeFinalOfflineAudit =
                await captureRuntimeMetrics(workers);
            const finalOfflineAuditStartedAt = performance.now();
            await finalOffline.request<ProcessSoakVerifyResult>({
                type: "verify",
                files: [...expected.values()],
                absentPaths: [...absent],
                trustedPublicKeys,
                conflict: {
                    mode: "resolved",
                    path: "/contested.txt",
                },
                noNamingConflicts: [
                    "/contested.txt",
                    "/partitioned.txt",
                    ...editorFiles.map((file) => file.path),
                ],
                exactTree: treeFromFiles(expected.values()),
                timeoutMs: COMMAND_TIMEOUT_MS,
            });
            await finalOffline.request<ProcessSoakVerifyResult>({
                type: "verify",
                conflict: {
                    mode: "resolved",
                    path: "/partitioned.txt",
                },
                timeoutMs: COMMAND_TIMEOUT_MS,
            });
            const finalOfflineAuditMs =
                performance.now() - finalOfflineAuditStartedAt;
            phaseRuntimeMetrics.afterFinalOfflineAudit =
                await captureRuntimeMetrics(workers);
            const finalOfflineNetworkAfterAudit =
                await finalOffline.request<ProcessSoakNetworkStatus>({
                    type: "network-status",
                });
            expect(finalOfflineNetworkAfterAudit).toEqual({
                connectionCount: 0,
                remotePeers: [],
            });
            const finalMetrics = await Promise.all(
                workers.map((worker) =>
                    worker.request<ProcessSoakMetrics>({ type: "metrics" })
                )
            );
            await validateRuntimeMetrics(
                workers,
                finalMetrics.map(withoutStorage)
            );
            const finalRequestedGcMetrics =
                await captureRequestedGcRuntimeMetrics(workers);
            phaseRuntimeMetrics.afterFinalRequestedGc =
                finalRequestedGcMetrics.map((result) => result.metrics);
            const reopenedAfterAuditStorage = await openStoragePhase(
                "reopened-after-audit-open",
                workers,
                finalMetrics
            );
            const stops = await Promise.allSettled(
                workers.map((worker) =>
                    stopWorker(worker, {
                        captureMetrics: true,
                        requestGcAfterStop: true,
                    })
                )
            );
            for (const worker of workers) {
                if (worker.hasClosed()) activeWorkers.delete(worker);
            }
            const unclosed = workers.filter((worker) => !worker.hasClosed());
            expect(
                unclosed,
                "Every process-soak worker must confirm close before state removal"
            ).toEqual([]);
            const failedStop = stops.find(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected"
            );
            if (failedStop) throw failedStop.reason;
            const completedStops = stops.map((result) => {
                if (result.status === "rejected") throw result.reason;
                return result.value;
            });
            const reopenedAfterCloseStorage = await closedStoragePhase(
                "reopened-after-clean-close",
                workers,
                completedStops
            );
            const finalShutdowns = await Promise.all(
                stops.map((result, index) => {
                    if (result.status === "rejected") throw result.reason;
                    return validateShutdownResult(workers[index], result.value);
                })
            );
            phaseRuntimeMetrics.beforeGracefulShutdown = finalShutdowns.map(
                (shutdown) => shutdown.beforeClose
            );
            phaseRuntimeMetrics.afterFsClose = finalShutdowns.map(
                (shutdown) => shutdown.afterFsClose
            );
            phaseRuntimeMetrics.afterPeerStop = finalShutdowns.map(
                (shutdown) => shutdown.afterPeerStop
            );
            phaseRuntimeMetrics.afterStopRequestedGc = finalShutdowns.map(
                (shutdown) => shutdown.afterStopRequestedGc!
            );
            const baselineFleetMemory = aggregateFleetMemory(
                baselineMetrics.map(withoutStorage)
            );
            const finalFleetMemory = aggregateFleetMemory(
                finalMetrics.map(withoutStorage)
            );
            const fleetMemoryByPhase = Object.fromEntries(
                Object.entries(phaseRuntimeMetrics).map(([phase, samples]) => [
                    phase,
                    aggregateFleetMemory(samples),
                ])
            );
            const submittedContent = contentLedger(
                baselineSubmittedContent,
                {
                    operations: logicalWriteOperations,
                    bytes: logicalContentBytesWritten,
                },
                expected.values()
            );
            const measuredSubmittedBytes =
                submittedContent.submitted.measured.bytes;
            const report = {
                rounds,
                writers: workers.length,
                processes: workers.length,
                payloadBytes,
                localCommitMs: distribution(localCommitSamples),
                allPeersAdmittedMs: distribution(allPeersAdmittedSamples),
                allPeersReadableMs: distribution(allPeersReadableSamples),
                editor: {
                    fsyncMs: distribution(
                        editorResults.map((result) => result.fsyncMs)
                    ),
                    releaseMs: distribution(
                        editorResults.map((result) => result.releaseMs)
                    ),
                    renameMs: distribution(
                        editorResults.map((result) => result.renameMs)
                    ),
                    totalLocalSaveMs: distribution(
                        editorResults.map((result) => result.totalMs)
                    ),
                    allPeersReadableMs: editorAllPeersReadableMs,
                },
                conflict: {
                    localCommitMs: distribution(
                        conflictWrites.map((result) => result.localCommitMs)
                    ),
                    allPeersVisibleMs: allPeersConflictVisibleMs,
                    resolveLocalCommitMs: resolveCommit.localCommitMs,
                    allPeersResolvedMs: allPeersConflictResolvedMs,
                },
                partition: {
                    divergentLocalCommitMs: {
                        online: partitionOnlineWrite.localCommitMs,
                        offline: partitionOfflineWrite.localCommitMs,
                    },
                    splitComponentsVerifiedMs: partitionSplitVerifiedMs,
                    divergentWriteToAllPeersVisibleMs:
                        partitionDivergentToVisibleMs,
                    networkRestartToAllPeersVisibleMs:
                        partitionRestartToVisibleMs,
                    deterministicVisibleHash:
                        partitionHealVerifications[0].visibleConflictHash,
                    offlineNetworkEvidence: {
                        beforeOpen: offlineNetworkBeforeOpen,
                        beforeDivergence: offlineNetworkBeforeDivergence,
                        afterDivergence: offlineNetworkAfterDivergence,
                    },
                    resolveLocalCommitMs: partitionResolve.localCommitMs,
                    allPeersResolvedMs: partitionAllPeersResolvedMs,
                },
                restart: {
                    killToCloseMs,
                    offlinePeerCreateReportedMs:
                        offlineRestartedReady.peerCreateMs,
                    offlinePeerRecreateWallMs: peerRecreateMs,
                    offlineFsOpenMs: offlineReopen.openMs,
                    offlineWriteReadyMs: offlineReopen.writeReadyMs,
                    offlineWriteReadinessSource:
                        offlineReopen.writeReadinessSource,
                    offlineAuditMs,
                    postRestartLocalCommitMs: postRestart.localCommitMs,
                    networkPeerCreateReportedMs: restartedReady.peerCreateMs,
                    networkPeerRecreateWallMs: networkPeerRecreateMs,
                    networkFsOpenMs: networkReopen.openMs,
                    networkWriteReadyMs: networkReopen.writeReadyMs,
                    networkWriteReadinessSource:
                        networkReopen.writeReadinessSource,
                    postRestartAllPeersReadableMs,
                    finalOfflinePeerCreateReportedMs:
                        finalOfflineReady.peerCreateMs,
                    finalOfflinePeerRecreateWallMs: finalOfflinePeerRecreateMs,
                    finalOfflineFsOpenMs: finalOfflineOpen.openMs,
                    finalOfflineWriteReadyMs: finalOfflineOpen.writeReadyMs,
                    finalOfflineWriteReadinessSource:
                        finalOfflineOpen.writeReadinessSource,
                    finalOfflineAuditMs,
                    finalOfflineNetworkEvidence: {
                        beforeOpen: finalOfflineNetworkBeforeOpen,
                        afterAudit: finalOfflineNetworkAfterAudit,
                    },
                },
                gc,
                resources: {
                    baseline: baselineMetrics,
                    final: finalMetrics,
                    startupMemoryCalibration,
                    content: submittedContent,
                    fleetMemorySums: {
                        baseline: baselineFleetMemory,
                        final: finalFleetMemory,
                        phases: fleetMemoryByPhase,
                    },
                    stateDirectoryStorage: {
                        phases: [
                            baselineStorage,
                            reopenedAfterAuditStorage,
                            reopenedAfterCloseStorage,
                        ],
                        growth: storageGrowth(
                            baselineStorage,
                            reopenedAfterAuditStorage,
                            workers.length,
                            measuredSubmittedBytes
                        ),
                    },
                    phases: phaseRuntimeMetrics,
                    finalRequestedGcSettleWallMs: finalRequestedGcMetrics.map(
                        (result) => ({
                            process: result.metrics.process,
                            settleWallMs: result.settleWallMs,
                        })
                    ),
                    finalShutdownGcSettleWallMs: finalShutdowns.map(
                        (shutdown) => ({
                            process: shutdown.afterStopRequestedGc!.process,
                            settleWallMs: shutdown.gcSettleWallMs!,
                        })
                    ),
                },
            };
            console.log(
                "process-isolated-soak:",
                JSON.stringify(report, (_key, value) =>
                    typeof value === "number" ? Number(value.toFixed(1)) : value
                )
            );
            await rm(root, { recursive: true, force: true });
            temporaryDirectories.delete(root);
        }
    );

    longChurnIt(
        "proves verified cold joins, two-writer churn, fsync crash recovery, two-pass GC, and offline completeness",
        { timeout: LONG_CHURN_TEST_TIMEOUT_MS },
        async () => {
            const joinRuns = configuredLongChurnJoins();
            const rounds = configuredLongChurnRounds();
            const hotVersions = configuredLongChurnHotVersions();
            const payloadBytes = configuredLongChurnPayloadBytes();
            const root = await mkdtemp(
                join(tmpdir(), "peerbit-shared-fs-process-long-churn-")
            );
            temporaryDirectories.add(root);
            const ownerDirectory = join(root, "owner");
            const owner = startWorker(0, ownerDirectory);
            activeWorkers.add(owner);
            const ownerReady = await owner.ready;
            const ownerOpen = await owner.request<ProcessSoakOpenResult>({
                type: "open",
                machineLabel: "process-long-churn-owner",
                timeoutMs: COMMAND_TIMEOUT_MS,
                bootstrap: false,
                remoteChunkFetch: false,
                gcSchedule: false,
            });
            expect(ownerOpen.gcScheduled).toBe(false);

            const fixtureFiles = Array.from({ length: 500 }, (_, index) => ({
                path: `/t/d-${index % 50}/f-${index}.txt`,
                content: `payload ${index}`,
            }));
            const expected = new Map<string, ProcessSoakFileExpectation>(
                fixtureFiles.map((file) => [file.path, file])
            );
            const absent = new Set<string>();
            let logicalContentBytesWritten = fixtureFiles.reduce(
                (total, file) => total + Buffer.byteLength(file.content),
                0
            );
            let logicalWriteOperations = fixtureFiles.length;
            const fixtureSeed = await owner.request<ProcessSoakBatchResult>({
                type: "write-batch",
                changesetId: "process-long-churn-fixture",
                entries: fixtureFiles,
            });
            const snapshot =
                await owner.request<ProcessSoakSnapshotWriteResult>({
                    type: "snapshot-write",
                });
            expect(snapshot.nodes).toBe("551");
            expect(snapshot.docs).toBe("1051");
            expect(BigInt(snapshot.bytes)).toBeGreaterThan(0n);
            expect(snapshot.segments).toBeGreaterThan(0);

            const requiredBootstrapEvents = [
                "open:start",
                "documents-open:start",
                "documents-open:end",
                "manifest-discovery:start",
                "manifest-discovery:end",
                "segments-fetch:start",
                "segments-fetch:end",
                "overlay-install:start",
                "overlay-ready",
                "pending-drained",
                "overlay-retired",
                "synchronizer-idle",
                "write-ready",
            ];
            const coldJoinSamples: Array<{
                run: number;
                peerCreateMs: number;
                openMs: number;
                writeReadyMs: number;
                localTreeAuditMs: number;
                bootstrapEvents: ProcessSoakOpenResult["bootstrapTelemetry"];
                memoryCalibration: ProcessSoakMemoryCalibration;
                openProfile: ProcessSoakOpenResult["openProfile"];
            }> = [];
            let writer!: RunningWorker;
            let writerReady!: ProcessSoakReadyMessage;
            let writerDirectory = "";
            for (let run = 0; run < joinRuns; run++) {
                const directory = join(root, `cold-join-${run + 1}`);
                const joiner = startWorker(run + 1, directory);
                activeWorkers.add(joiner);
                const joinerReady = await joiner.ready;
                await joiner.request({
                    type: "dial",
                    addresses: [dialAddress(ownerReady)],
                });
                const opened = await joiner.request<ProcessSoakOpenResult>({
                    type: "open",
                    address: ownerOpen.address,
                    machineLabel: `process-long-churn-cold-join-${run + 1}`,
                    timeoutMs: COMMAND_TIMEOUT_MS,
                    bootstrap: "require",
                    remoteChunkFetch: false,
                    gcSchedule: false,
                    captureBootstrapTelemetry: true,
                    captureOpenProfile: true,
                    awaitBootstrapConverged: true,
                });
                expect(opened.gcScheduled).toBe(false);
                expect(opened.bootstrapConvergence).toEqual({ verified: true });
                expect(opened.bootstrapStatus).toMatchObject({
                    phase: "converged",
                    snapshotCoverageVerified: true,
                    writeReady: true,
                    writeReadinessSource: "remote-settled",
                    pendingDocs: 0,
                    guardArmed: true,
                    manifest: { docs: "1051" },
                });
                const bootstrapEvents = opened.bootstrapTelemetry;
                const eventTypes = bootstrapEvents.map((event) => event.type);
                expect(
                    eventTypes.filter((type) =>
                        requiredBootstrapEvents.includes(type)
                    )
                ).toEqual(requiredBootstrapEvents);
                expect(
                    bootstrapEvents.filter(
                        (event) =>
                            event.type === "fallback" ||
                            event.type === "aborted"
                    )
                ).toEqual([]);
                for (let index = 1; index < bootstrapEvents.length; index++) {
                    expect(bootstrapEvents[index].atMs).toBeGreaterThanOrEqual(
                        bootstrapEvents[index - 1].atMs
                    );
                }
                expect(
                    bootstrapEvents.find(
                        (event) => event.type === "overlay-retired"
                    )
                ).toMatchObject({ verified: true });
                expect(
                    opened.openProfile.every((event) =>
                        isReportedSharedLogOpenProfile(event.name)
                    )
                ).toBe(true);
                for (const name of requiredSharedLogOpenProfileNames) {
                    expect(
                        opened.openProfile.filter(
                            (event) => event.name === name
                        ),
                        `${name} must emit exactly once during Documents.open`
                    ).toHaveLength(1);
                }
                for (const event of opened.openProfile) {
                    expect(event.component).toBe("shared-log");
                    expect(event.durationMs).toEqual(expect.any(Number));
                    expect(event.durationMs).toBeGreaterThanOrEqual(0);
                }
                const auditStartedAt = performance.now();
                await joiner.request<ProcessSoakVerifyResult>({
                    type: "verify",
                    changesets: [fixtureSeed.changeset],
                    files: fixtureFiles,
                    exactTree: treeFromFiles(fixtureFiles),
                    timeoutMs: COMMAND_TIMEOUT_MS,
                });
                const sample = {
                    run: run + 1,
                    peerCreateMs: joinerReady.peerCreateMs,
                    openMs: opened.openMs,
                    writeReadyMs: opened.writeReadyMs,
                    localTreeAuditMs: performance.now() - auditStartedAt,
                    bootstrapEvents,
                    memoryCalibration: opened.memoryCalibration,
                    openProfile: opened.openProfile,
                };
                coldJoinSamples.push(sample);
                console.log(
                    "process-long-churn-cold-join:",
                    JSON.stringify(sample, (_key, value) =>
                        typeof value === "number"
                            ? Number(value.toFixed(1))
                            : value
                    )
                );
                if (run === joinRuns - 1) {
                    writer = joiner;
                    writerReady = joinerReady;
                    writerDirectory = directory;
                } else {
                    const stopped = await stopWorker(joiner);
                    expect(stopped.code).toBe(0);
                    activeWorkers.delete(joiner);
                }
            }

            const retainedIdentity = writerReady.identity;
            const writerIndex = writer.index;
            const retainedStop = await stopWorker(writer);
            expect(retainedStop.code).toBe(0);
            activeWorkers.delete(writer);
            const retainedOffline = startWorker(writerIndex, writerDirectory, {
                offline: true,
            });
            activeWorkers.add(retainedOffline);
            const retainedOfflineReady = await retainedOffline.ready;
            expect(retainedOfflineReady.identity).toBe(retainedIdentity);
            expect(retainedOfflineReady.addresses).toEqual([]);
            expect(
                await retainedOffline.request<ProcessSoakNetworkStatus>({
                    type: "network-status",
                })
            ).toEqual({ connectionCount: 0, remotePeers: [] });
            const retainedOfflineOpen =
                await retainedOffline.request<ProcessSoakOpenResult>({
                    type: "open",
                    address: ownerOpen.address,
                    machineLabel: "process-long-churn-retained-offline",
                    timeoutMs: COMMAND_TIMEOUT_MS,
                    bootstrap: false,
                    remoteChunkFetch: false,
                    gcSchedule: false,
                });
            expect(retainedOfflineOpen.writeReadinessSource).toBe(
                "remote-settled"
            );
            await retainedOffline.request<ProcessSoakVerifyResult>({
                type: "verify",
                files: fixtureFiles,
                exactTree: treeFromFiles(fixtureFiles),
                timeoutMs: COMMAND_TIMEOUT_MS,
            });
            expect(
                await retainedOffline.request<ProcessSoakNetworkStatus>({
                    type: "network-status",
                })
            ).toEqual({ connectionCount: 0, remotePeers: [] });
            const retainedOfflineStop = await stopWorker(retainedOffline);
            expect(retainedOfflineStop.code).toBe(0);
            activeWorkers.delete(retainedOffline);

            writer = startWorker(writerIndex, writerDirectory);
            activeWorkers.add(writer);
            writerReady = await writer.ready;
            expect(writerReady.identity).toBe(retainedIdentity);
            await writer.request({
                type: "dial",
                addresses: [dialAddress(ownerReady)],
            });
            const writerOpen = await writer.request<ProcessSoakOpenResult>({
                type: "open",
                address: ownerOpen.address,
                machineLabel: "process-long-churn-writer",
                timeoutMs: COMMAND_TIMEOUT_MS,
                bootstrap: false,
                remoteChunkFetch: false,
                gcSchedule: false,
            });
            expect(writerOpen.writeReadinessSource).toBe("remote-settled");
            await owner.request({
                type: "authorize",
                publicKeys: [writerReady.publicKey],
            });
            const trustedPublicKeys = [
                ownerReady.publicKey,
                writerReady.publicKey,
            ];
            await Promise.all(
                [owner, writer].map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        trustedPublicKeys,
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );

            const baseFiles = [
                {
                    path: "/collaboration/editor.txt",
                    content: "editor-base",
                },
                {
                    path: "/collaboration/crash.txt",
                    content: "crash-base",
                },
                {
                    path: "/collaboration/contested.bin",
                    content: "conflict-base",
                },
                {
                    path: "/collaboration/hot.bin",
                    content: "hot-base",
                },
                {
                    path: "/writers/writer-0/seed.txt",
                    content: "writer-0-base",
                },
                {
                    path: "/writers/writer-1/seed.txt",
                    content: "writer-1-base",
                },
            ];
            const bases = await owner.request<ProcessSoakBatchResult>({
                type: "write-batch",
                changesetId: "process-long-churn-bases",
                entries: baseFiles,
            });
            baseFiles.forEach((file) => expected.set(file.path, file));
            logicalContentBytesWritten += baseFiles.reduce(
                (total, file) => total + Buffer.byteLength(file.content),
                0
            );
            logicalWriteOperations += baseFiles.length;
            await Promise.all(
                [owner, writer].map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        changesets: [bases.changeset],
                        files: baseFiles,
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );
            const baselineMetrics = await Promise.all(
                [owner, writer].map((worker) =>
                    worker.request<ProcessSoakMetrics>({ type: "metrics" })
                )
            );
            await validateRuntimeMetrics(
                [owner, writer],
                baselineMetrics.map(withoutStorage)
            );
            const baselineLogicalContentBytesWritten =
                logicalContentBytesWritten;
            const baselineLogicalWriteOperations = logicalWriteOperations;
            const baselineStartupMemoryCalibration = memoryCalibrationReport(
                [ownerReady, writerReady],
                [ownerOpen, writerOpen]
            );
            const baselineStorage = await openStoragePhase(
                "baseline-open",
                [owner, writer],
                baselineMetrics
            );

            const roundSamples: Array<{
                round: number;
                localCommitMs: number[];
                allPeersAdmittedMs: number;
                allPeersReadableMs: number;
            }> = [];
            for (let round = 0; round < rounds; round++) {
                const entries = [owner, writer].map((_, writerNumber) => {
                    const hot = createProcessSoakGeneratedContent(
                        `round=${round};writer=${writerNumber};hot;`,
                        `long-churn:round:${round}:writer:${writerNumber}:hot`,
                        payloadBytes
                    );
                    const history = createProcessSoakGeneratedContent(
                        `round=${round};writer=${writerNumber};history;`,
                        `long-churn:round:${round}:writer:${writerNumber}:history`,
                        payloadBytes
                    );
                    const hotPath = `/writers/writer-${writerNumber}/hot.bin`;
                    const historyPath = `/writers/writer-${writerNumber}/history/round-${round}.bin`;
                    expected.set(hotPath, {
                        path: hotPath,
                        content: hot.expectation,
                    });
                    expected.set(historyPath, {
                        path: historyPath,
                        content: history.expectation,
                    });
                    logicalContentBytesWritten +=
                        Buffer.byteLength(hot.content) +
                        Buffer.byteLength(history.content);
                    logicalWriteOperations += 2;
                    return {
                        entries: [
                            { path: hotPath, content: hot.content },
                            { path: historyPath, content: history.content },
                        ],
                        files: [
                            { path: hotPath, content: hot.expectation },
                            {
                                path: historyPath,
                                content: history.expectation,
                            },
                        ],
                    };
                });
                const startedAt = performance.now();
                const commits = await Promise.all(
                    [owner, writer].map((worker, writerNumber) =>
                        worker.request<ProcessSoakBatchResult>({
                            type: "write-batch",
                            changesetId: `process-long-churn-round-${round}-writer-${writerNumber}`,
                            entries: entries[writerNumber].entries,
                        })
                    )
                );
                await Promise.all(
                    [owner, writer].map((worker) =>
                        worker.request<ProcessSoakVerifyResult>({
                            type: "verify",
                            changesets: commits.map(
                                (commit) => commit.changeset
                            ),
                            timeoutMs: COMMAND_TIMEOUT_MS,
                        })
                    )
                );
                const allPeersAdmittedMs = performance.now() - startedAt;
                await Promise.all(
                    [owner, writer].map((worker) =>
                        worker.request<ProcessSoakVerifyResult>({
                            type: "verify",
                            files: entries.flatMap((entry) => entry.files),
                            timeoutMs: COMMAND_TIMEOUT_MS,
                        })
                    )
                );
                const sample = {
                    round: round + 1,
                    localCommitMs: commits.map(
                        (commit) => commit.localCommitMs
                    ),
                    allPeersAdmittedMs,
                    allPeersReadableMs: performance.now() - startedAt,
                };
                roundSamples.push(sample);
                console.log(
                    "process-long-churn-round:",
                    JSON.stringify(sample, (_key, value) =>
                        typeof value === "number"
                            ? Number(value.toFixed(1))
                            : value
                    )
                );
            }

            const editorPayload = createProcessSoakGeneratedContent(
                "editor-safe-save;",
                "long-churn:editor-safe-save",
                payloadBytes
            );
            const editor = await writer.request<ProcessSoakEditorResult>({
                type: "editor-save",
                tempPath: "/collaboration/.editor.tmp",
                path: "/collaboration/editor.txt",
                content: editorPayload.content,
            });
            expect(editor.targetNodeId).toBe(editor.tempNodeId);
            expect(editor.targetNodeId).not.toBe(editor.replacedNodeId);
            expected.set("/collaboration/editor.txt", {
                path: "/collaboration/editor.txt",
                content: editorPayload.expectation,
            });
            absent.add("/collaboration/.editor.tmp");
            logicalContentBytesWritten += Buffer.byteLength(
                editorPayload.content
            );
            logicalWriteOperations++;
            await Promise.all(
                [owner, writer].map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        files: [expected.get("/collaboration/editor.txt")!],
                        absentPaths: ["/collaboration/.editor.tmp"],
                        noNamingConflicts: ["/collaboration/editor.txt"],
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );

            const conflictBaseVersionId = bases.versionIds[2];
            expect(conflictBaseVersionId).toBeTypeOf("string");
            const conflictPayloads = [owner, writer].map((_, index) =>
                createProcessSoakGeneratedContent(
                    `conflict-writer=${index};`,
                    `long-churn:conflict:${index}`,
                    payloadBytes
                )
            );
            const conflictWrites = await Promise.all(
                [owner, writer].map((worker, index) =>
                    worker.request<ProcessSoakConflictWriteResult>({
                        type: "write-conflict",
                        path: "/collaboration/contested.bin",
                        content: conflictPayloads[index].content,
                        baseVersionIds: [conflictBaseVersionId!],
                    })
                )
            );
            logicalContentBytesWritten += conflictPayloads.reduce(
                (total, payload) => total + Buffer.byteLength(payload.content),
                0
            );
            logicalWriteOperations += conflictPayloads.length;
            const conflictHeads = conflictWrites.map((write, index) => ({
                versionId: write.versionId,
                content: conflictPayloads[index].expectation,
                parentVersionIds: [conflictBaseVersionId!],
            }));
            const conflictVisibility = await Promise.all(
                [owner, writer].map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        conflict: {
                            mode: "version-heads",
                            path: "/collaboration/contested.bin",
                            heads: conflictHeads,
                        },
                        noNamingConflicts: ["/collaboration/contested.bin"],
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );
            expect(
                new Set(
                    conflictVisibility.map(
                        (verification) => verification.visibleConflictHash
                    )
                ).size
            ).toBe(1);
            const visibleConflictHash =
                conflictVisibility[0].visibleConflictHash;
            const visibleConflict = conflictHeads.find(
                (head) => head.content.sha256 === visibleConflictHash
            );
            expect(visibleConflict).toBeDefined();
            expected.set("/collaboration/contested.bin", {
                path: "/collaboration/contested.bin",
                content: visibleConflict!.content,
            });

            const hotChangesets: ProcessSoakBatchResult["changeset"][] = [];
            let hotExpectation!: ProcessSoakFileExpectation;
            for (let version = 0; version < hotVersions; version++) {
                const payload = createProcessSoakGeneratedContent(
                    `hot-version=${version};`,
                    `long-churn:hot-version:${version}`,
                    payloadBytes
                );
                const committed = await owner.request<ProcessSoakBatchResult>({
                    type: "write-batch",
                    changesetId: `process-long-churn-hot-version-${version}`,
                    entries: [
                        {
                            path: "/collaboration/hot.bin",
                            content: payload.content,
                        },
                    ],
                });
                hotChangesets.push(committed.changeset);
                hotExpectation = {
                    path: "/collaboration/hot.bin",
                    content: payload.expectation,
                };
                expected.set(hotExpectation.path, hotExpectation);
                logicalContentBytesWritten += Buffer.byteLength(
                    payload.content
                );
                logicalWriteOperations++;
            }
            await Promise.all(
                [owner, writer].map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        changesets: hotChangesets,
                        files: [hotExpectation],
                        conflict: {
                            mode: "version-heads",
                            path: "/collaboration/contested.bin",
                            heads: conflictHeads,
                        },
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );

            const dayMs = 24 * 60 * 60 * 1000;
            const firstGcOffsetMs = 40 * dayMs;
            await Promise.all(
                [owner, writer].map((worker) =>
                    worker.request({
                        type: "set-clock-offset",
                        offsetMs: firstGcOffsetMs,
                    })
                )
            );
            const gcOptions = {
                keepVersions: 3,
                settleMs: 0,
                minOrphanSpanMs: 60_000,
            };
            const firstGc = await owner.request<ProcessSoakGcResult>({
                type: "collect-garbage",
                options: gcOptions,
            });
            expect(firstGc.report.retiredVersions).toBeGreaterThan(0);
            expect(firstGc.report.chunkCandidatesRecorded).toBeGreaterThan(0);
            expect(firstGc.report.deletedChunks).toBe(0);
            expect(firstGc.report.damagedNodeIds).toEqual([]);
            expect(firstGc.report.conflictedNodes).toBe(0);
            await Promise.all(
                [owner, writer].map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        files: [...expected.values()],
                        absentPaths: [...absent],
                        trustedPublicKeys,
                        conflict: {
                            mode: "version-heads",
                            path: "/collaboration/contested.bin",
                            heads: conflictHeads,
                        },
                        noNamingConflicts: ["/"],
                        exactTree: treeFromFiles(expected.values()),
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );

            const crashPayload = createProcessSoakGeneratedContent(
                "crash-safe-save;",
                "long-churn:crash-safe-save",
                payloadBytes
            );
            const crashTempPath = "/collaboration/.crash.txt.tmp";
            const checkpoint =
                await writer.request<ProcessSoakEditorFsyncCheckpointResult>({
                    type: "editor-fsync-checkpoint",
                    tempPath: crashTempPath,
                    path: "/collaboration/crash.txt",
                    content: crashPayload.content,
                });
            expect(checkpoint.tempNodeId).not.toBe(checkpoint.targetNodeId);
            const crashStartedAt = performance.now();
            await killWorker(writer);
            activeWorkers.delete(writer);
            const crashToCloseMs = performance.now() - crashStartedAt;

            const crashOffline = startWorker(writerIndex, writerDirectory, {
                offline: true,
            });
            activeWorkers.add(crashOffline);
            const crashOfflineReady = await crashOffline.ready;
            expect(crashOfflineReady.identity).toBe(retainedIdentity);
            expect(crashOfflineReady.addresses).toEqual([]);
            await crashOffline.request({
                type: "set-clock-offset",
                offsetMs: firstGcOffsetMs,
            });
            const crashOfflineNetworkBeforeOpen =
                await crashOffline.request<ProcessSoakNetworkStatus>({
                    type: "network-status",
                });
            expect(crashOfflineNetworkBeforeOpen).toEqual({
                connectionCount: 0,
                remotePeers: [],
            });
            const crashReopenStartedAt = performance.now();
            const crashOfflineOpen =
                await crashOffline.request<ProcessSoakOpenResult>({
                    type: "open",
                    address: ownerOpen.address,
                    machineLabel: "process-long-churn-crash-offline",
                    timeoutMs: COMMAND_TIMEOUT_MS,
                    bootstrap: false,
                    remoteChunkFetch: false,
                    gcSchedule: false,
                });
            const crashOfflineOpenMs = performance.now() - crashReopenStartedAt;
            expect(crashOfflineOpen.writeReadinessSource).toBe(
                "remote-settled"
            );
            await crashOffline.request<ProcessSoakVerifyResult>({
                type: "verify",
                files: [
                    ...expected.values(),
                    {
                        path: crashTempPath,
                        content: crashPayload.expectation,
                    },
                ],
                trustedPublicKeys,
                conflict: {
                    mode: "version-heads",
                    path: "/collaboration/contested.bin",
                    heads: conflictHeads,
                },
                timeoutMs: COMMAND_TIMEOUT_MS,
            });
            const recoveredRename =
                await crashOffline.request<ProcessSoakMountRenameResult>({
                    type: "mount-rename",
                    fromPath: crashTempPath,
                    toPath: "/collaboration/crash.txt",
                });
            expect(recoveredRename.sourceNodeId).toBe(checkpoint.tempNodeId);
            expect(recoveredRename.replacedNodeId).toBe(
                checkpoint.targetNodeId
            );
            expect(recoveredRename.targetNodeId).toBe(checkpoint.tempNodeId);
            expected.set("/collaboration/crash.txt", {
                path: "/collaboration/crash.txt",
                content: crashPayload.expectation,
            });
            absent.add(crashTempPath);
            logicalContentBytesWritten += Buffer.byteLength(
                crashPayload.content
            );
            logicalWriteOperations++;
            await crashOffline.request<ProcessSoakVerifyResult>({
                type: "verify",
                files: [...expected.values()],
                absentPaths: [...absent],
                conflict: {
                    mode: "version-heads",
                    path: "/collaboration/contested.bin",
                    heads: conflictHeads,
                },
                noNamingConflicts: ["/"],
                exactTree: treeFromFiles(expected.values()),
                timeoutMs: COMMAND_TIMEOUT_MS,
            });
            expect(
                await crashOffline.request<ProcessSoakNetworkStatus>({
                    type: "network-status",
                })
            ).toEqual({ connectionCount: 0, remotePeers: [] });
            const crashOfflineStop = await stopWorker(crashOffline);
            expect(crashOfflineStop.code).toBe(0);
            activeWorkers.delete(crashOffline);

            writer = startWorker(writerIndex, writerDirectory);
            activeWorkers.add(writer);
            writerReady = await writer.ready;
            expect(writerReady.identity).toBe(retainedIdentity);
            await writer.request({
                type: "set-clock-offset",
                offsetMs: firstGcOffsetMs,
            });
            await writer.request({
                type: "dial",
                addresses: [dialAddress(ownerReady)],
            });
            await writer.request<ProcessSoakOpenResult>({
                type: "open",
                address: ownerOpen.address,
                machineLabel: "process-long-churn-writer-reconnected",
                timeoutMs: COMMAND_TIMEOUT_MS,
                bootstrap: false,
                remoteChunkFetch: false,
                gcSchedule: false,
            });
            await Promise.all(
                [owner, writer].map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        files: [expected.get("/collaboration/crash.txt")!],
                        absentPaths: [crashTempPath],
                        conflict: {
                            mode: "version-heads",
                            path: "/collaboration/contested.bin",
                            heads: conflictHeads,
                        },
                        noNamingConflicts: ["/"],
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );

            const secondGcOffsetMs = firstGcOffsetMs + 120_000;
            await Promise.all(
                [owner, writer].map((worker) =>
                    worker.request({
                        type: "set-clock-offset",
                        offsetMs: secondGcOffsetMs,
                    })
                )
            );
            const secondGc = await owner.request<ProcessSoakGcResult>({
                type: "collect-garbage",
                options: gcOptions,
            });
            expect(secondGc.report.deletedChunks).toBeGreaterThan(0);
            expect(BigInt(secondGc.report.reclaimedChunkBytes)).toBeGreaterThan(
                0n
            );
            expect(secondGc.report.damagedNodeIds).toEqual([]);
            await Promise.all(
                [owner, writer].map((worker) =>
                    worker.request<ProcessSoakVerifyResult>({
                        type: "verify",
                        files: [...expected.values()],
                        absentPaths: [...absent],
                        trustedPublicKeys,
                        conflict: {
                            mode: "version-heads",
                            path: "/collaboration/contested.bin",
                            heads: conflictHeads,
                        },
                        noNamingConflicts: ["/"],
                        exactTree: treeFromFiles(expected.values()),
                        timeoutMs: COMMAND_TIMEOUT_MS,
                    })
                )
            );

            const onlineFinalMetrics = await Promise.all(
                [owner, writer].map((worker) =>
                    worker.request<ProcessSoakMetrics>({ type: "metrics" })
                )
            );
            await validateRuntimeMetrics(
                [owner, writer],
                onlineFinalMetrics.map(withoutStorage)
            );
            const onlineFinalStorage = await openStoragePhase(
                "online-final-open",
                [owner, writer],
                onlineFinalMetrics
            );
            const onlineStops = await Promise.all([
                stopWorker(owner),
                stopWorker(writer),
            ]);
            expect(onlineStops.map((result) => result.code)).toEqual([0, 0]);
            const afterCleanCloseStorage = await closedStoragePhase(
                "after-clean-close",
                [owner, writer],
                onlineStops
            );
            activeWorkers.delete(owner);
            activeWorkers.delete(writer);

            const finalOfflineOwner = startWorker(0, ownerDirectory, {
                offline: true,
            });
            const finalOfflineWriter = startWorker(
                writerIndex,
                writerDirectory,
                { offline: true }
            );
            activeWorkers.add(finalOfflineOwner);
            activeWorkers.add(finalOfflineWriter);
            const finalOfflineReady = await Promise.all([
                finalOfflineOwner.ready,
                finalOfflineWriter.ready,
            ]);
            expect(finalOfflineReady.map((ready) => ready.identity)).toEqual([
                ownerReady.identity,
                retainedIdentity,
            ]);
            expect(finalOfflineReady.map((ready) => ready.addresses)).toEqual([
                [],
                [],
            ]);
            const finalOfflineWorkers = [finalOfflineOwner, finalOfflineWriter];
            const finalOfflineOpens: ProcessSoakOpenResult[] = [];
            for (const worker of finalOfflineWorkers) {
                await worker.request({
                    type: "set-clock-offset",
                    offsetMs: secondGcOffsetMs,
                });
                expect(
                    await worker.request<ProcessSoakNetworkStatus>({
                        type: "network-status",
                    })
                ).toEqual({ connectionCount: 0, remotePeers: [] });
                finalOfflineOpens.push(
                    await worker.request<ProcessSoakOpenResult>({
                        type: "open",
                        address: ownerOpen.address,
                        machineLabel: `process-long-churn-final-offline-${worker.index}`,
                        timeoutMs: COMMAND_TIMEOUT_MS,
                        bootstrap: false,
                        remoteChunkFetch: false,
                        gcSchedule: false,
                    })
                );
            }
            const reopenedBeforeAuditMetrics = await Promise.all(
                finalOfflineWorkers.map((worker) =>
                    worker.request<ProcessSoakMetrics>({ type: "metrics" })
                )
            );
            await validateRuntimeMetrics(
                finalOfflineWorkers,
                reopenedBeforeAuditMetrics.map(withoutStorage)
            );
            const reopenedBeforeAuditStorage = await openStoragePhase(
                "reopened-before-audit-open",
                finalOfflineWorkers,
                reopenedBeforeAuditMetrics
            );
            for (const worker of finalOfflineWorkers) {
                await worker.request<ProcessSoakVerifyResult>({
                    type: "verify",
                    files: [...expected.values()],
                    absentPaths: [...absent],
                    trustedPublicKeys,
                    conflict: {
                        mode: "version-heads",
                        path: "/collaboration/contested.bin",
                        heads: conflictHeads,
                    },
                    noNamingConflicts: ["/"],
                    exactTree: treeFromFiles(expected.values()),
                    timeoutMs: COMMAND_TIMEOUT_MS,
                });
                expect(
                    await worker.request<ProcessSoakNetworkStatus>({
                        type: "network-status",
                    })
                ).toEqual({ connectionCount: 0, remotePeers: [] });
            }
            const finalOfflineMetrics = await Promise.all(
                finalOfflineWorkers.map((worker) =>
                    worker.request<ProcessSoakMetrics>({ type: "metrics" })
                )
            );
            await validateRuntimeMetrics(
                finalOfflineWorkers,
                finalOfflineMetrics.map(withoutStorage)
            );
            const reopenedAfterAuditStorage = await openStoragePhase(
                "reopened-after-audit-open",
                finalOfflineWorkers,
                finalOfflineMetrics
            );
            const finalStops = await Promise.all([
                stopWorker(finalOfflineOwner),
                stopWorker(finalOfflineWriter),
            ]);
            expect(finalStops.map((result) => result.code)).toEqual([0, 0]);
            const reopenedAfterCleanCloseStorage = await closedStoragePhase(
                "reopened-after-clean-close",
                finalOfflineWorkers,
                finalStops
            );
            activeWorkers.delete(finalOfflineOwner);
            activeWorkers.delete(finalOfflineWriter);

            const localCommitSamples = roundSamples.flatMap(
                (sample) => sample.localCommitMs
            );
            const bootstrapMilestonesMs = Object.fromEntries(
                requiredBootstrapEvents.map((type) => [
                    type,
                    distribution(
                        coldJoinSamples.map((sample) => {
                            const event = sample.bootstrapEvents.find(
                                (candidate) => candidate.type === type
                            );
                            expect(event).toBeDefined();
                            return event!.atMs;
                        })
                    ),
                ])
            );
            const bootstrapDurationsMs = Object.fromEntries(
                requiredBootstrapEvents.flatMap((type) => {
                    const values = coldJoinSamples.flatMap((sample) => {
                        const event = sample.bootstrapEvents.find(
                            (candidate) => candidate.type === type
                        );
                        return event && "durationMs" in event
                            ? [event.durationMs]
                            : [];
                    });
                    return values.length > 0
                        ? [[type, distribution(values)] as const]
                        : [];
                })
            );
            const openProfileNames = [
                ...new Set([
                    ...requiredSharedLogOpenProfileNames,
                    "sharedLog.open.fanout",
                    "sharedLog.blocks.resolveProviders",
                    ...coldJoinSamples.flatMap((sample) =>
                        sample.openProfile.map((event) => event.name)
                    ),
                ]),
            ].sort();
            const openProfileAggregates = Object.fromEntries(
                openProfileNames.map((name) => {
                    const matching = coldJoinSamples.flatMap((sample) =>
                        sample.openProfile.filter(
                            (event) => event.name === name
                        )
                    );
                    const durations = matching.flatMap((event) =>
                        event.durationMs === undefined ? [] : [event.durationMs]
                    );
                    const eventsPerJoin = coldJoinSamples.map(
                        (sample) =>
                            sample.openProfile.filter(
                                (event) => event.name === name
                            ).length
                    );
                    return [
                        name,
                        {
                            emitted: matching.length,
                            joinsWithEvent: eventsPerJoin.filter(
                                (count) => count > 0
                            ).length,
                            eventsPerJoin: distribution(eventsPerJoin),
                            durationMs:
                                durations.length > 0
                                    ? distribution(durations)
                                    : null,
                        },
                    ];
                })
            );
            const baselineFleetMemory = aggregateFleetMemory(
                baselineMetrics.map(withoutStorage)
            );
            const onlineFinalFleetMemory = aggregateFleetMemory(
                onlineFinalMetrics.map(withoutStorage)
            );
            const finalOfflineFleetMemory = aggregateFleetMemory(
                finalOfflineMetrics.map(withoutStorage)
            );
            const submittedContent = contentLedger(
                {
                    operations: baselineLogicalWriteOperations,
                    bytes: baselineLogicalContentBytesWritten,
                },
                {
                    operations: logicalWriteOperations,
                    bytes: logicalContentBytesWritten,
                },
                expected.values()
            );
            const measuredSubmittedBytes =
                submittedContent.submitted.measured.bytes;
            const report = {
                joinRuns,
                rounds,
                writers: 2,
                hotVersions,
                payloadBytes,
                snapshot,
                coldJoin: {
                    peerCreateMs: distribution(
                        coldJoinSamples.map((sample) => sample.peerCreateMs)
                    ),
                    openMs: distribution(
                        coldJoinSamples.map((sample) => sample.openMs)
                    ),
                    writeReadyMs: distribution(
                        coldJoinSamples.map((sample) => sample.writeReadyMs)
                    ),
                    localTreeAuditMs: distribution(
                        coldJoinSamples.map((sample) => sample.localTreeAuditMs)
                    ),
                    milestonesMs: bootstrapMilestonesMs,
                    durationsMs: bootstrapDurationsMs,
                    sharedLogOpenProfile: openProfileAggregates,
                    samples: coldJoinSamples,
                },
                multiWriter: {
                    localCommitMs: distribution(localCommitSamples),
                    allPeersAdmittedMs: distribution(
                        roundSamples.map((sample) => sample.allPeersAdmittedMs)
                    ),
                    allPeersReadableMs: distribution(
                        roundSamples.map((sample) => sample.allPeersReadableMs)
                    ),
                    samples: roundSamples,
                },
                editor,
                crashRecovery: {
                    checkpoint,
                    crashToCloseMs,
                    offlineOpenMs: crashOfflineOpenMs,
                    recoveredRename,
                },
                conflict: {
                    heads: conflictHeads.map((head) => head.versionId),
                    visibleHash: visibleConflictHash,
                },
                gc: { first: firstGc, second: secondGc },
                resources: {
                    baseline: baselineMetrics,
                    onlineFinal: onlineFinalMetrics,
                    reopenedBeforeAudit: reopenedBeforeAuditMetrics,
                    finalOffline: finalOfflineMetrics,
                    memoryCalibration: {
                        baseline: baselineStartupMemoryCalibration,
                        reopened: memoryCalibrationReport(
                            finalOfflineReady,
                            finalOfflineOpens
                        ),
                    },
                    content: submittedContent,
                    fleetMemorySums: {
                        baseline: baselineFleetMemory,
                        onlineFinal: onlineFinalFleetMemory,
                        finalOffline: finalOfflineFleetMemory,
                    },
                    stateDirectoryStorage: {
                        phases: [
                            baselineStorage,
                            onlineFinalStorage,
                            afterCleanCloseStorage,
                            reopenedBeforeAuditStorage,
                            reopenedAfterAuditStorage,
                            reopenedAfterCleanCloseStorage,
                        ],
                        growth: storageGrowth(
                            baselineStorage,
                            onlineFinalStorage,
                            finalOfflineWorkers.length,
                            measuredSubmittedBytes
                        ),
                    },
                },
            };
            console.log(
                "process-long-churn:",
                JSON.stringify(report, (_key, value) =>
                    typeof value === "number" ? Number(value.toFixed(1)) : value
                )
            );
            await rm(root, { recursive: true, force: true });
            temporaryDirectories.delete(root);
        }
    );
});
