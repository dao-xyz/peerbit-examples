import { test, expect } from "@playwright/test";
import { OFFLINE_BASE } from "../utils/url";
import { setupConsoleCapture } from "../utils/consoleCapture";

function uid(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function initDebugEvents(page: any) {
    await page.evaluate(() => {
        (window as any).__DBG_EVENTS = [];
        if (!(window as any).__LISTENING_PUBLISH) {
            (window as any).__LISTENING_PUBLISH = true;
            window.addEventListener("debug:event", (e: any) => {
                (window as any).__DBG_EVENTS.push(e.detail);
            });
        }
    });
}

async function getReplyPublishedEvents(page: any) {
    return (await page.evaluate(() => (window as any).__DBG_EVENTS))?.filter(
        (e: any) => e?.source === "DraftManager" && e?.name === "replyPublished"
    );
}

async function ensurePublic(toolbar: any) {
    const privacySwitch = toolbar.getByRole("switch", { name: /Private/i });
    if ((await privacySwitch.count()) === 0) return;
    const checked =
        (await privacySwitch.getAttribute("aria-checked")) === "true";
    if (checked) await privacySwitch.click();
}

async function publishPost(page: any, message: string) {
    const toolbar = page.getByTestId("toolbarcreatenew").first();
    const sendBtn = toolbar.getByTestId("send-button");
    const textArea = toolbar.locator("textarea");
    await expect(textArea).toBeVisible({ timeout: 30_000 });
    await ensurePublic(toolbar);

    const base = (await getReplyPublishedEvents(page))?.length ?? 0;
    await textArea.fill(message);
    await expect(sendBtn).toBeEnabled({ timeout: 20_000 });
    await sendBtn.click();
    await expect
        .poll(
            async () =>
                ((await getReplyPublishedEvents(page))?.length ?? 0) > base,
            { timeout: 30_000 }
        )
        .toBe(true);

    const evt = (await getReplyPublishedEvents(page))[base];
    const replyId = evt.replyId as string;
    const card = page.locator(`[data-canvas-id="${replyId}"]`).first();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByText(message)).toBeVisible({ timeout: 30_000 });
    return card;
}

test.describe("Comment thread does not leak root feed", () => {
    test("opening a post with zero comments shows an empty thread", async ({
        page,
    }, testInfo) => {
        await page.addInitScript(() => {
            try {
                localStorage.setItem("giga.identity.notice.guest.v1", "true");
                localStorage.setItem(
                    "giga.identity.notice.temporary.v1",
                    "true"
                );
            } catch {}
        });

        setupConsoleCapture(page, testInfo, {
            printAll: false,
            capturePageErrors: true,
        });

        await page.goto(OFFLINE_BASE);

        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });

        await initDebugEvents(page);

        const postA = uid("NoLeak-A");
        const postB = uid("NoLeak-B");

        const cardA = await publishPost(page, postA);
        await publishPost(page, postB);

        // Navigate via the comment button (same handler as "open post").
        await cardA.getByTestId("open-comments").first().click();
        await expect(page).toHaveURL(/#\/c\//, { timeout: 30_000 });

        // The opened post should be visible somewhere on the page.
        await expect(
            page.getByText(postA, { exact: true }).first()
        ).toBeVisible({ timeout: 60_000 });

        const thread = page.getByTestId("feed").first();

        // Regression: a thread with no replies must not render root feed items.
        await expect
            .poll(
                async () => ({
                    hasEmptyState:
                        ((await thread.textContent()) || "").includes(
                            "Nothing to see here"
                        ),
                    leaksRootPost:
                        (await thread
                            .getByText(postB, { exact: true })
                            .count()) > 0,
                }),
                { timeout: 60_000, intervals: [250, 500, 1000, 2000] }
            )
            .toEqual({ hasEmptyState: true, leaksRootPost: false });
    });
});
