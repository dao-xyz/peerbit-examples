import { expect, type Page } from "@playwright/test";

export function rootUrl(baseURL: string): string {
    return `${baseURL.replace(/\/$/, "")}/#/`;
}

export function withBootstrap(baseURL: string, addrs: string[]): string {
    const url = new URL(baseURL.replace(/#.*$/, ""));
    url.searchParams.set("bootstrap", addrs.join(","));
    url.hash = "/";
    return url.toString();
}

export async function createSpace(
    page: Page,
    url: string,
    name: string
): Promise<string> {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Type a name").fill(name);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/#\/s\//, { timeout: 180_000 });
    await page
        .getByText("Copy the URL to share all files")
        .waitFor({ timeout: 180_000 });
    return page.url();
}

export async function getSeederCount(page: Page): Promise<number> {
    const label = page.locator("span", { hasText: "Seeders:" }).first();
    await expect(label).toBeVisible({ timeout: 60_000 });
    const text = (await label.innerText()).replace(/\s+/g, " ");
    const match = text.match(/Seeders:\s*(\d+)/i);
    if (!match) {
        throw new Error(`Could not parse seeder count from "${text}"`);
    }
    return Number.parseInt(match[1], 10);
}

export async function expectSeeders(
    page: Page,
    expected: number,
    timeout = 120_000
) {
    await expect
        .poll(async () => getSeederCount(page), {
            timeout,
            message: `Expected seeder count to become ${expected}`,
        })
        .toBe(expected);
}

export async function expectSeedersAtLeast(
    page: Page,
    expected: number,
    timeout = 120_000
) {
    await expect
        .poll(async () => getSeederCount(page), {
            timeout,
            message: `Expected seeder count to reach at least ${expected}`,
        })
        .toBeGreaterThanOrEqual(expected);
}

export async function uploadSyntheticFile(
    page: Page,
    fileName: string,
    sizeMb: number
) {
    await page.locator("#imgupload").setInputFiles({
        name: fileName,
        mimeType: "application/octet-stream",
        buffer: Buffer.alloc(sizeMb * 1024 * 1024, 7),
    });
}

export async function waitForFileListed(
    page: Page,
    fileName: string,
    timeout = 180_000
) {
    await page
        .locator("li", { hasText: fileName })
        .first()
        .waitFor({ timeout });
}
