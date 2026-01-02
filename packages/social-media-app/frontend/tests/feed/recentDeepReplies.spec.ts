import { Page, type Locator } from "@playwright/test";
import { test, expect } from "../fixtures/persistentContext";
import { OFFLINE_BASE } from "../utils/url";
import { expectPersistent } from "../utils/persistence";
import { attachConsoleHooks } from "../utils/consoleHooks";

function uid(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

async function initDebugEvents(page: Page) {
    await page.evaluate(() => {
        (window as any).__DBG_EVENTS = [];
        if (!(window as any).__LISTENING_PUBLISH) {
            (window as any).__LISTENING_PUBLISH = true;
            window.addEventListener("debug:event", (e: any) => {
                (window as any).__DBG_EVENTS.push(e.detail);
            });
        }
    });
}

async function getReplyPublishedEvents(page: Page) {
    return (await page.evaluate(() => (window as any).__DBG_EVENTS))?.filter(
        (e: any) => e?.source === "DraftManager" && e?.name === "replyPublished"
    );
}

async function waitForComposerReady(page: Page, timeout = 30000) {
    await page.waitForFunction(
        () => {
            const ready = (window as any).__DRAFT_READY;
            const textarea = document.querySelector(
                '[data-testid="toolbarcreatenew"] textarea'
            );
            return !!ready?.draftId && !!textarea;
        },
        null,
        { timeout }
    );
}

async function ensurePublic(toolbar: Locator) {
    const privacySwitch = toolbar.getByRole("switch", { name: /Private/i });
    if ((await privacySwitch.count()) === 0) return;
    const checked = (await privacySwitch.getAttribute("aria-checked")) === "true";
    if (checked) await privacySwitch.click();
}

async function typeMessage(page: Page, textarea: Locator, message: string) {
    let filled = false;
    for (let i = 0; i < 4; i++) {
        await textarea.fill("");
        await textarea.type(message, { delay: 20 });
        await page.waitForTimeout(200);
        const val = await textarea.inputValue();
        if (val === message) {
            filled = true;
            break;
        }
    }
    expect(filled).toBe(true);
}

async function publishFromToolbar(
    page: Page,
    toolbar: Locator,
    message: string
) {
    await expect(toolbar).toBeVisible({ timeout: 30000 });
    const textarea = toolbar.locator("textarea").first();
    await expect(textarea).toBeVisible({ timeout: 30000 });
    await ensurePublic(toolbar);

    const sendBtn = toolbar.getByTestId("send-button");
    const base = (await getReplyPublishedEvents(page))?.length ?? 0;
    await typeMessage(page, textarea, message);
    await expect
        .poll(async () => await sendBtn.isEnabled(), { timeout: 20000 })
        .toBe(true);
    await sendBtn.click();

    await expect
        .poll(
            async () =>
                ((await getReplyPublishedEvents(page))?.length ?? 0) > base,
            { timeout: 30000 }
        )
        .toBe(true);
    const evt = (await getReplyPublishedEvents(page))[base];
    const replyId = evt.replyId as string;
    const card = page.locator(`[data-canvas-id="${replyId}"]`).first();
    await expect(card).toBeVisible({ timeout: 50000 });
    await expect(card.getByText(message)).toBeVisible({ timeout: 30000 });
    return replyId;
}

async function switchToChatView(page: Page) {
    await page.getByRole("button", { name: "Feed", exact: true }).click();
    await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
    await expect(page).toHaveURL(/([?&]v=chat)/, { timeout: 15000 });
}

test.describe("Recent feed includes deep replies", () => {
    test("root Recent shows replies from sub-contexts", async (
        { page },
        testInfo
    ) => {
        const consoleHook = attachConsoleHooks(page, {
            echoErrors: true,
            capturePageErrors: true,
        });
        try {
            const parentText = uid("RecentParent");
            const reply1Text = uid("RecentReply1");
            const reply2Text = uid("RecentReply2");

            // Create top-level post on root
            await page.goto(OFFLINE_BASE);
            await expectPersistent(page);
            await initDebugEvents(page);
            await waitForComposerReady(page);
            const rootToolbar = page.getByTestId("toolbarcreatenew").first();
            const parentId = await publishFromToolbar(
                page,
                rootToolbar,
                parentText
            );

            // Reply to the post (sub-context depth 2 relative to root)
            await page.goto(`${OFFLINE_BASE}c/${parentId}`);
            await expectPersistent(page);
            await waitForComposerReady(page);
            await switchToChatView(page);
            await initDebugEvents(page);
            await waitForComposerReady(page);
            const replyToolbar = page.getByTestId("toolbarcreatenew").last();
            const reply1Id = await publishFromToolbar(
                page,
                replyToolbar,
                reply1Text
            );

            // Nested reply under the first reply (depth 3 relative to root)
            await page.goto(`${OFFLINE_BASE}c/${reply1Id}`);
            await expectPersistent(page);
            await waitForComposerReady(page);
            await switchToChatView(page);
            await initDebugEvents(page);
            await waitForComposerReady(page);
            const replyToolbar2 = page.getByTestId("toolbarcreatenew").last();
            const reply2Id = await publishFromToolbar(
                page,
                replyToolbar2,
                reply2Text
            );

            // Root Recent should include both replies when using getRepliesQuery(root)
            const recentUrl = OFFLINE_BASE.replace("#/", "#/?s=recent");
            await page.goto(recentUrl);
            await expectPersistent(page);
            await waitForComposerReady(page);

            await expect(
                page.locator(`[data-canvas-id="${reply1Id}"]`).first()
            ).toBeVisible({ timeout: 60000 });
            await expect(
                page.locator(`[data-canvas-id="${reply2Id}"]`).first()
            ).toBeVisible({ timeout: 60000 });
        } finally {
            const consoleErrors = consoleHook.errors().map((msg) => msg.text());
            const pageErrors = consoleHook
                .pageErrors()
                .map((err) => err.stack || err.message || String(err));
            const allErrors = [...consoleErrors, ...pageErrors].filter(Boolean);
            if (allErrors.length) {
                await testInfo.attach("console+pageErrors", {
                    body: Buffer.from(allErrors.join("\n"), "utf8"),
                    contentType: "text/plain",
                });
            }
            consoleHook.stop();
        }
    });
});
