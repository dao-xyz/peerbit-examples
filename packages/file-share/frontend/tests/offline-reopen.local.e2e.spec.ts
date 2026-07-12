import {
    chromium,
    expect,
    test,
    type BrowserContext,
    type Page,
} from "@playwright/test";
import { rm } from "node:fs/promises";
import { DEFAULT_REPLICATION_ROLE } from "../src/role-state";
import { startBootstrapPeer } from "./bootstrapPeer";
import {
    createSpace,
    createSyntheticFileOnDisk,
    expectDownloadedFile,
    rootUrl,
    sha256FileBase64,
    waitForFileListed,
    waitForUploadComplete,
    withBootstrap,
} from "./helpers";

const FILE_SIZE_MB = Number(process.env.PW_REOPEN_FILE_MB || "6");
const TIMEOUT_MS = 180_000;
const logStage = (stage: string) =>
    console.log("FILE_SHARE_OFFLINE_REOPEN_STAGE", stage);

const launchPersistentReader = async (profileDirectory: string) => {
    const context = await chromium.launchPersistentContext(profileDirectory, {
        acceptDownloads: true,
        args: ["--enable-features=FileSystemAccessAPI"],
        headless: true,
        viewport: { width: 1280, height: 800 },
    });
    await context.addInitScript(() => {
        Object.defineProperty(navigator.storage, "persist", {
            configurable: true,
            value: async () => true,
        });
        Object.defineProperty(navigator.storage, "persisted", {
            configurable: true,
            value: async () => true,
        });
    });
    const existingPages = context.pages();
    const page =
        existingPages.find((candidate) => candidate.url().includes("#/s/")) ??
        existingPages[0] ??
        (await context.newPage());
    for (const extraPage of existingPages) {
        if (extraPage !== page) {
            await extraPage.close();
        }
    }
    return { context, page };
};

const getDiagnostics = async (page: Page) => {
    await page.waitForFunction(
        () =>
            typeof (window as any).__peerbitFileShareTestHooks
                ?.getDiagnostics === "function",
        undefined,
        { timeout: TIMEOUT_MS }
    );
    return (await page.evaluate(async () => {
        return await (
            window as any
        ).__peerbitFileShareTestHooks.getDiagnostics();
    })) as Record<string, any>;
};

const getAppDiagnostics = async (page: Page) => {
    await page.waitForFunction(
        () =>
            typeof (window as any).__peerbitFileShareAppDiagnostics ===
            "function",
        undefined,
        { timeout: TIMEOUT_MS }
    );
    return (await page.evaluate(() => {
        return (window as any).__peerbitFileShareAppDiagnostics();
    })) as Record<string, any>;
};

const getListedLargeFile = (
    diagnostics: Record<string, any>,
    fileName: string
) =>
    (diagnostics.listedFiles as Record<string, any>[] | undefined)?.find(
        (file) => file.name === fileName && file.type === "large"
    );

const waitForProgramOpen = async (page: Page, expectedAddress: string) => {
    await expect
        .poll(
            async () => {
                const diagnostics = await getDiagnostics(page);
                if (diagnostics.programHookError) {
                    throw new Error(
                        `Program open failed: ${diagnostics.programHookError}; peerHash=${diagnostics.peerHash}; programAddress=${diagnostics.programAddress}`
                    );
                }
                return (
                    diagnostics.programAddress === expectedAddress &&
                    typeof diagnostics.peerHash === "string"
                );
            },
            { timeout: TIMEOUT_MS }
        )
        .toBe(true);
    return getDiagnostics(page);
};

const waitForCompleteLocalBlocks = async (page: Page, fileName: string) => {
    await expect
        .poll(
            async () => {
                const diagnostics = await getDiagnostics(page);
                const file = getListedLargeFile(diagnostics, fileName);
                return Boolean(
                    Number.isInteger(file?.chunkCount) &&
                    file.chunkCount > 0 &&
                    file.localChunkBlockCount === file.chunkCount
                );
            },
            { timeout: TIMEOUT_MS }
        )
        .toBe(true);
    const diagnostics = await getDiagnostics(page);
    const file = getListedLargeFile(diagnostics, fileName);
    expect(file?.localChunkIndexRowCount).toBe(file?.localChunkCount);
    expect(file?.localChunkBlockCount).toBe(file?.chunkCount);
    return { diagnostics, file };
};

const expectDownloadHash = async (
    page: Page,
    fileName: string,
    expectedHash: string
) => {
    const download = await expectDownloadedFile(
        page,
        fileName,
        FILE_SIZE_MB,
        TIMEOUT_MS
    );
    try {
        expect(download.downloadPath).toBeTruthy();
        expect(await sha256FileBase64(download.downloadPath!)).toBe(
            expectedHash
        );
    } finally {
        await download.cleanup();
    }
};

const shutdownPage = async (page: Page) => {
    await page.evaluate(async () => {
        const shutdown = (window as any).__peerbitFileShareTestHooks?.shutdown;
        if (typeof shutdown !== "function") {
            throw new Error("Missing __peerbitFileShareTestHooks.shutdown");
        }
        await shutdown();
    });
};

test.describe("file-share persisted offline restart", () => {
    test("rereads a complete large file after a browser restart with no peers", async ({
        browser,
        baseURL,
    }, testInfo) => {
        test.setTimeout(8 * 60 * 1000);
        if (!baseURL) {
            throw new Error("Missing baseURL");
        }
        if (!Number.isSafeInteger(FILE_SIZE_MB) || FILE_SIZE_MB < 6) {
            throw new Error(
                "PW_REOPEN_FILE_MB must be an integer of at least 6"
            );
        }

        const profileDirectory = testInfo.outputPath("reader-profile");
        await rm(profileDirectory, { recursive: true, force: true });

        const fileName = `offline-reopen-${Date.now()}.bin`;
        const fixture = await createSyntheticFileOnDisk(
            fileName,
            FILE_SIZE_MB,
            {
                mode: "deterministic",
                seed: "peerbit-offline-reopen-v1",
            }
        );
        const expectedHash = fixture.fixture.sha256Base64;
        if (!expectedHash) {
            throw new Error("Deterministic fixture is missing its SHA-256");
        }

        let bootstrap:
            | Awaited<ReturnType<typeof startBootstrapPeer>>
            | undefined;
        let writerContext: BrowserContext | undefined;
        let readerContext: BrowserContext | undefined;

        try {
            logStage("start-bootstrap");
            bootstrap = await startBootstrapPeer();
            writerContext = await browser.newContext({
                acceptDownloads: true,
            });
            const writer = await writerContext.newPage();
            logStage("create-space");
            const shareUrl = await createSpace(
                writer,
                withBootstrap(rootUrl(baseURL), bootstrap.addrs),
                `offline-reopen-${Date.now()}`
            );
            const writerDiagnostics = await getDiagnostics(writer);
            const shareAddress = writerDiagnostics.programAddress;
            if (typeof shareAddress !== "string" || !shareAddress) {
                throw new Error(
                    "Writer diagnostics are missing programAddress"
                );
            }

            await writer.locator("#imgupload").setInputFiles(fixture.filePath);
            await expect(writer.locator("#imgupload")).toHaveValue("");
            await waitForFileListed(writer, fileName, TIMEOUT_MS);
            await waitForUploadComplete(writer, TIMEOUT_MS);
            logStage("writer-upload-complete");

            const initialReader =
                await launchPersistentReader(profileDirectory);
            readerContext = initialReader.context;
            await initialReader.page.addInitScript(
                ({ key, value }) => localStorage.setItem(key, value),
                {
                    key: `${shareAddress}-role`,
                    value: JSON.stringify(DEFAULT_REPLICATION_ROLE),
                }
            );
            await initialReader.page.goto(shareUrl, {
                waitUntil: "domcontentloaded",
            });
            logStage("initial-reader-open");
            expect(
                await initialReader.page.evaluate(async () => ({
                    getDirectory:
                        typeof navigator.storage.getDirectory === "function",
                    persisted: await navigator.storage.persisted(),
                }))
            ).toEqual({ getDirectory: true, persisted: true });
            await waitForFileListed(initialReader.page, fileName, TIMEOUT_MS);
            await expectDownloadHash(
                initialReader.page,
                fileName,
                expectedHash
            );
            logStage("initial-download-verified");
            const initialLocality = await waitForCompleteLocalBlocks(
                initialReader.page,
                fileName
            );
            expect(initialLocality.diagnostics.persistChunkReads).toBe(true);
            expect(initialLocality.diagnostics.programBlockPresent).toBe(true);
            expect(initialLocality.file.entryHead).toEqual(expect.any(String));
            expect(initialLocality.file.localEntryHead).toBe(
                initialLocality.file.entryHead
            );
            expect(initialLocality.file.localRootReady).toBe(true);
            expect(initialLocality.file.localRootFinalHash).toBe(expectedHash);
            expect(initialLocality.file.localRootEntryBlockPresent).toBe(true);
            const initialPeerHash = initialLocality.diagnostics.peerHash;
            expect(initialPeerHash).toEqual(expect.any(String));
            console.log("FILE_SHARE_OFFLINE_REOPEN_INITIAL_IDENTITY", {
                peerHash: initialPeerHash,
                programAddress: shareAddress,
            });
            logStage("initial-blocks-complete");

            logStage("initial-shutdown-start");
            await shutdownPage(initialReader.page);
            logStage("initial-shutdown-complete");
            // Prevent Chromium session restore from briefly reopening the old
            // peer-hinted URL and reacquiring this profile's identity lock
            // before the explicit offline navigation.
            await initialReader.page.goto("about:blank");
            await readerContext.close();
            readerContext = undefined;
            await writerContext.close();
            writerContext = undefined;
            await bootstrap.stop();
            bootstrap = undefined;
            logStage("all-peers-stopped");

            // @peerbit/react's tab-key mutex uses a one-second lease. A cold
            // browser restart must begin after the closed tab's lease expires
            // or it can temporarily select a different identity directory.
            await new Promise((resolve) => setTimeout(resolve, 1_100));

            const offlineUrl = new URL(shareUrl);
            offlineUrl.search = "";
            const hashQueryIndex = offlineUrl.hash.indexOf("?");
            if (hashQueryIndex !== -1) {
                offlineUrl.hash = offlineUrl.hash.slice(0, hashQueryIndex);
            }
            offlineUrl.searchParams.set("peer", "offline");

            const reopenedReader =
                await launchPersistentReader(profileDirectory);
            readerContext = reopenedReader.context;
            logStage("reader-profile-relaunched");
            await reopenedReader.page.goto(offlineUrl.toString(), {
                waitUntil: "domcontentloaded",
            });
            logStage("offline-page-open");
            const reopenedOpenDiagnostics = await waitForProgramOpen(
                reopenedReader.page,
                shareAddress
            );
            console.log("FILE_SHARE_OFFLINE_REOPEN_DIAGNOSTICS", {
                connectionCount: reopenedOpenDiagnostics.connectionCount,
                listCount: reopenedOpenDiagnostics.listCount,
                peerHash: reopenedOpenDiagnostics.peerHash,
                persistChunkReads: reopenedOpenDiagnostics.persistChunkReads,
                programAddress: reopenedOpenDiagnostics.programAddress,
                programHookError: reopenedOpenDiagnostics.programHookError,
            });
            expect(reopenedOpenDiagnostics.peerHash).toBe(initialPeerHash);
            expect(reopenedOpenDiagnostics.programAddress).toBe(shareAddress);
            await waitForFileListed(reopenedReader.page, fileName, TIMEOUT_MS);
            logStage("offline-file-listed");

            const appDiagnostics = await getAppDiagnostics(reopenedReader.page);
            expect(appDiagnostics).toMatchObject({
                peerHintSource: "peer",
                peerAddressCount: 0,
                connectionState: "ready",
            });
            const reopenedBeforeRead = await getDiagnostics(
                reopenedReader.page
            );
            expect(reopenedBeforeRead.connectionCount).toBe(0);
            expect(reopenedBeforeRead.persistChunkReads).toBe(true);
            expect(reopenedBeforeRead.peerHash).toBe(initialPeerHash);
            expect(reopenedBeforeRead.programBlockPresent).toBe(true);
            const reopenedFile = getListedLargeFile(
                reopenedBeforeRead,
                fileName
            );
            expect(reopenedFile?.localEntryHead).toBe(
                initialLocality.file.entryHead
            );
            expect(reopenedFile?.localRootReady).toBe(true);
            expect(reopenedFile?.localRootFinalHash).toBe(expectedHash);
            expect(reopenedFile?.localRootEntryBlockPresent).toBe(true);

            // Leave the reopened replicator idle long enough for its adaptive
            // rebalance to evaluate sparse blocks with freshly cleared runtime
            // retention maps. A fast click alone can race ahead of pruning.
            await reopenedReader.page.waitForTimeout(2_000);
            const stableBeforeRead = await getDiagnostics(reopenedReader.page);
            const stableFile = getListedLargeFile(stableBeforeRead, fileName);
            expect(stableBeforeRead.connectionCount).toBe(0);
            expect(stableFile?.localChunkBlockCount).toBe(
                stableFile?.chunkCount
            );
            logStage("offline-blocks-stable-after-idle");

            await reopenedReader.context.setOffline(true);
            logStage("browser-network-disabled");
            await expectDownloadHash(
                reopenedReader.page,
                fileName,
                expectedHash
            );
            logStage("offline-download-verified");
            const reopenedLocality = await waitForCompleteLocalBlocks(
                reopenedReader.page,
                fileName
            );
            const reopenedRead = reopenedLocality.diagnostics
                .lastReadDiagnostics as Record<string, any>;
            expect(reopenedRead.initialLocalChunkIndexRowCount).toBe(
                reopenedRead.initialLocalChunkCount
            );
            expect(reopenedRead.initialLocalChunkBlockCount).toBe(
                reopenedLocality.file.chunkCount
            );
            expect(reopenedRead.readAheadSource).toBe("persisted-local");
            expect(reopenedRead.chunkManifestHeadLocalBatchAcceptedCount).toBe(
                reopenedLocality.file.chunkCount
            );
            expect(reopenedRead.chunkManifestHeadRemoteBatchQueryCount).toBe(0);
            expect(reopenedRead.chunkBatchQueryCount).toBe(0);
            expect(reopenedRead.chunkBatchResolverFallbackCount).toBe(0);
            expect(reopenedRead.chunkFailure).toBe(null);
        } finally {
            await readerContext?.close().catch(() => {});
            await writerContext?.close().catch(() => {});
            await bootstrap?.stop().catch(() => {});
            await rm(profileDirectory, { recursive: true, force: true }).catch(
                () => {}
            );
            await rm(fixture.dir, { recursive: true, force: true }).catch(
                () => {}
            );
        }
    });
});
