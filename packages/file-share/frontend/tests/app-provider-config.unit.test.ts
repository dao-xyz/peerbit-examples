import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const appHarness = vi.hoisted(() => {
    const dial = vi.fn();
    const hasLocalProgram = vi.fn();
    return {
        providerConfigs: [] as unknown[],
        dial,
        hasLocalProgram,
        peer: {
            dial,
            services: { blocks: { has: hasLocalProgram } },
        },
    };
});

vi.mock("@peerbit/react", () => ({
    PeerProvider: ({
        config,
        children,
    }: {
        config: unknown;
        children: unknown;
    }) => {
        appHarness.providerConfigs.push(config);
        return children;
    },
    usePeer: () => ({
        peer: appHarness.peer,
    }),
}));

vi.mock("../src/routes", () => ({ BaseRoutes: () => null }));
vi.mock("../src/Footer", () => ({ Footer: () => null }));
vi.mock("../src/Spinner", () => ({ Spinner: () => null }));

describe("App PeerProvider lifecycle", () => {
    afterEach(() => {
        document.body.innerHTML = "";
        window.history.replaceState(null, "", "/");
        delete (
            window as Window & {
                __peerbitFileShareBenchmarkStorageMode?: unknown;
            }
        ).__peerbitFileShareBenchmarkStorageMode;
        appHarness.providerConfigs = [];
        appHarness.dial.mockReset();
        appHarness.hasLocalProgram.mockReset();
    });

    const renderApp = async () => {
        const { App } = await import("../src/App");
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        (
            globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = true;
        await act(async () => root.render(createElement(App)));
        return { container, root };
    };

    const flushApp = async () => {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    };

    const getAppDiagnostics = () =>
        (
            window as Window & {
                __peerbitFileShareAppDiagnostics?: () => Record<
                    string,
                    unknown
                >;
            }
        ).__peerbitFileShareAppDiagnostics?.();

    it("leaves normal users on the existing provider configuration", async () => {
        const { root } = await renderApp();

        const config = appHarness.providerConfigs.at(-1) as Record<
            string,
            unknown
        >;
        expect(Object.hasOwn(config, "inMemory")).toBe(false);
        expect(getAppDiagnostics()).toMatchObject({
            benchmarkStorageMode: null,
        });

        await act(async () => root.unmount());
    });

    it.each([
        ["memory", true],
        ["opfs", false],
    ] as const)(
        "applies the page-init %s storage cohort without changing config identity",
        async (mode, inMemory) => {
            (
                window as Window & {
                    __peerbitFileShareBenchmarkStorageMode?: unknown;
                }
            ).__peerbitFileShareBenchmarkStorageMode = mode;

            const { root } = await renderApp();

            expect(appHarness.providerConfigs.length).toBeGreaterThan(0);
            expect(new Set(appHarness.providerConfigs).size).toBe(1);
            expect(appHarness.providerConfigs.at(-1)).toMatchObject({
                inMemory,
            });
            expect(getAppDiagnostics()).toMatchObject({
                benchmarkStorageMode: mode,
            });

            await act(async () => root.unmount());
        }
    );

    it("fails closed before creating a provider for an invalid storage cohort", async () => {
        (
            window as Window & {
                __peerbitFileShareBenchmarkStorageMode?: unknown;
            }
        ).__peerbitFileShareBenchmarkStorageMode = "disk";

        await expect(renderApp()).rejects.toThrow(
            'expected "memory" or "opfs"'
        );
        expect(appHarness.providerConfigs).toHaveLength(0);
    });

    it("keeps the provider config identity stable when explicit dialing becomes ready", async () => {
        window.history.replaceState(
            null,
            "",
            "/?peer=%2Fip4%2F127.0.0.1%2Ftcp%2F9000%2Fws%2Fp2p%2Fwriter#/s/share"
        );
        appHarness.dial.mockResolvedValue(undefined);
        const { root } = await renderApp();
        await flushApp();

        expect(appHarness.dial).toHaveBeenCalledTimes(1);
        expect(appHarness.providerConfigs.length).toBeGreaterThanOrEqual(2);
        expect(new Set(appHarness.providerConfigs).size).toBe(1);

        await act(async () => root.unmount());
    });

    it("opens a saved local share after every direct peer hint fails", async () => {
        window.history.replaceState(
            null,
            "",
            "/?peer=stale-writer#/s/saved-share"
        );
        appHarness.dial.mockRejectedValue(new Error("writer unavailable"));
        appHarness.hasLocalProgram.mockResolvedValue(true);

        const { container, root } = await renderApp();
        await flushApp();

        expect(appHarness.hasLocalProgram).toHaveBeenCalledWith("saved-share");
        expect(getAppDiagnostics()).toMatchObject({
            connectionState: "ready-local",
            dialError: expect.stringContaining(
                "Failed to connect to all supplied peers"
            ),
            localFallbackState: "ready",
            localFallbackAddress: "saved-share",
        });
        expect(
            container.querySelector('[data-testid="saved-copy-warning"]')
        ).not.toBeNull();

        await act(async () => root.unmount());
    });

    it("keeps a stale direct hint fatal when the share is not saved locally", async () => {
        window.history.replaceState(
            null,
            "",
            "/?peer=stale-writer#/s/missing-share"
        );
        appHarness.dial.mockRejectedValue(new Error("writer unavailable"));
        appHarness.hasLocalProgram.mockResolvedValue(false);

        const { container, root } = await renderApp();
        await flushApp();

        expect(getAppDiagnostics()).toMatchObject({
            connectionState: "failed",
            localFallbackState: "missing",
            localFallbackAddress: "missing-share",
        });
        expect(container.textContent).toContain("Failed to connect to peer");

        await act(async () => root.unmount());
    });

    it("does not reinterpret an explicit bootstrap override as a saved-share hint", async () => {
        window.history.replaceState(
            null,
            "",
            "/?bootstrap=stale-bootstrap#/s/saved-share"
        );
        appHarness.dial.mockRejectedValue(new Error("bootstrap unavailable"));
        appHarness.hasLocalProgram.mockResolvedValue(true);

        const { root } = await renderApp();
        await flushApp();

        expect(appHarness.hasLocalProgram).not.toHaveBeenCalled();
        expect(getAppDiagnostics()).toMatchObject({
            connectionState: "failed",
            localFallbackState: "not-attempted",
        });

        await act(async () => root.unmount());
    });

    it("keeps a local block-store failure fatal", async () => {
        window.history.replaceState(
            null,
            "",
            "/?peer=stale-writer#/s/saved-share"
        );
        appHarness.dial.mockRejectedValue(new Error("writer unavailable"));
        appHarness.hasLocalProgram.mockRejectedValue(
            new Error("local store unavailable")
        );

        const { root } = await renderApp();
        await flushApp();

        expect(getAppDiagnostics()).toMatchObject({
            connectionState: "failed",
            localFallbackState: "error",
            localFallbackError: "local store unavailable",
        });

        await act(async () => root.unmount());
    });
});
