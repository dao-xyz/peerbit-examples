import { test, expect } from "../fixtures/persistentContext";
import { OFFLINE_BASE } from "../utils/url";
import { expectPersistent } from "../utils/persistence";
import { attachConsoleHooks } from "../utils/consoleHooks";

function uid(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

async function initDebugEvents(page: any) {
    await page.evaluate(() => {
        (window as any).__DRAFT_READY = null;
        (window as any).__DBG_EVENTS = [];
        if (!(window as any).__LISTENING_PUBLISH) {
            (window as any).__LISTENING_PUBLISH = true;
            window.addEventListener("debug:event", (e: any) => {
                (window as any).__DBG_EVENTS.push(e.detail);
            });
        }
    });
}

async function getReplyPublishedEvents(page: any) {
    return (await page.evaluate(() => (window as any).__DBG_EVENTS))?.filter(
        (e: any) => e?.source === "DraftManager" && e?.name === "replyPublished"
    );
}

async function waitForComposerReady(page: any, timeout = 30000) {
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

async function publishPost(page: any, message: string) {
    await page.goto(OFFLINE_BASE);
    await expectPersistent(page);
    await waitForComposerReady(page);
    const toolbar = page.getByTestId("toolbarcreatenew").first();
    const sendBtn = toolbar.getByTestId("send-button");
    const textArea = toolbar.locator("textarea");
    await textArea.fill(message);
    await expect(sendBtn).toBeEnabled({ timeout: 20000 });
    await sendBtn.click();
    // wait for card to appear
    await expect(
        page.locator(`[data-canvas-id]`, { hasText: message }).first()
    ).toBeVisible({ timeout: 30000 });
    const card = await page
        .locator(`[data-canvas-id]`, { hasText: message })
        .first()
        .elementHandle();
    const id = await card?.getAttribute("data-canvas-id");
    if (!id) throw new Error("missing id after publish");
    return id;
}

async function openChat(page: any, parentId: string) {
    await page.goto(`${OFFLINE_BASE}c/${parentId}`);
    await expectPersistent(page);
    await waitForComposerReady(page);
    await expect(page).toHaveURL(/#\/c\//, { timeout: 15000 });
}

async function sendReply(page: any, message: string) {
    const baseEvents = ((await getReplyPublishedEvents(page))?.length ??
        0) as number;
    const toolbar = page.getByTestId("toolbarcreatenew").last();
    const sendBtn = toolbar.getByTestId("send-button");
    const textArea = toolbar.locator("textarea").first();
    let filled = false;
    for (let i = 0; i < 4; i++) {
        await textArea.fill("");
        await textArea.type(message, { delay: 20 });
        await page.waitForTimeout(200);
        const val = await textArea.inputValue();
        if (val === message) {
            filled = true;
            break;
        }
    }
    expect(filled).toBe(true);
    await expect
        .poll(async () => await sendBtn.isEnabled(), { timeout: 20000 })
        .toBe(true);
    await sendBtn.click();
    await expect
        .poll(
            async () =>
                ((await getReplyPublishedEvents(page))?.length ?? 0) >
                baseEvents,
            { timeout: 30000 }
        )
        .toBe(true);
    await expect(
        page.locator("[data-canvas-id]").filter({ hasText: message }).first()
    ).toBeVisible({ timeout: 50000 });
}

async function orderForMessages(page: any, texts: string[]) {
    return page.evaluate((labels: string[]) => {
        const nodes = Array.from(document.querySelectorAll("[data-canvas-id]"));
        return labels.map((label) =>
            nodes.findIndex((n) => (n.textContent || "").includes(label))
        );
    }, texts);
}

test.describe("Chat view ordering", () => {
    test("no canvas errors when switching to chat view", async ({
        page,
    }, testInfo) => {
        const consoleHook = attachConsoleHooks(page, {
            echoErrors: true,
            capturePageErrors: true,
        });
        try {
            const parentId = await publishPost(page, uid("ChatParent"));

            await openChat(page, parentId);
            consoleHook.clear();
            await page
                .getByRole("button", { name: "Feed", exact: true })
                .click();
            await page
                .getByRole("menuitem", { name: "Chat", exact: true })
                .click();
            await expect(page).toHaveURL(/([?&]v=chat)/, { timeout: 15000 });
            await page.waitForTimeout(5000);

            const consoleErrors = consoleHook.errors().map((msg) => msg.text());
            const pageErrors = consoleHook
                .pageErrors()
                .map((err) => err.stack || err.message || String(err));
            const allErrors = [...consoleErrors, ...pageErrors].filter(Boolean);

            // Check for Canvas.nearestScope: not loaded errors
            const nearestScopeErrors = allErrors.filter((t) =>
                /Canvas\.nearestScope: not loaded/i.test(t)
            );

            if (nearestScopeErrors.length) {
                await testInfo.attach("nearestScope-not-loaded-errors", {
                    body: Buffer.from(nearestScopeErrors.join("\n"), "utf8"),
                    contentType: "text/plain",
                });
            }

            expect(
                nearestScopeErrors,
                "Unexpected 'Canvas.nearestScope: not loaded' error - canvas not properly loaded before transform"
            ).toEqual([]);

            // Also check for NotStartedError
            const notStarted = allErrors.filter((t) =>
                /NotStartedError: Not started/i.test(t)
            );

            if (notStarted.length) {
                await testInfo.attach("not-started-errors", {
                    body: Buffer.from(notStarted.join("\n"), "utf8"),
                    contentType: "text/plain",
                });
            }

            expect(
                notStarted,
                "Unexpected NotStartedError in page console"
            ).toEqual([]);
        } finally {
            consoleHook.stop();
        }
    });

    test("append at bottom", async ({ page }, testInfo) => {
        const consoleHook = attachConsoleHooks(page, {
            echoErrors: true,
            capturePageErrors: true,
        });
        try {
            const parentId = await publishPost(page, uid("ChatParent"));

            await openChat(page, parentId);
            await page
                .getByRole("button", { name: "Feed", exact: true })
                .click();
            await page
                .getByRole("menuitem", { name: "Chat", exact: true })
                .click();
            await expect(page).toHaveURL(/([?&]v=chat)/, { timeout: 15000 });
            await initDebugEvents(page);
            await waitForComposerReady(page);
            const first = uid("Chat-msg-1");
            const second = uid("Chat-msg-2");

            await sendReply(page, first);
            await sendReply(page, second);

            await expect
                .poll(
                    async () => {
                        const [a, b] = await orderForMessages(page, [
                            first,
                            second,
                        ]);
                        return a >= 0 && b >= 0 && b > a;
                    },
                    { timeout: 15000 }
                )
                .toBe(true);

            const templateNotStartedWarnings = consoleHook
                .messages()
                .filter(
                    (msg) =>
                        msg.type() === "warning" &&
                        /useTemplates: scope\/program not started, skipping bootstrap/i.test(
                            msg.text()
                        )
                )
                .map((msg) => msg.text());

            if (templateNotStartedWarnings.length) {
                await testInfo.attach(
                    "useTemplates-scope-not-started-warnings",
                    {
                        body: Buffer.from(
                            templateNotStartedWarnings.join("\n"),
                            "utf8"
                        ),
                        contentType: "text/plain",
                    }
                );
            }

            expect(
                templateNotStartedWarnings,
                "Unexpected useTemplates warning; treat as error to catch scope/program lifecycle races"
            ).toEqual([]);

            const consoleErrors = consoleHook.errors().map((msg) => msg.text());
            const pageErrors = consoleHook
                .pageErrors()
                .map((err) => err.stack || err.message || String(err));
            const allErrors = [...consoleErrors, ...pageErrors].filter(Boolean);

            const notStarted = allErrors.filter((t) =>
                /NotStartedError: Not started/i.test(t)
            );
            if (notStarted.length) {
                await testInfo.attach("not-started-errors", {
                    body: Buffer.from(notStarted.join("\n"), "utf8"),
                    contentType: "text/plain",
                });
            }
            expect(
                notStarted,
                "Unexpected NotStartedError; indicates scope/program stores not started (flake source)"
            ).toEqual([]);

            await page.waitForTimeout(1e4);
        } finally {
            consoleHook.stop();
        }
    });

    test("right order after refresh", async ({ page }) => {
        const parentId = await publishPost(page, uid("ChatParent"));

        await openChat(page, parentId);
        await page.getByRole("button", { name: "Feed", exact: true }).click();
        await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
        await expect(page).toHaveURL(/([?&]v=chat)/, { timeout: 15000 });
        await initDebugEvents(page);
        await waitForComposerReady(page);
        const first = uid("Chat-msg-1");
        const second = uid("Chat-msg-2");

        await sendReply(page, first);
        await sendReply(page, second);

        await expect
            .poll(
                async () => {
                    const [a, b] = await orderForMessages(page, [
                        first,
                        second,
                    ]);
                    return a >= 0 && b >= 0 && b > a;
                },
                { timeout: 15000 }
            )
            .toBe(true);

        await page.reload({ waitUntil: "networkidle" });
        await expectPersistent(page);
        await waitForComposerReady(page);
        await page.waitForTimeout(2000); // some timeout to trigger re-render (TODO why do we need this)
        await expect
            .poll(
                async () => {
                    const [a, b] = await orderForMessages(page, [
                        first,
                        second,
                    ]);
                    return a >= 0 && b >= 0 && b > a;
                },
                { timeout: 20000 }
            )
            .toBe(true);

        await page.waitForTimeout(1e4);
    });
});
