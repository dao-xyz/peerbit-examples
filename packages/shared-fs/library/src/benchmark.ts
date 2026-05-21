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
    largeFileSize?: number;
    smallFileCount?: number;
    smallFileSize?: number;
    cleanup?: boolean;
};

export type SharedFsBenchmarkResult = {
    root: string;
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

const measure = async (fn: () => Promise<void>) => {
    const started = Date.now();
    await fn();
    return Date.now() - started;
};

const patternedBytes = (size: number, seed = 0) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.byteLength; i++) {
        bytes[i] = (i + seed) % 251;
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

const cleanupTree = async (target: SharedFsBenchmarkTarget, root: string) => {
    const smallRoot = joinFsPath(root, "small");
    for (const entry of (await target.list(smallRoot).catch(() => [])) as {
        name: string;
    }[]) {
        await target.rm(joinFsPath(smallRoot, entry.name));
    }
    await target.rm(joinFsPath(root, "large.bin")).catch(() => {});
    await target.rm(smallRoot).catch(() => {});
    await target.rm(root).catch(() => {});
};

export const runSharedFsBenchmark = async (
    target: SharedFsBenchmarkTarget,
    options: SharedFsBenchmarkOptions = {}
): Promise<SharedFsBenchmarkResult> => {
    const root = normalizeFsPath(
        options.root ?? `/.peerbit-benchmark-${Date.now()}`
    );
    const largeFileSize = options.largeFileSize ?? 16 * 1024 * 1024;
    const smallFileCount = options.smallFileCount ?? 200;
    const smallFileSize = options.smallFileSize ?? 1024;
    const largePath = joinFsPath(root, "large.bin");
    const smallRoot = joinFsPath(root, "small");

    await target.mkdir(root);
    await target.mkdir(smallRoot);

    const largeFile = patternedBytes(largeFileSize);
    const largeWriteMs = await measure(async () => {
        await target.writeFile(largePath, largeFile);
    });
    const largeReadMs = await measure(async () => {
        assertBytesEqual(await target.readFile(largePath), largeFile);
    });

    const smallWriteMs = await measure(async () => {
        for (let i = 0; i < smallFileCount; i++) {
            await target.writeFile(
                joinFsPath(smallRoot, `file-${String(i).padStart(5, "0")}.bin`),
                patternedBytes(smallFileSize, i)
            );
        }
    });

    const listMs = await measure(async () => {
        const entries = await target.list(smallRoot);
        if (entries.length !== smallFileCount) {
            throw new Error(
                `Expected ${smallFileCount} small files, got ${entries.length}`
            );
        }
    });

    const smallReadMs = await measure(async () => {
        for (let i = 0; i < smallFileCount; i++) {
            assertBytesEqual(
                await target.readFile(
                    joinFsPath(
                        smallRoot,
                        `file-${String(i).padStart(5, "0")}.bin`
                    )
                ),
                patternedBytes(smallFileSize, i)
            );
        }
    });

    const result = {
        root,
        largeFile: {
            bytes: largeFileSize,
            writeMs: largeWriteMs,
            readMs: largeReadMs,
            writeMbps: bytesPerMsToMbps(largeFileSize, largeWriteMs),
            readMbps: bytesPerMsToMbps(largeFileSize, largeReadMs),
        },
        smallFiles: {
            count: smallFileCount,
            bytesPerFile: smallFileSize,
            writeMs: smallWriteMs,
            listMs,
            readMs: smallReadMs,
            filesPerSecondWrite: filesPerSecond(smallFileCount, smallWriteMs),
            filesPerSecondRead: filesPerSecond(smallFileCount, smallReadMs),
        },
    };

    if (options.cleanup) {
        await cleanupTree(target, root);
    }

    return result;
};
