import {
    type BrowserContext,
    type Page,
    type TestInfo,
} from "@playwright/test";
import { test, expect } from "@playwright/test";
import { withSearchParams } from "./utils/url";
import { startReplicator } from "./replicator/replicatorNode";
import {
    closePersistentBrowserContext,
    launchPersistentBrowserContext,
} from "./utils/persistentBrowser";

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
    const toolbar = page.getByTestId("toolbarcreatenew").first();
    await expect(toolbar).toBeVisible({ timeout: 30_000 });
    try {
        await toolbar.getByTestId("composer-textarea").first().click({
            timeout: 1_500,
        });
    } catch {
        // Some runs auto-focus the editor without a click.
    }
    await page.waitForFunction(
        () => {
            const ready = (window as any).__DRAFT_READY;
            const textarea = document.querySelector(
                '[data-testid="toolbarcreatenew"] textarea'
            );
            return !!ready?.draftId && !!textarea;
        },
        undefined,
        { timeout: 30_000 }
    );
    const textbox = toolbar.locator("textarea");
    await expect(textbox).toBeVisible({
        timeout: 30_000,
    });
    return textbox;
}

async function logPageState(page: Page, label: string) {
    try {
        console.log(`[${label}] url`, page.url());
        console.log(
            `[${label}] state`,
            await page.evaluate(() => ({
                readyState: document.readyState,
                search: window.location.search,
                hash: window.location.hash,
                dbgBootstrap: (window as any).__DBG_BOOTSTRAP ?? null,
                peerInfo: (window as any).__peerInfo ?? null,
                bodyText: document.body.innerText?.slice(0, 500) ?? "",
                textboxCount: document.querySelectorAll(
                    '[role="textbox"], textarea, [contenteditable="true"]'
                ).length,
                toolbarCount: document.querySelectorAll(
                    '[data-testid="toolbarcreatenew"]'
                ).length,
                startupPerf: (window as any).__STARTUP_PERF
                    ? {
                          marks: (window as any).__STARTUP_PERF.marks ?? null,
                          data: (window as any).__STARTUP_PERF.data ?? null,
                      }
                    : null,
            }))
        );
    } catch (error) {
        console.log(`[${label}] state-error`, String(error));
    }
}

async function ensurePublicComposer(page: Page) {
    const publicToggle = page.getByLabel("Public").first();
    if (await publicToggle.isVisible().catch(() => false)) {
        return;
    }
    const privateToggle = page.getByLabel("Private").first();
    if (await privateToggle.isVisible().catch(() => false)) {
        await privateToggle.click();
        await expect(page.getByLabel("Public").first()).toBeVisible({
            timeout: 10_000,
        });
    }
}

// skip for now because peerbit does not support non-persistent node live updates
test.describe("Two users relaying via node replicator", () => {
    // This flow launches a node relay plus a second persistent Chromium profile,
    // so a 30s cap is too tight on slower local/CI runs and causes harness timeouts
    // while the second user's composer is still initializing.
    test.setTimeout(90_000);
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
            console.log("[relay-test] primaryUrl", primaryUrl);
            console.log("[relay-test] bootstrap", bootstrap);
        }
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
        if (DEBUG_FEED) {
            console.log("[relay-test] primaryPage.url", primaryPage.url());
            console.log(
                "[relay-test] primary bootstrap state",
                await primaryPage.evaluate(() => ({
                    search: window.location.search,
                    hash: window.location.hash,
                    dbgBootstrap: (window as any).__DBG_BOOTSTRAP ?? null,
                }))
            );
        }
        let primaryTextarea;
        try {
            primaryTextarea = await waitForComposer(primaryPage);
        } catch (error) {
            await logPageState(primaryPage, "primary:waitForComposer");
            throw error;
        }
        const sendButton = primaryPage.getByTestId("send-button").first();

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
            if (DEBUG_FEED) {
                console.log("[relay-test] user2Url", user2Url);
                console.log("[relay-test] finalUrl", finalUrl);
            }
            await page2.goto(finalUrl);
            if (DEBUG_FEED) {
                console.log("[relay-test] page2.url", page2.url());
                console.log(
                    "[relay-test] user2 bootstrap state",
                    await page2.evaluate(() => ({
                        search: window.location.search,
                        hash: window.location.hash,
                        dbgBootstrap: (window as any).__DBG_BOOTSTRAP ?? null,
                    }))
                );
            }
            try {
                await waitForComposer(page2);
            } catch (error) {
                await logPageState(page2, "user2:waitForComposer");
                throw error;
            }

            // Ensure message is shared publicly
            await ensurePublicComposer(primaryPage);

            const message = `Relay message ${Date.now()}`;
            await primaryTextarea.fill(message);
            await sendButton.click();

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
            await closePersistentBrowserContext(user2Context);
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
