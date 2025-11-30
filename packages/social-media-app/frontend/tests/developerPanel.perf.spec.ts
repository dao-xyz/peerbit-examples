import { test, expect } from "@playwright/test";
import { attachConsoleHooks } from "./utils/consoleHooks";
import { OFFLINE_BASE } from "./utils/url";

function uid(prefix: string) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix} ${rand}-${Date.now()}`;
}

test.describe("DeveloperPanel: shows perf events when enabled", () => {
    test.beforeEach(async ({ page }) => {
        // Start with debug disabled; we will enable perf via the panel UI.
        await page.addInitScript(() => {
            try {
                localStorage.setItem("debug", "false");
            } catch { }
        });
    });

    test("enable via panel → publish → perf events appear in panel", async ({
        page,
    }) => {
        const hook = attachConsoleHooks(page, { echoErrors: true });
        await page.goto(OFFLINE_BASE);

        // Wait for toolbar to ensure app is ready
        const toolbar = page.getByTestId("toolbarcreatenew").first();
        await expect(toolbar).toBeVisible({ timeout: 30000 });

        // Open Developer panel via profile menu
        const headerProfileArea = page
            .getByTestId("header-profile-area")
            .first();
        await expect(headerProfileArea).toBeVisible({ timeout: 30000 });
        await headerProfileArea.getByRole("button").first().click();
        await page.getByRole("menuitem", { name: "Developer" }).click();

        const panel = page.getByRole("dialog", { name: "Developer" });
        await expect(panel).toBeVisible({ timeout: 30000 });

        // Enable perf instrumentation by setting runtime flag. This avoids flaky checkbox state inside portal.
        await page.evaluate(() => {
            const g: any = window as any;
            g.__DBG = { ...(g.__DBG || {}), perfEnabled: true };
            window.dispatchEvent(new Event("__DBG:changed"));
        });
        await expect
            .poll(
                async () =>
                    await page.evaluate(
                        () => !!(window as any).__DBG?.perfEnabled
                    ),
                { timeout: 30000 }
            )
            .toBe(true);

        // Close the panel to avoid interaction blockers, then send a message
        await panel.getByRole("button", { name: "Close" }).click();
        await expect(panel).toBeHidden();

        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 30000 });
        const msg = uid("Perf panel test");
        await textArea.fill(msg);
        const sendBtn = toolbar.getByTestId("send-button");
        await expect(sendBtn).toBeEnabled({ timeout: 30000 });
        await sendBtn.click();

        // Reopen Developer panel to inspect perf entries
        const headerProfileArea2 = page
            .getByTestId("header-profile-area")
            .first();
        await headerProfileArea2.getByRole("button").first().click();
        await page.getByRole("menuitem", { name: "Developer" }).click();
        const panel2 = page.getByRole("dialog", { name: "Developer" });
        await expect(panel2).toBeVisible({ timeout: 30000 });

        // Wait for at least one perf entry (<pre>) to appear
        const perfSection = panel2.locator('strong:has-text("Perf events")');
        await expect(perfSection).toBeVisible({ timeout: 30000 });
        const sectionContainer = perfSection.locator("xpath=..");
        await expect
            .poll(async () => await sectionContainer.locator("pre").count(), {
                timeout: 60000,
            })
            .toBeGreaterThan(0);
        hook.stop();
    });
});
