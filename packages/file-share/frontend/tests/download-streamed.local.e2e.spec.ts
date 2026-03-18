import { test } from "@playwright/test";
import { startBootstrapPeer } from "./bootstrapPeer";
import {
    createSpace,
    expectSavedViaPicker,
    installMockSaveFilePicker,
    rootUrl,
    setSeedMode,
    uploadSyntheticFile,
    waitForFileListed,
    waitForUploadComplete,
    withPeer,
} from "./helpers";

const FILE_SIZE_MB = Number(process.env.PW_FILE_MB || "100");

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

        try {
            await installMockSaveFilePicker(reader);
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

            await reader
                .locator("li", { hasText: fileName })
                .getByTestId("download-file")
                .click();

            await expectSavedViaPicker(
                reader,
                fileName,
                FILE_SIZE_MB,
                10 * 60 * 1000
            );
        } finally {
            await writerContext.close().catch(() => {});
            await readerContext.close().catch(() => {});
            await bootstrap.stop().catch(() => {});
        }
    });
});
