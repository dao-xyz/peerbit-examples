import { chromium, test as base } from "@playwright/test";
// Avoid using __dirname in ESM; just place the user data dir at project root relative path
const USER_DATA_DIR = "./.pw-user-data";

export const test = base.extend({
    context: async ({ }, use) => {
        const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
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
