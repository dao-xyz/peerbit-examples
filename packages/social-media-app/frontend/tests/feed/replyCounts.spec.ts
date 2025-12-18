import { test, expect } from "../fixtures/persistentContext";
import { OFFLINE_BASE, withSearchParams } from "../utils/url";
import { expectPersistent } from "../utils/persistence";

function uid(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

async function waitForStableDraft(page: any, timeout = 3000) {
    const start = Date.now();
    let lastId: string | null = null;
    while (Date.now() - start < timeout) {
        const info = await page.evaluate(() => (window as any).__DRAFT_READY);
        const draftId = info?.draftId || null;
        if (draftId && draftId === lastId) return draftId;
        lastId = draftId;
        await page.waitForTimeout(150);
    }
    return lastId;
}

async function getReplyPublishedEvents(page: any) {
    return (await page.evaluate(() => (window as any).__DBG_EVENTS))?.filter(
        (e: any) => e?.source === "DraftManager" && e?.name === "replyPublished"
    );
}

async function openView(page: any, url: string, label: string) {
    await page.goto(url);
    await expectPersistent(page);
    await waitForComposerReady(page);
    await waitForStableDraft(page);
    await page
        .getByRole("button", { name: label, exact: true })
        .first()
        .click();
}

async function publishPost(page: any, message: string) {
    const toolbar = page.getByTestId("toolbarcreatenew").first();
    const sendBtn = toolbar.getByTestId("send-button");
    const textArea = toolbar.locator("textarea");
    const privacySwitch = toolbar.getByRole("switch", { name: /Private/i });
    if ((await privacySwitch.count()) > 0) {
        await expect(privacySwitch).toHaveAttribute("aria-checked", "false");
    }
    await textArea.fill(message);
    await expect(sendBtn).toBeEnabled({ timeout: 20000 });
    const base = (await getReplyPublishedEvents(page))?.length ?? 0;
    await sendBtn.click();
    await expect
        .poll(
            async () =>
                ((await getReplyPublishedEvents(page))?.length ?? 0) > base,
            { timeout: 30000 }
        )
        .toBe(true);
    const evt = (await getReplyPublishedEvents(page))[base];
    expect(evt?.replyId).toBeTruthy();
    return evt.replyId as string;
}

async function addComment(page: any, parentId: string, message: string) {
    // Navigate via the comment button to the detail/chat view
    const card = page.locator(`[data-canvas-id="${parentId}"]`).first();
    await expect(card).toBeVisible({ timeout: 30000 });
    const commentBtn = card.getByTestId("open-comments").first();
    await commentBtn.click();
    await expect(page).toHaveURL(/#\/c\//, { timeout: 15000 });

    // Wait for detail composer to mount
    const textArea = page
        .locator('[data-testid="toolbarcreatenew"] textarea')
        .first();
    await expect(textArea).toBeVisible({ timeout: 20000 });
    await waitForStableDraft(page);
    const privacySwitch = page
        .getByRole("switch", { name: /Private/i })
        .first();
    if ((await privacySwitch.count()) > 0) {
        await expect(privacySwitch).toHaveAttribute("aria-checked", "false");
    }
    await textArea.click();
    // Retry typing in case draft rotation clears the value
    let filled = false;
    for (let attempt = 0; attempt < 4; attempt++) {
        await textArea.fill("");
        await textArea.type(message, { delay: 30 });
        await page.waitForTimeout(200);
        const val = await textArea.inputValue();
        if (val === message) {
            filled = true;
            break;
        }
    }
    expect(filled).toBe(true);
    const sendBtn = page.getByTestId("send-button").first();
    await expect
        .poll(async () => await sendBtn.isEnabled(), { timeout: 20000 })
        .toBe(true);
    const base = (await getReplyPublishedEvents(page))?.length ?? 0;
    await sendBtn.click({ trial: false });
    await expect
        .poll(
            async () =>
                ((await getReplyPublishedEvents(page))?.length ?? 0) > base,
            { timeout: 30000 }
        )
        .toBe(true);
}

async function commentCounts(page: any, ids: string[]) {
    return page.evaluate((ids: any) => {
        return ids.map((id: any) => {
            const btn = document.querySelector(
                `[data-canvas-id="${id}"] [data-testid="open-comments"]`
            ) as HTMLElement | null;
            if (!btn) return null;
            const t = (btn.textContent || "").replace(/[^0-9]/g, "");
            const n = Number.parseInt(t || "0", 10);
            return Number.isFinite(n) ? n : 0;
        });
    }, ids);
}

test.describe("Reply counts", () => {
    test("comment count increments and is visible on Best after refresh", async ({
        page,
    }) => {
        const url = withSearchParams(OFFLINE_BASE, { ephemeral: false });
        await openView(page, url, "Best");

        const older = await publishPost(page, uid("RC-older"));
        const newer = await publishPost(page, uid("RC-newer"));

        await addComment(page, older, uid("RC-comment"));

        await openView(page, url, "Best");
        // ensure cards are present
        for (const id of [older, newer]) {
            await expect(
                page.locator(`[data-canvas-id="${id}"]`).first()
            ).toBeVisible({ timeout: 30000 });
        }

        await expect
            .poll(async () => (await commentCounts(page, [older, newer]))[0], {
                timeout: 20000,
            })
            .toBeGreaterThan(0);
        const [, newerCount] = await commentCounts(page, [older, newer]);
        expect(newerCount).toBe(0);
    });

    // Document the upstream regression so it can be re-enabled once fixed.
    test("parent reply count increments in metadata after adding a reply (upstream regression)", async ({
        page,
    }) => {
        const url = withSearchParams(OFFLINE_BASE, { ephemeral: false });
        await openView(page, url, "Best");

        const parentId = await publishPost(page, uid("RC-meta-parent"));
        await addComment(page, parentId, uid("RC-meta-reply"));

        // Reload and inspect the parent card's indexed replies
        await openView(page, url, "Best");
        await expect
            .poll(async () => (await commentCounts(page, [parentId]))[0], {
                timeout: 20000,
            })
            .toBeGreaterThan(0);
    });
});
