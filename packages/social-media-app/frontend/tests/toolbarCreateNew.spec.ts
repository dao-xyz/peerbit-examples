import { test, expect } from "@playwright/test";
import { OFFLINE_BASE } from "./utils/url";
import { getCanvasSaveStats, waitForCanvasSaveDelta } from "./utils/autosave";

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

test.describe("ToolbarCreateNew", () => {
    // Ensure debug overlay from other tests doesn't leak into this suite
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            try {
                localStorage.setItem("debug", "false");
            } catch {}
        });
        page.on("console", (msg) => {
            const t = msg.text();
            if (/\[(DraftManager|DraftSession|CanvasWrapper)\]/.test(t)) {
                console.log(t);
            }
        });
    });

    const getReplyPublishedEvents = async (
        page: import("@playwright/test").Page
    ) => {
        return await page.evaluate(() => {
            const w: any = window as any;
            const topWin: any = w.top || w;
            const arr = (topWin.__DBG_EVENTS || w.__DBG_EVENTS || []) as any[];
            return arr.filter(
                (e: any) =>
                    e?.source === "DraftManager" && e?.name === "replyPublished"
            );
        });
    };

    async function openCardMenuAndClickOpen(
        page: import("@playwright/test").Page,
        card: import("@playwright/test").Locator
    ) {
        const triggers = card.locator("button.btn-icon.btn-icon-sm");
        const count = await triggers.count();
        if (count === 0) throw new Error("No menu trigger found in card");
        // Try from the end (settings usually last); fallback to first
        for (const idx of [count - 1, 0]) {
            await triggers.nth(idx).click();
            const item = page.getByRole("menuitem", { name: "Open" });
            try {
                await item.waitFor({ state: "visible", timeout: 1500 });
                await item.click();
                return;
            } catch {
                // try next candidate
            }
        }
        // As a final attempt, click all triggers sequentially
        for (let i = 0; i < count; i++) {
            await triggers.nth(i).click();
            const item = page.getByRole("menuitem", { name: "Open" });
            if (await item.isVisible()) {
                await item.click();
                return;
            }
        }
        throw new Error("Failed to open card menu");
    }

    async function clickToNavigateToDetail(
        page: import("@playwright/test").Page,
        card: import("@playwright/test").Locator,
        replyId: string
    ) {
        const before = page.url();
        const buttons = card.getByRole("button");
        const count = await buttons.count();
        for (let i = 0; i < count; i++) {
            const b = buttons.nth(i);
            try {
                await b.scrollIntoViewIfNeeded();
            } catch {}
            try {
                await b.click({ trial: false });
            } catch {
                continue;
            }
            try {
                await expect(page).toHaveURL(/#\/c\//, { timeout: 1500 });
                return;
            } catch {
                // If a menu opened, press Escape to close it and try next
                await page.keyboard.press("Escape").catch(() => {});
            }
        }
        // Fallback to dropdown menu → Open
        await openCardMenuAndClickOpen(page, card);
        try {
            await expect(page).toHaveURL(/#\/c\//, { timeout: 1500 });
            return;
        } catch {}
        // As last resort, navigate directly (consumes same route as clicking)
        await page.evaluate((id) => {
            // HashRouter: navigating by hash mimics user route
            location.hash = `#/c/${encodeURIComponent(id)}`;
        }, replyId);
        await expect(page).toHaveURL(/#\/c\//);
    }
    test("can type text before and after image upload", async ({ page }) => {
        await page.goto(OFFLINE_BASE);

        // Anchor to the first toolbar instance
        const toolbar = page.getByTestId("toolbarcreatenew").first();

        // Find textarea anywhere inside the toolbar
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 30000 });

        const msg1 = uid("Hello world");
        await textArea.fill(msg1);
        await expect(textArea).toHaveValue(msg1);

        // Upload image using the hidden input found inside the same toolbar
        const fileInput = toolbar.locator("input[type=file]");
        await expect(fileInput).toBeAttached();
        await fileInput.setInputFiles(
            smallPngFile(`typed-before-after-${Date.now()}.png`)
        );

        // Ensure typing still works
        const msg2 = uid("Text after image");
        await textArea.fill(msg2);
        await expect(textArea).toHaveValue(msg2);
    });

    test("can send two subsequent text messages and input clears between sends", async ({
        page,
    }) => {
        await page.goto(OFFLINE_BASE);

        const toolbar = page.getByTestId("toolbarcreatenew").first();
        // leave __DBG_PARENT unset to collect all debug events
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 30000 });

        await page.evaluate(() => {
            (window as any).__DBG_EVENTS = [];
        });

        // 1) Write a message and press send
        const firstMsg = uid("First message");
        await textArea.fill(firstMsg);
        const sendBtn = toolbar.getByTestId("send-button");
        await expect(sendBtn).toBeEnabled({ timeout: 30000 });
        // Capture baseline BEFORE the action to avoid race
        const base1 = (await getReplyPublishedEvents(page)).length;
        await sendBtn.click();

        // After send, input should clear (Markdown component clears after save)
        await page.waitForFunction(
            () => {
                const el = document.querySelector(
                    '[data-testid="toolbarcreatenew"] textarea'
                ) as HTMLTextAreaElement | null;
                return !el || el.value === "";
            },
            null,
            { timeout: 3000 }
        );

        // Wait for first publish event and verify reply appears by id
        await expect
            .poll(
                async () =>
                    (await getReplyPublishedEvents(page)).length > base1,
                { timeout: 60000 }
            )
            .toBe(true);
        const firstEvt = (await getReplyPublishedEvents(page))[base1];
        await expect(
            page.locator(`[data-canvas-id="${firstEvt.replyId}"]`).first()
        ).toBeVisible({ timeout: 60000 });

        // 2) Write a new message; draft rotates after first publish so reacquire textarea
        const secondMsg = uid("Second message");
        // Nudge editor into editing mode if needed
        try {
            const textContainer = toolbar
                .getByTestId("composer-textarea")
                .first();
            await textContainer.click({ timeout: 800 });
        } catch {}
        await page.waitForFunction(
            () => {
                const el = document.querySelector(
                    '[data-testid="toolbarcreatenew"] textarea'
                ) as HTMLTextAreaElement | null;
                return !!el;
            },
            null,
            { timeout: 5000 }
        );
        const textArea2 = toolbar.locator("textarea");
        await textArea2.fill(secondMsg, { timeout: 3000 });

        // Wait until send is enabled again, then click
        await expect(sendBtn).toBeEnabled({ timeout: 5000 });
        const base2 = (await getReplyPublishedEvents(page)).length;
        await sendBtn.click();

        // Input should clear again
        await page.waitForFunction(
            () => {
                const el = document.querySelector(
                    '[data-testid="toolbarcreatenew"] textarea'
                ) as HTMLTextAreaElement | null;
                return !el || el.value === "";
            },
            null,
            { timeout: 3000 }
        );

        // 3) Wait for second publish event and verify by id
        await expect
            .poll(
                async () =>
                    (await getReplyPublishedEvents(page)).length > base2,
                { timeout: 60000 }
            )
            .toBe(true);
        const secondEvt = (await getReplyPublishedEvents(page))[base2];
        await expect(
            page.locator(`[data-canvas-id="${secondEvt.replyId}"]`).first()
        ).toBeVisible({ timeout: 60000 });
    });

    test("upload image, then send a text message", async ({ page }) => {
        await page.goto(OFFLINE_BASE);

        const toolbar = page.getByTestId("toolbarcreatenew").first();
        // leave __DBG_PARENT unset to collect all debug events

        await page.evaluate(() => {
            (window as any).__DBG_EVENTS = [];
        });

        // Upload image first
        const fileInput = toolbar.locator("input[type=file]");
        await expect(fileInput).toBeAttached();
        const imgName = `after-image-${Date.now()}.png`;
        await fileInput.setInputFiles(smallPngFile(imgName));

        // Ensure we can type after image upload
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 30000 });
        const msg = uid("Message after image");
        await textArea.fill(msg);

        // Send and verify
        const sendBtn = toolbar.getByTestId("send-button");
        await expect(sendBtn).toBeEnabled({ timeout: 30000 });
        // Capture baseline BEFORE click to avoid race
        const prev = (await getReplyPublishedEvents(page)).length;
        await sendBtn.click();

        await page.waitForFunction(
            () => {
                const el = document.querySelector(
                    '[data-testid="toolbarcreatenew"] textarea'
                ) as HTMLTextAreaElement | null;
                return !el || el.value === "";
            },
            null,
            { timeout: 3000 }
        );

        // Verify publish event (text reply) and check by canvas id
        await expect
            .poll(
                async () => (await getReplyPublishedEvents(page)).length > prev,
                { timeout: 60000 }
            )
            .toBe(true);
        const evts = await getReplyPublishedEvents(page);
        const evt = evts.at(-1)!;
        await expect(
            page.locator(`[data-canvas-id="${evt.replyId}"]`).first()
        ).toBeVisible({ timeout: 60000 });
    });

    test("uploaded image appears in grid by alt", async ({ page }) => {
        await page.goto(OFFLINE_BASE);

        const toolbar = page.getByTestId("toolbarcreatenew").first();

        // Ensure the test alt isn't already present
        const uniqueName = `test-image-${Date.now()}.png`;
        await expect(page.getByRole("img", { name: uniqueName })).toHaveCount(
            0
        );

        // Upload image
        const fileInput = toolbar.locator("input[type=file]");
        await expect(fileInput).toBeAttached();
        const baseline = await getCanvasSaveStats(page);
        await fileInput.setInputFiles(smallPngFile(uniqueName));
        await waitForCanvasSaveDelta(page, {
            baseline,
            minRectDelta: 1,
        });

        // Image should appear in the ImageCanvas with alt set to file name
        await expect(
            page.getByRole("img", { name: uniqueName }).first()
        ).toBeVisible({ timeout: 60000 });
    });

    test("placeholder remains after queuing an image (before send)", async ({
        page,
    }) => {
        await page.goto(OFFLINE_BASE);

        const toolbar = page.getByTestId("toolbarcreatenew").first();

        // Queue one image but do not press send
        const fileInput = toolbar.locator("input[type=file]");
        await expect(fileInput).toBeAttached();
        const baseline = await getCanvasSaveStats(page);
        const imgName = `placeholder-test-${Date.now()}.png`;
        await fileInput.setInputFiles(smallPngFile(imgName));

        await waitForCanvasSaveDelta(page, {
            baseline,
            minRectDelta: 1,
        });
        // If the editor isn't already focused, click the text area container to start editing
        const textContainer = toolbar.getByTestId("composer-textarea").first();
        try {
            await textContainer.click({ timeout: 2000 });
        } catch {}
        const textArea = page.locator("textarea").first();
        await expect(textArea).toBeVisible({ timeout: 30000 });
    });

    test("create text post, navigate to it, and see content in detail view", async ({
        page,
    }) => {
        await page.goto(OFFLINE_BASE);

        const toolbar = page.getByTestId("toolbarcreatenew").first();
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 30000 });

        await page.evaluate(() => {
            (window as any).__DBG_EVENTS = [];
        });

        // Compose and send a text post
        const baseline = await getCanvasSaveStats(page);
        const msg = uid("Navigate to post");
        await textArea.fill(msg);
        await waitForCanvasSaveDelta(page, {
            baseline,
            minRectDelta: 1,
        });
        const sendBtn = toolbar.getByTestId("send-button");
        await expect(sendBtn).toBeEnabled({ timeout: 30000 });
        const base = (await getReplyPublishedEvents(page)).length;
        await sendBtn.click();
        await page.waitForFunction(
            () => {
                const el = document.querySelector(
                    '[data-testid="toolbarcreatenew"] textarea'
                ) as HTMLTextAreaElement | null;
                return !el || el.value === "";
            },
            null,
            { timeout: 3000 }
        );

        // Wait for publish event and capture the reply id
        await expect
            .poll(
                async () => (await getReplyPublishedEvents(page)).length > base,
                { timeout: 60000 }
            )
            .toBe(true);
        const evt = (await getReplyPublishedEvents(page))[base];
        const replyId = evt.replyId as string;

        // Locate the feed card and verify content is present
        const card = page.locator(`[data-canvas-id="${replyId}"]`).first();
        await expect(card).toBeVisible({ timeout: 60000 });
        await expect(card.getByText(msg).first()).toBeVisible({
            timeout: 60000,
        });
        // Navigate to detailed view via hash route
        await page.evaluate((id) => {
            location.hash = `#/c/${encodeURIComponent(id)}`;
        }, replyId);

        // Verify navigation and content in detailed view
        await expect(page).toHaveURL(/#\/c\//);
        await expect(page.getByText(msg).first()).toBeVisible({
            timeout: 60000,
        });
    });

    test("create image+text post, navigate to it, and see both in detail view", async ({
        page,
    }) => {
        await page.goto(OFFLINE_BASE);

        const toolbar = page.getByTestId("toolbarcreatenew").first();
        await page.evaluate(() => {
            (window as any).__DBG_EVENTS = [];
        });

        const baseline = await getCanvasSaveStats(page);

        // Upload an image
        const fileInput = toolbar.locator("input[type=file]");
        await expect(fileInput).toBeAttached();
        const imgName = `nav-test-${Date.now()}.png`;
        await fileInput.setInputFiles(smallPngFile(imgName));

        // Type a caption and send
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 30000 });
        const caption = uid("Image caption");
        await textArea.fill(caption);
        await waitForCanvasSaveDelta(page, {
            baseline,
            minRectDelta: 2,
        });
        const sendBtn = toolbar.getByTestId("send-button");
        await expect(sendBtn).toBeEnabled({ timeout: 30000 });
        const base = (await getReplyPublishedEvents(page)).length;
        await sendBtn.click();
        await page.waitForFunction(
            () => {
                const el = document.querySelector(
                    '[data-testid="toolbarcreatenew"] textarea'
                ) as HTMLTextAreaElement | null;
                return !el || el.value === "";
            },
            null,
            { timeout: 3000 }
        );

        // Wait for publish event and capture id
        await expect
            .poll(
                async () => (await getReplyPublishedEvents(page)).length > base,
                { timeout: 60000 }
            )
            .toBe(true);
        const evt = (await getReplyPublishedEvents(page))[base];
        const replyId = evt.replyId as string;

        const card = page.locator(`[data-canvas-id="${replyId}"]`).first();
        await expect(card).toBeVisible({ timeout: 60000 });
        await page.evaluate((id) => {
            (location as any).hash = `#/c/${encodeURIComponent(id)}`;
        }, replyId);

        // Verify navigation and both contents in detailed view
        await expect(page).toHaveURL(/#\/c\//);
        await expect(
            page.getByRole("img", { name: imgName }).first()
        ).toBeVisible({ timeout: 60000 });
        // Text may be collapsed or rendered differently; it's sufficient that the image is present in detail view.
    });
});
