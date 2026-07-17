import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { startBootstrapPeer } from "./bootstrapPeer";
import {
    createSyntheticFileOnDisk,
    createSpace,
    expectDownloadedFile,
    expectSavedViaPicker,
    installNodeBackedMockSaveFilePicker,
    rootUrl,
    setSeedMode,
    sha256AndCrc32File,
    uploadSyntheticFile,
    waitForFileListed,
    waitForUploadComplete,
    withPeer,
} from "./helpers";

const FILE_SIZE_MB = Number(process.env.PW_FILE_MB || "100");
const OPFS_FILE_SIZE_MB = Number(process.env.PW_OPFS_FILE_MB || "6");

test.describe("file-share streamed download via local bootstrap", () => {
    test("observer can stream a large file to the save picker without buffering the whole blob", async ({
        browser,
        baseURL,
    }) => {
        test.setTimeout(20 * 60 * 1000);
        if (!baseURL) {
            throw new Error("Missing baseURL");
        }

        const bootstrap = await startBootstrapPeer();
        const writerContext = await browser.newContext({
            acceptDownloads: true,
        });
        const readerContext = await browser.newContext({
            acceptDownloads: true,
        });
        const writer = await writerContext.newPage();
        const reader = await readerContext.newPage();
        const fileName = `local-streamed-download-${Date.now()}.bin`;
        let nodeSinkController:
            | Awaited<ReturnType<typeof installNodeBackedMockSaveFilePicker>>
            | undefined;

        try {
            nodeSinkController = await installNodeBackedMockSaveFilePicker(
                reader,
                {
                    expectedName: fileName,
                    expectedSizeBytes: FILE_SIZE_MB * 1024 * 1024,
                }
            );
            const entryUrl = withPeer(rootUrl(baseURL), bootstrap.addrs);
            const shareUrl = await createSpace(
                writer,
                entryUrl,
                `streamed-download-space-${Date.now()}`
            );

            await uploadSyntheticFile(writer, fileName, FILE_SIZE_MB);
            await waitForFileListed(writer, fileName, 600_000);
            await waitForUploadComplete(writer, 600_000);

            await reader.goto(shareUrl, { waitUntil: "domcontentloaded" });
            await setSeedMode(reader, false);
            await waitForFileListed(reader, fileName, 600_000);

            const saved = await expectSavedViaPicker(
                reader,
                fileName,
                FILE_SIZE_MB,
                10 * 60 * 1000
            );
            await saved.cleanup();
        } finally {
            await nodeSinkController?.cleanup().catch(() => {});
            await writerContext.close().catch(() => {});
            await readerContext.close().catch(() => {});
            await bootstrap.stop().catch(() => {});
        }
    });

    test("observer streams exact chunks through OPFS when the save picker is unavailable", async ({
        browser,
        baseURL,
    }) => {
        test.setTimeout(15 * 60 * 1000);
        if (!baseURL) {
            throw new Error("Missing baseURL");
        }

        const bootstrap = await startBootstrapPeer();
        const writerContext = await browser.newContext({
            acceptDownloads: true,
        });
        const readerContext = await browser.newContext({
            acceptDownloads: true,
        });
        const writer = await writerContext.newPage();
        const reader = await readerContext.newPage();
        const fileName = `local-opfs-download-${Date.now()}.bin`;
        const fixture = await createSyntheticFileOnDisk(
            fileName,
            OPFS_FILE_SIZE_MB,
            {
                mode: "deterministic",
                seed: "peerbit-opfs-download-e2e-v1",
            }
        );

        try {
            await reader.addInitScript(() => {
                Object.defineProperty(
                    window,
                    "__peerbitStreamingDownloadThresholdBytes",
                    {
                        configurable: true,
                        value: 1,
                    }
                );
                Object.defineProperty(window, "showSaveFilePicker", {
                    configurable: true,
                    value: undefined,
                });
            });
            const entryUrl = withPeer(rootUrl(baseURL), bootstrap.addrs);
            const shareUrl = await createSpace(
                writer,
                entryUrl,
                `opfs-download-space-${Date.now()}`
            );

            await writer.locator("#imgupload").setInputFiles(fixture.filePath);
            await expect(writer.locator("#imgupload")).toHaveValue("");
            await waitForFileListed(writer, fileName, 600_000);
            await waitForUploadComplete(writer, 600_000);

            await reader.goto(shareUrl, { waitUntil: "domcontentloaded" });
            await setSeedMode(reader, false);
            await waitForFileListed(reader, fileName, 600_000);

            const saved = await expectDownloadedFile(
                reader,
                fileName,
                OPFS_FILE_SIZE_MB,
                10 * 60 * 1000
            );
            if (!saved.downloadPath) {
                throw new Error("Browser download did not expose a file path");
            }
            expect(await sha256AndCrc32File(saved.downloadPath)).toEqual({
                sha256Base64: fixture.fixture.sha256Base64,
                crc32Hex: fixture.fixture.crc32Hex,
            });
            const readDiagnostics = await reader.evaluate(async () => {
                const hooks = (window as any).__peerbitFileShareTestHooks;
                if (!hooks?.getDiagnostics) {
                    throw new Error(
                        "Missing __peerbitFileShareTestHooks.getDiagnostics"
                    );
                }
                return (await hooks.getDiagnostics()).lastReadDiagnostics;
            });
            expect(
                Object.keys(readDiagnostics?.chunkWriteFinishedAt ?? {}).length
            ).toBeGreaterThan(1);
            expect(readDiagnostics?.computedFinalHash).toBe(
                fixture.fixture.sha256Base64
            );
            expect(readDiagnostics?.chunkFailure).toBe(null);
            await saved.cleanup();
        } finally {
            await rm(fixture.dir, { recursive: true, force: true }).catch(
                () => {}
            );
            await writerContext.close().catch(() => {});
            await readerContext.close().catch(() => {});
            await bootstrap.stop().catch(() => {});
        }
    });
});
