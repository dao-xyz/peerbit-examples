import { test, expect } from "@playwright/test";
import { withSearchParams } from "../utils/url";
import { setupConsoleCapture } from "../utils/consoleCapture";
import {
    seedReplicatorPosts,
    startReplicator,
} from "../replicator/replicatorNode";

const BASE_HTTP = process.env.BASE_URL || "http://localhost:5190";
const SEED_COUNT = 100;
const TOP_N = 10;
const STABILITY_WAIT_MS = 5_000;
const TARGET_INDEX = 50;
const MAX_BLANK_AFTER_FIRST_MS = Number(
    process.env.PW_FEED_MAX_BLANK_MS || (process.env.CI ? "1500" : "500")
);

test.describe("Feed loadMore stability", () => {
    test.setTimeout(300_000);

    let stop: (() => Promise<void>) | undefined;
    let bootstrap: string[] | undefined;
    let prefix: string | undefined;

    test.beforeAll(async () => {
        const { client, addrs, scope } = await startReplicator();
        bootstrap = addrs.map((a) => a.toString());
        prefix = `LoadMoreStable-${Date.now()}`;

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

    test("initial results stay stable, then scroll loads more", async ({
        page,
    }, testInfo) => {
        await page.addInitScript(() => {
            const now = () =>
                typeof performance !== "undefined" && performance.now
                    ? performance.now()
                    : Date.now();
            const isVisible = (el: Element) => {
                const node = el as HTMLElement;
                const style = window.getComputedStyle(node);
                if (style.display === "none" || style.visibility === "hidden")
                    return false;
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };

            (window as any).__E2E_LOAD_OBS__ = {
                spinnerAt: null as number | null,
                firstPostAt: null as number | null,
                emptyAt: null as number | null,
                zeroStartAt: null as number | null,
                maxZeroDurationMs: 0 as number,
            };

            const visiblePostCount = () =>
                Array.from(
                    document.querySelectorAll("[data-canvas-id]")
                ).reduce((acc, el) => acc + (isVisible(el) ? 1 : 0), 0);

            const scan = () => {
                const state = (window as any).__E2E_LOAD_OBS__;
                if (
                    state.spinnerAt == null &&
                    (() => {
                        const el = document.querySelector(
                            '[data-testid="spinner"]'
                        );
                        return !!el && isVisible(el);
                    })()
                ) {
                    state.spinnerAt = now();
                }
                const visible = visiblePostCount();
                if (visible > 0) {
                    if (state.firstPostAt == null) state.firstPostAt = now();
                    if (state.zeroStartAt != null) {
                        state.maxZeroDurationMs = Math.max(
                            state.maxZeroDurationMs,
                            now() - state.zeroStartAt
                        );
                        state.zeroStartAt = null;
                    }
                } else if (state.firstPostAt != null) {
                    if (state.zeroStartAt == null) state.zeroStartAt = now();
                }
                if (
                    state.emptyAt == null &&
                    document.body?.textContent?.includes("Nothing to see here")
                ) {
                    state.emptyAt = now();
                }
            };

            const obs = new MutationObserver(scan);
            // On some PW navigations the init script can run before `document.documentElement` exists.
            // Observing `document` (a Node) avoids a hard failure and still captures mutations.
            obs.observe(document, {
                childList: true,
                subtree: true,
                attributes: true,
            });
            setInterval(scan, 50);
            scan();
        });

        setupConsoleCapture(page, testInfo, {
            printAll: false,
            capturePageErrors: true,
        });

        if (!prefix) throw new Error("Missing seed prefix");

        const hashParams = new URLSearchParams({
            v: "feed",
            s: "new",
            q: prefix,
        });

        const url = withSearchParams(
            `${BASE_HTTP}#/?${hashParams.toString()}`,
            {
                ephemeral: true,
                bootstrap: (bootstrap || []).join(","),
            }
        );

        await page.goto(url);

        // App ready
        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });

        const feed = page.getByTestId("feed");

        // Ensure the query is connected by waiting for the newest seeded post.
        await expect(
            feed.getByText(`${prefix} ${SEED_COUNT - 1}`, { exact: true })
        ).toBeVisible({ timeout: 180_000 });

        const obs = await page.evaluate(() => (window as any).__E2E_LOAD_OBS__);
        expect(obs.emptyAt).toBeNull();
        expect(obs.spinnerAt).not.toBeNull();
        expect(obs.firstPostAt).not.toBeNull();
        expect(obs.spinnerAt).toBeLessThan(obs.firstPostAt);

        const topIds = async () =>
            feed.locator("[data-canvas-id]").evaluateAll((els, limit) => {
                const visible = (el: Element) => {
                    const node = el as HTMLElement;
                    const style = window.getComputedStyle(node);
                    if (style.display === "none") return false;
                    const rect = node.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                };
                const out: string[] = [];
                for (const el of els) {
                    if (!visible(el)) continue;
                    const id = el.getAttribute("data-canvas-id");
                    if (id) out.push(id);
                    if (out.length >= (limit as number)) break;
                }
                return out;
            }, TOP_N);

        await expect
            .poll(async () => (await topIds()).length, { timeout: 60_000 })
            .toBe(TOP_N);

        const initialTop = await topIds();
        await page.waitForTimeout(STABILITY_WAIT_MS);
        const afterWaitTop = await topIds();
        expect(afterWaitTop).toEqual(initialTop);

        const stabilityObs = await page.evaluate(() => {
            const state = (window as any).__E2E_LOAD_OBS__;
            const now =
                typeof performance !== "undefined" && performance.now
                    ? performance.now()
                    : Date.now();
            const maxZero =
                state.zeroStartAt != null
                    ? Math.max(state.maxZeroDurationMs, now - state.zeroStartAt)
                    : state.maxZeroDurationMs;
            return { ...state, maxZeroDurationMs: maxZero };
        });
        expect(stabilityObs.maxZeroDurationMs).toBeLessThan(
            MAX_BLANK_AFTER_FIRST_MS
        );

        const initialCount = await feed.locator("[data-canvas-id]").count();

        // Scroll until we reach an older (deeper) item, which requires loadMore.
        const targetText = `${prefix} ${TARGET_INDEX}`;
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
                    `Timed out waiting for older post to load: "${targetText}"`
                );
            }
        }

        await expect(card).toBeVisible({ timeout: 30_000 });

        const afterScrollCount = await feed.locator("[data-canvas-id]").count();
        expect(afterScrollCount).toBeGreaterThan(initialCount);
    });
});
