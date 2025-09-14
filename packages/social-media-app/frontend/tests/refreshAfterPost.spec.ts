import { test, expect } from "./fixtures/persistentContext";
import { OFFLINE_BASE, withSearchParams } from "./utils/url";
import {
    expectPersistent,
    getPeerInfo,
    waitForPeerInfo,
} from "./utils/persistence";
import exp from "constants";

function uid(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// Capture DraftManager.replyPublished events
async function getReplyPublishedEvents(page: import("@playwright/test").Page) {
    return (await page.evaluate(() => (window as any).__DBG_EVENTS))?.filter(
        (e: any) => e?.source === "DraftManager" && e?.name === "replyPublished"
    );
}

test.describe("refresh after post: no non-empty pending drafts; feed persists", () => {
    test("publish → visible → refresh → feed has post, drafts empty", async ({
        page,
    }) => {
        const url = withSearchParams(OFFLINE_BASE, { ephemeral: false });
        await page.goto(url);

        // Wait for peer to be ready and capture identity before publish
        await expectPersistent(page);
        const beforePeer = await getPeerInfo(page);

        // Install debug accumulator once
        await page.evaluate(() => {
            (window as any).__DBG_EVENTS = [];
            if (!(window as any).__LISTENING_PUBLISH) {
                (window as any).__LISTENING_PUBLISH = true;
                window.addEventListener("debug:event", (e: any) => {
                    (window as any).__DBG_EVENTS.push(e.detail);
                });
            }
        });

        // Compose and publish a post
        const toolbar = page.getByTestId("toolbarcreatenew").first();
        await expect(toolbar).toBeVisible({ timeout: 1e4 });
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 5e3 });
        const sendBtn = toolbar.getByTestId("send-button");

        const message = uid("RefreshPost");
        await textArea.fill(message);
        await expect(sendBtn).toBeEnabled({ timeout: 10000 });
        const base = (await getReplyPublishedEvents(page))?.length ?? 0;
        await sendBtn.click();

        // Wait for input cleared (rotation) and replyPublished
        await page.waitForFunction(
            () => {
                const el = document.querySelector(
                    '[data-testid="toolbarcreatenew"] textarea'
                ) as HTMLTextAreaElement | null;
                return !el || el.value === "";
            },
            null,
            { timeout: 2e4 }
        );
        await expect
            .poll(
                async () => (await getReplyPublishedEvents(page)).length > base,
                { timeout: 2e4 }
            )
            .toBe(true);
        const evt = (await getReplyPublishedEvents(page))[base];
        const replyId = evt.replyId as string;

        // Confirm the post appears in the feed with correct text
        const card = page.locator(`[data-canvas-id="${replyId}"]`).first();
        await expect(card).toBeVisible({ timeout: 30000 });
        await expect(card.getByText(message)).toBeVisible({ timeout: 30000 });

        // Refresh
        await page.reload();

        await waitForPeerInfo(page);
        const afterPeer = await getPeerInfo(page);
        expect(afterPeer?.peerHash).toBe(beforePeer?.peerHash);

        // Feed still has the post (persisted)
        const cardAfter = page.locator(`[data-canvas-id="${replyId}"]`).first();
        await expect(cardAfter).toBeVisible({ timeout: 15000 });
        await expect(cardAfter.getByText(message)).toBeVisible({
            timeout: 30000,
        });

        // Drafts row: if present, all entries should be empty (no elements)
        // We detect this via the DraftsRow's whenEmpty label "Empty post".
        const draftsHeader = page.locator("[data-pending-drafts]").first();
        if (await draftsHeader.count()) {
            throw new Error("Drafts row should not be present");
        }

        // Composer textarea should be empty (fresh draft; no persisted content)
        const toolbar2 = page.getByTestId("toolbarcreatenew").first();
        const textArea2 = toolbar2.locator("textarea");
        await expect(textArea2).toBeVisible({ timeout: 30000 });
        await expect
            .poll(async () => (await textArea2.inputValue()) === "", {
                timeout: 10000,
            })
            .toBe(true);
    });
});
