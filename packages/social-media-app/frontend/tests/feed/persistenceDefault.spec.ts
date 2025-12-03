import { test, expect } from "../fixtures/persistentContext";
import { OFFLINE_BASE, withSearchParams } from "../utils/url";
import { expectPersistent } from "../utils/persistence";

test.describe("Default persistence", () => {
    test("peer identity persists across reload by default (no ?ephemeral)", async ({
        page,
    }) => {
        await page.goto(withSearchParams(OFFLINE_BASE, { ephemeral: false }));
        await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
            timeout: 3e4,
        });
        await expectPersistent(page);

        const first = await page.evaluate(() => (window as any).__peerInfo);

        await page.reload();
        await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
            timeout: 30000,
        });
        const second = await page.evaluate(() => (window as any).__peerInfo);

        // We expect the app to be persistent by default; if browser grants persistence, identity should match
        expect(first?.peerHash).toBeTruthy();
        expect(second?.peerHash).toBeTruthy();
        expect(second.peerHash).toBe(first.peerHash);
    });
});
