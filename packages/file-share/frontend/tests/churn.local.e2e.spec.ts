import { test } from "@playwright/test";
import { startBootstrapPeer } from "./bootstrapPeer";
import {
    createSpace,
    expectSeeders,
    expectSeedersAtLeast,
    rootUrl,
    withBootstrap,
    uploadSyntheticFile,
    waitForFileListed,
} from "./helpers";

const FILE_SIZE_MB = Number(process.env.PW_FILE_MB || "10");

test.describe("file-share churn via local bootstrap", () => {
    test("receiver leave resets seeder count", async ({ browser, baseURL }) => {
        test.setTimeout(8 * 60 * 1000);
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
        const fileName = `local-churn-${Date.now()}.bin`;

        try {
            const entryUrl = withBootstrap(rootUrl(baseURL), bootstrap.addrs);
            const shareUrl = await createSpace(
                writer,
                entryUrl,
                `space-${Date.now()}`
            );

            await uploadSyntheticFile(writer, fileName, FILE_SIZE_MB);
            await waitForFileListed(writer, fileName);

            await reader.goto(shareUrl, { waitUntil: "domcontentloaded" });
            await waitForFileListed(reader, fileName);
            await expectSeedersAtLeast(writer, 2);

            await readerContext.close();
            await expectSeeders(writer, 1, 180_000);
        } finally {
            await writerContext.close().catch(() => {});
            await readerContext.close().catch(() => {});
            await bootstrap.stop().catch(() => {});
        }
    });

    test("three tabs reflect churn in seeder count", async ({ browser, baseURL }) => {
        test.setTimeout(8 * 60 * 1000);
        if (!baseURL) {
            throw new Error("Missing baseURL");
        }

        const bootstrap = await startBootstrapPeer();
        const writerContext = await browser.newContext({
            acceptDownloads: true,
        });
        const readerOneContext = await browser.newContext({
            acceptDownloads: true,
        });
        const readerTwoContext = await browser.newContext({
            acceptDownloads: true,
        });
        const writer = await writerContext.newPage();
        const readerOne = await readerOneContext.newPage();
        const readerTwo = await readerTwoContext.newPage();
        const fileName = `local-three-tab-${Date.now()}.bin`;

        try {
            const entryUrl = withBootstrap(rootUrl(baseURL), bootstrap.addrs);
            const shareUrl = await createSpace(
                writer,
                entryUrl,
                `space-${Date.now()}`
            );

            await uploadSyntheticFile(writer, fileName, FILE_SIZE_MB);
            await waitForFileListed(writer, fileName);

            await readerOne.goto(shareUrl, { waitUntil: "domcontentloaded" });
            await waitForFileListed(readerOne, fileName);
            await readerTwo.goto(shareUrl, { waitUntil: "domcontentloaded" });
            await waitForFileListed(readerTwo, fileName);

            await expectSeedersAtLeast(writer, 3);

            await readerOneContext.close();
            await expectSeeders(writer, 2, 180_000);

            await readerTwoContext.close();
            await expectSeeders(writer, 1, 180_000);
        } finally {
            await writerContext.close().catch(() => {});
            await readerOneContext.close().catch(() => {});
            await readerTwoContext.close().catch(() => {});
            await bootstrap.stop().catch(() => {});
        }
    });
});
