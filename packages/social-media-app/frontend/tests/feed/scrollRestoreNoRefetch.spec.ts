import { test, expect } from "@playwright/test";
import { withSearchParams } from "../utils/url";
import { setupConsoleCapture } from "../utils/consoleCapture";
import {
    seedReplicatorPosts,
    startReplicator,
} from "../replicator/replicatorNode";

const BASE_HTTP = process.env.BASE_URL || "http://localhost:5190";
const RECOVERY_BUDGET_MS = Number(
    process.env.PW_BACK_RESTORE_BUDGET_MS || (process.env.CI ? "8000" : "3000")
);

test.describe("Feed back navigation avoids refetch", () => {
    test.setTimeout(120_000);

    let stop: (() => Promise<void>) | undefined;
    let bootstrap: string[] | undefined;
    let prefix: string | undefined;

    test.beforeAll(async () => {
        const { client, addrs, scope } = await startReplicator();
        bootstrap = addrs.map((a) => a.toString());
        prefix = `BackRestore ${Date.now()}:`;

        await seedReplicatorPosts({
            client,
            scope,
            count: 1,
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

    test("reuses previous iterator and shows same post quickly", async ({
        page,
    }, testInfo) => {
        setupConsoleCapture(page, testInfo, {
            printAll: false,
            capturePageErrors: true,
        });

        await page.addInitScript(() => {
            const w: any = window as any;
            w.__DBG = {
                ...(w.__DBG || {}),
                enabled: true,
                captureEvents: true,
            };
            window.dispatchEvent(new Event("__DBG:changed"));
            try {
                (window as any).__DBG_EVENTS = [];
            } catch {}
        });

        if (!prefix) throw new Error("Missing seed prefix");
        const postText = `${prefix} 0`;

        const url = withSearchParams(`${BASE_HTTP}#/?s=new`, {
            ephemeral: true,
            bootstrap: (bootstrap || []).join(","),
        });
        await page.goto(url);

        // App ready
        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });

        const feed = page.getByTestId("feed");
        await expect(feed.getByText(postText, { exact: true })).toBeVisible({
            timeout: 180_000,
        });

        const card = feed
            .locator("[data-canvas-id]")
            .filter({ hasText: postText })
            .first();
        await expect(card).toBeVisible({ timeout: 30_000 });
        const anchorId = await card.getAttribute("data-canvas-id");
        if (!anchorId) throw new Error("Missing data-canvas-id for card");

        // Open the post.
        await card
            .getByTestId("open-post")
            .evaluate((el) => (el as HTMLElement).click());
        await expect(page).toHaveURL(/#\/c\//, { timeout: 30_000 });

        const baselineEventsLen =
            (await page.evaluate(() => (window as any).__DBG_EVENTS?.length)) ||
            0;

        // Back to feed.
        const tBack = Date.now();
        await page.getByTestId("nav-back").click();
        await expect(feed).toBeVisible({ timeout: 60_000 });

        await expect(feed.getByText(postText, { exact: true })).toBeVisible({
            timeout: RECOVERY_BUDGET_MS,
        });

        const recoveredMs = Date.now() - tBack;
        await testInfo.attach("timing:backRecoveredMs", {
            body: Buffer.from(String(recoveredMs), "utf8"),
            contentType: "text/plain",
        });

        // Sanity: the same post card is present after back.
        await expect(feed.locator(`[data-canvas-id="${anchorId}"]`)).toBeVisible(
            { timeout: RECOVERY_BUDGET_MS }
        );

        // Guard against a visible "empty skeleton" render after back navigation.
        const postPreviewRenders = await page.evaluate(
            ({ baseline, anchorId }) => {
                const w: any = window as any;
                const topWin: any = w.top || w;
                const evts = (topWin.__DBG_EVENTS ||
                    w.__DBG_EVENTS ||
                    []) as any[];
                return evts
                    .slice(baseline)
                    .filter(
                        (e: any) =>
                            e?.source === "CanvasPreview" &&
                            e?.name === "render" &&
                            e?.canvasId === anchorId &&
                            e?.variant === "post"
                    )
                    .map((e: any) => ({
                        rects: e?.rects,
                        pending: e?.pending,
                    }));
            },
            { baseline: baselineEventsLen, anchorId }
        );

        await testInfo.attach("debug:postPreviewRendersAfterBack", {
            body: Buffer.from(
                JSON.stringify(postPreviewRenders, null, 2),
                "utf8"
            ),
            contentType: "application/json",
        });

        const emptyRenders = postPreviewRenders.filter(
            (e: any) =>
                (typeof e?.rects === "number" ? e.rects : 0) === 0 &&
                (typeof e?.pending === "number" ? e.pending : 0) === 0
        );
        expect(emptyRenders).toEqual([]);
    });
});
