import { test, expect } from "@playwright/test";
import { withSearchParams } from "../utils/url";
import { setupConsoleCapture } from "../utils/consoleCapture";
import {
    seedReplicatorPosts,
    startReplicator,
} from "../replicator/replicatorNode";

const BASE_HTTP = process.env.BASE_URL || "http://localhost:5190";
const SEED_COUNT = Number(process.env.PW_SCROLL_PERF_SEED_COUNT || "10");
const SCROLL_TIMEOUT_MS = Number(
    process.env.PW_SCROLL_PERF_TIMEOUT_MS || (process.env.CI ? "60000" : "30000")
);
const SCROLL_STEP_FRACTION = Number(
    process.env.PW_SCROLL_PERF_SCROLL_STEP_FRACTION || "0.9"
);
const SCROLL_TICK_MS = Number(process.env.PW_SCROLL_PERF_SCROLL_TICK_MS || "150");

async function isInViewport(locator: import("@playwright/test").Locator) {
    return locator.evaluate((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        // Note: offscreen elements can still be "visible" by PW's definition, so ensure overlap.
        return rect.bottom > 0 && rect.top < window.innerHeight;
    });
}

test.describe("Feed scroll perf (replicator)", () => {
    test.setTimeout(300_000);

    let stop: (() => Promise<void>) | undefined;
    let bootstrap: string[] | undefined;
    let prefix: string | undefined;

    test.beforeAll(async () => {
        const { client, addrs, scope } = await startReplicator();
        bootstrap = addrs.map((a) => a.toString());
        prefix = `ScrollPerf ${Date.now()}:`;

        await seedReplicatorPosts({
            client,
            scope,
            count: SEED_COUNT,
            prefix,
        });

        stop = async () => {
            try {
                await client.stop();
            } catch {
                /* ignore */
            }
        };
    });

    test.afterAll(async () => {
        if (stop) await stop();
        stop = undefined;
        bootstrap = undefined;
        prefix = undefined;
    });

    test("scroll newest → oldest (10 posts) and report time", async ({
        page,
    }, testInfo) => {
        setupConsoleCapture(page, testInfo, {
            printAll: false,
            capturePageErrors: true,
        });

        if (!prefix) throw new Error("Missing seed prefix");

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

        // Ensure the replicator data source is connected by waiting for the newest post.
        await expect(
            feed.getByText(`${prefix} ${SEED_COUNT - 1}`, { exact: true })
        ).toBeVisible({ timeout: 180_000 });

        const targetText = `${prefix} 0`;
        const targetCard = feed
            .locator("[data-canvas-id]")
            .filter({ hasText: targetText })
            .first();

        const t0 = Date.now();
        let steps = 0;
        while (true) {
            const elapsed = Date.now() - t0;
            if (elapsed > SCROLL_TIMEOUT_MS) {
                throw new Error(
                    `Timed out after ${elapsed}ms scrolling to oldest post: "${targetText}"`
                );
            }

            if ((await targetCard.count()) > 0) {
                const visible = await targetCard.isVisible();
                if (visible && (await isInViewport(targetCard))) {
                    break;
                }
            }

            await page.evaluate((fraction) => {
                window.scrollBy(0, Math.floor(window.innerHeight * fraction));
            }, SCROLL_STEP_FRACTION);
            steps += 1;
            await page.waitForTimeout(SCROLL_TICK_MS);
        }

        const dt = Date.now() - t0;
        // eslint-disable-next-line no-console
        console.log(
            `[perf] feedScroll:newestToOldest seed=${SEED_COUNT} ms=${dt} steps=${steps}`
        );

        await testInfo.attach("timing:scrollNewestToOldestMs", {
            body: Buffer.from(String(dt), "utf8"),
            contentType: "text/plain",
        });
        await testInfo.attach("timing:scrollNewestToOldestSteps", {
            body: Buffer.from(String(steps), "utf8"),
            contentType: "text/plain",
        });
    });
});

