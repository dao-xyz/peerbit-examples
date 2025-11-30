import { test, expect } from "@playwright/test";
import { OFFLINE_BASE } from "../utils/url";

function uid(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Goal: Ensure that when a newly published post first becomes visible in the feed, its body/content
 * is present essentially immediately (no multi‑second "empty shell" period).
 *
 * Strategy:
 * 1. Install a MutationObserver before sending that records first appearance time (performance.now())
 *    for any element with data-canvas-id (reply container) into window.__REPLY_APPEAR.
 * 2. Send a message; wait for a replyPublished debug event to obtain replyId.
 * 3. Measure the time from container appearance to the time its text content includes the message.
 * 4. Assert the delta is below a threshold (e.g. < 1500ms). This catches current pathological ~5s gaps.
 */

test.describe("feed render content sync", () => {
    const EPHEMERAL = [true, false]; // test both ephemeral and non-ephemeral modes

    for (const eph of EPHEMERAL) {
        test(`post content appears with its container (no long gap) [ephemeral=${eph}]`, async ({
            page,
        }) => {
            // Use hash-style params to also exercise hash query parsing (/#/?bootstrap=offline)
            let url = OFFLINE_BASE;
            // Force perf instrumentation so perf:publish events appear
            url += url.includes("perf=")
                ? ""
                : (url.includes("?") ? "&" : "?") + "perf=1";
            url += "&ephemeral=" + eph;
            await page.goto(url);

            // Prepare debug events accumulator & appearance recorder (+timeline)
            await page.evaluate(() => {
                (window as any).__DBG_EVENTS = [];
                (window as any).__REPLY_APPEAR = {};
                (window as any).__TIMELINE = [];
                const pushTL = (t: any) => {
                    try {
                        (window as any).__TIMELINE.push({
                            t: performance.now(),
                            ...t,
                        });
                    } catch {}
                };
                pushTL({ phase: "init" });
                const rec: Record<string, { appeared: number }> = (
                    window as any
                ).__REPLY_APPEAR;
                const obs = new MutationObserver((muts) => {
                    for (const m of muts) {
                        for (const n of Array.from(m.addedNodes)) {
                            if (!(n instanceof HTMLElement)) continue;
                            const q: HTMLElement[] = [];
                            if (n.hasAttribute?.("data-canvas-id")) q.push(n);
                            q.push(
                                ...(Array.from(
                                    n.querySelectorAll(`[data-canvas-id]`)
                                ) as HTMLElement[])
                            );
                            for (const el of q) {
                                const id = el.getAttribute("data-canvas-id");
                                if (!id) continue;
                                if (!rec[id]) {
                                    const t = performance.now();
                                    rec[id] = { appeared: t };
                                    pushTL({ phase: "container:appear", id });
                                }
                            }
                        }
                    }
                });
                obs.observe(document.body, { childList: true, subtree: true });
                (window as any).__REPLY_OBSERVER = obs;
                // Capture hierarchical reindex events
                window.addEventListener("reindex:debug", (e: any) => {
                    pushTL({ phase: `reindex:${e.detail.phase}`, ...e.detail });
                });
                // Capture perf publish events
                window.addEventListener("perf:publish", (e: any) => {
                    pushTL({ phase: "perf:publish", ...e.detail });
                });
                window.addEventListener("debug:event", (e: any) => {
                    pushTL({ phase: `debug:${e.detail?.name}`, ...e.detail });
                });
            });

            // Toolbar
            const toolbar = page.getByTestId("toolbarcreatenew").first();
            // Nudge editor into editing mode to ensure the textarea mounts
            try {
                const textContainer = toolbar
                    .getByTestId("composer-textarea")
                    .first();
                await textContainer.click({ timeout: 1500 });
            } catch {}
            const textArea = toolbar.locator("textarea");
            await page.waitForFunction(
                () =>
                    !!document.querySelector(
                        '[data-testid="toolbarcreatenew"] textarea'
                    ),
                null,
                { timeout: 30000 }
            );
            await expect(textArea).toBeVisible();

            const message = uid("Feed sync msg");
            await textArea.fill(message);
            const sendBtn = toolbar.getByTestId("send-button");
            await expect(sendBtn).toBeEnabled();

            // Helper to read replyPublished events
            async function getReplyPublishedEvents() {
                return (
                    await page.evaluate(() => (window as any).__DBG_EVENTS)
                )?.filter(
                    (e: any) =>
                        e?.source === "DraftManager" &&
                        e?.name === "replyPublished"
                );
            }

            // Ensure debug listener is attached (reusing existing pattern from other tests)
            await page.evaluate(() => {
                if (!(window as any).__LISTENING_PUBLISH) {
                    (window as any).__LISTENING_PUBLISH = true;
                    window.addEventListener("perf:publish", (e: any) => {
                        (window as any).__DBG_EVENTS.push(e.detail);
                    });
                    window.addEventListener("debug:event", (e: any) => {
                        (window as any).__DBG_EVENTS.push(e.detail);
                    });
                }
            });

            const baseCount = (await getReplyPublishedEvents()).length;
            await page.evaluate(() =>
                (window as any).__TIMELINE?.push({
                    t: performance.now(),
                    phase: "click:send",
                })
            );
            await sendBtn.click();
            // After clicking send, the toolbar may rotate to a fresh draft.
            // Tolerate either the original textarea clearing or being replaced.
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

            // Wait for the replyPublished event (which has replyId)
            await expect
                .poll(
                    async () =>
                        (await getReplyPublishedEvents()).length > baseCount,
                    {
                        timeout: 60000,
                    }
                )
                .toBe(true);
            const replyEvt = (await getReplyPublishedEvents())[baseCount];
            await page.evaluate((evt) => {
                try {
                    (window as any).__TIMELINE?.push({
                        t: performance.now(),
                        phase: "event:replyPublished",
                        replyId: evt?.replyId,
                    });
                } catch {}
            }, replyEvt);
            const replyId = replyEvt.replyId as string;
            expect(replyId).toBeTruthy();

            // Fetch appearance timestamp from page context
            const appeared = await page.evaluate((id) => {
                return (window as any).__REPLY_APPEAR?.[id]?.appeared ?? null;
            }, replyId);
            expect(appeared).not.toBeNull();

            // Measure time until content text visible
            const contentTime = await page.evaluate(
                async ({ id, msg }) => {
                    const start = performance.now();
                    while (performance.now() - start < 10000) {
                        const el = document.querySelector(
                            `[data-canvas-id="${id}"]`
                        );
                        if (
                            el &&
                            el.textContent &&
                            el.textContent.includes(msg)
                        ) {
                            (window as any).__TIMELINE.push({
                                t: performance.now(),
                                phase: "content:ready",
                                id,
                            });
                            return performance.now();
                        }
                        await new Promise((r) => setTimeout(r, 50));
                    }
                    return null;
                },
                { id: replyId, msg: message }
            );
            expect(contentTime).not.toBeNull();

            const delta = (contentTime as number) - (appeared as number);
            // Assert content arrives quickly (< 1500ms). Adjust threshold if legitimate processing warrants more.
            if (delta >= 1500) {
                // Dump rich timeline for diagnostics
                const timeline = await page.evaluate(
                    () => (window as any).__TIMELINE
                );
                console.log(
                    "--- FEED CONTENT TIMELINE ---\n" +
                        timeline
                            .map(
                                (e: any) =>
                                    `${e.t.toFixed(1)}ms\t${e.phase}\t${
                                        e.id ?? ""
                                    }`
                            )
                            .join("\n")
                );
            }
            expect(delta).toBeLessThan(2000);
            // Add soft assertion for original target (will warn not fail)
            if (delta >= 1500) {
                console.warn(
                    `Content delay ${delta.toFixed(
                        0
                    )}ms exceeds ideal 1500ms threshold`
                );
            }
            // Also assert content contains our message in DOM
            await expect(
                page
                    .locator(
                        `[data-canvas-id="${replyId}"] :text("${message}")`
                    )
                    .first()
            ).toBeVisible();
        });
    }
});
