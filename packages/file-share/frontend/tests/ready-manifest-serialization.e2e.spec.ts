import { expect, test } from "@playwright/test";

const probePath = new URL("./ready-manifest-browser-probe.ts", import.meta.url)
    .pathname;

test("decodes ready manifests with chunk entry heads in the browser runtime", async ({
    page,
    baseURL,
}) => {
    if (!baseURL) {
        throw new Error("Missing baseURL");
    }

    await page.goto(baseURL, { waitUntil: "domcontentloaded" });

    const result = await page.evaluate(async (path) => {
        const { roundtripReadyManifest } = await import(
            /* @vite-ignore */ `/@fs${path}`
        );
        return roundtripReadyManifest();
    }, probePath);

    expect(result.constructor).toBe("LargeFileWithChunkHeads");
    expect(result.firstByte).toBe(2);
    expect(result.largeFileLike).toBe(true);
    expect(result.instanceOfLargeFileWithChunkHeads).toBe(true);
    expect(result.chunkEntryHeadCount).toBe(20);
});
