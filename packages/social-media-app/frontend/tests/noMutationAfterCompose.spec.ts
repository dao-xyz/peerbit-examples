import { test, expect } from "@playwright/test";
import { OFFLINE_BASE } from "./utils/url";

function uid(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// Helper to read replyPublished events captured on window
async function getReplyPublishedEvents(page: import("@playwright/test").Page) {
    return (await page.evaluate(() => (window as any).__DBG_EVENTS))?.filter(
        (e: any) => e?.source === "DraftManager" && e?.name === "replyPublished"
    );
}

test.describe("Composer should not mutate existing posts while drafting", () => {
    test("send two posts; composing a third does not change earlier content", async ({
        page,
    }) => {
        await page.goto(OFFLINE_BASE);

        // Prepare debug capture for replyPublished
        await page.evaluate(() => {
            (window as any).__DBG_EVENTS = [];
            if (!(window as any).__LISTENING_PUBLISH) {
                (window as any).__LISTENING_PUBLISH = true;
                window.addEventListener("debug:event", (e: any) => {
                    (window as any).__DBG_EVENTS.push(e.detail);
                });
            }
        });

        const toolbar = page.getByTestId("toolbarcreatenew").first();
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 30000 });
        const sendBtn = toolbar.getByTestId("send-button");

        // Helper to publish one text-only post and return replyId
        async function publishOnce(message: string) {
            // Ensure editor is active and a textarea exists (draft can rotate/mount)
            try {
                const textContainer = toolbar
                    .getByTestId("composer-textarea")
                    .first();
                await textContainer.click({ timeout: 800 });
            } catch {}
            await page
                .waitForFunction(
                    () =>
                        !!document.querySelector(
                            '[data-testid="toolbarcreatenew"] textarea'
                        ),
                    null, // dummy arg
                    { timeout: 5000 }
                )
                .catch(() => {});
            const area = toolbar.locator("textarea");
            await area.fill(message, { timeout: 3000 });
            await expect(sendBtn).toBeEnabled({ timeout: 10000 });
            const base = (await getReplyPublishedEvents(page)).length;
            await sendBtn.click();
            // Input clears or draft rotates
            await page
                .waitForFunction(
                    () => {
                        const el = document.querySelector(
                            '[data-testid="toolbarcreatenew"] textarea'
                        ) as HTMLTextAreaElement | null;
                        return !el || el.value === "";
                    },
                    null, // dummy arg
                    { timeout: 3000 }
                )
                .catch(() => {});
            // Wait for replyPublished
            await expect
                .poll(
                    async () =>
                        (await getReplyPublishedEvents(page)).length > base,
                    { timeout: 30000 }
                )
                .toBe(true);
            const evt = (await getReplyPublishedEvents(page))[base];
            const id = evt.replyId as string;
            // Ensure card appears
            const card = page.locator(`[data-canvas-id="${id}"]`).first();
            await expect(card).toBeVisible({ timeout: 30000 });
            // Navigate to detail view to assert exact text content, then navigate back
            await page.evaluate((rid) => {
                (location as any).hash = `#/c/${encodeURIComponent(rid)}`;
            }, id);
            await expect(page).toHaveURL(/#\/c\//);
            const detailCard = page.locator(`[data-canvas-id="${id}"]`).first();
            await expect
                .poll(
                    async () => {
                        const t = (await detailCard.textContent()) || "";
                        return t.includes(message);
                    },
                    { timeout: 15000 }
                )
                .toBe(true);
            await page.evaluate(() => {
                (location as any).hash = `#/`;
            });
            await expect(toolbar).toBeVisible({ timeout: 30000 });
            return id;
        }

        const msg1 = uid("NoMut1");
        const id1 = await publishOnce(msg1);

        const msg2 = uid("NoMut2");
        const id2 = await publishOnce(msg2);

        // Start composing a third but DO NOT send
        const msg3 = uid("DraftOnly");
        // Ensure the textarea exists (may have rotated)
        await page
            .waitForFunction(
                () =>
                    !!document.querySelector(
                        '[data-testid="toolbarcreatenew"] textarea'
                    ),
                null, // dummy arg
                { timeout: 5000 }
            )
            .catch(() => {});
        const textArea2 = toolbar.locator("textarea");
        await textArea2.fill(msg3, { timeout: 3000 });

        // Validate that previous posts remain unchanged and do not contain msg3
        for (const [id, msg] of [
            [id1, msg1],
            [id2, msg2],
        ] as const) {
            await page.evaluate((rid) => {
                (location as any).hash = `#/c/${encodeURIComponent(rid)}`;
            }, id);
            await expect(page).toHaveURL(/#\/c\//);
            const detailCard = page.locator(`[data-canvas-id="${id}"]`).first();
            // Positive: original text present
            await expect
                .poll(
                    async () => {
                        const t = (await detailCard.textContent()) || "";
                        return t.includes(msg);
                    },
                    { timeout: 15000 }
                )
                .toBe(true);
            // Negative: third draft text not present in detail view for this card
            await expect(detailCard.getByText(msg3)).toHaveCount(0);
            // Back to feed
            await page.evaluate(() => {
                (location as any).hash = `#/`;
            });
            await expect(toolbar).toBeVisible({ timeout: 20000 });
        }
    });
});
