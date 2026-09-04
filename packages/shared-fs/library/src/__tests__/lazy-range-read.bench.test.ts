import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const enabled = process.env.PEERBIT_SHARED_FS_RANGE_READ_BENCH === "1";
const manualDescribe = enabled ? describe : describe.skip;
const ALLOWED_SIZES_MIB = new Set([16, 64, 256]);
const requestedSizes = (
    process.env.PEERBIT_SHARED_FS_RANGE_READ_BENCH_SIZES ?? "16,64"
)
    .split(",")
    .map((value) => Number(value.trim()));
const SIZES_MIB = [...new Set(requestedSizes)];
if (
    SIZES_MIB.length === 0 ||
    SIZES_MIB.some(
        (value) => !Number.isInteger(value) || !ALLOWED_SIZES_MIB.has(value)
    )
) {
    throw new Error(
        "PEERBIT_SHARED_FS_RANGE_READ_BENCH_SIZES must be a comma-separated subset of 16,64,256"
    );
}
const MODES = ["eager", "lazy"] as const;
const READS = 16;
const READ_SIZE = 4096;
const CHILD_TIMEOUT_MS = 5 * 60_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const workerPath = fileURLToPath(
    new URL("./lazy-range-read.bench.worker.ts", import.meta.url)
);

type BenchmarkMode = (typeof MODES)[number];
type Phase = {
    p50Ms: number;
    p95Ms: number;
    totalMs: number;
    fetchedChunks: number;
    fetchedBytes: number;
};
type LazyRangeBenchmarkSample = {
    mode: BenchmarkMode;
    sizeMiB: number;
    sizeBytes: number;
    reads: number;
    readSize: number;
    logicalReadBytes: number;
    openMs: number;
    openFetchedChunks: number;
    openFetchedBytes: number;
    cold: Phase;
    warm: Phase;
    runtime: { node: string; platform: string; arch: string };
};
type WorkerMessage =
    | { type: "result"; sample: LazyRangeBenchmarkSample }
    | { type: "fatal"; message: string; stack?: string };

const runningChildren = new Set<ChildProcess>();

afterEach(() => {
    for (const child of runningChildren) child.kill();
    runningChildren.clear();
});

const runWorker = (sizeMiB: number, mode: BenchmarkMode) =>
    new Promise<LazyRangeBenchmarkSample>((resolve, reject) => {
        const child = fork(workerPath, [String(sizeMiB), mode], {
            execArgv: ["--enable-source-maps", "--import", "tsx"],
            env: { ...process.env, NODE_ENV: "test" },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            windowsHide: true,
        });
        runningChildren.add(child);
        let output = "";
        let sample: LazyRangeBenchmarkSample | undefined;
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
        const onError = (error: Error) =>
            fail(
                new Error(
                    `Lazy-range benchmark worker for ${mode} ${sizeMiB} MiB failed: ${error.message}${diagnostics()}`,
                    { cause: error }
                )
            );
        const onClose = (
            code: number | null,
            signal: NodeJS.Signals | null
        ) => {
            if (settled) return;
            if (code !== 0 || !sample) {
                fail(
                    new Error(
                        fatal ??
                            `Lazy-range benchmark worker for ${mode} ${sizeMiB} MiB exited without a result (code=${code}, signal=${signal})${diagnostics()}`
                    )
                );
                return;
            }
            settled = true;
            cleanup();
            resolve(sample);
        };
        const timeout = setTimeout(
            () =>
                fail(
                    new Error(
                        `Lazy-range benchmark worker for ${mode} ${sizeMiB} MiB exceeded ${CHILD_TIMEOUT_MS} ms${diagnostics()}`
                    )
                ),
            CHILD_TIMEOUT_MS
        );

        child.on("message", onMessage);
        child.once("error", onError);
        child.once("close", onClose);
    });

const expectFinite = (sample: LazyRangeBenchmarkSample) => {
    for (const [name, value] of Object.entries({
        openMs: sample.openMs,
        coldP50Ms: sample.cold.p50Ms,
        coldP95Ms: sample.cold.p95Ms,
        coldTotalMs: sample.cold.totalMs,
        warmP50Ms: sample.warm.p50Ms,
        warmP95Ms: sample.warm.p95Ms,
        warmTotalMs: sample.warm.totalMs,
    })) {
        expect(Number.isFinite(value), name).toBe(true);
        expect(value, name).toBeGreaterThanOrEqual(0);
    }
};

const validateSample = (
    sample: LazyRangeBenchmarkSample,
    sizeMiB: number,
    mode: BenchmarkMode
) => {
    const sizeBytes = sizeMiB * 1024 * 1024;
    expect(sample).toMatchObject({
        mode,
        sizeMiB,
        sizeBytes,
        reads: READS,
        readSize: READ_SIZE,
        logicalReadBytes: READS * READ_SIZE,
    });
    expectFinite(sample);
    expect(sample.runtime.node).toMatch(/^v\d+/);
    expect(sample.runtime.platform.length).toBeGreaterThan(0);
    expect(sample.runtime.arch.length).toBeGreaterThan(0);
    expect(sample.warm).toMatchObject({
        fetchedChunks: 0,
        fetchedBytes: 0,
    });
    if (mode === "lazy") {
        expect(sample.openFetchedChunks).toBe(1); // zero-byte marker
        expect(sample.openFetchedBytes).toBe(0);
        expect(sample.cold.fetchedChunks).toBe(READS);
        expect(sample.cold.fetchedBytes).toBe(READS * 512 * 1024);
    } else {
        expect(sample.openFetchedChunks).toBe(sizeBytes / (512 * 1024) + 1);
        expect(sample.openFetchedBytes).toBe(sizeBytes);
        expect(sample.cold).toMatchObject({
            fetchedChunks: 0,
            fetchedBytes: 0,
        });
    }
};

const roundedJson = (value: unknown) =>
    JSON.stringify(value, (_key, entry) =>
        typeof entry === "number" ? Number(entry.toFixed(3)) : entry
    );

manualDescribe("mount backend lazy range-read benchmark (manual)", () => {
    it(
        "compares cold and warm random 4 KiB reads with eager exact opens",
        {
            timeout:
                SIZES_MIB.length * MODES.length * CHILD_TIMEOUT_MS + 60_000,
        },
        async () => {
            for (const sizeMiB of SIZES_MIB) {
                const eager = await runWorker(sizeMiB, "eager");
                validateSample(eager, sizeMiB, "eager");
                console.log(
                    "mount-backend-range-read-bench-sample:",
                    roundedJson(eager)
                );

                const lazy = await runWorker(sizeMiB, "lazy");
                validateSample(lazy, sizeMiB, "lazy");
                console.log(
                    "mount-backend-range-read-bench-sample:",
                    roundedJson(lazy)
                );

                // Timing is descriptive. The byte counters are the hard
                // behavioral assertion: eager open fetches the whole file,
                // while a cold lazy 4 KiB read fetches one 512 KiB chunk.
                console.log(
                    "mount-backend-range-read-bench-pair:",
                    roundedJson({
                        sizeMiB,
                        eagerOpenMs: eager.openMs,
                        lazyOpenMs: lazy.openMs,
                        eagerOpenPlusColdMs: eager.openMs + eager.cold.totalMs,
                        lazyOpenPlusColdMs: lazy.openMs + lazy.cold.totalMs,
                        eagerFetchedBytes:
                            eager.openFetchedBytes + eager.cold.fetchedBytes,
                        lazyFetchedBytes:
                            lazy.openFetchedBytes + lazy.cold.fetchedBytes,
                        lazyColdReadAmplification:
                            lazy.cold.fetchedBytes / lazy.logicalReadBytes,
                    })
                );
            }
        }
    );
});
