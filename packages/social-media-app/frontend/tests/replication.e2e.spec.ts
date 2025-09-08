import { test, expect } from "./fixtures/persistentContext";
import { startReplicator } from "./replicator/replicatorNode";

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";

test.describe("Replication via node replicator relay", () => {
    let stop: (() => Promise<void>) | undefined;
    let bootstrap: string[] | undefined;

    test.beforeEach(async () => {
        const { client, addrs } = await startReplicator();
        bootstrap = addrs.map((a) => a.toString());
        stop = async () => {
            try {
                await client.stop();
            } catch {}
        };
    });

    test.afterEach(async () => {
        if (stop) await stop();
        stop = undefined;
        bootstrap = undefined;
    });

    test("post, reload (new client), still see message from replicator", async ({
        page,
    }) => {
        const url = `${BASE_URL}?ephemeral=true&bootstrap=${encodeURIComponent(
            (bootstrap || []).join(",")
        )}`;
        await page.goto(url);

        const toolbar = page.getByTestId("toolbarcreatenew").first();
        const textArea = toolbar.locator("textarea");
        await expect(textArea).toBeVisible({ timeout: 10000 });
        const msg = `Replicated ${Date.now()}`;
        await textArea.fill(msg);

        // Publish the message so it is stored in the public scope replicated by the node
        await toolbar.getByTestId("send-button").click();
        await page.waitForTimeout(3000);

        await page.reload();

        // Expect the published message to be visible on the page (fetched from replicator)
        await expect(page.getByText(msg, { exact: true })).toBeVisible({
            timeout: 20000,
        });
    });
});
