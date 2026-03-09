import { expect, type Page } from "@playwright/test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
    const bytes = sizeMb * 1024 * 1024;
    if (bytes <= 50 * 1024 * 1024) {
        await page.locator("#imgupload").setInputFiles({
            name: fileName,
            mimeType: "application/octet-stream",
            buffer: Buffer.alloc(bytes, 7),
        });
        return;
    }

    const dir = await mkdtemp(path.join(tmpdir(), "peerbit-upload-"));
    const filePath = path.join(dir, fileName);
    await writeFile(filePath, Buffer.alloc(bytes, 7));
    try {
        await page.locator("#imgupload").setInputFiles(filePath);
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
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

export async function waitForUploadComplete(page: Page, timeout = 600_000) {
    const progress = page.locator('[data-testid="upload-progress"], .progress-root');
    if ((await progress.count()) === 0) {
        return;
    }
    await progress.first().waitFor({ state: "hidden", timeout });
}

export async function setSeedMode(page: Page, seeded: boolean) {
    const byTestId = page.getByTestId("seed-toggle");
    const toggle =
        (await byTestId.count())
            ? byTestId
            : page.locator("button", { hasText: "Seed" }).first();
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    const expected = seeded ? "on" : "off";
    const current = await toggle.getAttribute("data-state");
    if (current !== expected) {
        await toggle.click();
    }
    await expect(toggle).toHaveAttribute("data-state", expected);
}

export async function expectDownloadedFile(
    page: Page,
    fileName: string,
    expectedSizeMb: number,
    timeout = 8 * 60 * 1000
) {
    const row = page.locator("li", { hasText: fileName }).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    const byTestId = row.getByTestId("download-file");
    const button =
        (await byTestId.count()) > 0 ? byTestId : row.locator("button").first();

    const ignoreTimeout = <T>(promise: Promise<T>) =>
        promise.catch((error: any) => {
            if (
                error?.name === "TimeoutError" ||
                /Timeout .* exceeded/i.test(String(error?.message || ""))
            ) {
                return new Promise<T>(() => {});
            }
            throw error;
        });

    const downloadPromise = page.waitForEvent("download", { timeout });
    const dialogFailure = ignoreTimeout(
        page.waitForEvent("dialog", { timeout }).then(async (dialog) => {
            const message = dialog.message();
            await dialog.dismiss().catch(() => {});
            throw new Error(`Download failed dialog: ${message}`);
        })
    );
    const pageErrorFailure = ignoreTimeout(
        page.waitForEvent("pageerror", { timeout }).then((error) => {
            throw error;
        })
    );

    await button.click();
    const download = await Promise.race([
        downloadPromise,
        dialogFailure,
        pageErrorFailure,
    ]);

    expect(download.suggestedFilename()).toBe(fileName);

    const dir = await mkdtemp(path.join(tmpdir(), "peerbit-file-download-"));
    const downloadPath = path.join(dir, fileName);
    await download.saveAs(downloadPath);
    const details = await stat(downloadPath);
    expect(details.size).toBe(expectedSizeMb * 1024 * 1024);

    return {
        downloadPath,
        size: details.size,
    };
}
