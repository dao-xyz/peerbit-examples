import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    expect,
    test,
    webkit,
    type Browser,
    type BrowserContext,
    type Page,
} from "@playwright/test";
import { createCrc32, sha256AndCrc32File } from "./helpers";

const TEST_BYTES = 1024 * 1024;
const TEST_CHUNK_BYTES = 128 * 1024;
const TEST_SEED = 0x6a09e667;

const createDeterministicChunks = (
    totalBytes: number,
    chunkBytes: number,
    seed: number
) => {
    const chunks: Uint8Array[] = [];
    let state = seed >>> 0;
    let remaining = totalBytes;
    while (remaining > 0) {
        const chunk = new Uint8Array(Math.min(chunkBytes, remaining));
        for (let index = 0; index < chunk.byteLength; index++) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            chunk[index] = state >>> 24;
        }
        chunks.push(chunk);
        remaining -= chunk.byteLength;
    }
    return chunks;
};

const createExpectedDigests = () => {
    const sha256 = createHash("sha256");
    const crc32 = createCrc32();
    for (const chunk of createDeterministicChunks(
        TEST_BYTES,
        TEST_CHUNK_BYTES,
        TEST_SEED
    )) {
        sha256.update(chunk);
        crc32.update(chunk);
    }
    return {
        sha256Base64: sha256.digest("base64"),
        crc32Hex: crc32.digestHex(),
    };
};

const openSinkPage = async (
    browser: Browser,
    browserName: string
): Promise<{
    context: BrowserContext;
    page: Page;
    cleanup: () => Promise<void>;
}> => {
    if (browserName !== "webkit") {
        const context = await browser.newContext({ acceptDownloads: true });
        return {
            context,
            page: await context.newPage(),
            cleanup: () => context.close(),
        };
    }

    // WebKit intentionally disables OPFS in private browsing. Playwright's
    // ordinary contexts are private, so use a throwaway persistent profile to
    // exercise the same storage mode as a normal Safari window.
    const profile = await mkdtemp(path.join(tmpdir(), "peerbit-opfs-webkit-"));
    const context = await webkit.launchPersistentContext(profile, {
        acceptDownloads: true,
        headless: true,
    });
    return {
        context,
        page: context.pages()[0] ?? (await context.newPage()),
        cleanup: async () => {
            await context.close().catch(() => {});
            await rm(profile, { recursive: true, force: true });
        },
    };
};

const supportsWritableOpfs = (page: Page) =>
    page.evaluate(async () => {
        if (typeof navigator.storage?.getDirectory !== "function") {
            return false;
        }

        const probeName = `peerbit-opfs-probe-${crypto.randomUUID()}`;
        let root: FileSystemDirectoryHandle | undefined;
        try {
            root = await navigator.storage.getDirectory();
            const handle = await root.getFileHandle(probeName, {
                create: true,
            });
            const writable = await handle.createWritable();
            await writable.write(new Uint8Array([1]));
            await writable.close();
            return true;
        } catch {
            return false;
        } finally {
            await root?.removeEntry(probeName).catch(() => {});
        }
    });

test.describe("bounded OPFS download sink", () => {
    test("streams exact chunks and deletes a cancelled partial file", async ({
        browser,
        browserName,
        baseURL,
    }) => {
        test.setTimeout(120_000);
        if (!baseURL) {
            throw new Error("Missing baseURL");
        }

        const sinkPage = await openSinkPage(browser, browserName);
        const fileName = `opfs-sink-${browserName}.bin`;
        try {
            // A same-origin static resource is enough to access OPFS and keeps
            // this sink contract test independent from Peerbit startup.
            await sinkPage.page.goto(new URL("robots.txt", baseURL).href);
            test.skip(
                !(await supportsWritableOpfs(sinkPage.page)),
                "This Playwright browser build does not provide writable OPFS"
            );

            const cancelled = await sinkPage.page.evaluate(async () => {
                const modulePath = "/src/download-sink.ts";
                const { createOpfsDownloadWriter } = await import(modulePath);
                const writer = await createOpfsDownloadWriter({
                    fileName: "cancelled.bin",
                    expectedSize: 16n,
                });
                await writer.write(new Uint8Array([1, 2, 3, 4]));
                await writer.abort(
                    new DOMException("Cancelled by test", "AbortError")
                );
                const root = await navigator.storage.getDirectory();
                const leftovers: string[] = [];
                for await (const [name] of root.entries()) {
                    if (name.startsWith("peerbit-download-v1-")) {
                        leftovers.push(name);
                    }
                }
                return leftovers;
            });
            expect(cancelled).toEqual([]);

            const downloadPromise = sinkPage.page.waitForEvent("download");
            const streamed = sinkPage.page.evaluate(
                async ({ fileName, totalBytes, chunkBytes, seed }) => {
                    const modulePath = "/src/download-sink.ts";
                    const { createOpfsDownloadWriter } = await import(
                        modulePath
                    );
                    const writer = await createOpfsDownloadWriter({
                        fileName,
                        expectedSize: BigInt(totalBytes),
                    });
                    let state = seed >>> 0;
                    let remaining = totalBytes;
                    let writeCalls = 0;
                    while (remaining > 0) {
                        const chunk = new Uint8Array(
                            Math.min(chunkBytes, remaining)
                        );
                        for (let index = 0; index < chunk.byteLength; index++) {
                            state =
                                (Math.imul(state, 1664525) + 1013904223) >>> 0;
                            chunk[index] = state >>> 24;
                        }
                        await writer.write(chunk);
                        writeCalls += 1;
                        remaining -= chunk.byteLength;
                    }
                    await writer.close();
                    return { writeCalls };
                },
                {
                    fileName,
                    totalBytes: TEST_BYTES,
                    chunkBytes: TEST_CHUNK_BYTES,
                    seed: TEST_SEED,
                }
            );
            const [download, streamResult] = await Promise.all([
                downloadPromise,
                streamed,
            ]);
            expect(download.suggestedFilename()).toBe(fileName);
            const downloadPath = await download.path();
            expect((await stat(downloadPath)).size).toBe(TEST_BYTES);
            expect(streamResult.writeCalls).toBe(TEST_BYTES / TEST_CHUNK_BYTES);
            expect(await sha256AndCrc32File(downloadPath)).toEqual(
                createExpectedDigests()
            );
            await download.delete();
        } finally {
            await sinkPage.cleanup();
        }
    });

    test("app startup removes an expired delivered entry after a reload", async ({
        browserName,
        page,
        baseURL,
    }) => {
        test.skip(browserName !== "chromium");
        if (!baseURL) {
            throw new Error("Missing baseURL");
        }
        await page.goto(new URL("robots.txt", baseURL).href);
        const entryNames = await page.evaluate(async () => {
            const now = Date.now();
            const dataName = `peerbit-download-v1-${now - 60 * 60 * 1000}-startup-test`;
            const markerName = `${dataName}.delivered-${now - 6 * 60 * 1000}`;
            const root = await navigator.storage.getDirectory();
            for (const name of [dataName, markerName]) {
                const handle = await root.getFileHandle(name, {
                    create: true,
                });
                const writable = await handle.createWritable();
                await writable.close();
            }
            return [dataName, markerName];
        });

        await page.goto(baseURL, { waitUntil: "domcontentloaded" });

        await expect
            .poll(() =>
                page.evaluate(async (names) => {
                    const root = await navigator.storage.getDirectory();
                    const remaining: string[] = [];
                    for await (const [name] of root.entries()) {
                        if (names.includes(name)) {
                            remaining.push(name);
                        }
                    }
                    return remaining;
                }, entryNames)
            )
            .toEqual([]);
    });
});
