import { test, expect } from "@playwright/test";
import { withSearchParams } from "../utils/url";
import { setupConsoleCapture } from "../utils/consoleCapture";
import {
    seedReplicatorPosts,
    startReplicator,
} from "../replicator/replicatorNode";

const BASE_HTTP = process.env.BASE_URL || "http://localhost:5190";

test.describe("Feed direct landing", () => {
    test.setTimeout(300_000);

    let stop: (() => Promise<void>) | undefined;
    let bootstrap: string[] | undefined;
    let prefix: string | undefined;

    test.beforeAll(async () => {
        const { client, addrs, scope } = await startReplicator();
        bootstrap = addrs.map((a) => a.toString());
        prefix = `Landing ${Date.now()}:`;

        await seedReplicatorPosts({ client, scope, count: 25, prefix });

        stop = async () => {
            try {
                await client.stop();
            } catch {}
        };
    });

    test.afterAll(async () => {
        if (stop) await stop();
        stop = undefined;
        bootstrap = undefined;
        prefix = undefined;
    });

    test("direct load #/?v=feed shows posts", async ({ page }, testInfo) => {
        setupConsoleCapture(page, testInfo, {
            printAll: false,
            capturePageErrors: true,
        });

        if (!prefix) throw new Error("Missing seed prefix");

        const url = withSearchParams(`${BASE_HTTP}#/?v=feed&s=new`, {
            ephemeral: true,
            bootstrap: (bootstrap || []).join(","),
        });

        await page.goto(url);

        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 60_000,
        });

        const feed = page.getByTestId("feed");
        await expect(feed.getByText(`${prefix} 24`, { exact: true })).toBeVisible(
            { timeout: 180_000 }
        );
    });
});

