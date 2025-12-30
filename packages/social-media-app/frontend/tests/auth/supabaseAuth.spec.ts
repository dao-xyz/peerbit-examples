import { test, expect } from "../fixtures/persistentContext";
import { OFFLINE_BASE } from "../utils/url";
import { launchPersistentBrowserContext } from "../utils/persistentBrowser";

const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

const missingEnv =
    !TEST_EMAIL?.trim() || !TEST_PASSWORD?.trim()
        ? "Set TEST_EMAIL and TEST_PASSWORD in packages/social-media-app/frontend/.env (not VITE_)."
        : undefined;

async function openProfileMenu(page: import("@playwright/test").Page) {
    const area = page.getByTestId("header-profile-area");
    await expect(area).toBeVisible({ timeout: 30_000 });
    // Trigger is the ProfileButton inside header-profile-area
    await area.locator("button").first().click();
}

async function goToAuthFromMenu(page: import("@playwright/test").Page) {
    await openProfileMenu(page);
    const entry = page.getByRole("menuitem", { name: /Sign in|Account/ });
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page).toHaveURL(/#\/auth/);
}

async function signInFromAuthScreen(
    page: import("@playwright/test").Page,
    opts: { email: string; password: string }
) {
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({
        timeout: 30_000,
    });

    // If a previous session exists, sign out first to keep the flow deterministic
    const signOut = page.getByRole("button", { name: "Sign out" });
    if (await signOut.isVisible().catch(() => false)) {
        await signOut.click();
    }

    await page.getByLabel("Email").fill(opts.email);
    await page.getByLabel("Password").fill(opts.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // After sign in, the app navigates back to root and the main UI becomes available.
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeHidden({
        timeout: 30_000,
    });
    await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
        timeout: 30_000,
    });
}

async function dismissMismatchIfPresent(page: import("@playwright/test").Page) {
    const title = page.getByText(/Use saved identity/);
    // The Supabase identity check can resolve slightly after navigation, so give it
    // a short grace window to appear before we decide it's not present.
    await title.waitFor({ state: "visible", timeout: 3_000 }).catch(() => {});
    if (!(await title.isVisible().catch(() => false))) return;
    const btn = page.getByRole("button", { name: "Continue for now" });
    await btn.click();
    await expect(title).toBeHidden({ timeout: 10_000 });
}

test.describe("Supabase auth (session + identity)", () => {
    test.skip(!!missingEnv, missingEnv || "");

    test("sign in, refresh, and reuse session without reload modal", async ({
        page,
    }) => {
        await page.goto(OFFLINE_BASE);
        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 30_000,
        });

        await goToAuthFromMenu(page);
        await signInFromAuthScreen(page, {
            email: TEST_EMAIL!,
            password: TEST_PASSWORD!,
        });

        // If the account already has a saved identity, we may see the mismatch modal.
        await dismissMismatchIfPresent(page);

        await page.reload();

        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 30_000,
        });

        // If the mismatch modal appears after reload, dismiss it so the flow stays deterministic.
        await dismissMismatchIfPresent(page);

        // Verify menu reflects an authenticated session
        await openProfileMenu(page);
        await expect(
            page.getByRole("menuitem", { name: "Account" })
        ).toBeVisible();
    });

    test("reload and switch resolves identity mismatch", async ({
        page,
    }, testInfo) => {
        // Seed: ensure the account has a saved identity in Supabase.
        await page.goto(OFFLINE_BASE);
        await expect(page.getByTestId("toolbarcreatenew").first()).toBeVisible({
            timeout: 30_000,
        });
        await goToAuthFromMenu(page);
        await signInFromAuthScreen(page, {
            email: TEST_EMAIL!,
            password: TEST_PASSWORD!,
        });
        await dismissMismatchIfPresent(page);

        const baseURL =
            (testInfo.project.use.baseURL as string | undefined) ||
            process.env.BASE_URL ||
            "http://localhost:5173";

        // New browser profile => new local Peerbit identity, but same Supabase account.
        const other = await launchPersistentBrowserContext(testInfo, {
            scope: "auth-mismatch",
            baseURL,
        });
        const otherPage = await other.newPage();

        try {
            await otherPage.goto(OFFLINE_BASE);
            await expect(
                otherPage.getByTestId("toolbarcreatenew").first()
            ).toBeVisible({ timeout: 30_000 });

            await goToAuthFromMenu(otherPage);
            await signInFromAuthScreen(otherPage, {
                email: TEST_EMAIL!,
                password: TEST_PASSWORD!,
            });

            const title = otherPage.getByText(/Use saved identity/);
            await expect(title).toBeVisible({ timeout: 30_000 });

            const reloadBtn = otherPage.getByRole("button", {
                name: "Reload and switch",
            });

            await Promise.all([
                otherPage.waitForLoadState("domcontentloaded"),
                reloadBtn.click(),
            ]);

            await expect(
                otherPage.getByTestId("toolbarcreatenew").first()
            ).toBeVisible({ timeout: 30_000 });

            await otherPage.waitForTimeout(2000);
            await expect(otherPage.getByText(/Use saved identity/)).toHaveCount(
                0
            );
        } finally {
            await other.close();
        }
    });
});
