import { test, expect } from "@playwright/test";
import { OFFLINE_BASE } from "./utils/url";
import { setupConsoleCapture } from "./utils/consoleCapture";
import { getCanvasSaveStats, waitForCanvasSaveDelta } from "./utils/autosave";

function uid(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// Capture DraftManager.replyPublished events
async function getReplyPublishedEvents(page: import("@playwright/test").Page) {
    return (await page.evaluate(() => (window as any).__DBG_EVENTS))?.filter(
        (e: any) => e?.source === "DraftManager" && e?.name === "replyPublished"
    );
}

test.describe("Draft rotation does not mutate previous posts in feed", () => {
    test("send a post; start typing a new one; first card stays unchanged", async ({
        page,
    }, testInfo) => {
        setupConsoleCapture(page, testInfo, {
            printAll: true,
            failOnError: false,
            ignorePatterns: [
                /Failed to dial/i, // relay dial issues allowed
                /Module \"crypto\" has been externalized/i,
            ],
        });
        await page.goto(OFFLINE_BASE);

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

        // Locate toolbar and textarea
        await page.waitForFunction(
            () => !!document.querySelector('[data-testid="toolbarcreatenew"]'),
            null,
            { timeout: 30000 }
        );
        const toolbar = page.getByTestId("toolbarcreatenew").first();
        await expect(toolbar).toBeVisible({ timeout: 5e3 });
        // Nudge editor into editing mode if needed (ensures a default text box is inserted)
        try {
            const textContainer = toolbar
                .getByTestId("composer-textarea")
                .first();
            await textContainer.click({ timeout: 1500 });
        } catch {}
        const textArea = toolbar.locator("textarea");
        // Wait for a textarea to exist; on slow starts, it may mount slightly later
        await page.waitForFunction(
            () =>
                !!document.querySelector(
                    '[data-testid="toolbarcreatenew"] textarea'
                ),
            null,
            { timeout: 30000 }
        );
        await expect(textArea).toBeVisible({ timeout: 30000 });
        const sendBtn = toolbar.getByTestId("send-button");

        // 1) Publish first post
        const firstMsg = uid("Hello");
        await textArea.fill(firstMsg);
        await expect(sendBtn).toBeEnabled({ timeout: 5e3 });
        const base = (await getReplyPublishedEvents(page))?.length ?? 0;
        await sendBtn.click();

        // Wait for input clear or rotation
        await page.waitForFunction(
            () => {
                const el = document.querySelector(
                    '[data-testid="toolbarcreatenew"] textarea'
                ) as HTMLTextAreaElement | null;
                return !el || el.value === "";
            },
            null, // dummy arg
            { timeout: 5000 }
        );

        // Wait for replyPublished and grab id
        await expect
            .poll(
                async () => (await getReplyPublishedEvents(page)).length > base,
                { timeout: 1e4 }
            )
            .toBe(true);
        const evt = (await getReplyPublishedEvents(page))[base];
        const replyId = evt.replyId as string;

        // Locate the feed card and assert it contains the first message
        const firstCard = page.locator(`[data-canvas-id="${replyId}"]`).first();
        await expect(firstCard).toBeVisible({ timeout: 30000 });
        await expect(firstCard.getByText(firstMsg)).toBeVisible({
            timeout: 3e4,
        });

        // 2) Wait a moment, then start composing a NEW draft without sending
        const baseline = await getCanvasSaveStats(page);
        await waitForCanvasSaveDelta(page, {
            baseline,
            minEventDelta: 1,
        });
        // Ensure textarea exists (new draft mounted). Nudge editor into editing mode if needed.
        try {
            const textContainer = toolbar
                .getByTestId("composer-textarea")
                .first();
            await textContainer.click({ timeout: 1500 });
        } catch {}
        // Wait for a textarea to be present for the fresh draft
        await page.waitForFunction(
            () =>
                !!document.querySelector(
                    '[data-testid="toolbarcreatenew"] textarea'
                ),
            null, // dummy arg,
            { timeout: 10000 } // allow some time for rotation/mount
        );

        // Re-acquire toolbar/textarea after rotation to avoid stale locators
        const toolbar2 = page.getByTestId("toolbarcreatenew").first();
        const textArea2 = toolbar2.locator("textarea");
        await expect(textArea2).toBeVisible({ timeout: 5000 });
        const secondMsg = uid("Second");
        await textArea2.fill(secondMsg);

        // Read draft canvas id from the composer area
        const draftId = await toolbar2
            .getByTestId("composer-textarea")
            .first()
            .getAttribute("data-draft-id");
        console.log("[TEST] draft canvas id (b64url)=", draftId);
        console.log("[TEST] first reply id (b64url)=", replyId);
        if (draftId) {
            expect(draftId).not.toBe(replyId);
        }

        // Let the UI settle; then re-locate the first card to avoid stale locators
        const baselineAfterDraft = await getCanvasSaveStats(page);
        await waitForCanvasSaveDelta(page, {
            baseline: baselineAfterDraft,
            minEventDelta: 1,
        });
        const firstCardAgain = page
            .locator(`[data-canvas-id="${replyId}"]`)
            .first();
        await expect(firstCardAgain).toBeVisible({ timeout: 10000 });

        // 3) Assert that the first post card stays unchanged in the FEED
        // Positive: still shows the original text
        try {
            await expect
                .poll(
                    async () => {
                        const t = (
                            (await firstCardAgain.textContent()) ?? ""
                        ).trim();
                        return t.includes(firstMsg);
                    },
                    { timeout: 15000 }
                )
                .toBe(true);
            // Negative: must not contain the new draft text while composing
            await expect(firstCardAgain.getByText(secondMsg)).toHaveCount(0);
        } catch (error) {
            // 4) Diagnostics: dump relevant debug events for this replyId
            const dbg = await page.evaluate(
                () => (window as any).__DBG_EVENTS || []
            );
            const relevant = dbg.filter(
                (e: any) =>
                    (e?.source === "CanvasWrapper" &&
                        e?.name === "contentChange") ||
                    (e?.source === "CanvasPreview" && e?.name === "render")
            );
            const filtered = relevant.filter(
                (e: any) => e?.canvasId === replyId
            );
            console.log("--- DEBUG for replyId=", replyId, "---");
            for (const e of filtered) {
                console.log(
                    JSON.stringify(
                        {
                            source: e.source,
                            name: e.name,
                            canvasId: e.canvasId,
                            elementId: e.elementId,
                            draft: e.draft,
                            texts: e.texts,
                            text: e.text,
                            rects: e.rects,
                            pending: e.pending,
                            variant: e.variant,
                        },
                        null,
                        2
                    )
                );
            }
            const actual = await firstCardAgain.textContent();
            throw new Error(
                `Original text "${firstMsg}" not found in first card after waiting. Instead got "${actual}"`
            );
        }
    });
});
