import { test, expect } from "./fixtures/persistentContext";
import { OFFLINE_BASE, withSearchParams } from "./utils/url";
import { expectPersistent } from "./utils/persistence";
import { Page } from "@playwright/test";

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
    return page.evaluate(() => (window as any).__DRAFT_READY);
}

test.describe("composer readiness", () => {
    test("initial draft becomes ready within budget", async ({ page }) => {
        const url = withSearchParams(OFFLINE_BASE, { ephemeral: false });
        await page.goto(url);
        await page.evaluate(() => {
            (window as any).__DRAFT_READY = null;
        });
        await expectPersistent(page);
        const start = Date.now();
        await waitForComposerReady(page);
        const elapsed = Date.now() - start;
        // Guardrail: ensure our toolbar mounts promptly
        expect(elapsed).toBeLessThan(15000);
    });

    test("draft ready signal updates after publish rotation", async ({
        page,
    }) => {
        const url = withSearchParams(OFFLINE_BASE, { ephemeral: false });
        await page.goto(url);
        await page.evaluate(() => {
            (window as any).__DRAFT_READY = null;
        });
        await expectPersistent(page);
        const initial = await waitForComposerReady(page);

        const toolbar = page.getByTestId("toolbarcreatenew").first();
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 30000 });
        await textArea.fill(`ComposerReady-${Date.now()}`);
        const sendBtn = toolbar.getByTestId("send-button");
        await expect(sendBtn).toBeEnabled({ timeout: 30000 });
        await sendBtn.click();

        // Wait for rotation to emit a new ready payload
        await page.waitForFunction(
            (prevId) => {
                const ready = (window as any).__DRAFT_READY;
                return ready?.draftId && ready.draftId !== prevId;
            },
            initial?.draftId ?? null,
            { timeout: 20000 }
        );
    });
});
