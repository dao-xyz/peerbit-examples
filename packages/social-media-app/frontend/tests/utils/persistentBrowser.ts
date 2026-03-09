import { chromium, type BrowserContext, type TestInfo } from "@playwright/test";
import inspector from "inspector";
import fs from "node:fs";

export type PersistentContextOptions = {
    /** Subdirectory name under the test output path. */
    scope: string;
    /** Absolute base URL for the app (used to grant permissions). */
    baseURL: string;
    headless?: boolean;
    viewport?: { width: number; height: number };
};

export function isDebugging() {
    return inspector.url() !== undefined;
}
/**
 * Launch a persistent Chromium context mirroring the behaviour from
 * `fixtures/persistentContext`, so tests can spin up additional users without
 * duplicating the boilerplate.
 */
export async function launchPersistentBrowserContext(
    testInfo: TestInfo,
    options: PersistentContextOptions
): Promise<BrowserContext> {
    const {
        scope,
        baseURL,
        headless = !isDebugging(),
        viewport = { width: 1280, height: 800 },
    } = options;

    const userDataDir = testInfo.outputPath(scope);
    // Ensure deterministic profiles across re-runs. Playwright may reuse the same
    // `testInfo.outputPath()` folder between local runs, which can leak localStorage
    // and IndexedDB state (e.g. Supabase identity switch flags) into new contexts.
    try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless,
        viewport,
        args: ["--enable-features=FileSystemAccessAPI"],
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, "storage", {
            value: {
                ...navigator.storage,
                persist: async () => true,
                persisted: async () => true,
            },
            configurable: true,
        });
        try {
            // Avoid modal prompts in most e2e specs that publish drafts.
            localStorage.setItem("giga.identity.notice.guest.v1", "true");
            localStorage.setItem("giga.identity.notice.temporary.v1", "true");
        } catch {}
    });

    const origin = new URL(baseURL).origin;
    await context.grantPermissions(["storage-access"], { origin });

    return context;
}

const isIgnorablePersistentCloseError = (error: unknown) => {
    const message = String((error as any)?.message ?? error ?? "");
    return (
        message.includes("ENOENT") &&
        (message.includes(".playwright-artifacts") ||
            message.includes(".trace") ||
            message.includes("recording") ||
            message.includes("video"))
    );
};

export async function closePersistentBrowserContext(
    context: BrowserContext
): Promise<void> {
    try {
        await context.close();
    } catch (error) {
        if (isIgnorablePersistentCloseError(error)) {
            return;
        }
        throw error;
    }
}
