import { test, expect } from "../fixtures/persistentContext";
import { setupConsoleCapture } from "../utils/consoleCapture";
import { OFFLINE_BASE, withSearchParams } from "../utils/url";
import { expectPersistent, waitForPeerInfo } from "../utils/persistence";

async function insertPhotoAlbumTemplates(
    page: import("@playwright/test").Page,
    count: number
) {
    const feed = page.getByTestId("feed");
    const cards = feed.locator("[data-canvas-id]");
    const templateSearch = page.getByPlaceholder("Search templates or apps");

    await page.evaluate(() => {
        (window as any).__DBG_EVENTS = [];
    });

    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
        const toolbar = page.getByTestId("toolbarcreatenew").first();
        await expect(toolbar).toBeVisible({ timeout: 30_000 });

        const before = await cards.count();
        const baseEventsLen = await page.evaluate(
            () => ((window as any).__DBG_EVENTS || []).length as number
        );

        // Open template picker from the composer (it's a toggle: +/x), then apply the template.
        const toggleTplPicker = toolbar
            .locator("button.btn.btn-icon.p-0.m-0.h-full")
            .first();
        if (!(await templateSearch.isVisible().catch(() => false))) {
            await toggleTplPicker.click();
            await expect(templateSearch).toBeVisible({ timeout: 30_000 });
        }

        const tplBtn = page.getByRole("button", {
            name: "Photo album",
            exact: true,
        });
        await expect(tplBtn).toBeVisible({ timeout: 30_000 });
        await tplBtn.click();

        const doneHandle = await page.waitForFunction(
            (fromIndex) => {
                const evts = (window as any).__DBG_EVENTS || [];
                for (let i = evts.length - 1; i >= fromIndex; i--) {
                    const e = evts[i];
                    if (
                        e?.source === "AppSelectPaneInline" &&
                        (e?.name === "templateInsert:done" ||
                            e?.name === "templateInsert:error") &&
                        e?.templateName === "Photo album"
                    ) {
                        return e;
                    }
                }
                return null;
            },
            baseEventsLen,
            { timeout: 60_000 }
        );
        const doneEvt = (await doneHandle.jsonValue()) as any;
        if (doneEvt?.name === "templateInsert:error") {
            throw new Error(
                `Template insert failed: ${doneEvt?.error ?? "unknown"}`
            );
        }
        const insertedId = doneEvt?.insertedId as string | undefined;
        if (!insertedId) throw new Error("Missing insertedId debug event");

        await expect(
            feed.locator(`[data-canvas-id="${insertedId}"]`).first()
        ).toBeVisible({ timeout: 60_000 });

        // Close picker (if still open) to keep the next loop deterministic.
        if (await templateSearch.isVisible().catch(() => false)) {
            await toggleTplPicker.click();
            await expect(templateSearch).toBeHidden({ timeout: 30_000 });
        }

        // Newest posts should appear first for "Recent" and get pinned for "Best".
        ids.push(insertedId);

        // Sanity: ensure some new card appeared in the feed list.
        await expect
            .poll(async () => await cards.count(), { timeout: 10_000 })
            .toBeGreaterThan(before);
    }

    // Ensure we end up with unique ids (sanity)
    const unique = Array.from(new Set(ids));
    expect(unique.length).toBe(ids.length);

    return { ids: unique };
}

async function waitForFeedCardsById(
    page: import("@playwright/test").Page,
    ids: string[],
    timeoutMs: number
) {
    const feed = page.getByTestId("feed");
    await expect
        .poll(
            async () => {
                const found = new Set(
                    await feed.evaluate(
                        () =>
                            Array.from(
                                document.querySelectorAll(
                                    "[data-testid='feed'] [data-canvas-id]"
                                )
                            )
                                .map((n) => n.getAttribute("data-canvas-id"))
                                .filter(Boolean) as string[]
                    )
                );
                return ids.every((id) => found.has(id));
            },
            { timeout: timeoutMs }
        )
        .toBe(true);
}

test.describe("Persistent reload perf (template posts)", () => {
    test("insert Photo album templates → reload → same posts visible (timed)", async ({
        page,
    }, testInfo) => {
        setupConsoleCapture(page, testInfo, {
            printAll: true,
            capturePageErrors: true,
        });

        const url = withSearchParams(
            OFFLINE_BASE.replace("#/", "#/?s=recent"),
            {
                ephemeral: false,
            }
        );
        await page.goto(url);
        await expectPersistent(page);

        const { ids } = await insertPhotoAlbumTemplates(page, 8);

        // Baseline: ensure these posts are visible before reload.
        await waitForFeedCardsById(page, ids, 60_000);

        const tReload = Date.now();
        await page.reload();
        await waitForPeerInfo(page, 30_000);

        // Measure time to re-render the same posts from persisted storage.
        await waitForFeedCardsById(page, ids, 60_000);
        const dt = Date.now() - tReload;
        await testInfo.attach("timing:reloadToSamePostsMs", {
            body: Buffer.from(String(dt), "utf8"),
            contentType: "text/plain",
        });

        // Guardrail: this should not be "incredibly slow" in persistent mode.
        expect(dt).toBeLessThan(15_000);
    });

    test("Photo album navigation children render as tabs, not feed posts", async ({
        page,
    }, testInfo) => {
        setupConsoleCapture(page, testInfo, {
            printAll: true,
            capturePageErrors: true,
        });

        const url = withSearchParams(OFFLINE_BASE, { ephemeral: false });
        await page.goto(url);
        await expectPersistent(page);

        const { ids } = await insertPhotoAlbumTemplates(page, 1);
        const albumId = ids[0];

        // Parent feed should only show the album root post.
        await expect(
            page.getByTestId("feed").locator("[data-canvas-id]")
        ).toHaveCount(1);

        // Open the album post
        await page.goto(`${OFFLINE_BASE}c/${albumId}`);
        await expectPersistent(page);

        // Navigational children should appear as "Places" tabs/rows
        await expect(
            page.getByRole("button", { name: "Photos", exact: true })
        ).toBeVisible({
            timeout: 30_000,
        });
        await expect(
            page.getByRole("button", { name: "Comments", exact: true })
        ).toBeVisible({
            timeout: 30_000,
        });

        // Feed should not render navigational children as posts.
        const feed = page.getByTestId("feed");
        await expect(
            feed.locator("[data-canvas-id]", { hasText: "Photos" })
        ).toHaveCount(0);
        await expect(
            feed.locator("[data-canvas-id]", { hasText: "Comments" })
        ).toHaveCount(0);
    });
});
