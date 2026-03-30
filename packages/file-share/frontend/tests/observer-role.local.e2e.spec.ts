import { expect, test, type Page } from "@playwright/test";
import { startBootstrapPeer } from "./bootstrapPeer";
import { createSpace, rootUrl, withBootstrap } from "./helpers";

const waitForTestHooks = async (page: Page) => {
    await page.waitForFunction(
        () =>
            Boolean(
                (window as any).__peerbitFileShareTestHooks?.setReplicationRole
            ),
        undefined,
        { timeout: 180_000 }
    );
};

const setReplicationRole = async (page: Page, role: unknown) => {
    await page.evaluate(async (roleOptions) => {
        const hooks = (window as any).__peerbitFileShareTestHooks;
        if (!hooks?.setReplicationRole) {
            throw new Error("Missing __peerbitFileShareTestHooks.setReplicationRole");
        }
        await hooks.setReplicationRole(roleOptions);
    }, role);
};

const getDiagnostics = async (page: Page) => {
    return await page.evaluate(async () => {
        const hooks = (window as any).__peerbitFileShareTestHooks;
        if (!hooks?.getDiagnostics) {
            throw new Error("Missing __peerbitFileShareTestHooks.getDiagnostics");
        }
        return await hooks.getDiagnostics();
    });
};

test.describe("file-share observer role", () => {
    test("observer mode disables persistent chunk reads", async ({
        browser,
        baseURL,
    }) => {
        test.setTimeout(10 * 60 * 1000);
        if (!baseURL) {
            throw new Error("Missing baseURL");
        }

        const bootstrap = await startBootstrapPeer();
        const writerContext = await browser.newContext();
        const readerContext = await browser.newContext();
        const writer = await writerContext.newPage();
        const reader = await readerContext.newPage();

        try {
            const entryUrl = withBootstrap(rootUrl(baseURL), bootstrap.addrs);
            const shareUrl = await createSpace(
                writer,
                entryUrl,
                `observer-role-space-${Date.now()}`
            );

            await reader.goto(shareUrl, { waitUntil: "domcontentloaded" });
            await waitForTestHooks(reader);

            await setReplicationRole(reader, false);

            await expect
                .poll(async () => {
                    const diagnostics = await getDiagnostics(reader);
                    return diagnostics.persistChunkReads;
                })
                .toBe(false);
        } finally {
            await writerContext.close().catch(() => {});
            await readerContext.close().catch(() => {});
            await bootstrap.stop().catch(() => {});
        }
    });
});
