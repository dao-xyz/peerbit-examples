import { test, expect, chromium } from "@playwright/test";

const BASE_URL =
    process.env.BASE_URL || "http://localhost:5173#/?ephemeral=false";

// Reproduces session lock: open one page, then a second. The second should not dead-end; it should recover after first closes.
test.describe("Peer singleton recovery", () => {
    test("second tab recovers after first closes", async ({ browser }) => {
        // Use separate contexts to simulate distinct tabs
        const context1 = await browser.newContext();
        const page1 = await context1.newPage();
        await page1.goto(BASE_URL);

        // Wait until peer is ready in first tab
        await page1.waitForFunction(() => !!(window as any).__peerInfo, null, {
            timeout: 30000,
        });

        // Second tab attempts to open while first is active
        const context2 = await browser.newContext();
        const page2 = await context2.newPage();
        await page2.goto(BASE_URL);

        // If there was a busy error UI, it should eventually disappear without manual action
        // Close first tab to release any lock
        await context1.close();

        // With retrying PeerProvider, second tab should establish a peer shortly after
        await expect
            .poll(
                async () =>
                    await page2.evaluate(() => !!(window as any).__peerInfo),
                { timeout: 30000 }
            )
            .toBe(true);

        await context2.close();
    });
});
