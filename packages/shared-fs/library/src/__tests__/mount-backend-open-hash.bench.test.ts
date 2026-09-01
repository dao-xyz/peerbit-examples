import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const enabled = process.env.PEERBIT_SHARED_FS_MOUNT_OPEN_BENCH === "1";
const manualDescribe = enabled ? describe : describe.skip;
const SIZES_MIB = [4, 64, 256] as const;
const MODES = ["fallback", "verified"] as const;
const SAMPLES = 5;
const CHILD_TIMEOUT_MS = 5 * 60_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const workerPath = fileURLToPath(
    new URL("./mount-backend-open-hash.bench.worker.ts", import.meta.url)
);

type BenchmarkMode = (typeof MODES)[number];

type OpenHashBenchmarkSample = {
    mode: BenchmarkMode;
    sizeMiB: number;
    sizeBytes: number;
    samples: number;
    openP50Ms: number;
    targetCopyP50Ms: number;
    targetHashP50Ms: number;
    openP50MiBPerSecond: number;
    legacyReadCalls: number;
    verifiedReadCalls: number;
    targetHashCalls: number;
    targetHashedBytes: number;
    statCalls: number;
    writeFileCalls: number;
    runtime: {
        node: string;
        platform: string;
        arch: string;
    };
};

type WorkerMessage =
    | { type: "result"; sample: OpenHashBenchmarkSample }
    | { type: "fatal"; message: string; stack?: string };

const runningChildren = new Set<ChildProcess>();

afterEach(() => {
    for (const child of runningChildren) {
        child.kill();
    }
    runningChildren.clear();
});

const runWorker = (sizeMiB: number, mode: BenchmarkMode) =>
    new Promise<OpenHashBenchmarkSample>((resolve, reject) => {
        const child = fork(workerPath, [String(sizeMiB), mode], {
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
        let sample: OpenHashBenchmarkSample | undefined;
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
                    `Open-hash benchmark worker for ${mode} ${sizeMiB} MiB failed: ${error.message}${diagnostics()}`,
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
                            `Open-hash benchmark worker for ${mode} ${sizeMiB} MiB exited without a result (code=${code}, signal=${signal})${diagnostics()}`
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
                    `Open-hash benchmark worker for ${mode} ${sizeMiB} MiB exceeded ${CHILD_TIMEOUT_MS} ms${diagnostics()}`
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

const validateSample = (
    sample: OpenHashBenchmarkSample,
    sizeMiB: number,
    mode: BenchmarkMode
) => {
    expect(sample).toMatchObject({
        mode,
        sizeMiB,
        sizeBytes: sizeMiB * 1024 * 1024,
        samples: SAMPLES,
        legacyReadCalls: mode === "fallback" ? SAMPLES : 0,
        verifiedReadCalls: mode === "verified" ? SAMPLES : 0,
        targetHashCalls: SAMPLES,
        targetHashedBytes: SAMPLES * sizeMiB * 1024 * 1024,
        statCalls: SAMPLES * 2,
        writeFileCalls: 0,
    });
    expectFiniteNumbers({
        openP50Ms: sample.openP50Ms,
        targetCopyP50Ms: sample.targetCopyP50Ms,
        targetHashP50Ms: sample.targetHashP50Ms,
        openP50MiBPerSecond: sample.openP50MiBPerSecond,
    });
    expect(sample.openP50Ms).toBeGreaterThan(0);
    expect(sample.targetCopyP50Ms).toBeGreaterThanOrEqual(0);
    expect(sample.targetHashP50Ms).toBeGreaterThan(0);
    expect(sample.runtime.node).toMatch(/^v\d+/);
    expect(sample.runtime.platform.length).toBeGreaterThan(0);
    expect(sample.runtime.arch.length).toBeGreaterThan(0);
};

const roundedJson = (value: unknown) =>
    JSON.stringify(value, (_key, entry) =>
        typeof entry === "number" ? Number(entry.toFixed(3)) : entry
    );

manualDescribe("mount backend writable-open hash benchmark (manual)", () => {
    it(
        "compares fallback and target-verified exact-version opens",
        {
            timeout:
                SIZES_MIB.length * MODES.length * CHILD_TIMEOUT_MS + 60_000,
        },
        async () => {
            for (const sizeMiB of SIZES_MIB) {
                const fallback = await runWorker(sizeMiB, "fallback");
                validateSample(fallback, sizeMiB, "fallback");
                console.log(
                    "mount-backend-open-hash-bench-sample:",
                    roundedJson(fallback)
                );

                const verified = await runWorker(sizeMiB, "verified");
                validateSample(verified, sizeMiB, "verified");
                console.log(
                    "mount-backend-open-hash-bench-sample:",
                    roundedJson(verified)
                );

                const observedOpenDeltaMs =
                    verified.openP50Ms - fallback.openP50Ms;
                const fallbackToVerifiedRatio =
                    fallback.openP50Ms / verified.openP50Ms;
                expectFiniteNumbers({
                    observedOpenDeltaMs,
                    fallbackToVerifiedRatio,
                });
                // No timing budget: allocator, CPU-frequency and scheduler
                // noise can reverse a paired observation on a busy host.
                console.log(
                    "mount-backend-open-hash-bench-pair:",
                    roundedJson({
                        sizeMiB,
                        fallbackOpenP50Ms: fallback.openP50Ms,
                        verifiedOpenP50Ms: verified.openP50Ms,
                        observedOpenDeltaMs,
                        fallbackToVerifiedRatio,
                    })
                );
            }
        }
    );
});
