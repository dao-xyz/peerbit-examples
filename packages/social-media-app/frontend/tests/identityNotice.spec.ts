import { test, expect } from "@playwright/test";
import { OFFLINE_BASE } from "./utils/url";

test.describe("Identity notice", () => {
    test("shows guest/quick-session popup on first post attempt", async ({
        page,
    }) => {
        await page.addInitScript(() => {
            try {
                localStorage.removeItem("giga.identity.notice.guest.v1");
                localStorage.removeItem("giga.identity.notice.temporary.v1");
            } catch {}
        });

        await page.goto(OFFLINE_BASE);

        const toolbar = page.getByTestId("toolbarcreatenew").first();
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 30000 });

        await textArea.fill("hello");

        const sendBtn = toolbar.getByTestId("send-button");
        await expect(sendBtn).toBeEnabled();
        await sendBtn.click();

        await expect(
            page.getByText(/Quick session|Posting as guest/)
        ).toBeVisible();

        const continueBtn = page.getByRole("button", {
            name: "Continue as guest",
        });
        await expect(continueBtn).toBeVisible();

        // Continue closes the dialog; publish may proceed afterwards.
        await continueBtn.click();
        await expect(continueBtn).toBeHidden({ timeout: 10_000 });
    });
});

