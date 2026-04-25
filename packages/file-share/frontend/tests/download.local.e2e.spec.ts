import { test } from "@playwright/test";
import { startBootstrapPeer } from "./bootstrapPeer";
import {
    createSpace,
    expectDownloadedFile,
    rootUrl,
    setSeedMode,
    uploadSyntheticFile,
    waitForFileListed,
    waitForUploadComplete,
    withBootstrap,
} from "./helpers";

const FILE_SIZE_MB = Number(process.env.PW_FILE_MB || "100");
const READER_ROLE = process.env.PW_READER_ROLE || "replicator";

test.describe("file-share download via local bootstrap", () => {
    test(`${READER_ROLE} can download a 100 MB file with the download button`, async ({
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
        const fileName = `local-download-${Date.now()}.bin`;

        try {
            const entryUrl = withBootstrap(rootUrl(baseURL), bootstrap.addrs);
            const shareUrl = await createSpace(
                writer,
                entryUrl,
                `download-space-${Date.now()}`
            );

            await uploadSyntheticFile(writer, fileName, FILE_SIZE_MB);
            await waitForFileListed(writer, fileName, 600_000);
            await waitForUploadComplete(writer, 600_000);

            await reader.goto(shareUrl, { waitUntil: "domcontentloaded" });
            await setSeedMode(reader, READER_ROLE === "replicator");
            await waitForFileListed(reader, fileName, 600_000);

            await expectDownloadedFile(reader, fileName, FILE_SIZE_MB, 600_000);
        } finally {
            await writerContext.close().catch(() => {});
            await readerContext.close().catch(() => {});
            await bootstrap.stop().catch(() => {});
        }
    });
});
