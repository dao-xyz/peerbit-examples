import { test } from "@playwright/test";
import {
    createSyntheticFileOnDisk,
    createSpace,
    getSeederCount,
    rootUrl,
    waitForFileListed,
    withBootstrap,
} from "./helpers";
import { startBootstrapPeer } from "./bootstrapPeer";
import { rm } from "node:fs/promises";

const FILE_MB = Number(process.env.PW_FILE_MB || "100");
const MONITOR_MS = Number(process.env.PW_MONITOR_MS || "60000");
const POLL_MS = Number(process.env.PW_POLL_MS || "5000");

async function getVisibleFileRow(page, fileName: string): Promise<string | null> {
    const row = page.locator("li", { hasText: fileName }).first();
    if (!(await row.isVisible().catch(() => false))) {
        return null;
    }
    return (await row.innerText()).replace(/\s+/g, " ").trim();
}

function attachBlockErrorCollector(name: string, page, target: string[]) {
    page.on("pageerror", (error) => {
        if (error.message.includes("Failed to resolve block")) {
            target.push(`${name}:pageerror:${error.message}`);
        }
    });
    page.on("console", (message) => {
        const text = message.text();
        if (text.includes("Failed to resolve block")) {
            target.push(`${name}:console.${message.type()}:${text}`);
        }
    });
}

test.describe("manual local refresh smoke", () => {
    test("third tab refresh converges seeder counts after large replication via local bootstrap", async ({
        browser,
        baseURL,
    }) => {
        test.setTimeout(15 * 60 * 1000);
        if (!baseURL) {
            throw new Error("Missing baseURL");
        }

        const bootstrap = await startBootstrapPeer();
        const file = await createSyntheticFileOnDisk(
            `local-${FILE_MB}mb.bin`,
            FILE_MB
        );
        const writerContext = await browser.newContext({ acceptDownloads: true });
        const readerOneContext = await browser.newContext({
            acceptDownloads: true,
        });
        const readerTwoContext = await browser.newContext({
            acceptDownloads: true,
        });
        const writer = await writerContext.newPage();
        const readerOne = await readerOneContext.newPage();
        const readerTwo = await readerTwoContext.newPage();
        const blockErrors: string[] = [];
        attachBlockErrorCollector("writer", writer, blockErrors);
        attachBlockErrorCollector("reader1", readerOne, blockErrors);
        attachBlockErrorCollector("reader2", readerTwo, blockErrors);

        const snapshots: Array<Record<string, unknown>> = [];

        const snapshot = async (label: string) => {
            const [
                writerSeeders,
                readerOneSeeders,
                readerTwoSeeders,
                writerRow,
                readerOneRow,
                readerTwoRow,
            ] = await Promise.all([
                getSeederCount(writer).catch((e) => `error:${e.message}`),
                getSeederCount(readerOne).catch((e) => `error:${e.message}`),
                getSeederCount(readerTwo).catch((e) => `error:${e.message}`),
                getVisibleFileRow(writer, file.fileName),
                getVisibleFileRow(readerOne, file.fileName),
                getVisibleFileRow(readerTwo, file.fileName),
            ]);

            const state = {
                label,
                writerSeeders,
                readerOneSeeders,
                readerTwoSeeders,
                writerRow,
                readerOneRow,
                readerTwoRow,
            };
            snapshots.push(state);
            return state;
        };

        try {
            const entryUrl = withBootstrap(rootUrl(baseURL), bootstrap.addrs);
            const shareUrl = await createSpace(
                writer,
                entryUrl,
                `refresh-space-${Date.now()}`
            );

            await readerOne.goto(shareUrl, { waitUntil: "domcontentloaded" });
            await writer.locator("#imgupload").setInputFiles(file.filePath);
            await waitForFileListed(writer, file.fileName, 600_000);
            await waitForFileListed(readerOne, file.fileName, 600_000);

            await readerTwo.goto(shareUrl, { waitUntil: "domcontentloaded" });
            await snapshot("reader2-joined");

            await writer.waitForTimeout(POLL_MS);
            await snapshot("before-refresh");

            await readerTwo.reload({ waitUntil: "domcontentloaded" });
            await snapshot("after-refresh");

            const deadline = Date.now() + MONITOR_MS;
            let converged = false;
            let lastSnapshot: Record<string, unknown> | undefined;
            while (Date.now() < deadline) {
                await writer.waitForTimeout(POLL_MS);
                const current = await snapshot(`poll-${snapshots.length}`);
                lastSnapshot = current;
                if (
                    current.writerSeeders === 3 &&
                    current.readerOneSeeders === 3 &&
                    current.readerTwoSeeders === 3
                ) {
                    converged = true;
                }
            }

            if (!converged) {
                throw new Error(
                    "Seeder counts did not converge to 3/3/3 after refreshing the third tab. " +
                        JSON.stringify(snapshots)
                );
            }

            if (
                lastSnapshot?.writerSeeders !== 3 ||
                lastSnapshot?.readerOneSeeders !== 3 ||
                lastSnapshot?.readerTwoSeeders !== 3
            ) {
                throw new Error(
                    "Seeder counts converged but did not remain at 3/3/3 through the end of the observation window. " +
                        JSON.stringify(snapshots)
                );
            }

            if (blockErrors.length > 0) {
                throw new Error(
                    "Observed block resolution errors during refresh smoke: " +
                        JSON.stringify(blockErrors)
                );
            }
        } finally {
            await writerContext.close().catch(() => {});
            await readerOneContext.close().catch(() => {});
            await readerTwoContext.close().catch(() => {});
            await rm(file.dir, { recursive: true, force: true }).catch(() => {});
            await bootstrap.stop().catch(() => {});
        }
    });
});
