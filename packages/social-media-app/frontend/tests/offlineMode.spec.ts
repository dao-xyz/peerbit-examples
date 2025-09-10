import { test, expect } from "@playwright/test";
import { OFFLINE_BASE } from "./utils/url";

// Basic smoke test for offline bootstrap mode (?bootstrap=offline)
// Ensures the app renders without attempting remote relay dial logic.
// We look for the offline console log we added and absence of the default remote bootstrap attempt message.

test("offline mode starts without dialing relays", async ({ page }) => {
    const messages: string[] = [];
    page.on("console", (msg) => {
        const text = msg.text();
        messages.push(text);
    });
    await page.goto(OFFLINE_BASE);
    // Wait for toolbar to confirm UI mounted
    const toolbar = page.getByTestId("toolbarcreatenew").first();
    await expect(toolbar).toBeVisible({ timeout: 30000 });

    // Assert we saw the offline log (non-fatal if minified build strips, so soft check)
    const sawOffline = messages.some((m) =>
        /Offline bootstrap: skipping relay dialing/i.test(m)
    );
    expect.soft(sawOffline).toBeTruthy();

    // Ensure we did NOT attempt remote bootstrap service (which would log "Failed to resolve relay addresses" in offline env)
    const failedResolve = messages.some((m) =>
        /Failed to resolve relay addresses/i.test(m)
    );
    expect(failedResolve).toBeFalsy();
});
