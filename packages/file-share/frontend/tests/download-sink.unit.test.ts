import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
    BoundedDownloadUnavailableError,
    cleanupOpfsDownloadsOnStartup,
    cleanupStaleOpfsDownloads,
    createOpfsDownloadWriter,
    DEFAULT_BOUNDED_DOWNLOAD_THRESHOLD_BYTES,
    DEFAULT_OPFS_CRASH_RECOVERY_MS,
    DEFAULT_OPFS_DOWNLOAD_RETENTION_MS,
    requiresBoundedDownload,
    sanitizeDownloadFileName,
    type OpfsDirectoryHandle,
    type OpfsDownloadDependencies,
} from "../src/download-sink";

type StoredFile = {
    chunks: Uint8Array[];
    closed: boolean;
    aborted: boolean;
};

const sha256 = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");

const createOpfsHarness = () => {
    const files = new Map<string, StoredFile>();
    const removed: string[] = [];
    const revoked: string[] = [];
    const downloads: Array<{ url: string; fileName: string }> = [];
    const objectUrlFiles: Blob[] = [];
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const lockedNames = new Set<string>();
    const removeFailures = new Map<string, number>();
    let token = 0;
    let writeCalls = 0;
    let now = 10_000;

    const directory: OpfsDirectoryHandle = {
        async getFileHandle(name, options) {
            let stored = files.get(name);
            if (!stored && options?.create) {
                stored = { chunks: [], closed: false, aborted: false };
                files.set(name, stored);
            }
            if (!stored) {
                throw new DOMException("Missing", "NotFoundError");
            }
            return {
                async createWritable() {
                    return {
                        async write(bytes: Uint8Array) {
                            if (stored!.closed || stored!.aborted) {
                                throw new Error("Stored file is not writable");
                            }
                            writeCalls += 1;
                            stored!.chunks.push(new Uint8Array(bytes));
                        },
                        async close() {
                            if (stored!.closed || stored!.aborted) {
                                throw new Error(
                                    "Stored file is already finished"
                                );
                            }
                            stored!.closed = true;
                        },
                        async abort() {
                            stored!.aborted = true;
                            stored!.chunks = [];
                        },
                    };
                },
                async getFile() {
                    return new Blob(stored!.chunks);
                },
            };
        },
        async removeEntry(name) {
            const failuresRemaining = removeFailures.get(name) ?? 0;
            if (failuresRemaining > 0) {
                removeFailures.set(name, failuresRemaining - 1);
                throw new DOMException("Storage busy", "InvalidStateError");
            }
            if (!files.delete(name)) {
                throw new DOMException("Missing", "NotFoundError");
            }
            removed.push(name);
        },
        async *entries() {
            for (const name of [...files.keys()]) {
                yield [name, {}] as [string, unknown];
            }
        },
    };

    const dependencies: OpfsDownloadDependencies = {
        getDirectory: async () => directory,
        createObjectURL: (file) => {
            objectUrlFiles.push(file);
            return `blob:test-${objectUrlFiles.length}`;
        },
        revokeObjectURL: (url) => {
            revoked.push(url);
        },
        triggerDownload: (url, fileName) => {
            downloads.push({ url, fileName });
        },
        randomToken: () => `token-${token++}`,
        now: () => now,
        schedule: (callback, delayMs) => {
            scheduled.push({ callback, delayMs });
            return scheduled.length;
        },
        acquireEntryLease: async (name) => {
            if (lockedNames.has(name)) {
                throw new Error(`Entry ${name} is already locked`);
            }
            lockedNames.add(name);
            let released = false;
            return {
                release: () => {
                    if (!released) {
                        released = true;
                        lockedNames.delete(name);
                    }
                },
            };
        },
        runIfEntryInactive: async (name, callback) => {
            if (lockedNames.has(name)) {
                return false;
            }
            await callback();
            return true;
        },
    };

    return {
        dependencies,
        directory,
        files,
        removed,
        revoked,
        downloads,
        objectUrlFiles,
        scheduled,
        lockedNames,
        setNow(value: number) {
            now = value;
        },
        failNextRemove(name: string) {
            removeFailures.set(name, (removeFailures.get(name) ?? 0) + 1);
        },
        get writeCalls() {
            return writeCalls;
        },
    };
};

describe("bounded browser download sink", () => {
    it("uses the bounded sink at and above the memory limit", () => {
        expect(
            requiresBoundedDownload(
                DEFAULT_BOUNDED_DOWNLOAD_THRESHOLD_BYTES - 1n
            )
        ).toBe(false);
        expect(
            requiresBoundedDownload(DEFAULT_BOUNDED_DOWNLOAD_THRESHOLD_BYTES)
        ).toBe(true);
        expect(requiresBoundedDownload(1n, 1)).toBe(true);
        expect(requiresBoundedDownload(0n, Number.NaN)).toBe(false);
    });

    it("writes each chunk to OPFS and preserves exact content integrity", async () => {
        const harness = createOpfsHarness();
        const chunks = [
            new Uint8Array([0, 1, 2, 3]),
            new Uint8Array([254, 255]),
            new TextEncoder().encode("peerbit-bounded-download"),
        ];
        const expected = new Uint8Array(
            chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
        );
        let offset = 0;
        for (const chunk of chunks) {
            expected.set(chunk, offset);
            offset += chunk.byteLength;
        }
        const writer = await createOpfsDownloadWriter(
            {
                fileName: "deterministic.bin",
                expectedSize: BigInt(expected.byteLength),
                retentionMs: 1234,
            },
            harness.dependencies
        );

        for (const chunk of chunks) {
            await writer.write(chunk);
            expect(harness.downloads).toHaveLength(0);
        }
        expect(harness.writeCalls).toBe(chunks.length);

        await writer.close();

        expect(harness.downloads).toEqual([
            { url: "blob:test-1", fileName: "deterministic.bin" },
        ]);
        expect(harness.objectUrlFiles).toHaveLength(1);
        const stored = new Uint8Array(
            await harness.objectUrlFiles[0].arrayBuffer()
        );
        expect(stored).toEqual(expected);
        expect(sha256(stored)).toBe(sha256(expected));
        expect(harness.scheduled).toHaveLength(1);
        expect(harness.scheduled[0].delayMs).toBe(1234);
        expect(harness.removed).toHaveLength(0);
        expect(harness.files.size).toBe(2);
        expect(harness.lockedNames.size).toBe(1);

        harness.scheduled[0].callback();
        await vi.waitFor(() => expect(harness.removed).toHaveLength(2));
        expect(harness.revoked).toEqual(["blob:test-1"]);
        expect(harness.files.size).toBe(0);
        expect(harness.lockedNames.size).toBe(0);
    });

    it("retries a transient owner cleanup failure without waiting for reload", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const harness = createOpfsHarness();
        const writer = await createOpfsDownloadWriter(
            {
                fileName: "cleanup-retry.bin",
                expectedSize: 0n,
                retentionMs: 1,
            },
            harness.dependencies
        );
        await writer.close();
        const dataName = [...harness.files.keys()].find(
            (name) => !name.includes(".delivered-")
        );
        expect(dataName).toBeDefined();
        harness.failNextRemove(dataName!);

        harness.scheduled.shift()!.callback();
        await vi.waitFor(() => expect(harness.scheduled).toHaveLength(1));
        expect(harness.scheduled[0].delayMs).toBe(30_000);
        expect(harness.files.has(dataName!)).toBe(true);
        expect(harness.lockedNames.size).toBe(0);

        harness.scheduled.shift()!.callback();
        await vi.waitFor(() => expect(harness.files.size).toBe(0));
        expect(harness.revoked).toEqual(["blob:test-1"]);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("Storage busy")
        );
        warn.mockRestore();
    });

    it("retries a transient partial-abort cleanup failure", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const harness = createOpfsHarness();
        const writer = await createOpfsDownloadWriter(
            {
                fileName: "abort-cleanup-retry.bin",
                expectedSize: 8n,
            },
            harness.dependencies
        );
        await writer.write(new Uint8Array([1, 2, 3]));
        const dataName = [...harness.files.keys()][0];
        harness.failNextRemove(dataName);

        await writer.abort(new DOMException("Cancelled", "AbortError"));

        expect(harness.files.has(dataName)).toBe(true);
        expect(harness.lockedNames.size).toBe(0);
        expect(harness.scheduled).toHaveLength(1);
        expect(harness.scheduled[0].delayMs).toBe(30_000);
        harness.scheduled.shift()!.callback();
        await vi.waitFor(() => expect(harness.files.size).toBe(0));
        expect(harness.downloads).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("Storage busy")
        );
        warn.mockRestore();
    });

    it("preserves a close error while retrying its transient cleanup failure", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const harness = createOpfsHarness();
        const writer = await createOpfsDownloadWriter(
            {
                fileName: "failed-close-cleanup-retry.bin",
                expectedSize: 4n,
            },
            harness.dependencies
        );
        await writer.write(new Uint8Array([1, 2, 3]));
        const dataName = [...harness.files.keys()][0];
        harness.failNextRemove(dataName);

        await expect(writer.close()).rejects.toThrow(
            "expected 4 bytes, received 3"
        );

        expect(harness.files.has(dataName)).toBe(true);
        expect(harness.lockedNames.size).toBe(0);
        expect(harness.scheduled).toHaveLength(1);
        expect(harness.scheduled[0].delayMs).toBe(30_000);
        harness.scheduled.shift()!.callback();
        await vi.waitFor(() => expect(harness.files.size).toBe(0));
        expect(harness.downloads).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("Storage busy")
        );
        warn.mockRestore();
    });

    it("does not let a concurrent abort revoke a download owned by close", async () => {
        const harness = createOpfsHarness();
        const getFileHandle = harness.directory.getFileHandle.bind(
            harness.directory
        );
        let markCloseStarted!: () => void;
        let releaseMarkerClose!: () => void;
        const markerCloseStarted = new Promise<void>((resolve) => {
            markCloseStarted = resolve;
        });
        const markerCloseGate = new Promise<void>((resolve) => {
            releaseMarkerClose = resolve;
        });
        harness.directory.getFileHandle = async (name, options) => {
            const handle = await getFileHandle(name, options);
            if (!name.includes(".delivered-")) {
                return handle;
            }
            return {
                ...handle,
                createWritable: async () => {
                    const writable = await handle.createWritable();
                    return {
                        ...writable,
                        close: async () => {
                            markCloseStarted();
                            await markerCloseGate;
                            await writable.close();
                        },
                    };
                },
            };
        };
        const writer = await createOpfsDownloadWriter(
            {
                fileName: "close-owned.bin",
                expectedSize: 0n,
                retentionMs: 1,
            },
            harness.dependencies
        );

        const closePromise = writer.close();
        await markerCloseStarted;
        await writer.abort(new DOMException("Late timeout", "AbortError"));
        expect(harness.downloads).toEqual([]);
        expect(harness.revoked).toEqual([]);
        expect(harness.files.size).toBe(2);

        releaseMarkerClose();
        await closePromise;
        expect(harness.downloads).toEqual([
            { url: "blob:test-1", fileName: "close-owned.bin" },
        ]);
        expect(harness.lockedNames.size).toBe(1);
        harness.scheduled[0].callback();
        await vi.waitFor(() => expect(harness.files.size).toBe(0));
        expect(harness.revoked).toEqual(["blob:test-1"]);
    });

    it("aborts a partial stream and removes it without triggering a download", async () => {
        const harness = createOpfsHarness();
        const writer = await createOpfsDownloadWriter(
            {
                fileName: "cancelled.bin",
                expectedSize: 8n,
            },
            harness.dependencies
        );

        await writer.write(new Uint8Array([1, 2, 3]));
        await writer.abort(new DOMException("Cancelled", "AbortError"));

        expect(harness.downloads).toHaveLength(0);
        expect(harness.objectUrlFiles).toHaveLength(0);
        expect(harness.removed).toHaveLength(1);
        expect(harness.files.size).toBe(0);
        expect(harness.lockedNames.size).toBe(0);
        await expect(writer.write(new Uint8Array([4]))).rejects.toThrow(
            "finished"
        );
        await expect(writer.close()).rejects.toThrow("already finished");
        await expect(writer.abort()).resolves.toBeUndefined();
    });

    it("fails closed and deletes an undersized temporary file", async () => {
        const harness = createOpfsHarness();
        const writer = await createOpfsDownloadWriter(
            {
                fileName: "truncated.bin",
                expectedSize: 4n,
            },
            harness.dependencies
        );

        await writer.write(new Uint8Array([1, 2, 3]));
        await expect(writer.close()).rejects.toThrow(
            "expected 4 bytes, received 3"
        );

        expect(harness.downloads).toHaveLength(0);
        expect(harness.files.size).toBe(0);
        expect(harness.removed).toHaveLength(1);
    });

    it("reclaims only abandoned entries past the crash window", async () => {
        const harness = createOpfsHarness();
        await harness.directory.getFileHandle("peerbit-download-v1-100-old", {
            create: true,
        });
        await harness.directory.getFileHandle(
            `peerbit-download-v1-${DEFAULT_OPFS_CRASH_RECOVERY_MS}-current`,
            { create: true }
        );
        await harness.directory.getFileHandle("other-app-file", {
            create: true,
        });

        const now = DEFAULT_OPFS_CRASH_RECOVERY_MS + 200;
        const result = await cleanupStaleOpfsDownloads(harness.directory, now, {
            runIfEntryInactive: harness.dependencies.runIfEntryInactive,
        });

        expect(harness.removed).toEqual(["peerbit-download-v1-100-old"]);
        expect([...harness.files.keys()].sort()).toEqual([
            "other-app-file",
            `peerbit-download-v1-${DEFAULT_OPFS_CRASH_RECOVERY_MS}-current`,
        ]);
        expect(result.errors).toEqual([]);
        expect(result.nextCleanupDelayMs).toBe(
            DEFAULT_OPFS_CRASH_RECOVERY_MS - 200
        );
    });

    it("uses a short delivered lifetime without applying it to active-age entries", async () => {
        const harness = createOpfsHarness();
        const now = 20 * 60 * 1000;
        const delivered = "peerbit-download-v1-100-delivered";
        const activeAge = `peerbit-download-v1-${now - 17 * 60 * 1000}-active`;
        await harness.directory.getFileHandle(delivered, { create: true });
        await harness.directory.getFileHandle(
            `${delivered}.delivered-${now - DEFAULT_OPFS_DOWNLOAD_RETENTION_MS - 1}`,
            { create: true }
        );
        await harness.directory.getFileHandle(activeAge, { create: true });

        await cleanupStaleOpfsDownloads(harness.directory, now, {
            runIfEntryInactive: harness.dependencies.runIfEntryInactive,
        });

        expect([...harness.files.keys()]).toEqual([activeAge]);
        expect(harness.removed).toHaveLength(2);
    });

    it("does not crash-recover a cross-tab transfer while its lease is held", async () => {
        const harness = createOpfsHarness();
        const activeName = "peerbit-download-v1-100-other-tab";
        await harness.directory.getFileHandle(activeName, { create: true });
        harness.lockedNames.add(activeName);
        harness.setNow(DEFAULT_OPFS_CRASH_RECOVERY_MS + 101);

        await cleanupOpfsDownloadsOnStartup(harness.dependencies);

        expect(harness.files.has(activeName)).toBe(true);
        expect(harness.scheduled).toHaveLength(1);
        expect(harness.scheduled[0].delayMs).toBe(30_000);

        harness.lockedNames.delete(activeName);
        harness.setNow(DEFAULT_OPFS_CRASH_RECOVERY_MS + 30_101);
        harness.scheduled.shift()!.callback();
        await vi.waitFor(() =>
            expect(harness.files.has(activeName)).toBe(false)
        );
    });

    it("automatically resumes young delivered cleanup after startup", async () => {
        const harness = createOpfsHarness();
        const dataName = "peerbit-download-v1-100-reloaded";
        const deliveredAt = 9_000;
        await harness.directory.getFileHandle(dataName, { create: true });
        await harness.directory.getFileHandle(
            `${dataName}.delivered-${deliveredAt}`,
            { create: true }
        );
        harness.setNow(10_000);

        await cleanupOpfsDownloadsOnStartup(harness.dependencies, {
            deliveredRetentionMs: 2_000,
        });

        expect(harness.scheduled).toHaveLength(1);
        expect(harness.scheduled[0].delayMs).toBe(1_000);
        harness.setNow(11_000);
        harness.scheduled.shift()!.callback();
        await vi.waitFor(() => expect(harness.files.size).toBe(0));
    });

    it("keeps unmarked stale entries when cross-tab exclusion is unavailable", async () => {
        const harness = createOpfsHarness();
        const name = "peerbit-download-v1-1-unknown-tab";
        await harness.directory.getFileHandle(name, { create: true });

        await cleanupStaleOpfsDownloads(
            harness.directory,
            DEFAULT_OPFS_CRASH_RECOVERY_MS + 2
        );

        expect(harness.files.has(name)).toBe(true);
        expect(harness.removed).toEqual([]);
    });

    it("sanitizes protocol-controlled names without changing ordinary names", () => {
        expect(sanitizeDownloadFileName("Résumé 2026 (final).pdf")).toBe(
            "Résumé 2026 (final).pdf"
        );
        expect(sanitizeDownloadFileName("CON.txt")).toBe("_CON.txt");
        const hostile = sanitizeDownloadFileName("../report\u202e:name?.txt. ");
        expect(hostile).not.toMatch(/[<>:"/\\|?*\u0000-\u001f\u007f]/u);
        expect(hostile).not.toMatch(/[ .]$/u);
    });

    it("bounds multibyte names by encoded bytes and preserves a short extension", () => {
        const safeName = sanitizeDownloadFileName(`${"😀".repeat(240)}.bin`);

        expect(new TextEncoder().encode(safeName).length).toBeLessThanOrEqual(
            240
        );
        expect(safeName.endsWith(".bin")).toBe(true);
        expect(Array.from(safeName.slice(0, -4))).toHaveLength(59);
    });

    it("reports unavailable OPFS without falling back to an aggregate Blob", async () => {
        const harness = createOpfsHarness();
        const failure = new DOMException("Private mode", "SecurityError");
        harness.dependencies.getDirectory = async () => {
            throw failure;
        };

        await expect(
            createOpfsDownloadWriter(
                { fileName: "too-large.bin", expectedSize: 1_000_000_000n },
                harness.dependencies
            )
        ).rejects.toMatchObject({
            name: "BoundedDownloadUnavailableError",
            cause: failure,
        } satisfies Partial<BoundedDownloadUnavailableError>);
        expect(harness.downloads).toHaveLength(0);
        expect(harness.objectUrlFiles).toHaveLength(0);
    });
});
