import { test, expect } from "./fixtures/persistentContext";
import { startReplicator } from "./replicator/replicatorNode";
import { withSearchParams } from "./utils/url";

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";

test.describe("Replication via node replicator relay", () => {
    test.setTimeout(30000);
    let stop: (() => Promise<void>) | undefined;
    let bootstrap: string[] | undefined;

    test.beforeEach(async () => {
        const { client, addrs } = await startReplicator();
        bootstrap = addrs.map((a) => a.toString());
        stop = async () => {
            try {
                await client.stop();
            } catch { }
        };
    });

    test.afterEach(async () => {
        if (stop) await stop();
        stop = undefined;
        bootstrap = undefined;
    });

    test.afterAll(async () => {
        if (stop) {
            try {
                await stop();
            } catch { }
        }
        stop = undefined;
        bootstrap = undefined;
    });

    test("post, reload (new client), still see message from replicator", async ({
        page,
    }) => {
        const url = `${BASE_URL}?ephemeral=true&bootstrap=${encodeURIComponent(
            (bootstrap || []).join(",")
        )}`;
        try {
            await page.goto(url);

            const toolbar = page.getByTestId("toolbarcreatenew").first();
            const textArea = toolbar.locator("textarea");
            await expect(textArea).toBeVisible({ timeout: 10000 });
            const msg = `Replicated ${Date.now()}`;
            await textArea.fill(msg);

            // Publish the message so it is stored in the public scope replicated by the node
            await toolbar.getByTestId("send-button").click();

            // wait for the text area to be empty 
            await expect(textArea).toHaveText("", { timeout: 15000 });

            // wait for the message to appear as a message in the feed
            await page.getByText(msg, { exact: true }).waitFor({ timeout: 15000 });

            await page.reload();

            // Expect the published message to be visible on the page (fetched from replicator)
            await expect(page.getByText(msg, { exact: true })).toBeVisible({
                timeout: 15000,
            });
        } finally {
            if (stop) {
                try {
                    await stop();
                } catch { }
                stop = undefined;
            }
        }
    });

    test.skip("measure feed latency for ephemeral browser with node replicator", async ({
        page,
    }, testInfo) => {
        const url = withSearchParams(BASE_URL, {
            ephemeral: "true",
            bootstrap:
                bootstrap && bootstrap.length ? bootstrap.join(",") : undefined,
        });
        try {
            await page.goto(url);

            await page.waitForFunction(
                () => Boolean((window as any).__peerInfo),
                undefined,
                { timeout: 30000 }
            );
            const peerInfo = await page.evaluate(
                () => (window as any).__peerInfo
            );
            console.log("Ephemeral peer info", peerInfo);

            const toolbar = page.getByTestId("toolbarcreatenew").first();
            const textArea = toolbar.locator("textarea");
            await expect(textArea).toBeVisible({ timeout: 10000 });

            const privacyToggle = toolbar.getByLabel("Private");
            if (await privacyToggle.isVisible()) {
                await privacyToggle.click();
                await expect(toolbar.getByLabel("Public")).toBeVisible({
                    timeout: 10000,
                });
            }

            const message = `hello ${Date.now()}`;
            await textArea.fill(message);
            const sendBtn = toolbar.getByTestId("send-button");
            await expect(sendBtn).toBeEnabled({ timeout: 10000 });

            const publishStart = Date.now();
            await sendBtn.click();

            await page.waitForFunction(
                () => {
                    const el = document.querySelector(
                        '[data-testid="toolbarcreatenew"] textarea'
                    ) as HTMLTextAreaElement | null;
                    return !el || el.value === "";
                },
                null,
                { timeout: 20000 }
            );

            const feedMessage = page.getByText(message, { exact: true });
            await feedMessage.waitFor({ timeout: 30000 });
            const latencyMs = Date.now() - publishStart;

            console.log(
                `Feed latency for "${message}" via node replicator: ${latencyMs}ms`
            );
            await testInfo.attach("feed-latency", {
                body: JSON.stringify(
                    {
                        message,
                        latencyMs,
                        bootstrap,
                        peerInfo,
                        url,
                    },
                    null,
                    2
                ),
                contentType: "application/json",
            });

            expect(latencyMs).toBeLessThanOrEqual(30000);
        } finally {
            if (stop) {
                try {
                    await stop();
                } catch { }
                stop = undefined;
            }
        }
    });
});
