import { test, expect } from "./fixtures/persistentContext";
import { withConsoleCapture } from "./utils/consoleHooks";
import { setupConsoleCapture } from "./utils/consoleCapture";
import { OFFLINE_BASE } from "./utils/url";

function uid(prefix: string) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix} ${rand}-${Date.now()}`;
}

// This suite ensures that the composer only recovers drafts from the private scope.
// After publishing (which syncs to public/parent), a fresh composer should not
// recover the published public reply as an in-progress draft.

test.describe("Draft recovery privacy", () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            try {
                localStorage.setItem("debug", "false");
            } catch { }
        });
    });

    test(
        "does not recover from public scope (published replies)",
        async ({ page }, testInfo) => {
            setupConsoleCapture(page, testInfo, {
                printAll: true,
                failOnError: false,
                capturePageErrors: true,
                captureWebErrors: true,
            });

            const { errors, pageErrors } = await withConsoleCapture(
                page,
                async () => {
                    await page.goto(OFFLINE_BASE);

                    // Fill a message and publish it (to create a public reply)
                    const toolbar = page.getByTestId("toolbarcreatenew").first();
                    const textArea = toolbar.locator("textarea");
                    await expect(textArea).toBeVisible({ timeout: 10000 });

                    const msg = uid("Public reply");
                    await textArea.fill(msg);

                    // Publish
                    await toolbar.getByTestId("send-button").click();

                    // Give some time for publish and indexing
                    await page.waitForTimeout(2000);

                    // Reload to get a fresh composer
                    await page.reload();

                    const toolbar2 = page.getByTestId("toolbarcreatenew").first();
                    const areas = toolbar2.locator("textarea");

                    // Composer should show exactly one empty text area (fresh draft),
                    // not the previously published message recovered.
                    await expect(areas).toHaveCount(1, { timeout: 10000 });
                    await page.waitForFunction(
                        () => {
                            const el = document.querySelector(
                                '[data-testid="toolbarcreatenew"] textarea'
                            ) as HTMLTextAreaElement | null;
                            return !el || el.value === "";
                        },
                        { timeout: 10000 }
                    );
                },
                { logAll: true, echoErrors: true, capturePageErrors: true }
            );

            const allErrors = [
                ...errors.map((msg) => msg.text()),
                ...pageErrors.map(
                    (err) => err.stack || err.message || String(err)
                ),
            ].filter(Boolean);

            if (allErrors.length) {
                await testInfo.attach("console-errors", {
                    body: Buffer.from(allErrors.join("\n"), "utf8"),
                    contentType: "text/plain",
                });
            }
        }
    );
});
