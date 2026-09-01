import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const enabled = process.env.PEERBIT_SHARED_FS_MOUNT_COW_BENCH === "1";
const manualDescribe = enabled ? describe : describe.skip;
const SIZES_MIB = [4, 64, 256] as const;
const CHILD_TIMEOUT_MS = 5 * 60_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const workerPath = fileURLToPath(
    new URL("./mount-backend-cow.bench.worker.ts", import.meta.url)
);

type MemorySnapshot = {
    rssBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    maxRssBytes: number;
};

type CowBenchmarkSample = {
    sizeMiB: number;
    sizeBytes: number;
    commitEnterMs: number;
    commitFinalizeMs: number;
    retainedCowWriteMs: number;
    commitEnterMiBPerSecond: number;
    retainedCowWriteMiBPerSecond: number;
    writeFileCalls: number;
    snapshotPreserved: boolean;
    liveMutationPreserved: boolean;
    memory: {
        baseline: MemorySnapshot;
        commitHeld: MemorySnapshot;
        commitSettled: MemorySnapshot;
        afterRetainedCowWrite: MemorySnapshot;
        deltas: {
            commitHeldVsBaseline: MemorySnapshot;
            commitSettledVsBaseline: MemorySnapshot;
            retainedCowWriteVsCommitSettled: MemorySnapshot;
        };
    };
    runtime: {
        node: string;
        platform: string;
        arch: string;
    };
};

type WorkerMessage =
    | { type: "result"; sample: CowBenchmarkSample }
    | { type: "fatal"; message: string; stack?: string };

const runningChildren = new Set<ChildProcess>();

afterEach(() => {
    for (const child of runningChildren) {
        child.kill();
    }
    runningChildren.clear();
});

const runWorker = (sizeMiB: number) =>
    new Promise<CowBenchmarkSample>((resolve, reject) => {
        const child = fork(workerPath, [String(sizeMiB)], {
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
        let sample: CowBenchmarkSample | undefined;
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
                    `COW benchmark worker for ${sizeMiB} MiB failed: ${error.message}${diagnostics()}`,
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
                            `COW benchmark worker for ${sizeMiB} MiB exited without a result (code=${code}, signal=${signal})${diagnostics()}`
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
                    `COW benchmark worker for ${sizeMiB} MiB exceeded ${CHILD_TIMEOUT_MS} ms${diagnostics()}`
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

const validateSample = (sample: CowBenchmarkSample, sizeMiB: number) => {
    expect(sample).toMatchObject({
        sizeMiB,
        sizeBytes: sizeMiB * 1024 * 1024,
        writeFileCalls: 1,
        snapshotPreserved: true,
        liveMutationPreserved: true,
    });
    expectFiniteNumbers({
        commitEnterMs: sample.commitEnterMs,
        commitFinalizeMs: sample.commitFinalizeMs,
        retainedCowWriteMs: sample.retainedCowWriteMs,
        commitEnterMiBPerSecond: sample.commitEnterMiBPerSecond,
        retainedCowWriteMiBPerSecond: sample.retainedCowWriteMiBPerSecond,
    });
    for (const snapshot of [
        sample.memory.baseline,
        sample.memory.commitHeld,
        sample.memory.commitSettled,
        sample.memory.afterRetainedCowWrite,
    ]) {
        expectFiniteNumbers(snapshot);
        for (const value of Object.values(snapshot)) {
            expect(value).toBeGreaterThanOrEqual(0);
        }
    }
    for (const delta of Object.values(sample.memory.deltas)) {
        // GC and allocator noise can make a descriptive delta negative. Only
        // require a complete numeric report; this benchmark has no budgets.
        expectFiniteNumbers(delta);
    }
    expect(sample.runtime.node).toMatch(/^v\d+/);
    expect(sample.runtime.platform.length).toBeGreaterThan(0);
    expect(sample.runtime.arch.length).toBeGreaterThan(0);
};

const roundedJson = (value: unknown) =>
    JSON.stringify(value, (_key, entry) =>
        typeof entry === "number" ? Number(entry.toFixed(3)) : entry
    );

manualDescribe("mount backend copy-on-write benchmark (manual)", () => {
    it(
        "reports isolated commit and retained-snapshot COW cost",
        { timeout: SIZES_MIB.length * CHILD_TIMEOUT_MS + 60_000 },
        async () => {
            const samples: CowBenchmarkSample[] = [];
            for (const sizeMiB of SIZES_MIB) {
                const sample = await runWorker(sizeMiB);
                validateSample(sample, sizeMiB);
                samples.push(sample);
                // Preserve each completed size if a larger child later fails.
                console.log(
                    "mount-backend-cow-bench-sample:",
                    roundedJson(sample)
                );
            }
            console.log(
                "mount-backend-cow-bench:",
                roundedJson({ sizesMiB: SIZES_MIB, samples })
            );
        }
    );
});
