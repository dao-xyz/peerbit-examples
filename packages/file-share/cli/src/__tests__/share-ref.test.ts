import { describe, expect, it } from "vitest";
import { formatShareUrl, parseShareReference } from "../share-ref.js";

describe("share references", () => {
    it("accepts raw share addresses", () => {
        expect(parseShareReference("zb2rhoExampleShare")).toBe(
            "zb2rhoExampleShare"
        );
    });

    it("extracts addresses from frontend hash URLs", () => {
        expect(
            parseShareReference(
                "https://files.example.invalid/#/s/zb2rhoExampleShare"
            )
        ).toBe("zb2rhoExampleShare");
    });

    it("extracts addresses from path-style share references", () => {
        expect(parseShareReference("/s/zb2rhoExampleShare")).toBe(
            "zb2rhoExampleShare"
        );
    });

    it("formats canonical share URLs", () => {
        expect(formatShareUrl("zb2rhoExampleShare")).toBe(
            "https://files.peerbit.org#/s/zb2rhoExampleShare"
        );
        expect(
            formatShareUrl(
                "zb2rhoExampleShare",
                "https://files.example.invalid/"
            )
        ).toBe("https://files.example.invalid#/s/zb2rhoExampleShare");
    });
});
