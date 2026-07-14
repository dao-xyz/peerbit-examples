import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostProvider, useHost } from "../HostProvider";
import { HostRegistryProvider } from "../HostRegistryProvider";
import { NavigationEvent } from "../client-host";

const resizeMocks = vi.hoisted(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
}));

vi.mock("@iframe-resizer/parent", () => ({
    default: resizeMocks.connect,
}));

const HostStatus = () => {
    const { ready } = useHost();
    return React.createElement(
        "output",
        { "data-testid": "host-ready" },
        String(ready)
    );
};

const hostTree = (properties: {
    origin: string;
    source?: string;
    onNavigate: (message: NavigationEvent) => void;
    enableResizer?: boolean;
}) =>
    React.createElement(
        HostRegistryProvider,
        null,
        React.createElement(HostProvider, {
            iframeOriginalSource: properties.origin,
            iframeSource: properties.source ?? properties.origin,
            onNavigate: properties.onNavigate,
            enableResizer: properties.enableResizer,
            children: (iframeRef) =>
                React.createElement(
                    React.Fragment,
                    null,
                    React.createElement("iframe", {
                        ref: iframeRef,
                        title: "embedded-app",
                    }),
                    React.createElement(HostStatus)
                ),
        })
    );

const dispatchFromIframe = (
    iframe: HTMLIFrameElement,
    origin: string,
    data: unknown
) => {
    if (!iframe.contentWindow) {
        throw new Error("Test iframe has no contentWindow");
    }
    act(() => {
        dispatchFromIframeNow(iframe, origin, data);
    });
};

const dispatchFromIframeNow = (
    iframe: HTMLIFrameElement,
    origin: string,
    data: unknown
) => {
    if (!iframe.contentWindow) {
        throw new Error("Test iframe has no contentWindow");
    }
    globalThis.dispatchEvent(
        new MessageEvent("message", {
            data,
            origin,
            source: iframe.contentWindow,
        })
    );
};

const DepartingDocumentMessage = (properties: {
    iframeRef: React.RefObject<HTMLIFrameElement | null>;
    origin?: string;
}) => {
    React.useLayoutEffect(() => {
        const iframe = properties.iframeRef.current;
        if (!iframe || !properties.origin) {
            return;
        }
        dispatchFromIframeNow(iframe, properties.origin, {
            type: "navigate",
            to: `${properties.origin}/departing-document`,
        });
    }, [properties.iframeRef, properties.origin]);
    return null;
};

const sourceChangeRaceTree = (properties: {
    origin: string;
    source: string;
    onNavigate: (message: NavigationEvent) => void;
    departingOrigin?: string;
}) =>
    React.createElement(
        HostRegistryProvider,
        null,
        React.createElement(HostProvider, {
            iframeOriginalSource: properties.origin,
            iframeSource: properties.source,
            onNavigate: properties.onNavigate,
            children: (iframeRef) =>
                React.createElement(
                    React.Fragment,
                    null,
                    React.createElement("iframe", {
                        ref: iframeRef,
                        title: "racing-embedded-app",
                    }),
                    React.createElement(DepartingDocumentMessage, {
                        iframeRef,
                        origin: properties.departingOrigin,
                    })
                ),
        })
    );

beforeEach(() => {
    resizeMocks.connect.mockReset();
    resizeMocks.disconnect.mockReset();
    resizeMocks.connect.mockReturnValue([
        { iFrameResizer: { disconnect: resizeMocks.disconnect } },
    ]);
});

afterEach(() => {
    cleanup();
});

describe("HostProvider lifecycle", () => {
    it("removes the departing source listener before descendant layout effects", () => {
        const firstNavigate = vi.fn();
        const secondNavigate = vi.fn();
        const view = render(
            sourceChangeRaceTree({
                origin: "https://stream.peerbit.org",
                source: "https://stream.peerbit.org/watch/1",
                onNavigate: firstNavigate,
            })
        );

        view.rerender(
            sourceChangeRaceTree({
                origin: "https://chat.peerbit.org",
                source: "https://chat.peerbit.org/room/2",
                onNavigate: secondNavigate,
                departingOrigin: "https://stream.peerbit.org",
            })
        );

        expect(firstNavigate).not.toHaveBeenCalled();
        expect(secondNavigate).not.toHaveBeenCalled();
    });

    it("invalidates readiness and callbacks when the normalized origin changes", async () => {
        const firstNavigate = vi.fn();
        const secondNavigate = vi.fn();
        const view = render(
            hostTree({
                origin: "https://stream.peerbit.org/initial",
                onNavigate: firstNavigate,
            })
        );
        const iframe = screen.getByTitle("embedded-app") as HTMLIFrameElement;

        dispatchFromIframe(iframe, "https://stream.peerbit.org", {
            type: "ready",
        });
        await waitFor(() =>
            expect(screen.getByTestId("host-ready").textContent).toBe("true")
        );

        view.rerender(
            hostTree({
                origin: "https://chat.peerbit.org/next",
                onNavigate: secondNavigate,
            })
        );
        expect(screen.getByTestId("host-ready").textContent).toBe("false");

        dispatchFromIframe(iframe, "https://stream.peerbit.org", {
            type: "ready",
        });
        expect(screen.getByTestId("host-ready").textContent).toBe("false");

        dispatchFromIframe(iframe, "https://chat.peerbit.org", {
            type: "ready",
        });
        await waitFor(() =>
            expect(screen.getByTestId("host-ready").textContent).toBe("true")
        );

        dispatchFromIframe(iframe, "https://chat.peerbit.org", {
            type: "navigate",
            to: "https://chat.peerbit.org/room/2",
        });
        expect(firstNavigate).not.toHaveBeenCalled();
        expect(secondNavigate).toHaveBeenCalledOnce();
    });

    it("keeps the active host for raw URLs with the same normalized origin", async () => {
        const onNavigate = vi.fn();
        const view = render(
            hostTree({
                origin: "https://STREAM.peerbit.org:443/first",
                source: "https://stream.peerbit.org/loaded",
                onNavigate,
            })
        );
        const iframe = screen.getByTitle("embedded-app") as HTMLIFrameElement;

        dispatchFromIframe(iframe, "https://stream.peerbit.org", {
            type: "ready",
        });
        await waitFor(() =>
            expect(screen.getByTestId("host-ready").textContent).toBe("true")
        );

        view.rerender(
            hostTree({
                origin: "https://stream.peerbit.org/second",
                source: "https://stream.peerbit.org/loaded",
                onNavigate,
            })
        );
        expect(screen.getByTestId("host-ready").textContent).toBe("true");
    });

    it("rebinds changed callbacks and resets readiness on the same origin", async () => {
        const firstNavigate = vi.fn();
        const secondNavigate = vi.fn();
        const view = render(
            hostTree({
                origin: "https://stream.peerbit.org",
                source: "https://stream.peerbit.org/loaded",
                onNavigate: firstNavigate,
            })
        );
        const iframe = screen.getByTitle("embedded-app") as HTMLIFrameElement;

        dispatchFromIframe(iframe, "https://stream.peerbit.org", {
            type: "ready",
        });
        await waitFor(() =>
            expect(screen.getByTestId("host-ready").textContent).toBe("true")
        );

        view.rerender(
            hostTree({
                origin: "https://stream.peerbit.org/next",
                source: "https://stream.peerbit.org/loaded",
                onNavigate: secondNavigate,
            })
        );
        expect(screen.getByTestId("host-ready").textContent).toBe("false");

        dispatchFromIframe(iframe, "https://stream.peerbit.org", {
            type: "ready",
        });
        dispatchFromIframe(iframe, "https://stream.peerbit.org", {
            type: "navigate",
            to: "https://stream.peerbit.org/watch/2",
        });
        expect(firstNavigate).not.toHaveBeenCalled();
        expect(secondNavigate).toHaveBeenCalledOnce();
    });

    it("resets readiness when the rendered document URL changes", async () => {
        const onNavigate = vi.fn();
        const view = render(
            hostTree({
                origin: "https://stream.peerbit.org",
                source: "https://stream.peerbit.org/watch/1",
                onNavigate,
            })
        );
        const iframe = screen.getByTitle("embedded-app") as HTMLIFrameElement;

        dispatchFromIframe(iframe, "https://stream.peerbit.org", {
            type: "ready",
        });
        await waitFor(() =>
            expect(screen.getByTestId("host-ready").textContent).toBe("true")
        );

        view.rerender(
            hostTree({
                origin: "https://stream.peerbit.org",
                source: "https://stream.peerbit.org/watch/2",
                onNavigate,
            })
        );
        expect(screen.getByTestId("host-ready").textContent).toBe("false");

        dispatchFromIframe(iframe, "https://stream.peerbit.org", {
            type: "ready",
        });
        await waitFor(() =>
            expect(screen.getByTestId("host-ready").textContent).toBe("true")
        );
    });

    it("does not start iframe-resizer unless explicitly enabled", async () => {
        const disabled = render(
            hostTree({
                origin: "https://arbitrary.example",
                onNavigate: vi.fn(),
            })
        );
        expect(resizeMocks.connect).not.toHaveBeenCalled();
        disabled.unmount();

        const enabled = render(
            hostTree({
                origin: "https://stream.peerbit.org",
                onNavigate: vi.fn(),
                enableResizer: true,
            })
        );
        await waitFor(() => expect(resizeMocks.connect).toHaveBeenCalledOnce());
        enabled.unmount();
        expect(resizeMocks.disconnect).toHaveBeenCalledOnce();
    });
});
