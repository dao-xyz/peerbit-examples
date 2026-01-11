import { test, expect } from "@playwright/test";
import { withSearchParams } from "../utils/url";
import { setupConsoleCapture } from "../utils/consoleCapture";
import {
    seedReplicatorPosts,
    startReplicator,
} from "../replicator/replicatorNode";
import { toBase64URL } from "@peerbit/crypto";

const BASE_HTTP = process.env.BASE_URL || "http://localhost:5190";

const MAX_CONTAINER_TO_CONTENT_MS = Number(
    process.env.PW_FEED_MAX_CONTAINER_TO_CONTENT_MS ||
        (process.env.CI ? "1500" : "750")
);
const MAX_HEIGHT_DELTA_PX = Number(
    process.env.PW_FEED_MAX_HEIGHT_DELTA_PX || "12"
);
const HEIGHT_STABILITY_WAIT_MS = Number(
    process.env.PW_FEED_HEIGHT_STABILITY_WAIT_MS || "1250"
);

async function waitForObservedAppearance(page: any, id: string) {
    await expect
        .poll(
            async () =>
                await page.evaluate((id: string) => {
                    return (
                        (window as any).__E2E_RENDER_GUARD__?.appear?.[id] ??
                        null
                    );
                }, id),
            { timeout: 60_000 }
        )
        .not.toBeNull();

    await expect
        .poll(
            async () =>
                await page.evaluate((id: string) => {
                    return (
                        (window as any).__E2E_RENDER_GUARD__?.appear?.[id]
                            ?.heightAtAppearPx ?? null
                    );
                }, id),
            { timeout: 10_000 }
        )
        .not.toBeNull();

    return (await page.evaluate((id: string) => {
        return (window as any).__E2E_RENDER_GUARD__?.appear?.[id] ?? null;
    }, id)) as { appeared: number; heightAtAppearPx: number };
}

async function waitForContentReady(page: any, id: string, text: string) {
    return (await page.evaluate(
        async ({ id, text }: { id: string; text: string }) => {
            const now = () =>
                typeof performance !== "undefined" && performance.now
                    ? performance.now()
                    : Date.now();
            const start = now();
            while (now() - start < 15_000) {
                const el = document.querySelector(`[data-canvas-id="${id}"]`);
                if (el && el.textContent && el.textContent.includes(text)) {
                    try {
                        (window as any).__E2E_RENDER_GUARD__?.timeline?.push({
                            t: now(),
                            phase: "content:ready",
                            id,
                        });
                    } catch {}
                    return now();
                }
                await new Promise((r) => setTimeout(r, 50));
            }
            return null;
        },
        { id, text }
    )) as number | null;
}

async function getCardHeight(page: any, id: string) {
    return (await page.evaluate((id: string) => {
        const el = document.querySelector(`[data-canvas-id="${id}"]`);
        if (!el) return null;
        return (el as HTMLElement).getBoundingClientRect().height;
    }, id)) as number | null;
}

test.describe("Feed render gating: don't render post shells before elements load", () => {
    test.setTimeout(300_000);

    let stop: (() => Promise<void>) | undefined;
    let bootstrap: string[] | undefined;
    let client: Awaited<ReturnType<typeof startReplicator>>["client"] | undefined;
    let scope: Awaited<ReturnType<typeof startReplicator>>["scope"] | undefined;

    test.beforeAll(async () => {
        const started = await startReplicator();
        client = started.client;
        scope = started.scope;
        bootstrap = started.addrs.map((a) => a.toString());

        stop = async () => {
            try {
                await started.client.stop();
            } catch {}
        };
    });

    test.afterAll(async () => {
        if (stop) await stop();
        stop = undefined;
        bootstrap = undefined;
        client = undefined;
        scope = undefined;
    });

    test("replicator insertion + reload: card content/height ready when container appears", async ({
        page,
    }, testInfo) => {
        await page.addInitScript(() => {
            const now = () =>
                typeof performance !== "undefined" && performance.now
                    ? performance.now()
                    : Date.now();
            const state = ((window as any).__E2E_RENDER_GUARD__ = {
                appear: {} as Record<
                    string,
                    { appeared: number; heightAtAppearPx: number | null }
                >,
                timeline: [] as any[],
            });

            const pushTL = (evt: any) => {
                try {
                    state.timeline.push({ t: now(), ...evt });
                } catch {}
            };

            const record = (el: HTMLElement) => {
                const id = el.getAttribute("data-canvas-id");
                if (!id) return;
                if (state.appear[id]) return;
                state.appear[id] = { appeared: now(), heightAtAppearPx: null };
                pushTL({ phase: "container:appear", id });
                requestAnimationFrame(() => {
                    try {
                        if (!state.appear[id]) return;
                        state.appear[id].heightAtAppearPx =
                            el.getBoundingClientRect().height;
                        pushTL({
                            phase: "container:appearHeight",
                            id,
                            height: state.appear[id].heightAtAppearPx,
                        });
                    } catch {}
                });
            };

            const scanNode = (n: Node) => {
                if (!(n instanceof HTMLElement)) return;
                if (n.hasAttribute("data-canvas-id")) record(n);
                for (const el of Array.from(
                    n.querySelectorAll("[data-canvas-id]")
                )) {
                    record(el as HTMLElement);
                }
            };

            const obs = new MutationObserver((muts) => {
                for (const m of muts) {
                    for (const n of Array.from(m.addedNodes)) {
                        scanNode(n);
                    }
                }
            });

            // On some PW navigations the init script can run before `document.body` exists.
            // Observing `document` avoids a hard failure and still captures mutations.
            obs.observe(document, { childList: true, subtree: true });
            pushTL({ phase: "observer:installed" });
        });

        setupConsoleCapture(page, testInfo, {
            printAll: false,
            capturePageErrors: true,
        });

        if (!client) throw new Error("Missing replicator client");
        if (!scope) throw new Error("Missing replicator scope");

        const url = withSearchParams(`${BASE_HTTP}#/?v=feed&s=new`, {
            ephemeral: true,
            bootstrap: (bootstrap || []).join(","),
        });

        await page.goto(url);

        // App ready
        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });
        const feed = page.getByTestId("feed");

        const prefix = `E2E-RenderGating-${Date.now()}`;
        const seeded = await seedReplicatorPosts({
            client,
            scope,
            count: 1,
            prefix,
        });

        const insertedPost = seeded.posts?.[0];
        const insertedMessage = seeded.messages?.[0];
        if (!insertedPost || !insertedMessage) {
            throw new Error("Failed to insert post via replicator");
        }

        const postId = toBase64URL(insertedPost.id);

        const card = feed.locator(`[data-canvas-id="${postId}"]`).first();

        const appear = await waitForObservedAppearance(page, postId);

        await expect(card).toBeVisible({ timeout: 180_000 });

        const readyAt = await waitForContentReady(page, postId, insertedMessage);
        expect(readyAt).not.toBeNull();
        if (readyAt == null) return;

        const heightAtReady = await getCardHeight(page, postId);
        await page.waitForTimeout(HEIGHT_STABILITY_WAIT_MS);
        const heightLater = await getCardHeight(page, postId);

        const metricsInsert = {
            postId,
            insertedMessage,
            appearedAt: appear.appeared,
            heightAtAppearPx: appear.heightAtAppearPx,
            contentReadyAt: readyAt,
            contentGapMs: readyAt - appear.appeared,
            heightAtReadyPx: heightAtReady,
            heightAfterWaitPx: heightLater,
            heightDeltaAppearToReadyPx:
                heightAtReady == null
                    ? null
                    : heightAtReady - appear.heightAtAppearPx,
            heightDeltaReadyToLaterPx:
                heightLater == null || heightAtReady == null
                    ? null
                    : heightLater - heightAtReady,
        };

        await testInfo.attach("metrics:insert", {
            body: Buffer.from(JSON.stringify(metricsInsert, null, 2), "utf8"),
            contentType: "application/json",
        });

        const timelineInsert = await page.evaluate(
            () => (window as any).__E2E_RENDER_GUARD__?.timeline ?? []
        );
        await testInfo.attach("timeline:insert", {
            body: Buffer.from(JSON.stringify(timelineInsert, null, 2), "utf8"),
            contentType: "application/json",
        });

        if (metricsInsert.contentGapMs >= MAX_CONTAINER_TO_CONTENT_MS) {
            throw new Error(
                `Content appeared ${metricsInsert.contentGapMs.toFixed(
                    0
                )}ms after container (max ${MAX_CONTAINER_TO_CONTENT_MS}ms)`
            );
        }

        if (
            metricsInsert.heightDeltaAppearToReadyPx != null &&
            Math.abs(metricsInsert.heightDeltaAppearToReadyPx) >
                MAX_HEIGHT_DELTA_PX
        ) {
            throw new Error(
                `Card height changed by ${metricsInsert.heightDeltaAppearToReadyPx.toFixed(
                    1
                )}px between container and content (max ±${MAX_HEIGHT_DELTA_PX}px)`
            );
        }

        if (
            metricsInsert.heightDeltaReadyToLaterPx != null &&
            Math.abs(metricsInsert.heightDeltaReadyToLaterPx) >
                MAX_HEIGHT_DELTA_PX
        ) {
            throw new Error(
                `Card height changed by ${metricsInsert.heightDeltaReadyToLaterPx.toFixed(
                    1
                )}px after content ready (max ±${MAX_HEIGHT_DELTA_PX}px)`
            );
        }

        await expect(card.getByText(insertedMessage, { exact: true })).toBeVisible(
            { timeout: 30_000 }
        );

        // Reload and assert we don't regress into "empty shell then content" on re-hydration.
        await page.reload();
        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });
        await expect(card).toBeVisible({ timeout: 180_000 });

        const appearReload = await waitForObservedAppearance(page, postId);
        const readyReloadAt = await waitForContentReady(
            page,
            postId,
            insertedMessage
        );
        expect(readyReloadAt).not.toBeNull();
        if (readyReloadAt == null) return;

        const heightReloadAtReady = await getCardHeight(page, postId);
        await page.waitForTimeout(HEIGHT_STABILITY_WAIT_MS);
        const heightReloadLater = await getCardHeight(page, postId);

        const metricsReload = {
            postId,
            insertedMessage,
            appearedAt: appearReload.appeared,
            heightAtAppearPx: appearReload.heightAtAppearPx,
            contentReadyAt: readyReloadAt,
            contentGapMs: readyReloadAt - appearReload.appeared,
            heightAtReadyPx: heightReloadAtReady,
            heightAfterWaitPx: heightReloadLater,
            heightDeltaAppearToReadyPx:
                heightReloadAtReady == null
                    ? null
                    : heightReloadAtReady - appearReload.heightAtAppearPx,
            heightDeltaReadyToLaterPx:
                heightReloadLater == null || heightReloadAtReady == null
                    ? null
                    : heightReloadLater - heightReloadAtReady,
        };

        await testInfo.attach("metrics:reload", {
            body: Buffer.from(JSON.stringify(metricsReload, null, 2), "utf8"),
            contentType: "application/json",
        });

        const timelineReload = await page.evaluate(
            () => (window as any).__E2E_RENDER_GUARD__?.timeline ?? []
        );
        await testInfo.attach("timeline:reload", {
            body: Buffer.from(JSON.stringify(timelineReload, null, 2), "utf8"),
            contentType: "application/json",
        });

        if (metricsReload.contentGapMs >= MAX_CONTAINER_TO_CONTENT_MS) {
            throw new Error(
                `After reload: content appeared ${metricsReload.contentGapMs.toFixed(
                    0
                )}ms after container (max ${MAX_CONTAINER_TO_CONTENT_MS}ms)`
            );
        }

        if (
            metricsReload.heightDeltaAppearToReadyPx != null &&
            Math.abs(metricsReload.heightDeltaAppearToReadyPx) >
                MAX_HEIGHT_DELTA_PX
        ) {
            throw new Error(
                `After reload: card height changed by ${metricsReload.heightDeltaAppearToReadyPx.toFixed(
                    1
                )}px between container and content (max ±${MAX_HEIGHT_DELTA_PX}px)`
            );
        }

        if (
            metricsReload.heightDeltaReadyToLaterPx != null &&
            Math.abs(metricsReload.heightDeltaReadyToLaterPx) >
                MAX_HEIGHT_DELTA_PX
        ) {
            throw new Error(
                `After reload: card height changed by ${metricsReload.heightDeltaReadyToLaterPx.toFixed(
                    1
                )}px after content ready (max ±${MAX_HEIGHT_DELTA_PX}px)`
            );
        }
    });
});

