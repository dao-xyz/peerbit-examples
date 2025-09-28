import { test } from "./fixtures/persistentContext";

const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

test("debug draft recovery", async ({ page }) => {
    page.on("console", (msg) => {
        console.log(`[console.${msg.type()}]`, msg.text());
    });
    await page.goto("http://localhost:5173#/offline");
    await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
        timeout: 30000,
    });
    console.log(
        "peer before",
        await page.evaluate(() => (window as any).__peerInfo)
    );
    const toolbar = page.getByTestId("toolbarcreatenew").first();
    await toolbar.waitFor({ state: "visible", timeout: 30000 });
    const fileInput = toolbar.locator("input[type=file]").first();
    await fileInput.setInputFiles({
        name: "debug-image.png",
        mimeType: "image/png",
        buffer: Buffer.from(PNG_BASE64, "base64"),
    });
    const manualRead = await page.evaluate(async (b64) => {
        const { readFileAsImage } = await import(
            "/src/content/native/image/utils.ts"
        );
        const binary = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const file = new File([binary], "manual.png", { type: "image/png" });
        const res = await readFileAsImage(file);
        return res.length;
    }, PNG_BASE64);
    console.log("manual read count", manualRead);
    await page.waitForTimeout(3000);
    console.log(
        "pending before",
        await page.evaluate(() => (window as any).__pendingRects)
    );
    console.log(
        "committed before",
        await page.evaluate(() => (window as any).__committedRects)
    );
    console.log("toolbar html before", await toolbar.innerHTML());
    console.log(
        "before reload images",
        await page.evaluate(() =>
            Array.from(
                document.querySelectorAll(
                    '[data-testid="toolbarcreatenew"] img'
                )
            ).map((img) => ({ alt: img.alt, src: img.getAttribute("src") }))
        )
    );
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
        timeout: 30000,
    });
    console.log(
        "peer after",
        await page.evaluate(() => (window as any).__peerInfo)
    );
    const toolbar2 = page.getByTestId("toolbarcreatenew").first();
    await toolbar2.waitFor({ state: "visible", timeout: 30000 });
    console.log(
        "pending after",
        await page.evaluate(() => (window as any).__pendingRects)
    );
    console.log(
        "committed after",
        await page.evaluate(() => (window as any).__committedRects)
    );
    console.log("toolbar html after", await toolbar2.innerHTML());
    console.log(
        "after reload images",
        await page.evaluate(() =>
            Array.from(
                document.querySelectorAll(
                    '[data-testid="toolbarcreatenew"] img'
                )
            ).map((img) => ({ alt: img.alt, src: img.getAttribute("src") }))
        )
    );
});
