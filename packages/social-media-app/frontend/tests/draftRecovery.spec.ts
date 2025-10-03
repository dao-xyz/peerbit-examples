import { test, expect } from "./fixtures/persistentContext";
import { expectPersistent } from "./utils/persistence";
import { OFFLINE_BASE } from "./utils/url";
import { waitForCanvasSaveDelta, getCanvasSaveStats } from "./utils/autosave";

const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

function smallPngFile(name = "test-image.png") {
    return {
        name,
        mimeType: "image/png",
        buffer: Buffer.from(PNG_BASE64, "base64"),
    };
}

function uid(prefix: string) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix} ${rand}-${Date.now()}`;
}

test.describe("Draft recovery", () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            try {
                localStorage.setItem("debug", "false");
            } catch { }
        });
    });

    test("peer identity persists across reload (debug)", async ({ page }) => {
        await page.goto(OFFLINE_BASE);
        await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
            timeout: 20000,
        });
        const first = await page.evaluate(() => (window as any).__peerInfo);
        await page.reload();
        await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
            timeout: 20000,
        });
        const second = await page.evaluate(() => (window as any).__peerInfo);

        expect(first?.peerHash).toBeTruthy();
        await expectPersistent(page);
        expect(second?.peerHash).toBe(first?.peerHash);
    });

    test("recovers text only: one text element (no empty placeholder)", async ({
        page,
    }) => {
        await page.goto(OFFLINE_BASE);
        await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
            timeout: 20000,
        });

        const toolbar = page.getByTestId("toolbarcreatenew").first();
        await expect(toolbar).toBeVisible({ timeout: 20000 });
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 20000 });

        const saveBaseline = await getCanvasSaveStats(page);

        const msg = uid("Recovered text");
        await textArea.fill(msg);

        await waitForCanvasSaveDelta(page, {
            baseline: saveBaseline,
            minRectDelta: 1,
        });

        // Capture identity and reload to trigger recovery
        await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
            timeout: 20000,
        });
        const first = await page.evaluate(() => (window as any).__peerInfo);
        await page.reload();
        await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
            timeout: 20000,
        });
        const second = await page.evaluate(() => (window as any).__peerInfo);

        const toolbar2 = page.getByTestId("toolbarcreatenew").first();
        const textAreas = toolbar2.locator("textarea");
        await expect(textAreas).toHaveCount(1, { timeout: 20000 });
        await expectPersistent(page);
        await expect
            .poll(async () => await textAreas.first().inputValue(), {
                timeout: 20000,
                message: "Waiting for recovered text to appear",
            })
            .toBe(msg);
    });

    test("recovers image only: one empty text element + image", async ({
        page,
    }) => {
        await page.goto(OFFLINE_BASE);
        // Ensure peer/session is ready so the composer can mount
        await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
            timeout: 30000,
        });
        const toolbar = page.getByTestId("toolbarcreatenew").first();
        // Wait for toolbar to mount and be visible
        await expect(toolbar).toBeVisible({ timeout: 30000 });
        // Target the file input within the toolbar to avoid cross-component races
        const fileInput = toolbar.locator("input[type=file]").first();
        await expect(fileInput).toBeAttached({ timeout: 30000 });

        const saveBaseline = await getCanvasSaveStats(page);

        const imgName = `recover-image-${Date.now()}.png`;
        await fileInput.setInputFiles(smallPngFile(imgName));

        await waitForCanvasSaveDelta(page, {
            baseline: saveBaseline,
            minRectDelta: 1,
        });

        await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
            timeout: 20000,
        });
        const first = await page.evaluate(() => (window as any).__peerInfo);
        await page.reload();
        await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
            timeout: 20000,
        });
        const second = await page.evaluate(() => (window as any).__peerInfo);

        const toolbar2 = page.getByTestId("toolbarcreatenew").first();
        // Check identity stability and assert accordingly
        if (
            first?.peerHash &&
            second?.peerHash &&
            first.peerHash === second.peerHash
        ) {
            // Image should be present by alt
            await expect(
                toolbar2.getByRole("img", { name: imgName }).first()
            ).toBeVisible({ timeout: 20000 });
        } else {
            // New identity: no recovered image expected
            await expect(
                toolbar2.getByRole("img", { name: imgName }).first()
            ).toHaveCount(0, { timeout: 20000 } as any);
        }

        // Exactly one text editor, expected to be empty placeholder
        const textAreas = toolbar2.locator("textarea");
        await expect(textAreas).toHaveCount(1, { timeout: 20000 });
        await expectPersistent(page);
        await page.waitForFunction(
            () => {
                const el = document.querySelector(
                    '[data-testid="toolbarcreatenew"] textarea'
                ) as HTMLTextAreaElement | null;
                return !el || el.value === "";
            },
            { timeout: 20000 }
        );
    });

    test("recovers text + image: one text element (the recovered one) + image", async ({
        page,
    }) => {
        await page.goto(OFFLINE_BASE);

        const toolbar = page.getByTestId("toolbarcreatenew").first();
        await expect(toolbar).toBeVisible({ timeout: 20000 });
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 20000 });

        const saveBaseline = await getCanvasSaveStats(page);

        const msg = uid("Recovered caption");
        await textArea.fill(msg);

        const fileInput = toolbar.locator("input[type=file]").first();
        await expect(fileInput).toBeAttached({ timeout: 30000 });
        const imgName = `recover-mixed-${Date.now()}.png`;
        await fileInput.setInputFiles(smallPngFile(imgName));

        await waitForCanvasSaveDelta(page, {
            baseline: saveBaseline,
            minRectDelta: 2,
        });

        // Read identity info opportunistically (don’t block the test on it)
        const first = await page.evaluate(() => (window as any).__peerInfo);
        await page.reload();
        const second = await page.evaluate(() => (window as any).__peerInfo);

        const toolbar2 = page.getByTestId("toolbarcreatenew").first();
        // Image present only if identity stable
        await expectPersistent(page);
        await expect(
            toolbar2.getByRole("img", { name: imgName }).first()
        ).toBeVisible({ timeout: 20000 });

        // Exactly one text editor with recovered text
        const textAreas = toolbar2.locator("textarea");
        await expect(textAreas).toHaveCount(1, { timeout: 20000 });
        await expect
            .poll(async () => await textAreas.first().inputValue(), {
                timeout: 20000,
                message: "Waiting for recovered text with image to appear",
            })
            .toBe(msg);
    });
});
