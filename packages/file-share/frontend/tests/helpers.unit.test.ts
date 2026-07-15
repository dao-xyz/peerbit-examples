import { gzipSync } from "node:zlib";
import { createReadStream } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
    crc32SavedViaPicker,
    createCrc32,
    createSyntheticFileOnDisk,
    installHashOnlyMockSaveFilePicker,
    installMockSaveFilePicker,
    installNodeBackedMockSaveFilePicker,
    sha256AndCrc32File,
    sha256FileBase64,
} from "./helpers";

vi.mock("@playwright/test", () => ({ expect: vi.fn() }));

const FIXTURE_SIZE_MB = 1 / 16;
const FIXTURE_SIZE_BYTES = 64 * 1024;
const MOCK_PICKER_WINDOW_KEYS = [
    "__peerbitStreamingDownloadThresholdBytes",
    "__mockSavedFiles",
    "__cleanupMockSavedFile",
    "__crc32MockSavedFile",
    "showSaveFilePicker",
] as const;

const snapshotMockPickerWindow = () =>
    new Map(
        MOCK_PICKER_WINDOW_KEYS.map((key) => [
            key,
            Object.getOwnPropertyDescriptor(window, key),
        ])
    );

const restoreMockPickerWindow = (
    descriptors: ReturnType<typeof snapshotMockPickerWindow>
) => {
    for (const key of MOCK_PICKER_WINDOW_KEYS) {
        const descriptor = descriptors.get(key);
        if (descriptor) {
            Object.defineProperty(window, key, descriptor);
        } else {
            Reflect.deleteProperty(window, key);
        }
    }
};

const createInitScriptPage = () => {
    let closeListener: (() => void) | undefined;
    const page = {
        addInitScript: async <T>(script: (argument: T) => void, argument: T) =>
            script(argument),
        evaluate: async <T, A>(
            script: (argument: A) => Promise<T>,
            argument: A
        ) => script(argument),
        once: (event: string, listener: () => void) => {
            if (event === "close") {
                closeListener = listener;
            }
        },
    } as unknown as Parameters<typeof installNodeBackedMockSaveFilePicker>[0];
    return {
        page,
        close: () => closeListener?.(),
    };
};

const crc32FileHex = async (filePath: string) => {
    const crc32 = createCrc32();
    for await (const chunk of createReadStream(filePath)) {
        crc32.update(chunk);
    }
    return crc32.digestHex();
};

describe("synthetic on-disk fixtures", () => {
    it("keeps the default sparse fixture behavior", async () => {
        const fixture = await createSyntheticFileOnDisk(
            "default-sparse.bin",
            FIXTURE_SIZE_MB
        );
        try {
            expect((await stat(fixture.filePath)).size).toBe(
                FIXTURE_SIZE_BYTES
            );
            expect(fixture.fixture).toEqual({
                mode: "sparse-zero",
                seed: null,
                sha256Base64: null,
                crc32Hex: null,
            });
            expect(
                (await readFile(fixture.filePath)).every((byte) => byte === 0)
            ).toBe(true);
        } finally {
            await rm(fixture.dir, { recursive: true, force: true });
        }
    });

    it("computes canonical CRC32 across chunk boundaries", () => {
        const crc32 = createCrc32();
        crc32.update(new TextEncoder().encode("1234"));
        crc32.update(new TextEncoder().encode("56789"));

        expect(crc32.digestHex()).toBe("cbf43926");
        expect(crc32.digestHex()).toMatch(/^[0-9a-f]{8}$/);
    });

    it("writes deterministic, incompressible content with a streamed hash", async () => {
        const first = await createSyntheticFileOnDisk(
            "first.bin",
            FIXTURE_SIZE_MB,
            { mode: "deterministic", seed: "stable-seed" }
        );
        const second = await createSyntheticFileOnDisk(
            "second.bin",
            FIXTURE_SIZE_MB,
            { mode: "deterministic", seed: "stable-seed" }
        );
        const different = await createSyntheticFileOnDisk(
            "different.bin",
            FIXTURE_SIZE_MB,
            { mode: "deterministic", seed: "different-seed" }
        );

        try {
            const firstBytes = await readFile(first.filePath);
            const secondBytes = await readFile(second.filePath);
            const differentBytes = await readFile(different.filePath);

            expect(first.fixture).toEqual({
                mode: "aes-256-ctr-v1",
                seed: "stable-seed",
                sha256Base64: second.fixture.sha256Base64,
                crc32Hex: second.fixture.crc32Hex,
            });
            expect(first.fixture.sha256Base64).not.toBe(
                different.fixture.sha256Base64
            );
            expect(firstBytes.equals(secondBytes)).toBe(true);
            expect(firstBytes.equals(differentBytes)).toBe(false);
            expect(await sha256FileBase64(first.filePath)).toBe(
                first.fixture.sha256Base64
            );
            expect(await crc32FileHex(first.filePath)).toBe(
                first.fixture.crc32Hex
            );
            expect(await sha256AndCrc32File(first.filePath)).toEqual({
                sha256Base64: first.fixture.sha256Base64,
                crc32Hex: first.fixture.crc32Hex,
            });
            expect(first.fixture.crc32Hex).toMatch(/^[0-9a-f]{8}$/);
            expect(first.fixture.crc32Hex).not.toBe(different.fixture.crc32Hex);
            expect(
                gzipSync(firstBytes).byteLength / firstBytes.byteLength
            ).toBeGreaterThan(0.98);
        } finally {
            await Promise.all(
                [first.dir, second.dir, different.dir].map((dir) =>
                    rm(dir, { recursive: true, force: true })
                )
            );
        }
    });

    it("streams OPFS readback through the installed CRC32 hook", async () => {
        type StoredFile = { chunks: Uint8Array[] };
        const storedFiles = new Map<string, StoredFile>();
        let readbackStreamCount = 0;
        const root = {
            async getFileHandle(
                storageName: string,
                options?: { create?: boolean }
            ) {
                let stored = storedFiles.get(storageName);
                if (!stored && options?.create) {
                    stored = { chunks: [] };
                    storedFiles.set(storageName, stored);
                }
                if (!stored) {
                    throw new DOMException("Missing file", "NotFoundError");
                }
                return {
                    async createWritable() {
                        stored!.chunks = [];
                        return {
                            async write(bytes: Uint8Array) {
                                stored!.chunks.push(new Uint8Array(bytes));
                            },
                            async close() {},
                            async abort() {
                                stored!.chunks = [];
                            },
                        };
                    },
                    async getFile() {
                        const chunks = stored!.chunks.map(
                            (chunk) => new Uint8Array(chunk)
                        );
                        return {
                            size: chunks.reduce(
                                (total, chunk) => total + chunk.byteLength,
                                0
                            ),
                            stream() {
                                readbackStreamCount += 1;
                                let index = 0;
                                return new ReadableStream<Uint8Array>({
                                    pull(controller) {
                                        const chunk = chunks[index++];
                                        if (chunk) {
                                            controller.enqueue(chunk);
                                        } else {
                                            controller.close();
                                        }
                                    },
                                });
                            },
                        };
                    },
                };
            },
            async removeEntry(storageName: string) {
                if (!storedFiles.delete(storageName)) {
                    throw new DOMException("Missing file", "NotFoundError");
                }
            },
        };
        const storageDescriptor = Object.getOwnPropertyDescriptor(
            navigator,
            "storage"
        );
        const windowKeys = [
            "__peerbitStreamingDownloadThresholdBytes",
            "__mockSavedFiles",
            "__cleanupMockSavedFile",
            "__crc32MockSavedFile",
            "showSaveFilePicker",
        ] as const;
        const windowDescriptors = new Map(
            windowKeys.map((key) => [
                key,
                Object.getOwnPropertyDescriptor(window, key),
            ])
        );
        const page = {
            addInitScript: async (script: () => void) => script(),
            evaluate: async <T, A>(
                script: (argument: A) => Promise<T>,
                argument: A
            ) => script(argument),
        } as unknown as Parameters<typeof installMockSaveFilePicker>[0];

        try {
            Object.defineProperty(navigator, "storage", {
                configurable: true,
                value: { getDirectory: async () => root },
            });
            await installMockSaveFilePicker(page);
            const handle = await (window as any).showSaveFilePicker({
                suggestedName: "crc32-readback.bin",
            });
            const writable = await handle.createWritable();
            await writable.write(new TextEncoder().encode("1234"));
            await writable.write(new TextEncoder().encode("56789"));
            await writable.close();

            expect(await crc32SavedViaPicker(page, "crc32-readback.bin")).toBe(
                "cbf43926"
            );
            expect((window as any).__mockSavedFiles[0]).toMatchObject({
                sink: "opfs",
                sinkWriteCalls: 2,
            });
            expect(readbackStreamCount).toBe(1);
        } finally {
            if (storageDescriptor) {
                Object.defineProperty(navigator, "storage", storageDescriptor);
            } else {
                Reflect.deleteProperty(navigator, "storage");
            }
            for (const key of windowKeys) {
                const descriptor = windowDescriptors.get(key);
                if (descriptor) {
                    Object.defineProperty(window, key, descriptor);
                } else {
                    Reflect.deleteProperty(window, key);
                }
            }
        }
    });

    it("hashes and discards benchmark bytes without network or storage I/O", async () => {
        const descriptors = snapshotMockPickerWindow();
        const { page } = createInitScriptPage();
        const fileName = "hash-only.bin";
        try {
            await installHashOnlyMockSaveFilePicker(page, {
                expectedName: fileName,
                expectedSizeBytes: 9,
            });
            const handle = await (window as any).showSaveFilePicker({
                suggestedName: fileName,
            });
            const writable = await handle.createWritable();
            await writable.write(new TextEncoder().encode("1234"));
            await writable.write(new TextEncoder().encode("56789"));
            await writable.close();

            expect((window as any).__mockSavedFiles).toEqual([
                expect.objectContaining({
                    name: fileName,
                    size: 9,
                    sink: "hash-only",
                    crc32Hex: "cbf43926",
                    sinkWriteCalls: 2,
                }),
            ]);
            expect(await crc32SavedViaPicker(page, fileName)).toBe("cbf43926");
            await expect(writable.write(new Uint8Array([0]))).rejects.toThrow(
                "closed"
            );
            await (window as any).__cleanupMockSavedFile(fileName);
            expect((window as any).__mockSavedFiles).toEqual([]);
        } finally {
            restoreMockPickerWindow(descriptors);
        }
    });

    it("streams exact bytes to a Node file and verifies them after close", async () => {
        const descriptors = snapshotMockPickerWindow();
        const { page } = createInitScriptPage();
        const fileName = "node-readback.bin";
        let controller:
            | Awaited<ReturnType<typeof installNodeBackedMockSaveFilePicker>>
            | undefined;
        try {
            controller = await installNodeBackedMockSaveFilePicker(page, {
                expectedName: fileName,
                expectedSizeBytes: 9,
            });
            const handle = await (window as any).showSaveFilePicker({
                suggestedName: fileName,
            });
            const writable = await handle.createWritable();
            await writable.write(new TextEncoder().encode("1234"));
            await writable.write(new TextEncoder().encode("56789"));
            await writable.close();

            const saved = (window as any).__mockSavedFiles[0];
            expect(saved).toMatchObject({
                name: fileName,
                size: 9,
                sink: "node-file",
                sinkWriteCalls: 2,
                serverWriteCalls: 2,
            });
            expect(saved.sinkWriteDurationMs).toBeGreaterThanOrEqual(0);
            expect(saved.serverWriteDurationMs).toBeGreaterThanOrEqual(0);
            const storedPath = `${controller.directory}/${saved.storageName}`;
            expect((await readFile(storedPath)).toString()).toBe("123456789");
            expect(await crc32SavedViaPicker(page, fileName)).toBe("cbf43926");
            await expect(writable.write(new Uint8Array([0]))).rejects.toThrow(
                "closed"
            );
            await expect(writable.close()).rejects.toThrow("already closed");

            await (window as any).__cleanupMockSavedFile(fileName);
            await (window as any).__cleanupMockSavedFile(fileName);
            await expect(stat(storedPath)).rejects.toMatchObject({
                code: "ENOENT",
            });
        } finally {
            await controller?.cleanup();
            restoreMockPickerWindow(descriptors);
        }
        await expect(stat(controller!.directory)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("rejects wrong names, oversized writes, and undersized closes", async () => {
        const descriptors = snapshotMockPickerWindow();
        const { page } = createInitScriptPage();
        const fileName = "strict-size.bin";
        let controller:
            | Awaited<ReturnType<typeof installNodeBackedMockSaveFilePicker>>
            | undefined;
        try {
            controller = await installNodeBackedMockSaveFilePicker(page, {
                expectedName: fileName,
                expectedSizeBytes: 4,
            });
            await expect(
                (window as any).showSaveFilePicker({
                    suggestedName: "wrong-name.bin",
                })
            ).rejects.toThrow("Unexpected benchmark sink name");

            const oversizedHandle = await (window as any).showSaveFilePicker({
                suggestedName: fileName,
            });
            const oversized = await oversizedHandle.createWritable();
            await expect(
                oversized.write(new Uint8Array([1, 2, 3, 4, 5]))
            ).rejects.toThrow("exceeds expected size");
            await oversized.abort();
            await oversized.abort();

            const undersizedHandle = await (window as any).showSaveFilePicker({
                suggestedName: fileName,
            });
            const undersized = await undersizedHandle.createWritable();
            await undersized.write(new Uint8Array([1, 2]));
            await expect(undersized.close()).rejects.toThrow(
                "expected 4, received 2"
            );
            await undersized.abort();
            expect(await readdir(controller.directory)).toEqual([]);
        } finally {
            await controller?.cleanup();
            restoreMockPickerWindow(descriptors);
        }
        await expect(stat(controller!.directory)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("can clean up an active Node sink before close without leaking", async () => {
        const descriptors = snapshotMockPickerWindow();
        const { page } = createInitScriptPage();
        const fileName = "active-cleanup.bin";
        let controller:
            | Awaited<ReturnType<typeof installNodeBackedMockSaveFilePicker>>
            | undefined;
        try {
            controller = await installNodeBackedMockSaveFilePicker(page, {
                expectedName: fileName,
                expectedSizeBytes: 4,
            });
            const handle = await (window as any).showSaveFilePicker({
                suggestedName: fileName,
            });
            const writable = await handle.createWritable();
            await writable.write(new Uint8Array([1, 2]));
            await (window as any).__cleanupMockSavedFile(fileName);
            await expect(
                writable.write(new Uint8Array([3, 4]))
            ).rejects.toThrow("Unknown benchmark sink file");
            await writable.abort();
            expect(await readdir(controller.directory)).toEqual([]);
        } finally {
            await controller?.cleanup();
            restoreMockPickerWindow(descriptors);
        }
        await expect(stat(controller!.directory)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("removes a partial fixture directory when setup fails", async () => {
        const before = new Set(
            (await readdir(tmpdir())).filter((name) =>
                name.startsWith("peerbit-file-share-")
            )
        );

        await expect(
            createSyntheticFileOnDisk(
                "missing-parent/fixture.bin",
                FIXTURE_SIZE_MB,
                { mode: "deterministic" }
            )
        ).rejects.toBeDefined();

        const leaked = (await readdir(tmpdir())).filter(
            (name) =>
                name.startsWith("peerbit-file-share-") && !before.has(name)
        );
        expect(leaked).toEqual([]);
    });
});
