import { chromium, test as base } from "@playwright/test";

export const test = base.extend({
    context: async ({}, use, testInfo) => {
        // Create a unique user data dir per test to prevent cross-test session collisions
        const userDataDir = testInfo.outputPath("user-data");
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: true,
            viewport: { width: 1280, height: 800 },
            args: ["--enable-features=FileSystemAccessAPI"],
        });
        await use(context);
        await context.close();
    },
    page: async ({ context }, use) => {
        const page = await context.newPage();
        await use(page);
    },
});

export const expect = test.expect;
