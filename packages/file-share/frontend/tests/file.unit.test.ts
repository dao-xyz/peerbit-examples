import { describe, expect, it } from "vitest";
import { shouldDisableFileDownload } from "../src/File";

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
});
