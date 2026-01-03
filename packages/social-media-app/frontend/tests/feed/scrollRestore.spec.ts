import { test, expect } from "@playwright/test";
import { withSearchParams } from "../utils/url";
import { setupConsoleCapture } from "../utils/consoleCapture";
import {
    seedReplicatorPosts,
    startReplicator,
} from "../replicator/replicatorNode";

const BASE_HTTP = process.env.BASE_URL || "http://localhost:5190";
const SEED_COUNT = 160;
const TARGET_INDEX = 80;
const RECOVERY_BUDGET_MS = Number(
    process.env.PW_SCROLL_RECOVERY_BUDGET_MS ||
        (process.env.CI ? "15000" : "8000")
);
const RECOVERY_ASSERT_TIMEOUT_MS = Math.max(RECOVERY_BUDGET_MS * 2, 30_000);
const MAX_OFFSET_ERROR_PX = 300;
const DEBUG_HISTORY = process.env.PW_SCROLL_RESTORE_DEBUG_HISTORY === "1";

test.describe("Feed scroll restoration", () => {
    test.setTimeout(300_000);

    let stop: (() => Promise<void>) | undefined;
    let bootstrap: string[] | undefined;
    let prefix: string | undefined;

    test.beforeAll(async () => {
        const { client, addrs, scope } = await startReplicator();
        bootstrap = addrs.map((a) => a.toString());
        prefix = `ScrollRestore ${Date.now()}:`;

        await seedReplicatorPosts({
            client,
            scope,
            count: SEED_COUNT,
            prefix,
        });

        stop = async () => {
            try {
                await client.stop();
            } catch {}
        };
    });

    test.afterAll(async () => {
        if (stop) await stop();
        stop = undefined;
        bootstrap = undefined;
        prefix = undefined;
    });

    test("back returns to same scroll position after opening a deep post", async ({
        page,
    }, testInfo) => {
        setupConsoleCapture(page, testInfo, {
            printAll: false,
            capturePageErrors: true,
        });

        if (!prefix) throw new Error("Missing seed prefix");
        const targetText = `${prefix} ${TARGET_INDEX}`;
        const url = withSearchParams(`${BASE_HTTP}#/?s=new`, {
            ephemeral: true,
            bootstrap: (bootstrap || []).join(","),
        });

        await page.goto(url);

        const attachHistory = async (label: string) => {
            if (!DEBUG_HISTORY) return;
            const snapshot = await page.evaluate(() => {
                const s: any = window.history.state;
                return {
                    href: window.location.href,
                    hash: window.location.hash,
                    search: window.location.search,
                    historyState: s
                        ? { idx: s.idx, key: s.key, usr: s.usr }
                        : null,
                };
            });
            await testInfo.attach(`history:${label}`, {
                body: Buffer.from(JSON.stringify(snapshot, null, 2), "utf8"),
                contentType: "application/json",
            });
        };

        await attachHistory("afterGoto");

        // App ready
        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });

        const feed = page.getByTestId("feed");

        // Ensure the data source is connected by waiting for the newest post to appear.
        await expect(
            feed.getByText(`${prefix} ${SEED_COUNT - 1}`, { exact: true })
        ).toBeVisible({ timeout: 180_000 });

        // Scroll until a deep (older) post is actually visible.
        const card = feed
            .locator("[data-canvas-id]")
            .filter({ hasText: targetText })
            .first();
        const t0 = Date.now();
        while ((await card.count()) === 0) {
            await page.evaluate(() => {
                window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
            });
            await page.waitForTimeout(250);
            if (Date.now() - t0 > 180_000) {
                throw new Error(
                    `Timed out waiting for target post to become visible: "${targetText}"`
                );
            }
        }
        await expect(card).toBeVisible({ timeout: 30_000 });
        // Ensure we measure and snapshot at the same scrolled position (avoid Playwright auto-scroll).
        await card.scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);

        const anchorId = await card.getAttribute("data-canvas-id");
        if (!anchorId) throw new Error("Missing data-canvas-id for target card");

        const beforeTop = await card.evaluate(
            (el) => (el as HTMLElement).getBoundingClientRect().top
        );

        // Open the post (avoid clicking markdown/text elements which are non-navigating).
        await card
            .getByTestId("open-post")
            .evaluate((el) => (el as HTMLElement).click());
        await expect(page).toHaveURL(/#\/c\//, { timeout: 30_000 });
        await attachHistory("afterOpenPost");

        // Back to feed via the in-app back button.
        const tBack = Date.now();
        await page.getByTestId("nav-back").click();
        await expect(feed).toBeVisible({ timeout: 60_000 });
        await attachHistory("afterBack");

        const cardAfter = feed.locator(`[data-canvas-id="${anchorId}"]`).first();
        await expect(cardAfter).toBeVisible({
            timeout: RECOVERY_ASSERT_TIMEOUT_MS,
        });

        // Allow some layout variance (header/toolbar animation) but still expect to return to the same vicinity.
        await expect
            .poll(
                async () => {
                    const top = await cardAfter.evaluate(
                        (el) => (el as HTMLElement).getBoundingClientRect().top
                    );
                    return Math.abs(top - beforeTop);
                },
                { timeout: RECOVERY_ASSERT_TIMEOUT_MS }
            )
            .toBeLessThanOrEqual(MAX_OFFSET_ERROR_PX);

        const recoveredMs = Date.now() - tBack;
        await testInfo.attach("timing:backToFeedRecoveredMs", {
            body: Buffer.from(String(recoveredMs), "utf8"),
            contentType: "text/plain",
        });
        // Guardrail: recovery should be fast now that the feed iterator is cached across navigation.
        expect(recoveredMs).toBeLessThan(RECOVERY_BUDGET_MS);
    });
});
