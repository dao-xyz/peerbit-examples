import { test, expect, Page } from "@playwright/test";
import { OFFLINE_BASE } from "../utils/url";

test.describe("Draft autosave dedupe", () => {

    const setupCapture = async (page: Page) => {
        await page.addInitScript(() => {
            try {
                localStorage.setItem("debug", "true");
            } catch { }
            (window as any).__DBG_EVENTS = [];
        });

        const getNewSaves = async (baseline: number) => {
            return page.evaluate((start) => {
                const events = (window as any).__DBG_EVENTS || [];
                return events
                    .slice(start)
                    .filter(
                        (e: any) =>
                            e?.source === "CanvasWrapper" &&
                            e?.name === "save:done" &&
                            !e?.synthetic
                    );
            }, baseline);
        };

        const getNewMutations = async (baseline: number) => {
            return page.evaluate((start) => {
                const events = (window as any).__DBG_EVENTS || [];
                return events
                    .slice(start)
                    .filter(
                        (e: any) =>
                            e?.source === "CanvasWrapper" &&
                            e?.name === "contentChange"
                    );
            }, baseline);
        };

        return { getNewSaves, getNewMutations };
    };
    test("single keystroke triggers one save", async ({ page }) => {
        const { getNewSaves, getNewMutations } = await setupCapture(page);
        await page.goto(OFFLINE_BASE);

        const saveBaseline = (await getNewSaves(0)).length;
        expect(saveBaseline).toBe(0);
        const mutationBaseline = (await getNewMutations(0)).length;

        const toolbar = page.getByTestId("toolbarcreatenew").first();
        const textarea = toolbar.locator("textarea");
        await expect(textarea).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(1_500); // ensure ready

        await textarea.fill("a");

        // Allow debounced autosave to run
        await page.waitForTimeout(3e3);

        const newSaves = await getNewSaves(saveBaseline);
        expect(newSaves.length).toBeLessThanOrEqual(1);
        const mutations = await getNewMutations(mutationBaseline);
        expect(mutations.length).toBeLessThanOrEqual(1);
        const uniqueNonEmptyTexts = new Set(
            mutations
                .map((m: any) => (typeof m?.text === "string" ? m.text : ""))
                .filter((t) => t.trim().length > 0)
        );
        expect(uniqueNonEmptyTexts.size).toBeLessThanOrEqual(1);
    });

    test("two key strokes at most 2 saves", async ({ page }) => {
        const { getNewSaves, getNewMutations } = await setupCapture(page);
        await page.goto(OFFLINE_BASE);

        const saveBaseline = (await getNewSaves(0)).length;
        expect(saveBaseline).toBe(0);
        const mutationBaseline = (await getNewMutations(0)).length;

        const toolbar = page.getByTestId("toolbarcreatenew").first();
        const textarea = toolbar.locator("textarea");
        await expect(textarea).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(1_500); // ensure ready

        await textarea.type("a");
        await page.waitForTimeout(500); // wait between keystrokes
        await textarea.type("b");

        // Allow debounced autosave to run
        await page.waitForTimeout(3e3);

        const newSaves = await getNewSaves(saveBaseline);
        expect(newSaves.length).toBeLessThanOrEqual(2);
        const mutations = await getNewMutations(mutationBaseline);
        expect(mutations.length).toBeLessThanOrEqual(2);
        const uniqueNonEmptyTexts = new Set(
            mutations
                .map((m: any) => (typeof m?.text === "string" ? m.text : ""))
                .filter((t: any) => t.trim().length > 0)
        );
        expect(uniqueNonEmptyTexts.size).toBeLessThanOrEqual(2);
    });
}); 
