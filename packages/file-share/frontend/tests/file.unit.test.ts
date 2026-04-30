import { describe, expect, it } from "vitest";
import { shouldDisableFileDownload } from "../src/File";

describe("file download controls", () => {
    it("disables while a download is in progress", () => {
        expect(
            shouldDisableFileDownload({
                progress: 0,
                waitForLocalChunksBeforeDownload: false,
                replicatedChunksRatio: 0,
                largeFileReady: true,
            })
        ).to.equal(true);
    });

    it("waits for replicated pending large files to materialize locally", () => {
        expect(
            shouldDisableFileDownload({
                progress: null,
                waitForLocalChunksBeforeDownload: true,
                replicatedChunksRatio: 99,
                largeFileReady: false,
            })
        ).to.equal(true);

        expect(
            shouldDisableFileDownload({
                progress: null,
                waitForLocalChunksBeforeDownload: true,
                replicatedChunksRatio: 100,
                largeFileReady: false,
            })
        ).to.equal(false);
    });

    it("keeps observer pending large files downloadable for remote reads", () => {
        expect(
            shouldDisableFileDownload({
                progress: null,
                waitForLocalChunksBeforeDownload: false,
                replicatedChunksRatio: 0,
                largeFileReady: false,
            })
        ).to.equal(false);
    });

    it("enables ready large files even before local chunk badges update", () => {
        expect(
            shouldDisableFileDownload({
                progress: null,
                waitForLocalChunksBeforeDownload: true,
                replicatedChunksRatio: 0,
                largeFileReady: true,
            })
        ).to.equal(false);
    });
});
