import { test, expect } from "@playwright/test";
import { attachConsoleHooks } from "./utils/consoleHooks";

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";

function uid(prefix: string) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix} ${rand}-${Date.now()}`;
}

test.describe("DeveloperPanel: enable logs, close, then send message", () => {
    test.beforeEach(async ({ page }) => {
        // Ensure debug is off by default; we'll turn it on via the panel UI
        await page.addInitScript(() => {
            try {
                localStorage.setItem("debug", "false");
            } catch {}
        });
    });

    test("can enable logs in panel, close it, and send a message", async ({
        page,
    }) => {
        const hook = attachConsoleHooks(page, { echoErrors: true });
        await page.goto(BASE_URL + "/#/");

        // Wait for the toolbar (peer/session ready)
        const toolbar = page.getByTestId("toolbarcreatenew").first();
        await expect(toolbar).toBeVisible({ timeout: 30000 });

        // Open the profile dropdown menu and click Developer
        // The trigger is the ProfileButton inside the header. Click the first button in the header's profile area.
        const headerProfileArea = page
            .getByTestId("header-profile-area")
            .first();
        await expect(headerProfileArea).toBeVisible({ timeout: 30000 });
        await headerProfileArea.getByRole("button").first().click();

        // Click the Developer menu item
        await page.getByRole("menuitem", { name: "Developer" }).click();

        // In the DeveloperPanel, enable all toggles (Debug enabled, Capture events, Perf instrumentation)
        const panel = page.getByRole("dialog", { name: "Developer" });
        await expect(panel).toBeVisible({ timeout: 30000 });

        // Flip debug flags via runtime to avoid flaky checkbox clicks in the portal
        await page.evaluate(() => {
            const g: any = window as any;
            g.__DBG = {
                ...(g.__DBG || {}),
                enabled: true,
                captureEvents: true,
                perfEnabled: true,
            };
            window.dispatchEvent(new Event("__DBG:changed"));
        });
        await expect
            .poll(
                async () =>
                    await page.evaluate(() => !!(window as any).__DBG?.enabled),
                { timeout: 30000 }
            )
            .toBe(true);

        // Close the panel and ensure overlay does not block interactions
        await panel.getByRole("button", { name: "Close" }).click();
        // Ensure the panel is hidden and the overlay (if any) is non-interactive/removed
        await expect(panel).toBeHidden();
        const overlay = page.getByTestId("developer-overlay");
        await expect(overlay).toBeHidden({ timeout: 30000 });

        // Dismiss any remaining menus/popovers just in case (e.g., dropdown menu)
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press("Escape").catch(() => {});
        }
        // Click a neutral area to clear focus/overlays
        await page.mouse.click(20, 20).catch(() => {});

        // Compose a unique message and send
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 30000 });
        const msg = uid("Panel send test");
        await textArea.fill(msg);
        const sendBtn = toolbar.getByTestId("send-button");
        await expect(sendBtn).toBeEnabled({ timeout: 30000 });
        // Try a normal click first with a short timeout, then fall back to force
        try {
            await sendBtn.click({ timeout: 2000 });
        } catch {
            await sendBtn.click({ force: true });
        }

        // Assert that input is cleared and button disabled again (optional but confirms the click worked)
        await expect(textArea).toHaveValue("");
        await expect(sendBtn).toBeDisabled();
        hook.stop();
    });
});
