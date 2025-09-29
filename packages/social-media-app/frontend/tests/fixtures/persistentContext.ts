import { test as base } from "@playwright/test";

import { launchPersistentBrowserContext } from "../utils/persistentBrowser";

export const test = base.extend({
    context: async ({}, use, testInfo) => {
        const baseURL =
            (testInfo.project.use.baseURL as string | undefined) ||
            process.env.BASE_URL ||
            "http://localhost:5173";

        const context = await launchPersistentBrowserContext(testInfo, {
            scope: "user-data",
            baseURL,
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
