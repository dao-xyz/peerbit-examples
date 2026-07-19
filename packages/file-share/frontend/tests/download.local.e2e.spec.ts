import { expect, test, type Page } from "@playwright/test";
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

const getTopologySnapshot = async (page: Page) =>
    await page.evaluate(async () => {
        const hooks = (window as any).__peerbitFileShareTestHooks;
        if (!hooks?.getTopologySnapshot) {
            throw new Error(
                "Missing __peerbitFileShareTestHooks.getTopologySnapshot"
            );
        }
        return await hooks.getTopologySnapshot();
    });

const counterpartDirectBlockStreams = (
    diagnostics: Record<string, any>,
    remotePeer: string
) =>
    (Array.isArray(diagnostics.directBlockStreams)
        ? diagnostics.directBlockStreams
        : []
    ).filter(
        (stream: Record<string, any>) =>
            stream.remotePeer === remotePeer &&
            stream.counterStreamIdentityMatch === true &&
            stream.connectionIdentityMatchCount === 1 &&
            typeof stream.id === "string" &&
            stream.id.length > 0 &&
            typeof stream.connectionId === "string" &&
            stream.connectionId.length > 0 &&
            typeof stream.multiplexer === "string" &&
            stream.multiplexer.length > 0 &&
            Number.isSafeInteger(stream.bytes) &&
            stream.bytes >= 0
    );

const directBlockStreamKey = (stream: Record<string, any>) =>
    [stream.connectionId, stream.direction, stream.id, stream.multiplexer].join(
        ":"
    );

test.describe("file-share download via local bootstrap", () => {
    test("observer can download a 100 MB file with the download button", async ({
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
            await setSeedMode(reader, false);
            await waitForFileListed(reader, fileName, 600_000);

            // Let DirectStream's 500 ms outbound-candidate grace period settle
            // before capturing continuity evidence.
            await reader.waitForTimeout(750);

            const writerDiagnosticsBefore = await getTopologySnapshot(writer);
            const readerDiagnosticsBefore = await getTopologySnapshot(reader);
            expect(writerDiagnosticsBefore.peerId).toEqual(expect.any(String));
            expect(writerDiagnosticsBefore.peerId.length).toBeGreaterThan(0);
            expect(readerDiagnosticsBefore.peerId).toEqual(expect.any(String));
            expect(readerDiagnosticsBefore.peerId.length).toBeGreaterThan(0);
            const writerStreamsBefore = counterpartDirectBlockStreams(
                writerDiagnosticsBefore,
                readerDiagnosticsBefore.peerId
            );
            const readerStreamsBefore = counterpartDirectBlockStreams(
                readerDiagnosticsBefore,
                writerDiagnosticsBefore.peerId
            );
            expect(writerStreamsBefore.length).toBeGreaterThan(0);
            expect(readerStreamsBefore.length).toBeGreaterThan(0);

            await expectDownloadedFile(reader, fileName, FILE_SIZE_MB, 600_000);

            const [writerDiagnosticsAfter, readerDiagnosticsAfter] =
                await Promise.all([
                    getTopologySnapshot(writer),
                    getTopologySnapshot(reader),
                ]);
            const writerKeysAfter = new Set(
                counterpartDirectBlockStreams(
                    writerDiagnosticsAfter,
                    readerDiagnosticsBefore.peerId
                ).map(directBlockStreamKey)
            );
            const readerKeysAfter = new Set(
                counterpartDirectBlockStreams(
                    readerDiagnosticsAfter,
                    writerDiagnosticsBefore.peerId
                ).map(directBlockStreamKey)
            );
            expect(
                writerStreamsBefore.some((stream: Record<string, any>) =>
                    writerKeysAfter.has(directBlockStreamKey(stream))
                )
            ).toBe(true);
            expect(
                readerStreamsBefore.some((stream: Record<string, any>) =>
                    readerKeysAfter.has(directBlockStreamKey(stream))
                )
            ).toBe(true);
        } finally {
            await writerContext.close().catch(() => {});
            await readerContext.close().catch(() => {});
            await bootstrap.stop().catch(() => {});
        }
    });
});
