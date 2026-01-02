import { test, expect } from "@playwright/test";
import { setupConsoleCapture } from "../utils/consoleCapture";
import { withSearchParams } from "../utils/url";
import {
    seedReplicatorPosts,
    startReplicator,
} from "../replicator/replicatorNode";

const BASE_HTTP = process.env.BASE_URL || "http://localhost:5173";

test.describe("Bench: Best feed renders 10 posts from 1k (replicator)", () => {
    test.skip(
        process.env.PW_BENCH !== "1",
        "Set PW_BENCH=1 to run bench specs"
    );
    test.setTimeout(300_000);

    let stop: (() => Promise<void>) | undefined;
    let bootstrap: string[] | undefined;
    let lastMessage: string | undefined;

    test.beforeAll(async ({}, testInfo) => {
        const t0 = Date.now();
        const { client, addrs, scope } = await startReplicator();
        bootstrap = addrs.map((a) => a.toString());

        const prefix = `Bench 1k ${Date.now()}:`;
        const seed = await seedReplicatorPosts({
            client,
            scope,
            count: 1000,
            prefix,
        });
        lastMessage = `${prefix} ${seed.messages.length - 1}`;

        stop = async () => {
            try {
                await client.stop();
            } catch {}
        };

        const seedMs = Date.now() - t0;
        // eslint-disable-next-line no-console
        console.log(`[bench] seedReplicatorMs=${seedMs}`);
        await testInfo.attach("bench:seedReplicatorMs", {
            body: Buffer.from(String(seedMs), "utf8"),
            contentType: "text/plain",
        });
    });

    test.afterAll(async () => {
        if (stop) await stop();
        stop = undefined;
        bootstrap = undefined;
        lastMessage = undefined;
    });

    test("time to show 10 Best posts (new ephemeral session)", async ({
        page,
    }, testInfo) => {
        setupConsoleCapture(page, testInfo, {
            // Bench specs can produce a lot of logs; keep memory usage low.
            printAll: false,
            capturePageErrors: true,
        });

        const t0 = Date.now();
        const url = withSearchParams(`${BASE_HTTP}#/?s=best`, {
            ephemeral: true,
            bootstrap: (bootstrap || []).join(","),
        });
        await page.goto(url);

        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });
        const timeToToolbarMs = Date.now() - t0;
        // eslint-disable-next-line no-console
        console.log(`[bench] timeToToolbarMs=${timeToToolbarMs}`);
        await testInfo.attach("bench:timeToToolbarMs", {
            body: Buffer.from(String(timeToToolbarMs), "utf8"),
            contentType: "text/plain",
        });

        const target = lastMessage;
        if (!target) throw new Error("Missing lastMessage from seeding step");
        await expect(
            page.getByTestId("feed").getByText(target, { exact: true })
        ).toBeVisible({ timeout: 180_000 });
        const timeToTopPostMs = Date.now() - t0;
        // eslint-disable-next-line no-console
        console.log(`[bench] timeToTopPostMs=${timeToTopPostMs}`);
        await testInfo.attach("bench:timeToTopPostMs", {
            body: Buffer.from(String(timeToTopPostMs), "utf8"),
            contentType: "text/plain",
        });

        const visibleCards = page
            .getByTestId("feed")
            .locator("[data-canvas-id].visible");
        await expect
            .poll(async () => await visibleCards.count(), { timeout: 180_000 })
            .toBeGreaterThanOrEqual(10);
        const timeTo10VisibleMs = Date.now() - t0;
        // eslint-disable-next-line no-console
        console.log(`[bench] timeTo10VisibleMs=${timeTo10VisibleMs}`);
        await testInfo.attach("bench:timeTo10VisibleMs", {
            body: Buffer.from(String(timeTo10VisibleMs), "utf8"),
            contentType: "text/plain",
        });
    });
});
