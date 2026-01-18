import { test, expect } from "../fixtures/persistentContext";
import { withSearchParams } from "../utils/url";
import { setupConsoleCapture } from "../utils/consoleCapture";

const BASE_HTTP = process.env.BASE_URL || "http://localhost:5190";
const BOOTSTRAP = process.env.PW_BOOTSTRAP;

test.describe("Late results diagnostics (prod bootstrap)", () => {
    test.skip(
        process.env.PW_VITE_MODE !== "production",
        "Set PW_VITE_MODE=production to run (uses prod bootstrap addrs)."
    );

    test.setTimeout(180_000);

    test("captures onLateResults events and list reorderings", async ({
        page,
    }, testInfo) => {
        setupConsoleCapture(page, testInfo, {
            printAll: false,
            capturePageErrors: true,
        });

        await page.addInitScript(() => {
            const w: any = window as any;
            w.__DBG = { ...(w.__DBG || {}), enabled: true, captureEvents: true };
            try {
                w.__DBG_EVENTS = [];
            } catch {}
            window.dispatchEvent(new Event("__DBG:changed"));
        });

        const url = withSearchParams(`${BASE_HTTP}#/?s=best`, {
            ephemeral: true,
            bootstrap: BOOTSTRAP,
        });
        await page.goto(url);

        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });

        const feed = page.getByTestId("feed");
        await expect(feed).toBeVisible({ timeout: 60_000 });

        const captureFeedTop = async (label: string) => {
            const snap = await page.evaluate(() => {
                const feed = document.querySelector(
                    '[data-testid="feed"]'
                ) as HTMLElement | null;
                const nodes = feed
                    ? Array.from(feed.querySelectorAll("[data-canvas-id]")).slice(
                          0,
                          6
                      )
                    : [];
                return nodes.map((el) => ({
                    id: el.getAttribute("data-canvas-id"),
                    text: (el as HTMLElement).innerText
                        .replace(/\s+/g, " ")
                        .slice(0, 140),
                }));
            });
            await testInfo.attach(`feedTop:${label}`, {
                body: Buffer.from(JSON.stringify(snap, null, 2), "utf8"),
                contentType: "application/json",
            });
        };

        await captureFeedTop("initial");

        // Trigger a couple of incremental loads to increase the chance of out-of-order/late results.
        for (let i = 0; i < 3; i++) {
            await page.evaluate(() => {
                window.scrollTo({
                    top: document.documentElement.scrollHeight,
                    behavior: "instant" as any,
                });
            });
            await page.waitForTimeout(4_000);
            await captureFeedTop(`afterScroll${i + 1}`);
        }

        // Give late peers a window to contribute.
        await page.waitForTimeout(10_000);
        await captureFeedTop("afterWait");

        const lateEvents = await page.evaluate(() => {
            const w: any = window as any;
            const evts = (w.__DBG_EVENTS || []) as any[];
            return evts.filter(
                (e) => e?.source === "stream" && e?.name === "lateResults"
            );
        });

        await testInfo.attach("debug:lateResultsEvents", {
            body: Buffer.from(JSON.stringify(lateEvents, null, 2), "utf8"),
            contentType: "application/json",
        });

        const starts = lateEvents.filter((e: any) => e?.phase === "start");
        const byPosition = starts.reduce((acc: any, e: any) => {
            const key = e?.position || "unknown";
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});
        // eslint-disable-next-line no-console
        console.log("[diag] lateResults", {
            total: lateEvents.length,
            starts: starts.length,
            byPosition,
            sample: starts.slice(0, 3).map((e: any) => ({
                amount: e?.amount,
                peerHash: e?.peerHash,
                beforeCount: e?.beforeCount,
                position: e?.position,
                stableOrdering: e?.stableOrdering,
            })),
        });

        // Sanity check: the page loaded and we captured the diagnostics artifact.
        expect(Array.isArray(lateEvents)).toBeTruthy();
    });
});
