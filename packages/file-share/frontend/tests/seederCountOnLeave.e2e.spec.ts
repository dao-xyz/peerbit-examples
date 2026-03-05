import { test, expect, type Page } from "@playwright/test";

const FILE_SIZE_MB = 40;

const getSeederCount = async (page: Page): Promise<number> => {
    const label = page.locator("span", { hasText: "Seeders:" }).first();
    await expect(label).toBeVisible({ timeout: 60_000 });
    const text = (await label.innerText()).replace(/\s+/g, " ");
    const match = text.match(/Seeders:\s*(\d+)/i);
    if (!match) {
        throw new Error(`Could not parse seeder count from "${text}"`);
    }
    return Number.parseInt(match[1], 10);
};

test.describe("file-share regression", () => {
    test("seeder count drops when receiver leaves during large transfer", async ({
        browser,
        baseURL,
    }) => {
        test.setTimeout(8 * 60 * 1000);
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

        const fileName = `large-${Date.now()}.bin`;
        const uploadPayload = Buffer.alloc(FILE_SIZE_MB * 1024 * 1024, 7);

        try {
            await writer.goto(`${baseURL}/#/`, { waitUntil: "domcontentloaded" });
            await writer.getByPlaceholder("Type a name").fill(`space-${Date.now()}`);
            await writer.getByRole("button", { name: "Create" }).click();
            await writer.waitForURL(/#\/s\//, { timeout: 180_000 });
            await writer
                .getByText("Copy the URL to share all files")
                .waitFor({ timeout: 180_000 });

            const shareUrl = writer.url();
            const initialSeeders = await getSeederCount(writer);

            await reader.goto(shareUrl, { waitUntil: "domcontentloaded" });
            await expect
                .poll(async () => getSeederCount(writer), {
                    timeout: 120_000,
                    message: "Expected receiver join to increase seeder count",
                })
                .toBeGreaterThanOrEqual(initialSeeders + 1);
            const joinedSeeders = await getSeederCount(writer);

            await writer.locator("#imgupload").setInputFiles({
                name: fileName,
                mimeType: "application/octet-stream",
                buffer: uploadPayload,
            });

            // Ensure transfer has started before simulating receiver disconnect.
            await writer
                .locator(".progress-root")
                .waitFor({ state: "visible", timeout: 120_000 });
            await readerContext.close();

            await expect
                .poll(async () => getSeederCount(writer), {
                    timeout: 180_000,
                    message:
                        "Expected writer seeder count to return after receiver leaves",
                })
                .toBeLessThan(joinedSeeders);

            // Upload should still complete and clear progress.
            await writer
                .locator("li", { hasText: fileName })
                .first()
                .waitFor({ timeout: 10 * 60 * 1000 });
            await writer
                .locator(".progress-root")
                .waitFor({ state: "hidden", timeout: 10 * 60 * 1000 });
        } finally {
            await writerContext.close();
            await readerContext.close().catch(() => {});
        }
    });
});
