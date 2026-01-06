import { test, expect } from "@playwright/test";
import { withSearchParams } from "../utils/url";
import { setupConsoleCapture } from "../utils/consoleCapture";
import {
    addReplicatorReply,
    seedReplicatorPosts,
    startReplicator,
} from "../replicator/replicatorNode";

const BASE_HTTP = process.env.BASE_URL || "http://localhost:5190";

function orderForIdsInFeed(page: any, a: string, b: string) {
    return page.evaluate(
        ({ a, b }) => {
            const nodes = Array.from(
                document.querySelectorAll(
                    '[data-testid="feed"] [data-canvas-id]'
                )
            );
            return {
                a: nodes.findIndex(
                    (n) => n.getAttribute("data-canvas-id") === a
                ),
                b: nodes.findIndex(
                    (n) => n.getAttribute("data-canvas-id") === b
                ),
            };
        },
        { a, b }
    );
}

function commentCountForId(page: any, id: string) {
    return page.evaluate((id) => {
        const btn = document.querySelector(
            `[data-canvas-id="${id}"] [data-testid="open-comments"]`
        ) as HTMLElement | null;
        if (!btn) return null;
        const text = (btn.textContent || "").replace(/[^0-9]/g, "");
        const n = Number.parseInt(text || "0", 10);
        return Number.isFinite(n) ? n : 0;
    }, id);
}

test.describe("Best feed stability on live reply updates", () => {
    test.setTimeout(300_000);

    let stop: (() => Promise<void>) | undefined;
    let bootstrap: string[] | undefined;
    let prefix: string | undefined;
    let addCommentToOldest: ((msg: string) => Promise<void>) | undefined;

    test.beforeAll(async () => {
        const { client, addrs, scope } = await startReplicator();
        bootstrap = addrs.map((a) => a.toString());
        prefix = `BestLiveReplies-${Date.now()}`;

        const seeded = await seedReplicatorPosts({
            client,
            scope,
            count: 2,
            prefix,
            delayMs: 25, // avoid same-ms timestamps
        });

        const oldest = seeded.posts?.[0];
        if (!oldest) {
            throw new Error("Failed to seed two posts");
        }

        addCommentToOldest = async (msg: string) => {
            await addReplicatorReply({
                client,
                scope: seeded.scope,
                parent: oldest,
                message: msg,
                reindexParent: true,
            });
        };

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
        addCommentToOldest = undefined;
    });

    test("does not reorder when an older post gets a new comment, but updates the count", async ({
        page,
    }, testInfo) => {
        setupConsoleCapture(page, testInfo, {
            printAll: false,
            capturePageErrors: true,
        });

        if (!prefix) throw new Error("Missing seed prefix");
        if (!addCommentToOldest) throw new Error("Missing comment helper");

        const hashParams = new URLSearchParams({
            v: "feed",
            s: "best",
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

        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });

        const feed = page.getByTestId("feed");
        const olderText = `${prefix} 0`;
        const newerText = `${prefix} 1`;

        const olderCard = feed
            .locator("[data-canvas-id]")
            .filter({ hasText: olderText })
            .first();
        const newerCard = feed
            .locator("[data-canvas-id]")
            .filter({ hasText: newerText })
            .first();

        await expect(newerCard).toBeVisible({ timeout: 180_000 });
        await expect(olderCard).toBeVisible({ timeout: 180_000 });

        const olderId = await olderCard.getAttribute("data-canvas-id");
        const newerId = await newerCard.getAttribute("data-canvas-id");
        if (!olderId || !newerId) {
            throw new Error("Missing data-canvas-id for seeded cards");
        }

        // Initial order should be chronological (created desc): newer above older.
        const initialOrder = await orderForIdsInFeed(page, olderId, newerId);
        expect(initialOrder.a).toBeGreaterThanOrEqual(0);
        expect(initialOrder.b).toBeGreaterThanOrEqual(0);
        // b=newerId should appear above a=olderId
        expect(initialOrder.b).toBeLessThan(initialOrder.a);

        // Baseline: no comments, so count should be 0 (0 is not rendered in the UI).
        expect(await commentCountForId(page, olderId)).toBe(0);

        const commentMsg = `${prefix}-comment-${Date.now()}`;
        await addCommentToOldest(commentMsg);

        // Open the older post so the app loads the new comment canvas (some peers don't replicate deep replies in the feed view).
        await olderCard.getByTestId("open-comments").first().click();
        await expect(page).toHaveURL(/#\/c\//, { timeout: 30_000 });
        await expect(page.getByText(commentMsg, { exact: true })).toBeVisible({
            timeout: 180_000,
        });

        // Back to feed; order should remain stable even after reply count updates.
        await page.getByTestId("nav-back").click();
        await expect(feed).toBeVisible({ timeout: 60_000 });

        // Wait until the older post's reply count updates in the feed UI.
        await expect
            .poll(async () => await commentCountForId(page, olderId), {
                timeout: 180_000,
                intervals: [500, 1000, 2000, 5000],
            })
            .toBeGreaterThanOrEqual(1);

        // Critical assertion: even though Best ranking would change (replies DESC),
        // the visible feed order remains stable within this session.

        const afterOrder = await orderForIdsInFeed(page, olderId, newerId);
        expect(afterOrder.a).toBeGreaterThanOrEqual(0);
        expect(afterOrder.b).toBeGreaterThanOrEqual(0);
        expect(afterOrder.b).toBeLessThan(afterOrder.a);
    });
});
