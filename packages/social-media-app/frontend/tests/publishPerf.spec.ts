import { test, expect } from "@playwright/test";
import { OFFLINE_BASE } from "./utils/url";

function uid(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Captures perf:publish event emitted by DraftManager when perfEnabled is true.
 * Asserts expected marks exist and logs their ordering for analysis.
 */

test.describe("publish perf marks", () => {
    test("collect and assert timing phases", async ({ page }) => {
        // Enable perf instrumentation before app loads
        await page.addInitScript(() => {
            const dbg = (window as any).__DBG || ((window as any).__DBG = {});
            dbg.perfEnabled = true; // triggers perf instrumentation
            dbg.enabled = true; // ensure debug overlay logic doesn't prune events
            dbg.captureEvents = true;
        });

        await page.goto(OFFLINE_BASE);

        // Listen for perf:publish
        await page.evaluate(() => {
            (window as any).__PUBLISH_PERF = [];
            window.addEventListener("perf:publish", (e: any) => {
                (window as any).__PUBLISH_PERF.push(e.detail);
            });
            (window as any).__DBG_EVENTS = [];
            window.addEventListener("debug:event", (e: any) => {
                (window as any).__DBG_EVENTS.push(e.detail);
            });
        });

        // Compose and send a message
        const toolbar = page.getByTestId("toolbarcreatenew").first();
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible();
        const message = uid("Perf publish");
        await textArea.fill(message);
        const sendBtn = toolbar.getByTestId("send-button");
        await expect(sendBtn).toBeEnabled();
        const publishStart = Date.now();
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

        // Wait for replyPublished debug event (sanity)
        await expect
            .poll(
                async () => {
                    const events = await page.evaluate(
                        () => (window as any).__DBG_EVENTS
                    );
                    return events.some(
                        (e: any) => e?.name === "replyPublished"
                    );
                },
                { timeout: 60000 }
            )
            .toBe(true);

        // Wait for one perf:publish event
        const detail = await expect
            .poll(
                async () => {
                    const perf = await page.evaluate(
                        () => (window as any).__PUBLISH_PERF
                    );
                    return perf[0] || null;
                },
                { timeout: 60000 }
            )
            .not.toBeNull();

        const perfData: any = await page.evaluate(
            () => (window as any).__PUBLISH_PERF[0]
        );

        // Basic shape assertions
        // Accept updated phase naming: preCanvasFlush may replace preParentFlush, and parentFlush may replace postParentFlush
        const required = ["rotate", "flushLocal", "upsertReply"];
        for (const phase of required) {
            expect(typeof perfData[phase]).toBe("number");
        }
        const postFlush = perfData.parentFlush ?? perfData.postParentFlush;
        expect(typeof postFlush).toBe("number");
        // Ensure monotonic ordering (each mark >= previous)
        const phases = [
            "rotate",
            "flushLocal",
            // preCanvasFlush is emitted for draft-side flush; keep it optional
            ...(typeof perfData.preCanvasFlush === "number"
                ? ["preCanvasFlush"]
                : []),
            "upsertReply",
            // parent flush naming changed from postParentFlush → parentFlush
            ...(typeof perfData.parentFlush === "number"
                ? ["parentFlush"]
                : typeof perfData.postParentFlush === "number"
                  ? ["postParentFlush"]
                  : []),
        ];
        let prev = 0;
        for (const phase of phases) {
            const v = perfData[phase];
            expect(v).toBeGreaterThanOrEqual(prev);
            prev = v;
        }

        // Total should be >= last phase value
        expect(perfData.total).toBeGreaterThanOrEqual(postFlush || prev);

        // Check overall wall time sanity (< 10s)
        const wall = Date.now() - publishStart;
        expect(wall).toBeLessThan(10000);

        // Log for CI artifact (console output)
        console.log("Publish perf marks", perfData);
    });
});
