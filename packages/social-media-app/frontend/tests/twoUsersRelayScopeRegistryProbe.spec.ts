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
    public: { status: string; address?: string };
    private: { status: string; address?: string };
};

const waitForProbeRoot = async (page: Page) => {
    await page.waitForFunction(() => Boolean((window as any).__peerInfo), null, {
        timeout: 30_000,
    });
    await expect(page.getByTestId("scope-registry-probe-root")).toBeVisible({
        timeout: 30_000,
    });
};

const expectedState = (mode: string) => {
    if (mode === "private") {
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
                    ((await page.evaluate(
                        () => (window as any).__scopeRegistryProbe
                    )) ?? null) as ProbeSnapshot | null,
                {
                    timeout: 90_000,
                    message: `${label} scope registry probe did not fully open`,
                }
            )
            .toMatchObject(expectedState(mode));
    } catch (error) {
        console.log(
            `[${label}] state`,
            await page.evaluate(() => ({
                peerInfo: (window as any).__peerInfo ?? null,
                scopeRegistryProbe: (window as any).__scopeRegistryProbe ?? null,
                startupPerf: (window as any).__STARTUP_PERF
                    ? {
                          marks: (window as any).__STARTUP_PERF.marks ?? null,
                          data: (window as any).__STARTUP_PERF.data ?? null,
                      }
                    : null,
            }))
        );
        throw error;
    }
};

async function createSecondUserContext(
    testInfo: TestInfo,
    baseUrl: string
): Promise<BrowserContext> {
    return await launchPersistentBrowserContext(testInfo, {
        scope: "scope-registry-probe-user-2",
        baseURL: baseUrl,
    });
}

test.describe("Two users relay scope registry probe", () => {
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
            scopeprobe: `registry-${mode}`,
            perf: "1",
        });

    for (const mode of ["private", "public-private"]) {
        test(`${mode} scope registry path opens for persisted second user`, async (
            { page },
            testInfo
        ) => {
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
