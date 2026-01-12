import { test, expect } from "@playwright/test";
import { withSearchParams } from "../utils/url";
import { setupConsoleCapture } from "../utils/consoleCapture";
import {
    seedReplicatorPosts,
    startReplicator,
} from "../replicator/replicatorNode";
import { sha256Sync, toBase64URL } from "@peerbit/crypto";
import {
    Canvas,
    Element as CanvasElement,
    Layout,
    LOWEST_QUALITY,
    ReplyKind,
    Scope,
    StaticContent,
    StaticImage,
} from "@giga-app/interface";
import type { Peerbit } from "peerbit";

const BASE_HTTP = process.env.BASE_URL || "http://localhost:5190";

const MAX_CONTAINER_TO_CONTENT_MS = Number(
    process.env.PW_FEED_MAX_CONTAINER_TO_CONTENT_MS ||
        (process.env.CI ? "1500" : "750")
);
const MAX_CONTAINER_TO_IMAGE_MS = Number(
    process.env.PW_FEED_MAX_CONTAINER_TO_IMAGE_MS ||
        (process.env.CI ? "2000" : "1000")
);
const MAX_HEIGHT_DELTA_PX = Number(
    process.env.PW_FEED_MAX_HEIGHT_DELTA_PX || "12"
);
const HEIGHT_STABILITY_WAIT_MS = Number(
    process.env.PW_FEED_HEIGHT_STABILITY_WAIT_MS || "1250"
);

const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

async function installE2EFlags(page: any) {
    await page.addInitScript(() => {
        try {
            localStorage.setItem("debug", "false");
            // Avoid the "Quick session / Posting as guest" modal blocking publish in e2e.
            localStorage.setItem("giga.identity.notice.guest.v1", "true");
            localStorage.setItem("giga.identity.notice.temporary.v1", "true");
        } catch {}
    });
}

async function installRenderGuard(page: any) {
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

        const isVisible = (el: Element) => {
            const node = el as HTMLElement;
            const style = window.getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden")
                return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };

        const scan = () => {
            // Only track cards in the feed view; detail views also render a
            // `data-canvas-id` container, which would break back/forward tests.
            const feed = document.querySelector('[data-testid="feed"]');
            if (!feed) return;
            const nodes = Array.from(feed.querySelectorAll("[data-canvas-id]"));
            for (const node of nodes) {
                if (!isVisible(node)) continue;
                const el = node as HTMLElement;
                const id = el.getAttribute("data-canvas-id");
                if (!id) continue;
                if (state.appear[id]) continue;
                state.appear[id] = {
                    appeared: now(),
                    heightAtAppearPx: el.getBoundingClientRect().height,
                };
                pushTL({
                    phase: "container:visible",
                    id,
                    height: state.appear[id].heightAtAppearPx,
                });
            }
        };

        const obs = new MutationObserver(scan);

        // On some PW navigations the init script can run before `document.body` exists.
        // Observing `document` avoids a hard failure and still captures mutations.
        obs.observe(document, {
            childList: true,
            subtree: true,
            attributes: true,
        });
        setInterval(scan, 50);
        scan();
        pushTL({ phase: "observer:installed" });
    });
}

async function seedReplicatorImagePosts(options: {
    client: Peerbit;
    scope: Scope;
    root: Canvas;
    count: number;
    prefix?: string;
    delayMs?: number;
}) {
    const { client, scope, root, count, prefix, delayMs } = options;
    const buffer = Buffer.from(PNG_BASE64, "base64");
    const bytes = new Uint8Array(buffer);

    const posts: Canvas[] = [];
    const alts: string[] = [];

    await scope.suppressReindex(async () => {
        for (let i = 0; i < count; i++) {
            const alt = `${prefix ?? "E2E image"} ${i}.png`;

            const draft = new Canvas({
                publicKey: client.identity.publicKey,
                selfScope: scope,
            });
            const post = await scope.openWithSameSettings(draft);

            await post.elements.put(
                new CanvasElement({
                    content: new StaticContent({
                        content: new StaticImage({
                            data: bytes,
                            mimeType: "image/png",
                            width: 1,
                            height: 1,
                            alt,
                        }),
                        contentId: sha256Sync(bytes),
                        quality: LOWEST_QUALITY,
                    }),
                    canvasId: post.id,
                    location: Layout.zero(),
                    publicKey: client.identity.publicKey,
                })
            );

            // Ensure parent link exists before the first replies.put so the indexed row includes correct path/kind.
            await root.addReply(post, new ReplyKind(), "both");
            await scope.replies.put(post);

            posts.push(post);
            alts.push(alt);

            if (delayMs && i < count - 1) {
                await new Promise((r) => setTimeout(r, delayMs));
            }
        }
    });

    return { posts, alts };
}

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

async function waitForImageReady(page: any, id: string, alt: string) {
    return (await page.evaluate(
        async ({ id, alt }: { id: string; alt: string }) => {
            const now = () =>
                typeof performance !== "undefined" && performance.now
                    ? performance.now()
                    : Date.now();
            const start = now();
            while (now() - start < 20_000) {
                const el = document.querySelector(`[data-canvas-id="${id}"]`);
                if (el) {
                    const img = Array.from(el.querySelectorAll("img")).find(
                        (node) =>
                            node.getAttribute("alt") === alt &&
                            (node.getAttribute("src") || "").startsWith("blob:")
                    ) as HTMLImageElement | undefined;

                    if (
                        img &&
                        img.complete &&
                        img.naturalWidth > 0 &&
                        img.naturalHeight > 0 &&
                        img.getBoundingClientRect().height > 0
                    ) {
                        try {
                            (window as any).__E2E_RENDER_GUARD__?.timeline?.push(
                                {
                                    t: now(),
                                    phase: "image:ready",
                                    id,
                                    alt,
                                    src: img.currentSrc || img.src,
                                    w: img.naturalWidth,
                                    h: img.naturalHeight,
                                }
                            );
                        } catch {}
                        return now();
                    }
                }
                await new Promise((r) => setTimeout(r, 50));
            }
            return null;
        },
        { id, alt }
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
        await installE2EFlags(page);
        await installRenderGuard(page);

        setupConsoleCapture(page, testInfo, {
            printAll: false,
            capturePageErrors: true,
        });

        if (!client) throw new Error("Missing replicator client");
        if (!scope) throw new Error("Missing replicator scope");

        // Seed one baseline post up-front so we can confirm the browser has
        // actually connected to the replicator before testing live insertion.
        const prefixBase = `E2E-RenderGating-${Date.now()}`;
        const baseline = await seedReplicatorPosts({
            client,
            scope,
            count: 1,
            prefix: `${prefixBase}-baseline`,
        });
        const baselinePost = baseline.posts?.[0];
        const baselineMessage = baseline.messages?.[0];
        if (!baselinePost || !baselineMessage) {
            throw new Error("Failed to seed baseline post via replicator");
        }
        const baselineId = toBase64URL(baselinePost.id);

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

        // Confirm the feed is connected by waiting for the baseline post to appear.
        await expect(feed.locator(`[data-canvas-id="${baselineId}"]`).first()).toBeVisible({
            timeout: 180_000,
        });
        await expect(feed.getByText(baselineMessage, { exact: true })).toBeVisible({
            timeout: 180_000,
        });

        // Now insert the post we want to measure while the feed is already "hot".
        const seeded = await seedReplicatorPosts({
            client,
            scope,
            count: 1,
            prefix: `${prefixBase}-insert`,
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

    test("replicator insertion + reload: image content/height ready when container appears", async ({
        page,
    }, testInfo) => {
        await installE2EFlags(page);
        await installRenderGuard(page);

        setupConsoleCapture(page, testInfo, {
            printAll: false,
            capturePageErrors: true,
        });

        if (!client) throw new Error("Missing replicator client");
        if (!scope) throw new Error("Missing replicator scope");

        // Seed one baseline post so we can confirm the browser is connected to the replicator.
        const prefixBase = `E2E-RenderGatingImage-${Date.now()}`;
        const baseline = await seedReplicatorPosts({
            client,
            scope,
            count: 1,
            prefix: `${prefixBase}-baseline`,
        });
        const baselinePost = baseline.posts?.[0];
        const baselineMessage = baseline.messages?.[0];
        if (!baselinePost || !baselineMessage) {
            throw new Error("Failed to seed baseline post via replicator");
        }
        const baselineId = toBase64URL(baselinePost.id);

        const url = withSearchParams(`${BASE_HTTP}#/?v=feed&s=new`, {
            ephemeral: true,
            bootstrap: (bootstrap || []).join(","),
        });

        await page.goto(url);

        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });
        const feed = page.getByTestId("feed");

        await expect(feed.locator(`[data-canvas-id="${baselineId}"]`).first()).toBeVisible({
            timeout: 180_000,
        });
        await expect(feed.getByText(baselineMessage, { exact: true })).toBeVisible({
            timeout: 180_000,
        });

        // Insert the image post we want to measure while the feed is already "hot".
        const seeded = await seedReplicatorImagePosts({
            client,
            scope: baseline.scope,
            root: baseline.root,
            count: 1,
            prefix: `${prefixBase}-insert`,
        });

        const insertedPost = seeded.posts?.[0];
        const imageAlt = seeded.alts?.[0];
        if (!insertedPost || !imageAlt) {
            throw new Error("Failed to insert image post via replicator");
        }

        const postId = toBase64URL(insertedPost.id);
        const card = feed.locator(`[data-canvas-id="${postId}"]`).first();

        const appear = await waitForObservedAppearance(page, postId);
        await expect(card).toBeVisible({ timeout: 180_000 });

        const imageReadyAt = await waitForImageReady(page, postId, imageAlt);
        expect(imageReadyAt).not.toBeNull();
        if (imageReadyAt == null) return;

        const heightAtReady = await getCardHeight(page, postId);
        await page.waitForTimeout(HEIGHT_STABILITY_WAIT_MS);
        const heightLater = await getCardHeight(page, postId);

        const metricsInsert = {
            postId,
            imageAlt,
            appearedAt: appear.appeared,
            heightAtAppearPx: appear.heightAtAppearPx,
            imageReadyAt,
            imageGapMs: imageReadyAt - appear.appeared,
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

        await testInfo.attach("metrics:image-insert", {
            body: Buffer.from(JSON.stringify(metricsInsert, null, 2), "utf8"),
            contentType: "application/json",
        });

        const timelineInsert = await page.evaluate(
            () => (window as any).__E2E_RENDER_GUARD__?.timeline ?? []
        );
        await testInfo.attach("timeline:image-insert", {
            body: Buffer.from(JSON.stringify(timelineInsert, null, 2), "utf8"),
            contentType: "application/json",
        });

        if (metricsInsert.imageGapMs >= MAX_CONTAINER_TO_IMAGE_MS) {
            throw new Error(
                `Image appeared ${metricsInsert.imageGapMs.toFixed(
                    0
                )}ms after container (max ${MAX_CONTAINER_TO_IMAGE_MS}ms)`
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
                )}px between container and image (max ±${MAX_HEIGHT_DELTA_PX}px)`
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
                )}px after image ready (max ±${MAX_HEIGHT_DELTA_PX}px)`
            );
        }

        await expect(card.getByRole("img", { name: imageAlt }).first()).toBeVisible(
            { timeout: 30_000 }
        );

        // Reload and assert we don't regress into "empty shell then image" on re-hydration.
        await page.reload();
        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });
        await expect(card).toBeVisible({ timeout: 180_000 });

        const appearReload = await waitForObservedAppearance(page, postId);
        const imageReadyReloadAt = await waitForImageReady(
            page,
            postId,
            imageAlt
        );
        expect(imageReadyReloadAt).not.toBeNull();
        if (imageReadyReloadAt == null) return;

        const heightReloadAtReady = await getCardHeight(page, postId);
        await page.waitForTimeout(HEIGHT_STABILITY_WAIT_MS);
        const heightReloadLater = await getCardHeight(page, postId);

        const metricsReload = {
            postId,
            imageAlt,
            appearedAt: appearReload.appeared,
            heightAtAppearPx: appearReload.heightAtAppearPx,
            imageReadyAt: imageReadyReloadAt,
            imageGapMs: imageReadyReloadAt - appearReload.appeared,
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

        await testInfo.attach("metrics:image-reload", {
            body: Buffer.from(JSON.stringify(metricsReload, null, 2), "utf8"),
            contentType: "application/json",
        });

        const timelineReload = await page.evaluate(
            () => (window as any).__E2E_RENDER_GUARD__?.timeline ?? []
        );
        await testInfo.attach("timeline:image-reload", {
            body: Buffer.from(JSON.stringify(timelineReload, null, 2), "utf8"),
            contentType: "application/json",
        });

        if (metricsReload.imageGapMs >= MAX_CONTAINER_TO_IMAGE_MS) {
            throw new Error(
                `After reload: image appeared ${metricsReload.imageGapMs.toFixed(
                    0
                )}ms after container (max ${MAX_CONTAINER_TO_IMAGE_MS}ms)`
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
                )}px between container and image (max ±${MAX_HEIGHT_DELTA_PX}px)`
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
                )}px after image ready (max ±${MAX_HEIGHT_DELTA_PX}px)`
            );
        }
    });

    test("back navigation: content/height ready when feed card appears", async ({
        page,
    }, testInfo) => {
        await installE2EFlags(page);
        await installRenderGuard(page);

        setupConsoleCapture(page, testInfo, {
            printAll: false,
            capturePageErrors: true,
        });

        if (!client) throw new Error("Missing replicator client");
        if (!scope) throw new Error("Missing replicator scope");

        const prefixBase = `E2E-RenderGatingBack-${Date.now()}`;
        const seeded = await seedReplicatorPosts({
            client,
            scope,
            count: 25,
            prefix: prefixBase,
        });
        const newestMsg = seeded.messages?.at(-1);
        if (!newestMsg) throw new Error("Failed to seed posts via replicator");

        const url = withSearchParams(`${BASE_HTTP}#/?v=feed&s=new`, {
            ephemeral: true,
            bootstrap: (bootstrap || []).join(","),
        });

        await page.goto(url);

        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });
        const feed = page.getByTestId("feed");

        // Confirm the feed is connected by waiting for the newest seeded post to appear.
        await expect(feed.getByText(newestMsg, { exact: true })).toBeVisible({
            timeout: 180_000,
        });

        const targetPost = seeded.posts?.[0];
        const targetMessage = seeded.messages?.[0];
        if (!targetPost || !targetMessage) {
            throw new Error("Missing target seeded post");
        }
        const postId = toBase64URL(targetPost.id);
        const card = feed.locator(`[data-canvas-id="${postId}"]`).first();

        // Scroll until the older target post is actually in the DOM (triggering loadMore),
        // and ensure we leave the top of the feed so snapshot restoration is exercised.
        const cardWithText = feed
            .locator("[data-canvas-id]")
            .filter({ hasText: targetMessage })
            .first();
        const t0 = Date.now();
        while ((await cardWithText.count()) === 0) {
            await page.evaluate(() => {
                window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
            });
            await page.waitForTimeout(250);
            if (Date.now() - t0 > 180_000) {
                throw new Error(
                    `Timed out waiting for target post to load: "${targetMessage}"`
                );
            }
        }

        await cardWithText.scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        await expect(
            cardWithText.getByText(targetMessage, { exact: true })
        ).toBeVisible({ timeout: 180_000 });

        // Open the post (avoid clicking markdown/text elements which are non-navigating).
        await cardWithText
            .getByTestId("open-post")
            .evaluate((el) => (el as HTMLElement).click());
        await expect(page).toHaveURL(/#\/c\//, { timeout: 30_000 });

        // Reset the feed-appearance marker for this card so we can measure the back navigation.
        await page.evaluate((id: string) => {
            const now = () =>
                typeof performance !== "undefined" && performance.now
                    ? performance.now()
                    : Date.now();
            const guard: any = (window as any).__E2E_RENDER_GUARD__;
            if (!guard) return;
            if (guard.appear) {
                delete guard.appear[id];
            }
            try {
                guard.timeline?.push({ t: now(), phase: "appear:reset", id });
            } catch {}
        }, postId);

        // Back to feed via the in-app back button.
        await page.getByTestId("nav-back").click();
        await expect(feed).toBeVisible({ timeout: 60_000 });

        const appear = await waitForObservedAppearance(page, postId);
        await expect(card).toBeVisible({ timeout: 180_000 });

        const readyAt = await waitForContentReady(page, postId, targetMessage);
        expect(readyAt).not.toBeNull();
        if (readyAt == null) return;

        const heightAtReady = await getCardHeight(page, postId);
        await page.waitForTimeout(HEIGHT_STABILITY_WAIT_MS);
        const heightLater = await getCardHeight(page, postId);

        const metricsBack = {
            postId,
            targetMessage,
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

        await testInfo.attach("metrics:back", {
            body: Buffer.from(JSON.stringify(metricsBack, null, 2), "utf8"),
            contentType: "application/json",
        });

        const timelineBack = await page.evaluate(
            () => (window as any).__E2E_RENDER_GUARD__?.timeline ?? []
        );
        await testInfo.attach("timeline:back", {
            body: Buffer.from(JSON.stringify(timelineBack, null, 2), "utf8"),
            contentType: "application/json",
        });

        if (metricsBack.contentGapMs >= MAX_CONTAINER_TO_CONTENT_MS) {
            throw new Error(
                `After back: content appeared ${metricsBack.contentGapMs.toFixed(
                    0
                )}ms after container (max ${MAX_CONTAINER_TO_CONTENT_MS}ms)`
            );
        }

        if (
            metricsBack.heightDeltaAppearToReadyPx != null &&
            Math.abs(metricsBack.heightDeltaAppearToReadyPx) >
                MAX_HEIGHT_DELTA_PX
        ) {
            throw new Error(
                `After back: card height changed by ${metricsBack.heightDeltaAppearToReadyPx.toFixed(
                    1
                )}px between container and content (max ±${MAX_HEIGHT_DELTA_PX}px)`
            );
        }

        if (
            metricsBack.heightDeltaReadyToLaterPx != null &&
            Math.abs(metricsBack.heightDeltaReadyToLaterPx) >
                MAX_HEIGHT_DELTA_PX
        ) {
            throw new Error(
                `After back: card height changed by ${metricsBack.heightDeltaReadyToLaterPx.toFixed(
                    1
                )}px after content ready (max ±${MAX_HEIGHT_DELTA_PX}px)`
            );
        }
    });
});
