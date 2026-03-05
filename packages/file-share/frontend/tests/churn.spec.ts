import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

function findWorkspaceRoot(startDir: string): string {
    let dir = startDir;
    for (let i = 0; i < 15; i++) {
        if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return startDir;
}

function readPackageVersionFromPath(packageJsonPath: string): string {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
}

function parseSemver(version: string): [number, number, number] {
    const [core] = version.split("-", 1);
    const parts = core.split(".");
    return [
        Number(parts[0] || 0),
        Number(parts[1] || 0),
        Number(parts[2] || 0),
    ];
}

function semverLt(a: string, b: string): boolean {
    const [am, an, ap] = parseSemver(a);
    const [bm, bn, bp] = parseSemver(b);
    if (am !== bm) return am < bm;
    if (an !== bn) return an < bn;
    return ap < bp;
}

function semverGte(a: string, b: string): boolean {
    return !semverLt(a, b);
}

const WORKSPACE_ROOT = findWorkspaceRoot(process.cwd());
const PEERBIT_VERSION = readPackageVersionFromPath(
    path.join(process.cwd(), "node_modules", "peerbit", "package.json")
);
const SHARED_LOG_VERSION = readPackageVersionFromPath(
    path.join(
        WORKSPACE_ROOT,
        "node_modules",
        "@peerbit",
        "shared-log",
        "package.json"
    )
);
const HAS_REPLICATOR_LEASE_FIX = semverGte(SHARED_LOG_VERSION, "13.0.1");
const ALLOW_BOOTSTRAP_FAILURE =
    process.env.PW_ALLOW_BOOTSTRAP_FAILURE === "1" ||
    semverLt(PEERBIT_VERSION, "5.0.1");

function mb(n: number): number {
    return Math.round(n * 1_000_000);
}

async function writeFileOfSize(filePath: string, sizeBytes: number) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const handle = await fs.promises.open(filePath, "w");
    try {
        await handle.truncate(sizeBytes);
    } finally {
        await handle.close();
    }
}

function attachConsoleGuards(
    page: Page,
    label: string,
    failures: string[],
    logs: string[]
) {
    page.on("console", (msg) => {
        const text = msg.text();
        const type = msg.type();

        logs.push(`[${label}] console.${type}: ${text}`);

        // Be selective: some libraries use console.warn for expected retries.
        const isBad =
            text.includes("Failed to resolve complete file list") ||
            text.includes("Failed to get message") ||
            text.includes("delivery acknowledges") ||
            text.includes("SeekDelivery");

        const isBootstrapError = text.startsWith("Failed to bootstrap:");
        if (
            (type === "error" &&
                !(ALLOW_BOOTSTRAP_FAILURE && isBootstrapError)) ||
            isBad
        ) {
            failures.push(`[${label}] console.${type}: ${text}`);
        }
    });
    page.on("pageerror", (err) => {
        failures.push(`[${label}] pageerror: ${err?.message ?? String(err)}`);
    });
}

async function createSpace(page: Page, name: string): Promise<string> {
    // HashRouter requires an explicit hash route; `page.goto("/")` will drop the fragment.
    await page.goto("/#/");
    const nameInput = page.getByTestId("space-name-input");
    try {
        await nameInput.waitFor({ state: "visible", timeout: 30_000 });
    } catch {
        const debug = await page.evaluate(() => {
            const root = document.getElementById("root");
            return {
                href: window.location.href,
                hash: window.location.hash,
                title: document.title,
                rootText: root?.textContent?.slice(0, 500) ?? "",
                rootHtmlLen: root?.innerHTML?.length ?? 0,
                bodyText: document.body?.textContent?.slice(0, 500) ?? "",
            };
        });
        throw new Error(
            [
                "CreateDrop did not render (space-name-input not visible).",
                `debug=${JSON.stringify(debug)}`,
            ].join("\n")
        );
    }

    await nameInput.fill(name);
    await page.getByTestId("create-space").click();
    await expect(page).toHaveURL(/#\/s\//, { timeout: 60_000 });
    await expect(page.getByTestId("seeder-count")).toBeVisible();
    return page.url();
}

async function uploadFile(page: Page, filePath: string) {
    // Use the filesystem path so Playwright can stream without buffering the whole file.
    await page.getByTestId("upload-input").setInputFiles(filePath);
}

async function waitForFileListed(page: Page, fileName: string) {
    await expect(page.getByTestId("file-list")).toBeVisible();
    await expect(page.getByTestId("file-list").getByText(fileName)).toBeVisible();
}

async function seederCount(page: Page): Promise<number> {
    const raw = (await page.getByTestId("seeder-count").textContent()) ?? "";
    const value = Number(raw.trim());
    return Number.isFinite(value) ? value : NaN;
}

test("churn: closing a receiver drops seeder count", async ({ browser }, testInfo) => {
    test.skip(
        !HAS_REPLICATOR_LEASE_FIX,
        `Requires @peerbit/shared-log >= 13.0.1 (found ${SHARED_LOG_VERSION})`,
    );

    const failures: string[] = [];
    const logs: string[] = [];

    const uploaderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();

    const uploader = await uploaderCtx.newPage();
    const receiver = await receiverCtx.newPage();

    attachConsoleGuards(uploader, "uploader", failures, logs);
    attachConsoleGuards(receiver, "receiver", failures, logs);

    let url: string;
    try {
        url = await createSpace(uploader, "e2e-churn");
    } catch (error) {
        throw new Error(
            [
                `Failed to create space: ${(error as Error)?.message ?? String(error)}`,
                "Logs:",
                ...logs.slice(-200),
            ].join("\n")
        );
    }

    const fileSizeMb = Number(process.env.PW_FILE_MB || "10");
    const fileName = `blob-${fileSizeMb}mb.bin`;
    const filePath = testInfo.outputPath(fileName);
    await writeFileOfSize(filePath, mb(fileSizeMb));

    await uploadFile(uploader, filePath);
    await waitForFileListed(uploader, fileName);

    await receiver.goto(url);
    await waitForFileListed(receiver, fileName);

    // Expect at least two replicators (uploader + receiver) at steady state.
    await expect
        .poll(() => seederCount(uploader), { timeout: 60_000 })
        .toBeGreaterThanOrEqual(2);

    await receiverCtx.close();

    // Uploader should eventually see only itself as replicator.
    await expect
        .poll(() => seederCount(uploader), { timeout: 60_000 })
        .toBe(1);

    await uploaderCtx.close();

    expect(failures, failures.join("\n")).toEqual([]);
});

test(
    "churn: multi-party join/leave updates seeder count",
    async ({ browser }, testInfo) => {
        test.skip(
            !HAS_REPLICATOR_LEASE_FIX,
            `Requires @peerbit/shared-log >= 13.0.1 (found ${SHARED_LOG_VERSION})`,
        );

        const failures: string[] = [];
        const logs: string[] = [];

        const uploaderCtx = await browser.newContext();
        const receiver1Ctx = await browser.newContext();
        const receiver2Ctx = await browser.newContext();

        const uploader = await uploaderCtx.newPage();
        const receiver1 = await receiver1Ctx.newPage();
        const receiver2 = await receiver2Ctx.newPage();

        attachConsoleGuards(uploader, "uploader", failures, logs);
        attachConsoleGuards(receiver1, "receiver1", failures, logs);
        attachConsoleGuards(receiver2, "receiver2", failures, logs);

        let url: string;
        try {
            url = await createSpace(uploader, "e2e-multi-churn");
        } catch (error) {
            throw new Error(
                [
                    `Failed to create space: ${(error as Error)?.message ?? String(error)}`,
                    "Logs:",
                    ...logs.slice(-200),
                ].join("\n")
            );
        }

        const fileSizeMb = Number(process.env.PW_FILE_MB || "10");
        const fileName = `blob-${fileSizeMb}mb.bin`;
        const filePath = testInfo.outputPath(fileName);
        await writeFileOfSize(filePath, mb(fileSizeMb));

        await uploadFile(uploader, filePath);
        await waitForFileListed(uploader, fileName);

        await receiver1.goto(url);
        await waitForFileListed(receiver1, fileName);
        await receiver2.goto(url);
        await waitForFileListed(receiver2, fileName);

        await expect
            .poll(() => seederCount(uploader), { timeout: 60_000 })
            .toBeGreaterThanOrEqual(3);

        await receiver1Ctx.close();
        await expect
            .poll(() => seederCount(uploader), { timeout: 60_000 })
            .toBe(2);

        await receiver2Ctx.close();
        await expect
            .poll(() => seederCount(uploader), { timeout: 60_000 })
            .toBe(1);

        await uploaderCtx.close();

        expect(failures, failures.join("\n")).toEqual([]);
    }
);
