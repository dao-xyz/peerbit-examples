import {
    type BrowserContext,
    type Page,
    type TestInfo,
    expect,
    test,
} from "@playwright/test";
import { startReplicator } from "./replicator/replicatorNode";
import {
    closePersistentBrowserContext,
    launchPersistentBrowserContext,
} from "./utils/persistentBrowser";
import { withSearchParams } from "./utils/url";

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";

type ProbeSnapshot = {
    mode: string;
    peerHash: string | number | null;
    persisted: boolean | null;
    public: { status: string; address?: string; error?: string };
    private: { status: string; address?: string; error?: string };
};

const waitForProbeRoot = async (page: Page) => {
    await page.waitForFunction(() => Boolean((window as any).__peerInfo), null, {
        timeout: 30_000,
    });
    await expect(page.getByTestId("scopeprobe-root")).toBeVisible({
        timeout: 30_000,
    });
};

const expectedProbeState = (mode: string) => {
    if (mode === "public-only") {
        return {
            public: { status: "open" },
            private: { status: "skipped" },
        };
    }
    if (
        mode === "private-only" ||
        mode === "private-only-no-messages" ||
        mode === "private-only-local" ||
        mode === "private-only-local-no-messages"
    ) {
        return {
            public: { status: "skipped" },
            private: { status: "open" },
        };
    }
    return {
        public: { status: "open" },
        private: { status: "open" },
    };
};

const waitForProbeOpen = async (page: Page, label: string, mode: string) => {
    try {
        await expect
            .poll(
                async () =>
                    ((await page.evaluate(() => (window as any).__scopeProbe)) ??
                        null) as ProbeSnapshot | null,
                {
                    timeout: 90_000,
                    message: `${label} scope probe did not fully open`,
                }
            )
            .toMatchObject(expectedProbeState(mode));
    } catch (error) {
        await logProbeState(page, label);
        throw error;
    }
};

const logProbeState = async (page: Page, label: string) => {
    try {
        console.log(`[${label}] url`, page.url());
        console.log(
            `[${label}] state`,
            await page.evaluate(() => ({
                readyState: document.readyState,
                search: window.location.search,
                hash: window.location.hash,
                dbgBootstrap: (window as any).__DBG_BOOTSTRAP ?? null,
                peerInfo: (window as any).__peerInfo ?? null,
                scopeProbe: (window as any).__scopeProbe ?? null,
                startupPerf: (window as any).__STARTUP_PERF
                    ? {
                          marks: (window as any).__STARTUP_PERF.marks ?? null,
                          data: (window as any).__STARTUP_PERF.data ?? null,
                      }
                    : null,
            }))
        );
    } catch (error) {
        console.log(`[${label}] state-error`, String(error));
    }
};

async function createSecondUserContext(
    testInfo: TestInfo,
    baseUrl: string
): Promise<BrowserContext> {
    return await launchPersistentBrowserContext(testInfo, {
        scope: "scope-probe-user-2",
        baseURL: baseUrl,
    });
}

test.describe("Two users relay scope probe", () => {
    test.setTimeout(150_000);

    let bootstrap: string[] = [];
    let stopReplicator: (() => Promise<void>) | undefined;

    test.beforeEach(async () => {
        const { client, addrs } = await startReplicator();
        bootstrap = addrs.map((addr) => addr.toString());
        stopReplicator = async () => {
            try {
                await client.stop();
            } catch {
                // ignore
            }
        };
    });

    test.afterEach(async () => {
        if (stopReplicator) {
            await stopReplicator();
            stopReplicator = undefined;
        }
    });

    const buildUrl = (baseUrl: string, mode: string) =>
        withSearchParams(baseUrl, {
            bootstrap: bootstrap.join(","),
            scopeprobe: mode,
            perf: "1",
        });

    for (const mode of [
        "parallel",
        "serial",
        "public-only",
        "private-only",
        "private-only-no-messages",
        "private-only-local",
        "private-only-local-no-messages",
        "parallel-no-messages",
        "parallel-private-local",
        "parallel-private-local-no-messages",
        "serial-private-local",
        "serial-no-messages",
        "serial-private-first-no-messages",
        "serial-private-local-no-messages",
    ]) {
        test(`${mode} scope open succeeds for persisted second user`, async ({
            page,
        }, testInfo) => {
            const baseAppUrl =
                (testInfo.project.use.baseURL as string | undefined) || BASE_URL;
            const url = buildUrl(baseAppUrl, mode);

            await page.goto(url);
            await waitForProbeRoot(page);
            await waitForProbeOpen(page, `primary:${mode}`, mode);

            const user2Context = await createSecondUserContext(
                testInfo,
                baseAppUrl
            );
            try {
                const page2 = await user2Context.newPage();
                await page2.goto(url);
                await waitForProbeRoot(page2);
                await waitForProbeOpen(page2, `user2:${mode}`, mode);
            } finally {
                await closePersistentBrowserContext(user2Context);
            }
        });
    }
});
