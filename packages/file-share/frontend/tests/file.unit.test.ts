import { describe, expect, it } from "vitest";
import {
    formatIndexedChunkRatio,
    hasFileChunkChange,
    shouldDisableFileDownload,
} from "../src/File";

describe("file download controls", () => {
    it("disables while a download is in progress", () => {
        expect(
            shouldDisableFileDownload({
                progress: 0,
            })
        ).to.equal(true);
    });

    it("does not block pending large files before the read starts", () => {
        expect(
            shouldDisableFileDownload({
                progress: null,
            })
        ).to.equal(false);
    });

    it("refreshes local progress when a child chunk is removed", () => {
        expect(
            hasFileChunkChange(
                {
                    added: [],
                    removed: [{ parentId: "file-id" }],
                },
                "file-id"
            )
        ).toBe(true);
    });

    it("labels local chunk counts as indexed rather than fully replicated", () => {
        expect(formatIndexedChunkRatio(100)).toBe("100% indexed");
    });
});
