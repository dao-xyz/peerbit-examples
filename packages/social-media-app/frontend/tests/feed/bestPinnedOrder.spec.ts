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

test.describe("Best feed pins new posts in-session", () => {
    test("two posts appear in creation order at the top of Best", async ({
        page,
    }) => {
        const url = withSearchParams(OFFLINE_BASE, { ephemeral: false });
        await page.goto(url);
        await expectPersistent(page);
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
        await waitForComposerReady(page);

        const toolbar = page.getByTestId("toolbarcreatenew").first();
        const sendBtn = toolbar.getByTestId("send-button");
        const post = async (message: string) => {
            const textArea = toolbar.locator("textarea");
            await expect(textArea).toBeVisible({ timeout: 30000 });
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
                        ((await getReplyPublishedEvents(page))?.length ?? 0) >
                        base,
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
        };

        const firstMsg = uid("BestOrderA");
        const firstId = await post(firstMsg);

        const secondMsg = uid("BestOrderB");
        const secondId = await post(secondMsg);

        // Ensure both appear in the feed with the latest post on top (insertion order)
        const order = await page.evaluate(
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
            { a: firstId, b: secondId }
        );

        expect(order.b).toBeGreaterThanOrEqual(0);
        expect(order.a).toBeGreaterThanOrEqual(0);
        expect(order.b).toBeLessThan(order.a);
    });
});
