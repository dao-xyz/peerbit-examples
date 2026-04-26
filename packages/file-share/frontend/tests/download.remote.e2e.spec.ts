import { test } from "@playwright/test";
import {
    createSpace,
    expectDownloadedFile,
    rootUrl,
    setSeedMode,
    uploadSyntheticFile,
    waitForFileListed,
    waitForUploadComplete,
} from "./helpers";

const PROD_ONLY = process.env.PW_PROD_SMOKE === "1";
const FILE_SIZE_MB = Number(process.env.PW_FILE_MB || "100");
const READER_ROLE = process.env.PW_READER_ROLE || "adaptive";

test.describe("file-share download via production site", () => {
    test.skip(!PROD_ONLY, "Set PW_PROD_SMOKE=1 to run against production");

    test(`${READER_ROLE} can download a 100 MB file with the download button`, async ({
        browser,
        baseURL,
    }) => {
        test.setTimeout(15 * 60 * 1000);
        if (!baseURL) {
            throw new Error("Missing baseURL");
        }

        const writerContext = await browser.newContext({
            acceptDownloads: true,
        });
        const readerContext = await browser.newContext({
            acceptDownloads: true,
        });
        const writer = await writerContext.newPage();
        const reader = await readerContext.newPage();
        const fileName = `prod-download-${Date.now()}.bin`;

        try {
            const shareUrl = await createSpace(
                writer,
                rootUrl(baseURL),
                `download-space-${Date.now()}`
            );

            await uploadSyntheticFile(writer, fileName, FILE_SIZE_MB);
            await waitForFileListed(writer, fileName, 600_000);
            await waitForUploadComplete(writer, 600_000);

            await reader.goto(shareUrl, { waitUntil: "domcontentloaded" });
            await setSeedMode(reader, READER_ROLE !== "observer");
            await waitForFileListed(reader, fileName, 600_000);

            await expectDownloadedFile(reader, fileName, FILE_SIZE_MB, 600_000);
        } finally {
            await writerContext.close().catch(() => {});
            await readerContext.close().catch(() => {});
        }
    });
});
