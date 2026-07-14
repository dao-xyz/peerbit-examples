import { expect, test } from "@playwright/test";

test.describe("account auth disabled", () => {
    test.skip(
        process.env.VITE_SUPABASE_AUTH_ENABLED === "true",
        "This smoke covers builds where account auth is disabled."
    );

    test("hides account UI, redirects auth routes, and makes no Supabase requests", async ({
        page,
    }) => {
        test.setTimeout(120_000);
        const supabaseRequests: string[] = [];
        page.on("request", (request) => {
            const url = new URL(request.url());
            if (
                url.hostname.endsWith(".supabase.co") ||
                url.hostname.endsWith(".supabase.in")
            ) {
                supabaseRequests.push(request.url());
            }
        });

        await page.goto("/?ephemeral=true&bootstrap=offline#/auth");
        await expect(page).toHaveURL(/#\/$/, { timeout: 120_000 });
        await expect(page.getByLabel("Email")).toHaveCount(0);

        const profile = page.getByTestId("header-profile-area");
        await expect(profile).toBeVisible({ timeout: 120_000 });
        await profile.locator("button").first().click();
        await expect(
            page.getByRole("menuitem", { name: /^(?:Sign in|Account)$/ })
        ).toHaveCount(0);
        expect(supabaseRequests).toEqual([]);
    });
});
