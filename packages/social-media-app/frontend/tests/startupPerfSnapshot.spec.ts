import { test, expect } from "./fixtures/persistentContext";
import { OFFLINE_BASE, withSearchParams } from "./utils/url";

test.describe("startup perf snapshot", () => {
    test("emits a startup snapshot when ?perf=1", async ({ page }) => {
        const url = withSearchParams(OFFLINE_BASE, { perf: 1, ephemeral: false });
        await page.goto(url);

        // Wait for a stable "interactive" UI signal
        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 30_000,
        });

        const snapshots = await page.evaluate(() => {
            const events = (window as any).__DBG_PERF_EVENTS || [];
            return (events as any[]).filter(
                (e) => e?.type === "peer" && e?.detail?.kind === "startup"
            );
        });

        expect(snapshots.length).toBeGreaterThan(0);

        const peerReady = snapshots.find(
            (e: any) => e?.detail?.reason === "peer:context:ready"
        );
        expect(peerReady?.detail?.marks?.["peer:event:ready"]).toBeDefined();
        expect(
            peerReady?.detail?.durations?.["total:toPeerContextReady"]
        ).toBeDefined();
    });
});

