import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const appHarness = vi.hoisted(() => {
    const dial = vi.fn();
    return {
        providerConfigs: [] as unknown[],
        dial,
        peer: { dial },
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
        appHarness.providerConfigs = [];
        appHarness.dial.mockReset();
    });

    it("keeps the provider config identity stable when explicit dialing becomes ready", async () => {
        window.history.replaceState(
            null,
            "",
            "/?peer=%2Fip4%2F127.0.0.1%2Ftcp%2F9000%2Fws%2Fp2p%2Fwriter#/s/share"
        );
        appHarness.dial.mockResolvedValue(undefined);
        const { App } = await import("../src/App");
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        (
            globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = true;

        await act(async () => {
            root.render(createElement(App));
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(appHarness.dial).toHaveBeenCalledTimes(1);
        expect(appHarness.providerConfigs.length).toBeGreaterThanOrEqual(2);
        expect(new Set(appHarness.providerConfigs).size).toBe(1);

        await act(async () => root.unmount());
    });
});
