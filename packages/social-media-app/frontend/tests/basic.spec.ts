import { test, expect } from "@playwright/test";
import { OFFLINE_BASE } from "./utils/url";

test("renders toolbar and disables send when empty", async ({ page }) => {
    await page.goto(OFFLINE_BASE);
    const toolbar = page.getByTestId("toolbarcreatenew").first();
    await expect(toolbar).toBeVisible({ timeout: 30000 });

    const sendBtn = toolbar.getByRole("button", { name: "Send" });
    await expect(sendBtn).toBeVisible();
    await expect(sendBtn).toBeDisabled();

    const textArea = toolbar.locator("textarea");
    await textArea.fill("hello");
    await expect(sendBtn).toBeEnabled();
});

test("debug overlay toggle appears with localStorage.debug", async ({
    page,
}) => {
    // Enable debug before navigation to ensure early init
    await page.addInitScript(() => {
        try {
            localStorage.setItem("debug", "true");
        } catch { }
    });
    await page.goto(OFFLINE_BASE);
    // Verify debug console was initialized
    const patched = await page.evaluate(
        () => (window as any).__pretty_console_patched__ === true
    );
    expect(patched).toBe(true);
});
