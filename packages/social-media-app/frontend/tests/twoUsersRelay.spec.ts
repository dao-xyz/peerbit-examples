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
const DEBUG_FEED = Boolean(
    process.env.PEERBIT_DEBUG_FEED ||
    process.env.DEBUG_FEED ||
    process.env.PEERBIT_DEBUG_ITERATORS
);

const attachConsoleLogging = (page: Page, label: string) => {
    if (!DEBUG_FEED) return () => {};
    const handler = (msg: any) => {
        const text = msg.text?.();
        console.log(`[${label}][${msg.type()}] ${text}`);
    };
    page.on("console", handler);
    return () => page.off("console", handler);
};

async function createSecondUserContext(
    testInfo: TestInfo,
    baseUrl: string,
    opts: { ephemeral: boolean }
): Promise<{ context: BrowserContext; url: string }> {
    const context = await launchPersistentBrowserContext(testInfo, {
        scope: opts.ephemeral ? "user-ephemeral" : "user-replicator",
        baseURL: baseUrl,
    });

    const url = withSearchParams(baseUrl, {
        ...(opts.ephemeral ? { ephemeral: "true" } : {}),
        ...(DEBUG_FEED ? { debugfeed: "1" } : {}),
    });

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
    test.setTimeout(3e4);
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
            ...(DEBUG_FEED ? { debugfeed: "1" } : {}),
        });

    async function runTwoUserFlow(
        primaryPage: Page,
        testInfo: TestInfo,
        opts: { ephemeral: boolean }
    ) {
        const baseAppUrl =
            (testInfo.project.use.baseURL as string | undefined) || BASE_URL;
        const primaryUrl = buildUrl(baseAppUrl, opts);
        if (DEBUG_FEED) {
            await primaryPage.addInitScript(() => {
                (window as any).__PEERBIT_DEBUG__ = true;
            });
        }
        const detachPrimaryConsole = attachConsoleLogging(
            primaryPage,
            "primary"
        );
        await primaryPage.goto(primaryUrl);
        await waitForComposer(primaryPage);
        const toolbar = primaryPage.getByTestId("toolbarcreatenew").first();
        const primaryTextarea = toolbar.locator("textarea");

        const { context: user2Context, url: user2Url } =
            await createSecondUserContext(testInfo, baseAppUrl, opts);
        let detachSecondaryConsole = () => {};
        try {
            const page2 = await user2Context.newPage();
            if (DEBUG_FEED) {
                await page2.addInitScript(() => {
                    (window as any).__PEERBIT_DEBUG__ = true;
                });
                detachSecondaryConsole = attachConsoleLogging(page2, "user2");
            }
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

            const messagePattern = new RegExp(
                message.trim().replace(/\s+/g, "\\s+")
            );
            const locateMessage = () => page2.getByText(messagePattern);
            await expect
                .poll(
                    async () => {
                        const count = await locateMessage().count();
                        if (DEBUG_FEED) {
                            console.log("[user2][log] message-count", {
                                message,
                                count,
                            });
                            if (count === 0) {
                                const presentInDom =
                                    (await page2.evaluate((payload) => {
                                        const normalizedPayload = payload
                                            .trim()
                                            .replace(/\s+/g, " ");
                                        const normalizedBody =
                                            document.body.innerText
                                                ?.replace(/\s+/g, " ")
                                                ?.trim() ?? "";
                                        return normalizedBody.includes(
                                            normalizedPayload
                                        );
                                    }, message)) ?? false;
                                console.log("[user2][log] message-in-body", {
                                    includes: presentInDom,
                                });
                            }
                        }
                        return count;
                    },
                    { timeout: 60_000 }
                )
                .toBeGreaterThan(0);
        } finally {
            detachSecondaryConsole();
            detachPrimaryConsole();
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
