import { test, expect } from "../fixtures/persistentContext";
import { OFFLINE_BASE, withSearchParams } from "../utils/url";
import { expectPersistent } from "../utils/persistence";
import { Page } from "@playwright/test";

function uid(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// Capture DraftManager.replyPublished events
async function getReplyPublishedEvents(page: Page) {
    return (await page.evaluate(() => (window as any).__DBG_EVENTS))?.filter(
        (e: any) => e?.source === "DraftManager" && e?.name === "replyPublished"
    );
}

async function waitForComposerReady(page: Page, timeout = 30000) {
    await page.waitForFunction(
        () => {
            const ready = (window as any).__DRAFT_READY;
            const textarea = document.querySelector(
                '[data-testid="toolbarcreatenew"] textarea'
            );
            return !!ready?.draftId && !!textarea;
        },
        null,
        { timeout }
    );
}

async function openFeedView(
    page: Page,
    url: string,
    viewLabel: string,
    ids: string[] = []
) {
    await page.goto(url);
    await expectPersistent(page);
    await waitForComposerReady(page);
    await page
        .getByRole("button", { name: viewLabel, exact: true })
        .first()
        .click();
    for (const id of ids) {
        await expect(
            page.locator(`[data-canvas-id="${id}"]`).first()
        ).toBeVisible({ timeout: 30000 });
    }
}

function orderForIds(page: Page, a: string, b: string) {
    return page.evaluate(
        ({ a, b }) => {
            const nodes = Array.from(
                document.querySelectorAll("[data-canvas-id]")
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

async function replyCountsForIds(page: Page, ids: string[]) {
    return page.evaluate((ids) => {
        const parseCount = (id: string) => {
            const btn = document.querySelector(
                `[data-canvas-id="${id}"] [data-testid="open-comments"]`
            );
            if (!btn) return null;
            const text = (btn.textContent || "").replace(/[^0-9]/g, "");
            const n = Number.parseInt(text || "0", 10);
            return Number.isFinite(n) ? n : 0;
        };
        return ids.map((id) => parseCount(id));
    }, ids);
}

async function publishPost(page: Page, message: string) {
    const toolbar = page.getByTestId("toolbarcreatenew").first();
    const sendBtn = toolbar.getByTestId("send-button");
    const textArea = toolbar.locator("textarea");
    await expect(textArea).toBeVisible({ timeout: 30000 });
    const privacySwitch = toolbar.getByRole("switch", { name: /Private/i });
    try {
        if ((await privacySwitch.count()) > 0) {
            const checked =
                (await privacySwitch.getAttribute("aria-checked")) === "true";
            if (checked) await privacySwitch.click();
        }
    } catch {}
    await textArea.fill(message);
    await expect(sendBtn).toBeEnabled({ timeout: 20000 });
    const base = (await getReplyPublishedEvents(page))?.length ?? 0;
    await sendBtn.click();
    await page.waitForFunction(
        () => {
            const el = document.querySelector(
                '[data-testid="toolbarcreatenew"] textarea'
            ) as HTMLTextAreaElement | null;
            return !el || el.value === "";
        },
        null,
        { timeout: 20000 }
    );
    await expect
        .poll(
            async () =>
                ((await getReplyPublishedEvents(page))?.length ?? 0) > base,
            { timeout: 20000 }
        )
        .toBe(true);
    const evt = (await getReplyPublishedEvents(page))[base];
    const replyId = evt.replyId as string;
    const card = page.locator(`[data-canvas-id="${replyId}"]`).first();
    await expect(card).toBeVisible({ timeout: 30000 });
    await expect(card.getByText(message)).toBeVisible({
        timeout: 30000,
    });
    return replyId;
}

async function addCommentToPost(page: Page, postId: string, comment: string) {
    // Jump directly to the post detail view (chat) to comment
    await page.evaluate((id) => {
        const url = new URL(window.location.href);
        url.hash = `#/c/${encodeURIComponent(id)}?view=chat&v=feed`;
        window.location.assign(url.toString());
    }, postId);
    await expect(page).toHaveURL(/#\/c\//, { timeout: 15000 });
    await waitForComposerReady(page);
    const baseEvents =
        (await page.evaluate(() => (window as any).__DBG_EVENTS?.length)) || 0;

    const replyToolbar = page.getByTestId("toolbarcreatenew").last();
    try {
        await replyToolbar.getByTestId("composer-textarea").first().click({
            timeout: 1500,
        });
    } catch {}
    const privacySwitch = replyToolbar.getByRole("switch", {
        name: /Private/i,
    });
    try {
        if ((await privacySwitch.count()) > 0) {
            const checked =
                (await privacySwitch.getAttribute("aria-checked")) === "true";
            if (checked) await privacySwitch.click();
        }
    } catch {}
    const commentBox = replyToolbar.locator("textarea").first();
    await expect(commentBox).toBeVisible({ timeout: 20000 });

    await commentBox.click({ timeout: 2000 });
    await commentBox.fill(comment);
    const sendBtn = replyToolbar.getByTestId("send-button");
    await expect(sendBtn).toBeVisible({ timeout: 20000 });
    await expect
        .poll(
            async () => {
                await page.waitForTimeout(250);
                if (!(await sendBtn.isEnabled())) {
                    await commentBox.type(" .");
                }
                return await sendBtn.isEnabled();
            },
            { timeout: 30000, intervals: [200, 400, 800, 1200] }
        )
        .toBe(true);

    await sendBtn.click();
    await expect
        .poll(
            async () => {
                const evts =
                    (await page.evaluate(
                        () => (window as any).__DBG_EVENTS?.length
                    )) || 0;
                return evts > baseEvents;
            },
            { timeout: 30000 }
        )
        .toBe(true);
    // Caller reopens feed and asserts ordering.
}

test.describe("Best feed ordering (after refresh)", () => {
    test("two posts appear in creation order after a refresh", async ({
        page,
    }) => {
        const url = withSearchParams(OFFLINE_BASE, { ephemeral: false });
        await openFeedView(page, url, "Best");
        await page.evaluate(() => {
            (window as any).__DRAFT_READY = null;
            (window as any).__DBG_EVENTS = [];
            if (!(window as any).__LISTENING_PUBLISH) {
                (window as any).__LISTENING_PUBLISH = true;
                window.addEventListener("debug:event", (e: any) => {
                    (window as any).__DBG_EVENTS.push(e.detail);
                });
            }
        });

        const firstId = await publishPost(page, uid("BestOrderA"));
        const secondId = await publishPost(page, uid("BestOrderB"));

        // Refresh to avoid transient in-session pinning and assert persisted Best order
        await openFeedView(page, url, "Best", [firstId, secondId]);
        const order = await orderForIds(page, firstId, secondId);

        expect(order.b).toBeGreaterThanOrEqual(0);
        expect(order.a).toBeGreaterThanOrEqual(0);
        expect(order.b).toBeLessThan(order.a);
    });

    test("posts with more comments rise above newer posts after refresh", async ({
        page,
    }) => {
        const url = withSearchParams(OFFLINE_BASE, { ephemeral: false });
        await openFeedView(page, url, "Best");
        await page.evaluate(() => {
            (window as any).__DRAFT_READY = null;
            (window as any).__DBG_EVENTS = [];
            if (!(window as any).__LISTENING_PUBLISH) {
                (window as any).__LISTENING_PUBLISH = true;
                window.addEventListener("debug:event", (e: any) => {
                    (window as any).__DBG_EVENTS.push(e.detail);
                });
            }
        });

        const olderId = await publishPost(page, uid("BestCommentOlder"));
        const newerId = await publishPost(page, uid("BestCommentNewer"));

        await addCommentToPost(page, olderId, uid("Comment-on-older"));

        // Reload feed to clear local pinning and wait until counts + ordering reflect the reply.
        await expect
            .poll(
                async () => {
                    try {
                        await openFeedView(page, url, "Best", [
                            olderId,
                            newerId,
                        ]);
                    } catch {
                        return false;
                    }
                    const [olderCount, newerCount] = await replyCountsForIds(
                        page,
                        [olderId, newerId]
                    );
                    const order = await orderForIds(page, olderId, newerId);
                    const countsOk =
                        olderCount != null &&
                        newerCount != null &&
                        olderCount > newerCount;
                    const orderOk =
                        order.b >= 0 && order.a >= 0 && order.b < order.a;
                    return countsOk && orderOk;
                },
                { timeout: 60000, intervals: [1500, 3000, 6000] }
            )
            .toBe(true);
    });

    for (const view of ["New", "Recent"]) {
        test(`${view} shows newest post first after refresh`, async ({
            page,
        }) => {
            const url = withSearchParams(OFFLINE_BASE, { ephemeral: false });
            await openFeedView(page, url, view);
            const ids = [
                await publishPost(page, uid(`${view}-older`)),
                await publishPost(page, uid(`${view}-mid`)),
                await publishPost(page, uid(`${view}-newest`)),
            ];

            await openFeedView(page, url, view, ids);
            const order = await orderForIds(page, ids[0], ids[2]); // compare oldest vs newest
            // Newest (ids[2]) should appear above oldest (ids[0])
            expect(order.b).toBeGreaterThanOrEqual(0);
            expect(order.a).toBeGreaterThanOrEqual(0);
            expect(order.b).toBeLessThan(order.a);
        });
    }
});
