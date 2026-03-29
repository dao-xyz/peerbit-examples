import { test } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { startBootstrapPeer } from "./bootstrapPeer";
import {
    createSpace,
    createSyntheticFileOnDisk,
    expectDownloadedFile,
    rootUrl,
    setSeedMode,
    waitForFileListed,
    waitForUploadComplete,
    withBootstrap,
} from "./helpers";

const ENABLED = process.env.PW_BENCH === "1";
const SCENARIO = process.env.PW_BENCH_SCENARIO || "local";
const FILE_SIZE_MB = Number(process.env.PW_FILE_MB || "1024");
const RESULT_FILE = process.env.PW_RESULT_FILE;
const UPLOAD_TIMEOUT_MS = Number(
    process.env.PW_UPLOAD_TIMEOUT_MS || "1800000"
);
const DOWNLOAD_TIMEOUT_MS = Number(
    process.env.PW_DOWNLOAD_TIMEOUT_MS || "1800000"
);

if (!["local", "prod"].includes(SCENARIO)) {
    throw new Error(`Unsupported PW_BENCH_SCENARIO='${SCENARIO}'`);
}

const persistResult = async (result: Record<string, unknown>) => {
    if (!RESULT_FILE) {
        return;
    }
    await mkdir(path.dirname(RESULT_FILE), { recursive: true });
    await writeFile(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`);
};

const logStage = (stage: string, details: Record<string, unknown> = {}) => {
    console.log(
        `FILE_SHARE_TRANSFER_BENCH_STAGE ${JSON.stringify({
            stage,
            scenario: SCENARIO,
            fileSizeMb: FILE_SIZE_MB,
            ...details,
        })}`
    );
};

const toMiBPerSecond = (bytes: number, durationMs: number) =>
    durationMs > 0 ? bytes / (1024 * 1024) / (durationMs / 1000) : null;

const toMbps = (bytes: number, durationMs: number) =>
    durationMs > 0 ? (bytes * 8) / 1_000_000 / (durationMs / 1000) : null;

test.describe("file-share transfer benchmark", () => {
    test.skip(!ENABLED, "Set PW_BENCH=1 to run file-share benchmark");

    test("measures upload and download throughput", async ({
        browser,
        baseURL,
    }) => {
        test.setTimeout(
            Math.max(
                45 * 60 * 1000,
                UPLOAD_TIMEOUT_MS + DOWNLOAD_TIMEOUT_MS + 10 * 60 * 1000
            )
        );
        if (!baseURL) {
            throw new Error("Missing baseURL");
        }

        const usesLocalBootstrap = SCENARIO === "local";
        const bootstrap = usesLocalBootstrap
            ? await startBootstrapPeer()
            : undefined;
        const writerContext = await browser.newContext({
            acceptDownloads: true,
        });
        const readerContext = await browser.newContext({
            acceptDownloads: true,
        });
        const writer = await writerContext.newPage();
        const reader = await readerContext.newPage();
        const fileName = `file-share-transfer-bench-${Date.now()}.bin`;
        const preparedFile = await createSyntheticFileOnDisk(
            fileName,
            FILE_SIZE_MB
        );

        try {
            logStage("create-space");
            const entryUrl =
                usesLocalBootstrap && bootstrap
                    ? withBootstrap(rootUrl(baseURL), bootstrap.addrs)
                    : rootUrl(baseURL);
            const shareUrl = await createSpace(
                writer,
                entryUrl,
                `file-share-transfer-bench-${Date.now()}`
            );

            logStage("open-reader", { shareUrl });
            await reader.goto(shareUrl, { waitUntil: "domcontentloaded" });
            await setSeedMode(reader, false);

            logStage("wait-for-input");
            await writer.locator("#imgupload").waitFor({
                state: "attached",
                timeout: 60_000,
            });

            logStage("upload");
            const uploadStartedAt = Date.now();
            await writer.locator("#imgupload").setInputFiles(preparedFile.filePath);
            await waitForFileListed(writer, fileName, UPLOAD_TIMEOUT_MS);
            await waitForUploadComplete(writer, UPLOAD_TIMEOUT_MS);
            const uploadFinishedAt = Date.now();

            logStage("wait-for-reader-listing");
            await waitForFileListed(reader, fileName, UPLOAD_TIMEOUT_MS);
            const readerVisibleAt = Date.now();

            logStage("download");
            const downloadStartedAt = Date.now();
            const downloaded = await expectDownloadedFile(
                reader,
                fileName,
                FILE_SIZE_MB,
                DOWNLOAD_TIMEOUT_MS
            );
            const downloadFinishedAt = Date.now();

            const result = {
                status: "passed",
                scenario: SCENARIO,
                baseURL,
                shareUrl,
                fileName,
                fileSizeMb: FILE_SIZE_MB,
                sizeBytes: downloaded.size,
                uploadDurationMs: uploadFinishedAt - uploadStartedAt,
                discoveryLagMs: readerVisibleAt - uploadFinishedAt,
                downloadDurationMs: downloadFinishedAt - downloadStartedAt,
                uploadMiBps: toMiBPerSecond(
                    downloaded.size,
                    uploadFinishedAt - uploadStartedAt
                ),
                uploadMbps: toMbps(
                    downloaded.size,
                    uploadFinishedAt - uploadStartedAt
                ),
                downloadMiBps: toMiBPerSecond(
                    downloaded.size,
                    downloadFinishedAt - downloadStartedAt
                ),
                downloadMbps: toMbps(
                    downloaded.size,
                    downloadFinishedAt - downloadStartedAt
                ),
                startedAt: uploadStartedAt,
                finishedAt: downloadFinishedAt,
            };

            await persistResult(result);
            console.log(`FILE_SHARE_TRANSFER_BENCH ${JSON.stringify(result)}`);
        } catch (error: any) {
            const result = {
                status: "failed",
                scenario: SCENARIO,
                fileName,
                fileSizeMb: FILE_SIZE_MB,
                failure: {
                    message:
                        typeof error?.message === "string"
                            ? error.message
                            : String(error),
                    stack:
                        typeof error?.stack === "string" ? error.stack : undefined,
                },
            };
            await persistResult(result);
            console.error(`FILE_SHARE_TRANSFER_BENCH ${JSON.stringify(result)}`);
            throw error;
        } finally {
            await writerContext.close().catch(() => {});
            await readerContext.close().catch(() => {});
            await bootstrap?.stop().catch(() => {});
            await rm(preparedFile.dir, {
                recursive: true,
                force: true,
            }).catch(() => {});
        }
    });
});
