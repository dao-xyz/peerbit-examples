import { test, expect } from "@playwright/test";
import { attachConsoleHooks } from "./utils/consoleHooks";
import { OFFLINE_BASE } from "./utils/url";

function uid(prefix: string) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix} ${rand}-${Date.now()}`;
}

test.describe("Developer panel / debug signals", () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            try {
                localStorage.setItem("debug", "false");
                // Avoid modal prompts in publish-focused specs.
                localStorage.setItem("giga.identity.notice.guest.v1", "true");
                localStorage.setItem(
                    "giga.identity.notice.temporary.v1",
                    "true"
                );
            } catch {}
        });
    });

    test("enabling debug flags programmatically yields perf + debug events on publish", async ({
        page,
    }) => {
        const hook = attachConsoleHooks(page, { echoErrors: true });
        await page.goto(OFFLINE_BASE);
        await page.waitForLoadState("domcontentloaded");
        // Ensure app providers mounted (toolbar present)
        await expect
            .poll(
                async () => await page.getByTestId("toolbarcreatenew").count(),
                {
                    timeout: 60000,
                }
            )
            .toBeGreaterThan(0);

        // Wire capture arrays in page context
        await page.evaluate(() => {
            (window as any).__PERF = [];
            const onPerf = (e: Event) => {
                try {
                    const detail = (e as CustomEvent).detail;
                    (window as any).__PERF.push(detail);
                } catch {}
            };
            window.addEventListener("perf:publish", onPerf);
            window.addEventListener("perf:peer", onPerf);
        });

        // Enable debug/capture/perf through the same mechanism as DeveloperPanel
        await page.evaluate(() => {
            const g: any = window as any;
            g.__DBG = {
                ...(g.__DBG || {}),
                enabled: true,
                captureEvents: true,
                perfEnabled: true,
            };
            window.dispatchEvent(new Event("__DBG:changed"));
            (window as any).__DBG_EVENTS = [];
        });

        // Compose a text message and publish
        const toolbar = page.getByTestId("toolbarcreatenew").first();
        await expect(toolbar).toBeVisible({ timeout: 30000 });
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 30000 });
        const msg = uid("Debug log test");
        await textArea.fill(msg);
        const sendBtn = toolbar.getByTestId("send-button");
        await expect(sendBtn).toBeEnabled({ timeout: 30000 });
        await sendBtn.click();

        // Expect structured debug event (replyPublished) to be emitted
        await expect
            .poll(
                async () =>
                    (await page.evaluate(() => {
                        const w: any = window;
                        const arr =
                            (w.top as any)?.__DBG_EVENTS ||
                            w.__DBG_EVENTS ||
                            [];
                        return arr.filter(
                            (e: any) =>
                                e?.source === "DraftManager" &&
                                e?.name === "replyPublished"
                        ).length;
                    })) > 0,
                { timeout: 60000 }
            )
            .toBe(true);

        // Expect perf event to be captured
        await expect
            .poll(
                async () =>
                    (await page.evaluate(
                        () => ((window as any).__PERF || []).length
                    )) > 0,
                { timeout: 60000 }
            )
            .toBe(true);
        // If the test reached here, detach hooks
        hook.stop();
    });

    test("UI: DeveloperPanel shows console logs when enabled", async ({
        page,
    }) => {
        const hook = attachConsoleHooks(page, { echoErrors: true });
        await page.goto(OFFLINE_BASE);

        // Wait for the toolbar to ensure app/providers are fully mounted
        const toolbar = page.getByTestId("toolbarcreatenew").first();
        await expect(toolbar).toBeVisible({ timeout: 30000 });

        // Open Developer panel via profile area
        const profileArea = page.getByTestId("header-profile-area").first();
        await expect(profileArea).toBeVisible({ timeout: 30000 });
        await profileArea.getByRole("button").first().click();
        await page.getByRole("menuitem", { name: "Developer" }).click();

        const panel = page.getByRole("dialog", { name: "Developer" });
        await expect(panel).toBeVisible({ timeout: 30000 });

        // Enable Debug enabled toggle
        const checkbox = panel.getByTestId("dbg-enabled-toggle");
        await expect(checkbox).toBeVisible();
        if (!(await checkbox.isChecked())) {
            await checkbox.click();
        }
        await expect
            .poll(
                async () =>
                    await page.evaluate(() => !!(window as any).__DBG?.enabled),
                { timeout: 30000 }
            )
            .toBe(true);
        await expect
            .poll(
                async () =>
                    await page.evaluate(
                        () =>
                            (window as any).__pretty_console_patched__ === true
                    ),
                { timeout: 30000 }
            )
            .toBe(true);

        // Emit a distinctive log from the page
        const marker =
            "DBG panel log test " + Math.random().toString(36).slice(2);
        await page.evaluate((m) => console.log(m), marker);

        // Expect it to be captured by the logger pipeline
        await expect
            .poll(
                async () =>
                    await page.evaluate((m) => {
                        const w: any = window as any;
                        const logs: any[] = w.__DBG_LOGS || [];
                        return logs.some((e: any) =>
                            (e?.args || []).includes(m)
                        );
                    }, marker),
                { timeout: 30000 }
            )
            .toBe(true);
        hook.stop();
    });
});
