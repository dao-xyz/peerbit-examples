import { test, type Page } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { startBootstrapPeer } from "./bootstrapPeer";
import {
    createSyntheticFileOnDisk,
    expectDownloadedFile,
    rootUrl,
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

const waitForCreateSpaceHook = async (page: Page) => {
    await page.waitForFunction(
        () => Boolean((window as any).__peerbitFileShareCreateSpace),
        undefined,
        { timeout: 180_000 }
    );
};

const createSpaceFromHook = async (page: Page, name: string) => {
    return await page.evaluate(async (spaceName) => {
        const createSpace = (window as any).__peerbitFileShareCreateSpace;
        if (!createSpace) {
            throw new Error("Missing __peerbitFileShareCreateSpace");
        }
        return await createSpace(spaceName);
    }, name);
};

const waitForTestHooks = async (page: Page) => {
    await page.waitForFunction(
        () => Boolean((window as any).__peerbitFileShareTestHooks?.setReplicationRole),
        undefined,
        { timeout: 180_000 }
    );
};

const applyReplicationRole = async (
    page: Page,
    role: unknown
) => {
    await page.evaluate(async (roleOptions) => {
        const hooks = (window as any).__peerbitFileShareTestHooks;
        if (!hooks?.setReplicationRole) {
            throw new Error("Missing __peerbitFileShareTestHooks.setReplicationRole");
        }
        await hooks.setReplicationRole(roleOptions);
    }, role);
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
            await writer.goto(entryUrl, { waitUntil: "domcontentloaded" });
            await waitForCreateSpaceHook(writer);
            const address = await createSpaceFromHook(
                writer,
                `file-share-transfer-bench-${Date.now()}`
            );
            const shareUrl = new URL(entryUrl);
            shareUrl.hash = `/s/${address}`;

            logStage("open-reader", { shareUrl: shareUrl.toString() });
            logStage("open-writer-page");
            await writer.goto(shareUrl.toString(), { waitUntil: "domcontentloaded" });
            logStage("writer-page-ready");
            await reader.goto(shareUrl.toString(), { waitUntil: "domcontentloaded" });
            logStage("reader-page-ready");
            logStage("wait-for-test-hooks");
            await Promise.all([waitForTestHooks(writer), waitForTestHooks(reader)]);
            logStage("apply-reader-role");
            await applyReplicationRole(reader, false);
            logStage("reader-seed-disabled");

            logStage("wait-for-input");
            await writer.locator("#imgupload").waitFor({
                state: "attached",
                timeout: 60_000,
            });

            logStage("upload");
            const uploadStartedAt = Date.now();
            await writer.locator("#imgupload").setInputFiles(preparedFile.filePath);
            logStage("wait-for-writer-listing");
            await waitForFileListed(writer, fileName, UPLOAD_TIMEOUT_MS);
            logStage("wait-for-upload-complete");
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
                shareUrl: shareUrl.toString(),
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
