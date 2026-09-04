import { describe, expect, it, vi } from "vitest";
import {
    runSharedFsBenchmark,
    type SharedFsBenchmarkTarget,
} from "../benchmark.js";

class MemoryBenchmarkTarget implements SharedFsBenchmarkTarget {
    readonly directories = new Set(["/"]);
    readonly files = new Map<string, Uint8Array>();
    readonly removed: string[] = [];
    readonly mutations: string[] = [];
    transformRead?: (
        path: string,
        bytes: Uint8Array | undefined
    ) => Uint8Array | undefined;
    failRemoval?: (path: string) => Error | undefined;

    async readFile(path: string) {
        const stored = this.files.get(path);
        const bytes = stored ? new Uint8Array(stored) : undefined;
        return this.transformRead ? this.transformRead(path, bytes) : bytes;
    }

    async writeFile(path: string, source: Uint8Array | string) {
        this.mutations.push(`write:${path}`);
        this.files.set(
            path,
            typeof source === "string"
                ? new TextEncoder().encode(source)
                : new Uint8Array(source)
        );
    }

    async mkdir(path: string) {
        this.mutations.push(`mkdir:${path}`);
        if (this.directories.has(path)) {
            throw Object.assign(new Error(`Path already exists: ${path}`), {
                code: "EEXIST",
            });
        }
        this.directories.add(path);
    }

    async rm(path: string) {
        this.removed.push(path);
        const failure = this.failRemoval?.(path);
        if (failure) {
            throw failure;
        }
        if (this.files.delete(path)) {
            return;
        }
        if (this.directories.has(path)) {
            const prefix = `${path}/`;
            if (
                [...this.files.keys(), ...this.directories].some(
                    (candidate) =>
                        candidate !== path && candidate.startsWith(prefix)
                )
            ) {
                throw Object.assign(new Error(`Directory not empty: ${path}`), {
                    code: "ENOTEMPTY",
                });
            }
            this.directories.delete(path);
        }
    }

    async list(path = "/") {
        const prefix = path === "/" ? "/" : `${path}/`;
        return [...this.files.keys()]
            .filter((candidate) => {
                if (!candidate.startsWith(prefix)) {
                    return false;
                }
                return !candidate.slice(prefix.length).includes("/");
            })
            .map((candidate) => ({ name: candidate.slice(prefix.length) }));
    }
}

const options = (root: string, seed: string) => ({
    root,
    seed,
    largeFileSize: 257,
    smallFileCount: 3,
    smallFileSize: 17,
});

const corpusSnapshot = (target: MemoryBenchmarkTarget, root: string) =>
    [...target.files.entries()]
        .filter(([path]) => path.startsWith(`${root}/`))
        .map(([path, bytes]) => [path.slice(root.length), Array.from(bytes)])
        .sort(([left], [right]) => String(left).localeCompare(String(right)));

describe("shared fs baseline benchmark", () => {
    it("reproduces the exact corpus for an explicit seed", async () => {
        const first = new MemoryBenchmarkTarget();
        const second = new MemoryBenchmarkTarget();

        const firstResult = await runSharedFsBenchmark(
            first,
            options("/first", "repeatable-seed")
        );
        const secondResult = await runSharedFsBenchmark(
            second,
            options("/second", "repeatable-seed")
        );

        expect(firstResult.seed).toBe("repeatable-seed");
        expect(secondResult.seed).toBe("repeatable-seed");
        expect(corpusSnapshot(first, "/first")).toEqual(
            corpusSnapshot(second, "/second")
        );
    });

    it("changes the write corpus when the seed changes", async () => {
        const first = new MemoryBenchmarkTarget();
        const second = new MemoryBenchmarkTarget();

        await runSharedFsBenchmark(first, options("/first", "seed-one"));
        await runSharedFsBenchmark(second, options("/second", "seed-two"));

        expect(corpusSnapshot(first, "/first")).not.toEqual(
            corpusSnapshot(second, "/second")
        );
    });

    it("does not repeat the old 251-file patterned corpus", async () => {
        const target = new MemoryBenchmarkTarget();
        await runSharedFsBenchmark(target, {
            root: "/many-small",
            seed: "many-small-seed",
            largeFileSize: 1,
            smallFileCount: 252,
            smallFileSize: 32,
        });

        expect(
            target.files.get("/many-small/small/file-00000.bin")
        ).not.toEqual(target.files.get("/many-small/small/file-00251.bin"));
    });

    it("uses a fresh collision-resistant default corpus seed", async () => {
        const first = new MemoryBenchmarkTarget();
        const second = new MemoryBenchmarkTarget();

        const firstResult = await runSharedFsBenchmark(first, {
            ...options("/first", "unused"),
            seed: undefined,
        });
        const secondResult = await runSharedFsBenchmark(second, {
            ...options("/second", "unused"),
            seed: undefined,
        });

        expect(firstResult.seed).not.toBe(secondResult.seed);
        expect(corpusSnapshot(first, "/first")).not.toEqual(
            corpusSnapshot(second, "/second")
        );
    });

    it("stops the high-resolution read timer before verifying bytes", async () => {
        const events: string[] = [];
        let timestamp = 0;
        const now = vi
            .spyOn(globalThis.performance, "now")
            .mockImplementation(() => {
                events.push("clock");
                timestamp += 0.25;
                return timestamp;
            });
        const target = new MemoryBenchmarkTarget();
        target.transformRead = (path, bytes) => {
            if (!path.endsWith("/large.bin") || !bytes) {
                return bytes;
            }
            events.push("large-read");
            return new Proxy(bytes, {
                get(value, property) {
                    if (
                        property === "byteLength" ||
                        (typeof property === "string" && /^\d+$/.test(property))
                    ) {
                        events.push("verify-byte");
                    }
                    return Reflect.get(value, property, value);
                },
            });
        };

        try {
            const result = await runSharedFsBenchmark(target, {
                root: "/timing",
                seed: "timing-seed",
                largeFileSize: 8,
                smallFileCount: 0,
            });

            const readIndex = events.indexOf("large-read");
            const clockAfterRead = events.indexOf("clock", readIndex);
            const verificationIndex = events.indexOf("verify-byte", readIndex);
            expect(readIndex).toBeGreaterThan(-1);
            expect(clockAfterRead).toBeGreaterThan(readIndex);
            expect(verificationIndex).toBeGreaterThan(clockAfterRead);
            expect(result.largeFile.readMs).toBe(0.25);
        } finally {
            now.mockRestore();
        }
    });

    it.each(["large", "small"])(
        "fully verifies corrupt %s-file reads",
        async (kind) => {
            const target = new MemoryBenchmarkTarget();
            target.transformRead = (path, bytes) => {
                const shouldCorrupt =
                    kind === "large"
                        ? path.endsWith("/large.bin")
                        : path.endsWith("/file-00000.bin");
                if (!shouldCorrupt || !bytes || bytes.byteLength === 0) {
                    return bytes;
                }
                bytes[bytes.byteLength - 1] ^= 0xff;
                return bytes;
            };

            await expect(
                runSharedFsBenchmark(target, {
                    root: `/corrupt-${kind}`,
                    seed: "verification-seed",
                    largeFileSize: 8,
                    smallFileCount: 1,
                    smallFileSize: 8,
                })
            ).rejects.toThrow("Byte mismatch at offset 7");
        }
    );

    it("cleans only generated paths after failure and preserves the primary error", async () => {
        const target = new MemoryBenchmarkTarget();
        target.transformRead = (path, bytes) => {
            if (path.endsWith("/large.bin") && bytes) {
                bytes[0] ^= 0xff;
            }
            return bytes;
        };
        target.failRemoval = (path) =>
            path.endsWith("/large.bin")
                ? new Error("injected cleanup failure")
                : undefined;

        await expect(
            runSharedFsBenchmark(target, {
                root: "/cleanup-failure",
                seed: "cleanup-seed",
                largeFileSize: 8,
                smallFileCount: 2,
                smallFileSize: 4,
                cleanup: true,
            })
        ).rejects.toThrow("Byte mismatch at offset 0");

        expect(target.removed).toEqual([
            "/cleanup-failure/small/file-00000.bin",
            "/cleanup-failure/small/file-00001.bin",
            "/cleanup-failure/large.bin",
            "/cleanup-failure/small",
            "/cleanup-failure",
        ]);
    });

    it("never removes paths when cleanup is disabled", async () => {
        const target = new MemoryBenchmarkTarget();
        await runSharedFsBenchmark(target, {
            ...options("/no-cleanup", "no-cleanup-seed"),
            cleanup: false,
        });
        expect(target.removed).toEqual([]);
    });

    it("removes the exact generated tree when cleanup succeeds", async () => {
        const target = new MemoryBenchmarkTarget();
        await runSharedFsBenchmark(target, {
            root: "/clean",
            seed: "successful-cleanup-seed",
            largeFileSize: 8,
            smallFileCount: 2,
            smallFileSize: 4,
            cleanup: true,
        });

        expect(target.removed).toEqual([
            "/clean/small/file-00000.bin",
            "/clean/small/file-00001.bin",
            "/clean/large.bin",
            "/clean/small",
            "/clean",
        ]);
        expect(target.files.size).toBe(0);
        expect([...target.directories]).toEqual(["/"]);
    });

    it("reports cleanup failure after an otherwise successful workload", async () => {
        const target = new MemoryBenchmarkTarget();
        target.failRemoval = (path) =>
            path.endsWith("/large.bin")
                ? new Error("injected cleanup failure")
                : undefined;

        await expect(
            runSharedFsBenchmark(target, {
                root: "/cleanup-error",
                seed: "cleanup-error-seed",
                largeFileSize: 8,
                smallFileCount: 1,
                smallFileSize: 4,
                cleanup: true,
            })
        ).rejects.toThrow("injected cleanup failure");
    });

    it("validates the root and workload sizes before mutating the target", async () => {
        for (const invalidOptions of [
            { root: "/", largeFileSize: 1 },
            { root: "/invalid", largeFileSize: -1 },
            { root: "/invalid", smallFileCount: Number.POSITIVE_INFINITY },
            { root: "/invalid", smallFileSize: 1.5 },
        ]) {
            const target = new MemoryBenchmarkTarget();
            await expect(
                runSharedFsBenchmark(target, {
                    ...invalidOptions,
                    seed: "validation-seed",
                })
            ).rejects.toThrow();
            expect(target.mutations).toEqual([]);
            expect(target.removed).toEqual([]);
        }
    });

    it("does not clean a root it failed to create", async () => {
        const target = new MemoryBenchmarkTarget();
        target.directories.add("/existing");

        await expect(
            runSharedFsBenchmark(target, {
                root: "/existing",
                seed: "existing-root-seed",
                largeFileSize: 1,
                smallFileCount: 1,
                smallFileSize: 1,
                cleanup: true,
            })
        ).rejects.toThrow("Path already exists");
        expect(target.removed).toEqual([]);
    });
});
