import {
    type BrowserContext,
    type Page,
    type TestInfo,
} from "@playwright/test";
import { test, expect } from "@playwright/test";
import { withSearchParams } from "./utils/url";
import { startReplicator } from "./replicator/replicatorNode";
import { launchPersistentBrowserContext } from "./utils/persistentBrowser";

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";

async function createSecondUserContext(
    testInfo: TestInfo,
    baseUrl: string,
    opts: { ephemeral: boolean }
): Promise<{ context: BrowserContext; url: string }> {
    const context = await launchPersistentBrowserContext(testInfo, {
        scope: opts.ephemeral ? "user-ephemeral" : "user-replicator",
        baseURL: baseUrl,
    });

    const url = withSearchParams(
        baseUrl,
        opts.ephemeral ? { ephemeral: "true" } : {}
    );

    return { context, url };
}

async function waitForComposer(page: Page) {
    await page.waitForFunction(
        () =>
            typeof (window as any).__peerInfo?.peerHash === "number" ||
            Boolean((window as any).__peerInfo?.peerHash),
        undefined,
        { timeout: 30_000 }
    );
    await expect(
        page.getByTestId("toolbarcreatenew").first().locator("textarea")
    ).toBeVisible({ timeout: 30_000 });
}

// skip for now because peerbit does not support non-persistent node live updates
test.describe("Two users relaying via node replicator", () => {
    test.setTimeout(60_000);
    let bootstrap: string[] = [];
    let stopReplicator: (() => Promise<void>) | undefined;

    test.beforeEach(async () => {
        const { client, addrs } = await startReplicator();
        bootstrap = addrs.map((addr) => addr.toString());
        stopReplicator = async () => {
            try {
                await client.stop();
            } catch {
                /* ignore */
            }
        };
    });

    test.afterEach(async () => {
        if (stopReplicator) {
            await stopReplicator();
            stopReplicator = undefined;
        }
    });

    const buildUrl = (baseUrl: string, opts: { ephemeral: boolean }) =>
        withSearchParams(baseUrl, {
            ...(bootstrap.length ? { bootstrap: bootstrap.join(",") } : {}),
            ...(opts.ephemeral ? { ephemeral: "true" } : {}),
        });

    async function runTwoUserFlow(
        primaryPage: Page,
        testInfo: TestInfo,
        opts: { ephemeral: boolean }
    ) {
        const baseAppUrl =
            (testInfo.project.use.baseURL as string | undefined) || BASE_URL;
        const primaryUrl = buildUrl(baseAppUrl, opts);
        await primaryPage.goto(primaryUrl);
        await waitForComposer(primaryPage);
        const toolbar = primaryPage.getByTestId("toolbarcreatenew").first();
        const primaryTextarea = toolbar.locator("textarea");

        const { context: user2Context, url: user2Url } =
            await createSecondUserContext(testInfo, baseAppUrl, opts);
        try {
            const page2 = await user2Context.newPage();
            const finalUrl = withSearchParams(user2Url, {
                ...(bootstrap.length ? { bootstrap: bootstrap.join(",") } : {}),
            });
            await page2.goto(finalUrl);
            await waitForComposer(page2);

            // Ensure message is shared publicly
            const privacyToggle = toolbar.getByLabel("Private");
            if (await privacyToggle.isVisible()) {
                await privacyToggle.click();
                await expect(toolbar.getByLabel("Public")).toBeVisible({
                    timeout: 10_000,
                });
            }

            const message = `Relay message ${Date.now()}`;
            await primaryTextarea.fill(message);
            await toolbar.getByTestId("send-button").click();

            await expect
                .poll(
                    async () =>
                        await page2.getByText(message, { exact: true }).count(),
                    { timeout: 60_000 }
                )
                .toBeGreaterThan(0);
        } finally {
            await user2Context.close();
        }
    }

    test("both users persisted (replicators)", async ({ page }, testInfo) => {
        await runTwoUserFlow(page, testInfo, { ephemeral: false });
    });

    test("both users ephemeral (non-persistent)", async ({
        page,
    }, testInfo) => {
        await runTwoUserFlow(page, testInfo, { ephemeral: true });
    });
});
