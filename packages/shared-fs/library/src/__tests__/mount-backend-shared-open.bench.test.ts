import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const enabled = process.env.PEERBIT_SHARED_FS_SHARED_OPEN_BENCH === "1";
const manualDescribe = enabled ? describe : describe.skip;
const SIZE_MIB = 64;
const SIZE_BYTES = SIZE_MIB * 1024 * 1024;
const HANDLE_COUNTS = [1, 8] as const;
const CHILD_TIMEOUT_MS = 5 * 60_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const FIXED_MEMORY_ALLOWANCE_BYTES = 2 * 1024 * 1024;
const AFTER_RELEASE_ALLOWANCE_BYTES = 8 * 1024 * 1024;
const workerPath = fileURLToPath(
    new URL("./mount-backend-shared-open.bench.worker.ts", import.meta.url)
);

type MemorySnapshot = {
    rssBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
};

type SharedOpenBenchmarkSample = {
    handles: number;
    sizeMiB: number;
    sizeBytes: number;
    openMs: number;
    verifiedCopyMs: number;
    verifiedHashMs: number;
    verifiedReadCalls: number;
    targetHashCalls: number;
    targetHashedBytes: number;
    readFileCalls: number;
    readVersionCalls: number;
    statCalls: number;
    writeFileCalls: number;
    memory: {
        baseline: MemorySnapshot;
        retained: MemorySnapshot;
        afterRelease: MemorySnapshot;
        retainedDeltaArrayBuffersBytes: number;
        afterReleaseDeltaArrayBuffersBytes: number;
    };
    runtime: {
        node: string;
        platform: string;
        arch: string;
    };
};

type WorkerMessage =
    | { type: "result"; sample: SharedOpenBenchmarkSample }
    | { type: "fatal"; message: string; stack?: string };

const runningChildren = new Set<ChildProcess>();

afterEach(() => {
    for (const child of runningChildren) {
        child.kill();
    }
    runningChildren.clear();
});

const runWorker = (handles: number) =>
    new Promise<SharedOpenBenchmarkSample>((resolve, reject) => {
        const child = fork(workerPath, [String(handles)], {
            execArgv: [
                "--expose-gc",
                "--enable-source-maps",
                "--import",
                "tsx",
            ],
            env: { ...process.env, NODE_ENV: "test" },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            windowsHide: true,
        });
        runningChildren.add(child);
        let output = "";
        let sample: SharedOpenBenchmarkSample | undefined;
        let fatal: string | undefined;
        let settled = false;

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

        const diagnostics = () => {
            const text = output.trim();
            return text ? `\nWorker output:\n${text}` : "";
        };
        const cleanup = () => {
            clearTimeout(timeout);
            child.off("message", onMessage);
            child.off("error", onError);
            child.off("close", onClose);
            runningChildren.delete(child);
        };
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            child.kill();
            reject(error);
        };
        const onMessage = (raw: unknown) => {
            const message = raw as WorkerMessage;
            if (message?.type === "fatal") {
                fatal = `${message.message}${message.stack ? `\n${message.stack}` : ""}`;
            } else if (message?.type === "result") {
                sample = message.sample;
            }
        };
        const onError = (error: Error) => {
            fail(
                new Error(
                    `Shared-open benchmark worker for ${handles} handles failed: ${error.message}${diagnostics()}`,
                    { cause: error }
                )
            );
        };
        const onClose = (
            code: number | null,
            signal: NodeJS.Signals | null
        ) => {
            if (settled) return;
            if (code !== 0 || !sample) {
                fail(
                    new Error(
                        fatal ??
                            `Shared-open benchmark worker for ${handles} handles exited without a result (code=${code}, signal=${signal})${diagnostics()}`
                    )
                );
                return;
            }
            settled = true;
            cleanup();
            resolve(sample);
        };
        const timeout = setTimeout(() => {
            fail(
                new Error(
                    `Shared-open benchmark worker for ${handles} handles exceeded ${CHILD_TIMEOUT_MS} ms${diagnostics()}`
                )
            );
        }, CHILD_TIMEOUT_MS);

        child.on("message", onMessage);
        child.once("error", onError);
        child.once("close", onClose);
    });

const expectFiniteNumbers = (values: Record<string, number>) => {
    for (const [name, value] of Object.entries(values)) {
        expect(Number.isFinite(value), name).toBe(true);
    }
};

const validateSample = (sample: SharedOpenBenchmarkSample, handles: number) => {
    expect(sample).toMatchObject({
        handles,
        sizeMiB: SIZE_MIB,
        sizeBytes: SIZE_BYTES,
        verifiedReadCalls: 1,
        targetHashCalls: 1,
        targetHashedBytes: SIZE_BYTES,
        readFileCalls: 0,
        readVersionCalls: 0,
        statCalls: handles + 1,
        writeFileCalls: 0,
    });
    expectFiniteNumbers({
        openMs: sample.openMs,
        verifiedCopyMs: sample.verifiedCopyMs,
        verifiedHashMs: sample.verifiedHashMs,
        retainedDeltaArrayBuffersBytes:
            sample.memory.retainedDeltaArrayBuffersBytes,
        afterReleaseDeltaArrayBuffersBytes:
            sample.memory.afterReleaseDeltaArrayBuffersBytes,
    });
    expect(sample.openMs).toBeGreaterThan(0);
    expect(sample.verifiedCopyMs).toBeGreaterThan(0);
    expect(sample.verifiedHashMs).toBeGreaterThan(0);
    for (const snapshot of [
        sample.memory.baseline,
        sample.memory.retained,
        sample.memory.afterRelease,
    ]) {
        expectFiniteNumbers(snapshot);
        for (const value of Object.values(snapshot)) {
            expect(value).toBeGreaterThanOrEqual(0);
        }
    }
    expect(sample.runtime.node).toMatch(/^v\d+/);
    expect(sample.runtime.platform.length).toBeGreaterThan(0);
    expect(sample.runtime.arch.length).toBeGreaterThan(0);
};

const roundedJson = (value: unknown) =>
    JSON.stringify(value, (_key, entry) =>
        typeof entry === "number" ? Number(entry.toFixed(3)) : entry
    );

manualDescribe("mount backend shared-open benchmark (manual)", () => {
    it(
        "loads and retains one verified 64 MiB state for eight descriptors",
        { timeout: HANDLE_COUNTS.length * CHILD_TIMEOUT_MS + 60_000 },
        async () => {
            const one = await runWorker(1);
            validateSample(one, 1);
            console.log(
                "mount-backend-shared-open-bench-sample:",
                roundedJson(one)
            );

            const eight = await runWorker(8);
            validateSample(eight, 8);
            console.log(
                "mount-backend-shared-open-bench-sample:",
                roundedJson(eight)
            );

            expect(
                eight.memory.retainedDeltaArrayBuffersBytes
            ).toBeLessThanOrEqual(SIZE_BYTES * 1.25);
            expect(
                eight.memory.retainedDeltaArrayBuffersBytes
            ).toBeLessThanOrEqual(
                Math.max(0, one.memory.retainedDeltaArrayBuffersBytes) * 1.1 +
                    FIXED_MEMORY_ALLOWANCE_BYTES
            );
            expect(
                one.memory.afterReleaseDeltaArrayBuffersBytes
            ).toBeLessThanOrEqual(AFTER_RELEASE_ALLOWANCE_BYTES);
            expect(
                eight.memory.afterReleaseDeltaArrayBuffersBytes
            ).toBeLessThanOrEqual(AFTER_RELEASE_ALLOWANCE_BYTES);

            const openLatencyRatio = eight.openMs / one.openMs;
            const retainedArrayBufferRatio =
                eight.memory.retainedDeltaArrayBuffersBytes /
                one.memory.retainedDeltaArrayBuffersBytes;
            expectFiniteNumbers({
                openLatencyRatio,
                retainedArrayBufferRatio,
            });
            // Timing is report-only: CPU frequency, allocator state and
            // scheduling noise can dominate a single isolated observation.
            console.log(
                "mount-backend-shared-open-bench-pair:",
                roundedJson({
                    sizeMiB: SIZE_MIB,
                    oneOpenMs: one.openMs,
                    eightOpenMs: eight.openMs,
                    openLatencyRatio,
                    oneRetainedArrayBuffersBytes:
                        one.memory.retainedDeltaArrayBuffersBytes,
                    eightRetainedArrayBuffersBytes:
                        eight.memory.retainedDeltaArrayBuffersBytes,
                    retainedArrayBufferRatio,
                })
            );
        }
    );
});
