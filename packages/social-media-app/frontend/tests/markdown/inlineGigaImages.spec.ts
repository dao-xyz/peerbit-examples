import { test, expect, Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { OFFLINE_BASE } from "../utils/url";
import { setupConsoleCapture } from "../utils/consoleCapture";
import { getCanvasSaveStats, waitForCanvasSaveDelta } from "../utils/autosave";

const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

function smallPngFile(name = "test-image.png") {
    const buffer = Buffer.from(PNG_BASE64, "base64");
    return {
        name,
        mimeType: "image/png",
        buffer,
        gigaRef: createHash("sha256").update(buffer).digest("base64url"),
    };
}

function uid(prefix: string) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${rand}-${Date.now()}`;
}

async function getReplyPublishedEvents(page: Page) {
    return await page.evaluate(() => {
        const w: any = window as any;
        const topWin: any = w.top || w;
        const arr = (topWin.__DBG_EVENTS || w.__DBG_EVENTS || []) as any[];
        return arr.filter(
            (e: any) =>
                e?.source === "DraftManager" && e?.name === "replyPublished"
        );
    });
}

test.describe("Markdown inline giga://image", () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            try {
                localStorage.setItem("debug", "false");
                // Avoid the "Quick session / Posting as guest" modal blocking publish in e2e.
                localStorage.setItem(
                    "giga.identity.notice.guest.v1",
                    "true"
                );
                localStorage.setItem(
                    "giga.identity.notice.temporary.v1",
                    "true"
                );
            } catch {}
        });
    });

    test(
        "renders inline giga image and hides standalone duplicate image",
        async ({ page }, testInfo) => {
            setupConsoleCapture(page, testInfo, {
                printAll: false,
                failOnError: false,
                capturePageErrors: true,
                captureWebErrors: true,
            });

            await page.goto(OFFLINE_BASE);
            await page.evaluate(() => {
                (window as any).__DBG_EVENTS = [];
            });

            const toolbar = page.getByTestId("toolbarcreatenew").first();
            const fileInput = toolbar.locator("input[type=file]");
            await expect(fileInput).toBeAttached();

            const draftId = (await (
                await page.waitForFunction(
                    () => (window as any).__DRAFT_READY?.draftId || null,
                    null,
                    { timeout: 30000 }
                )
            ).jsonValue()) as string;
            if (!draftId) throw new Error("Draft session never became ready");

            const imgName = `inline-dup-${Date.now()}.png`;
            const img = smallPngFile(imgName);
            const gigaUrl = `giga://image/${img.gigaRef}`;

            await fileInput.setInputFiles(img);
            await expect(
                page.getByRole("img", { name: imgName }).first()
            ).toBeVisible({ timeout: 60000 });

            const markerText = uid("inline-giga-marker");
            const inlineAlt = uid("inline-giga-alt");
            const markdown = `${markerText}\n\n![${inlineAlt}](${gigaUrl})\n`;

            const textArea = toolbar.locator("textarea");
            await expect(textArea).toBeVisible({ timeout: 30000 });
            const baseline = await getCanvasSaveStats(page, {
                canvasId: draftId,
            });
            await textArea.fill(markdown);
            // Markdown edits are debounced; ensure they are flushed to the draft before publishing
            // so the published post actually contains the text + inline ref.
            await waitForCanvasSaveDelta(page, {
                baseline,
                canvasId: draftId,
                minEventDelta: 1,
                minRectDelta: 1,
                timeout: 30000,
            });

            const sendBtn = toolbar.getByTestId("send-button");
            await expect(sendBtn).toBeEnabled({ timeout: 30000 });

            const base = (await getReplyPublishedEvents(page)).length;
            await sendBtn.click();

            await page.waitForFunction(
                () => {
                    const el = document.querySelector(
                        '[data-testid="toolbarcreatenew"] textarea'
                    ) as HTMLTextAreaElement | null;
                    return !el || el.value === "";
                },
                null,
                { timeout: 10000 }
            );

            await expect
                .poll(
                    async () =>
                        (await getReplyPublishedEvents(page)).length > base,
                    { timeout: 60000 }
                )
                .toBe(true);

            const evt = (await getReplyPublishedEvents(page))[base];
            const replyId = evt.replyId as string;

            // Navigate to the post detail view (uses the detailed container with matching data-canvas-id)
            await page.evaluate((id) => {
                location.hash = `#/c/${encodeURIComponent(id)}`;
            }, replyId);
            await expect(page).toHaveURL(/#\/c\//);

            const detail = page
                .locator(`div[data-canvas-id="${replyId}"]`)
                .first();
            await expect(detail).toBeVisible({ timeout: 60000 });
            await expect(detail.getByText(markerText).first()).toBeVisible({
                timeout: 60000,
            });

            const inlineImg = detail
                .getByRole("img", { name: inlineAlt })
                .first();
            await expect(inlineImg).toHaveAttribute("src", /^blob:/);
            await expect(inlineImg).toHaveClass(/cursor-zoom-in/);

            // If the giga:// ref isn't resolved to a real image element, Markdown falls back to "[missing image]".
            await expect(detail.getByText("[missing image]")).toHaveCount(0);

            // The underlying image element should NOT also render as a separate standalone image.
            await expect(
                detail.getByRole("img", { name: imgName })
            ).toHaveCount(0);
        }
    );
});
