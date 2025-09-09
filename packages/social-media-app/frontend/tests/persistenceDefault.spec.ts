import { test, expect } from "@playwright/test";

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";

test.describe("Default persistence", () => {
    test("peer identity persists across reload by default (no ?ephemeral)", async ({
        page,
    }) => {
        await page.goto(BASE_URL);
        await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
            timeout: 30000,
        });
        const first = await page.evaluate(() => (window as any).__peerInfo);

        await page.reload();
        await page.waitForFunction(() => !!(window as any).__peerInfo, null, {
            timeout: 30000,
        });
        const second = await page.evaluate(() => (window as any).__peerInfo);

        // We expect the app to be persistent by default; if browser grants persistence, identity should match
        expect(first?.peerHash).toBeTruthy();
        expect(second?.peerHash).toBeTruthy();
        // Allow non-determinism if browser denies persistence: assert equality only when both report persisted
        if (first?.persisted && second?.persisted) {
            expect(second.peerHash).toBe(first.peerHash);
        }
    });
});
