import { randomBytes, sha256Sync, toBase64URL } from "@peerbit/crypto";
import { joinFsPath, normalizeFsPath } from "./path.js";

export type SharedFsBenchmarkTarget = {
    readFile(path: string): Promise<Uint8Array | undefined>;
    writeFile(path: string, source: Uint8Array | string): Promise<unknown>;
    mkdir(path: string): Promise<unknown>;
    rm(path: string): Promise<unknown>;
    list(path?: string): Promise<unknown[]>;
};

export type SharedFsBenchmarkOptions = {
    root?: string;
    /** Reuse a seed to reproduce the exact byte corpus across benchmark runs. */
    seed?: string;
    largeFileSize?: number;
    smallFileCount?: number;
    smallFileSize?: number;
    cleanup?: boolean;
};

export type SharedFsBenchmarkResult = {
    root: string;
    /** Present on results returned by `runSharedFsBenchmark`. */
    seed?: string;
    largeFile: {
        bytes: number;
        writeMs: number;
        readMs: number;
        writeMbps: number;
        readMbps: number;
    };
    smallFiles: {
        count: number;
        bytesPerFile: number;
        writeMs: number;
        listMs: number;
        readMs: number;
        filesPerSecondWrite: number;
        filesPerSecondRead: number;
    };
};

export type SharedFsBenchmarkRunResult = SharedFsBenchmarkResult & {
    /** The corpus seed. Pass it back as `seed` to reproduce the same bytes. */
    seed: string;
};

type Timed<T> = {
    value: T;
    ms: number;
};

const bytesPerMsToMbps = (bytes: number, ms: number) => {
    if (ms <= 0) {
        return 0;
    }
    return (bytes * 8) / 1_000_000 / (ms / 1_000);
};

const filesPerSecond = (files: number, ms: number) => {
    if (ms <= 0) {
        return 0;
    }
    return files / (ms / 1_000);
};

const now = () =>
    typeof globalThis.performance?.now === "function"
        ? globalThis.performance.now()
        : Date.now();

const measure = async <T>(fn: () => Promise<T>): Promise<Timed<T>> => {
    const started = now();
    const value = await fn();
    return { value, ms: now() - started };
};

const defaultCorpusSeed = () => toBase64URL(randomBytes(24));

const textEncoder = new TextEncoder();

const assertNonNegativeInteger = (name: string, value: number) => {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a finite non-negative integer`);
    }
};

const rotateLeft = (value: number, bits: number) =>
    (value << bits) | (value >>> (32 - bits));

/**
 * Create a fast deterministic byte stream from a SHA-256-derived 128-bit
 * xoshiro state. Corpus creation is deliberately outside all timed I/O.
 */
const corpusBytes = (size: number, seed: string, stream: string) => {
    const digest = sha256Sync(textEncoder.encode(`${seed}\0${stream}`));
    const digestView = new DataView(
        digest.buffer,
        digest.byteOffset,
        digest.byteLength
    );
    const state: number[] = [
        digestView.getUint32(0, true),
        digestView.getUint32(4, true),
        digestView.getUint32(8, true),
        digestView.getUint32(12, true),
    ];
    const allZero = state.reduce((bits, word) => bits | word, 0) === 0;
    if (allZero) {
        state[0] = 1;
    }

    const bytes = new Uint8Array(size);
    let word = 0;
    for (let offset = 0; offset < size; offset++) {
        if ((offset & 3) === 0) {
            word = Math.imul(rotateLeft(Math.imul(state[1], 5), 7), 9);
            const shifted = state[1] << 9;
            state[2] ^= state[0];
            state[3] ^= state[1];
            state[1] ^= state[2];
            state[0] ^= state[3];
            state[2] ^= shifted;
            state[3] = rotateLeft(state[3], 11);
        }
        bytes[offset] = word >>> ((offset & 3) * 8);
    }
    return bytes;
};

const assertBytesEqual = (
    actual: Uint8Array | undefined,
    expected: Uint8Array
) => {
    if (!actual) {
        throw new Error("Expected file bytes, got undefined");
    }
    if (actual.byteLength !== expected.byteLength) {
        throw new Error(
            `Expected ${expected.byteLength} bytes, got ${actual.byteLength}`
        );
    }
    for (let i = 0; i < expected.byteLength; i++) {
        if (actual[i] !== expected[i]) {
            throw new Error(`Byte mismatch at offset ${i}`);
        }
    }
};

const smallFilePath = (smallRoot: string, index: number) =>
    joinFsPath(smallRoot, `file-${String(index).padStart(5, "0")}.bin`);

const cleanupTree = async (
    target: SharedFsBenchmarkTarget,
    root: string,
    smallFileCount: number
) => {
    const smallRoot = joinFsPath(root, "small");
    let firstError: unknown;
    let failed = false;
    const remove = async (path: string) => {
        try {
            await target.rm(path);
        } catch (error) {
            if (!failed) {
                failed = true;
                firstError = error;
            }
        }
    };
    for (let index = 0; index < smallFileCount; index++) {
        await remove(smallFilePath(smallRoot, index));
    }
    await remove(joinFsPath(root, "large.bin"));
    await remove(smallRoot);
    await remove(root);
    if (failed) {
        throw firstError;
    }
};

export const runSharedFsBenchmark = async (
    target: SharedFsBenchmarkTarget,
    options: SharedFsBenchmarkOptions = {}
): Promise<SharedFsBenchmarkRunResult> => {
    const seed = options.seed ?? defaultCorpusSeed();
    const largeFileSize = options.largeFileSize ?? 16 * 1024 * 1024;
    const smallFileCount = options.smallFileCount ?? 200;
    const smallFileSize = options.smallFileSize ?? 1024;
    assertNonNegativeInteger("largeFileSize", largeFileSize);
    assertNonNegativeInteger("smallFileCount", smallFileCount);
    assertNonNegativeInteger("smallFileSize", smallFileSize);
    const seedToken = toBase64URL(sha256Sync(textEncoder.encode(seed))).slice(
        0,
        10
    );
    const root = normalizeFsPath(
        options.root ?? `/fs-benchmark-${Date.now()}-${seedToken}`
    );
    if (root === "/") {
        throw new Error("Benchmark root must not be the filesystem root");
    }
    const largePath = joinFsPath(root, "large.bin");
    const smallRoot = joinFsPath(root, "small");
    const largeFile = corpusBytes(largeFileSize, seed, "large");

    let benchmarkError: unknown;
    let benchmarkFailed = false;
    let ownsRoot = false;
    let result!: SharedFsBenchmarkRunResult;
    try {
        await target.mkdir(root);
        ownsRoot = true;
        await target.mkdir(smallRoot);

        const largeWrite = await measure(() =>
            target.writeFile(largePath, largeFile)
        );
        const largeRead = await measure(() => target.readFile(largePath));
        assertBytesEqual(largeRead.value, largeFile);

        let smallWriteMs = 0;
        for (let index = 0; index < smallFileCount; index++) {
            const bytes = corpusBytes(smallFileSize, seed, `small:${index}`);
            const write = await measure(() =>
                target.writeFile(smallFilePath(smallRoot, index), bytes)
            );
            smallWriteMs += write.ms;
        }

        const list = await measure(() => target.list(smallRoot));
        if (list.value.length !== smallFileCount) {
            throw new Error(
                `Expected ${smallFileCount} small files, got ${list.value.length}`
            );
        }

        let smallReadMs = 0;
        for (let index = 0; index < smallFileCount; index++) {
            const read = await measure(() =>
                target.readFile(smallFilePath(smallRoot, index))
            );
            smallReadMs += read.ms;
            assertBytesEqual(
                read.value,
                corpusBytes(smallFileSize, seed, `small:${index}`)
            );
        }

        result = {
            root,
            seed,
            largeFile: {
                bytes: largeFileSize,
                writeMs: largeWrite.ms,
                readMs: largeRead.ms,
                writeMbps: bytesPerMsToMbps(largeFileSize, largeWrite.ms),
                readMbps: bytesPerMsToMbps(largeFileSize, largeRead.ms),
            },
            smallFiles: {
                count: smallFileCount,
                bytesPerFile: smallFileSize,
                writeMs: smallWriteMs,
                listMs: list.ms,
                readMs: smallReadMs,
                filesPerSecondWrite: filesPerSecond(
                    smallFileCount,
                    smallWriteMs
                ),
                filesPerSecondRead: filesPerSecond(smallFileCount, smallReadMs),
            },
        };
    } catch (error) {
        benchmarkFailed = true;
        benchmarkError = error;
    }

    let cleanupError: unknown;
    let cleanupFailed = false;
    if (options.cleanup && ownsRoot) {
        try {
            await cleanupTree(target, root, smallFileCount);
        } catch (error) {
            cleanupFailed = true;
            cleanupError = error;
        }
    }

    if (benchmarkFailed) {
        throw benchmarkError;
    }
    if (cleanupFailed) {
        throw cleanupError;
    }
    return result;
};
