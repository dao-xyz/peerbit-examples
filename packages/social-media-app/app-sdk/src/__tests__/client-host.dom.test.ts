import { afterEach, describe, expect, it, vi } from "vitest";
import {
    AppClient,
    AppHost,
    isAppMessage,
    isSafeNavigationTarget,
    normalizeAppOrigin,
    normalizeMatchingAppOrigin,
    resolveParentOrigin,
    resolveIframeCapabilities,
} from "../client-host";

vi.mock("@iframe-resizer/child", () => ({}));

const dispatchMessage = (properties: {
    data: unknown;
    origin: string;
    source: MessageEventSource;
}) => {
    globalThis.dispatchEvent(
        new MessageEvent("message", {
            data: properties.data,
            origin: properties.origin,
            source: properties.source,
        })
    );
};

const createIframe = () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    if (!iframe.contentWindow) {
        throw new Error("Test iframe has no contentWindow");
    }
    return iframe;
};

afterEach(() => {
    document.documentElement.classList.remove("dark");
    document.body.replaceChildren();
    vi.restoreAllMocks();
});

describe("app message schema", () => {
    it("accepts only the closed runtime schema", () => {
        expect(isAppMessage({ type: "ready" })).toBe(true);
        expect(isAppMessage({ type: "theme", theme: "dark" })).toBe(true);
        expect(
            isAppMessage({ type: "navigate", to: "https://app.example/a" })
        ).toBe(true);

        expect(isAppMessage(null)).toBe(false);
        expect(isAppMessage({ type: "ready", forged: true })).toBe(false);
        expect(isAppMessage({ type: "theme", theme: "sepia" })).toBe(false);
        expect(
            isAppMessage({ type: "size", width: Infinity, height: 10 })
        ).toBe(false);
    });
});

describe("app origin and navigation policy", () => {
    it("normalizes concrete HTTPS and local-development origins", () => {
        expect(normalizeAppOrigin("https://app.example/path?q=1")).toBe(
            "https://app.example"
        );
        expect(normalizeAppOrigin("http://stream.test:5801/path")).toBe(
            "http://stream.test:5801"
        );
        expect(() => normalizeAppOrigin("*")).toThrow();
        expect(() => normalizeAppOrigin("http://app.example")).toThrow();
        expect(() =>
            normalizeAppOrigin("https://user:password@app.example")
        ).toThrow();
        expect(() => normalizeAppOrigin("data:text/plain,hello")).toThrow();
    });

    it("derives the parent origin without a wildcard fallback", () => {
        expect(
            resolveParentOrigin(undefined, "https://giga.peerbit.org/post/1")
        ).toBe("https://giga.peerbit.org");
        expect(resolveParentOrigin(undefined, "")).toBeUndefined();
        expect(
            resolveParentOrigin(undefined, "http://untrusted.example/post/1")
        ).toBeUndefined();
        expect(() => resolveParentOrigin("*", "")).toThrow();
    });

    it("rejects forged original-source metadata for a different loaded origin", () => {
        expect(() =>
            normalizeMatchingAppOrigin(
                "https://attacker.example/phish",
                "https://stream.peerbit.org"
            )
        ).toThrow("must remain on its original app origin");
        expect(() =>
            normalizeMatchingAppOrigin(
                "https://stream.peerbit.org",
                "https://attacker.example/forged-original"
            )
        ).toThrow("must remain on its original app origin");
    });

    it("compares normalized origins instead of raw iframe URLs", () => {
        expect(
            normalizeMatchingAppOrigin(
                "https://STREAM.peerbit.org:443/watch?id=1",
                "https://stream.peerbit.org/"
            )
        ).toBe("https://stream.peerbit.org");
    });

    it("defaults arbitrary frames to no privileged capabilities", () => {
        expect(
            resolveIframeCapabilities({
                trusted: false,
                permissions: ["camera", "microphone", "fullscreen"],
                resizerRequested: true,
                resizerAllowed: true,
            })
        ).toEqual({ permissions: [], resizer: false });

        // Registry trust plus persisted metadata is not enough. The curated
        // app must explicitly opt in after proving it bundles the child.
        expect(
            resolveIframeCapabilities({
                trusted: true,
                permissions: ["fullscreen"],
                resizerRequested: true,
            })
        ).toEqual({ permissions: ["fullscreen"], resizer: false });

        expect(
            resolveIframeCapabilities({
                trusted: true,
                permissions: ["fullscreen"],
                resizerRequested: false,
                resizerAllowed: true,
            })
        ).toEqual({ permissions: ["fullscreen"], resizer: false });

        expect(
            resolveIframeCapabilities({
                trusted: true,
                permissions: ["fullscreen"],
                resizerRequested: true,
                resizerAllowed: true,
            })
        ).toEqual({ permissions: ["fullscreen"], resizer: true });
    });

    it("allows only absolute, credential-free, same-origin navigation", () => {
        const origin = "https://stream.peerbit.org";
        expect(
            isSafeNavigationTarget(
                "https://stream.peerbit.org/watch?id=1#live",
                origin
            )
        ).toBe(true);
        expect(isSafeNavigationTarget("/watch", origin)).toBe(false);
        expect(
            isSafeNavigationTarget("https://attacker.example/watch", origin)
        ).toBe(false);
        expect(
            isSafeNavigationTarget("http://stream.peerbit.org/watch", origin)
        ).toBe(false);
        expect(
            isSafeNavigationTarget(
                "https://user:password@stream.peerbit.org/watch",
                origin
            )
        ).toBe(false);
        expect(isSafeNavigationTarget("javascript:alert(1)", origin)).toBe(
            false
        );
    });
});

describe("AppHost message trust", () => {
    const setupHost = () => {
        const iframe = createIframe();
        const onNavigate = vi.fn();
        const onReady = vi.fn();
        const host = new AppHost({
            iframeOriginalSource: "https://stream.peerbit.org",
            iframe,
            onResize: vi.fn(),
            onNavigate,
            onReady,
        });
        return { host, iframe, onNavigate, onReady };
    };

    it("rejects a valid message from the wrong origin", () => {
        const { host, iframe, onReady } = setupHost();
        dispatchMessage({
            data: { type: "ready" },
            origin: "https://attacker.example",
            source: iframe.contentWindow!,
        });
        expect(onReady).not.toHaveBeenCalled();
        host.stop();
    });

    it("rejects a valid message from the wrong window", () => {
        const { host, onReady } = setupHost();
        const attackerIframe = createIframe();
        dispatchMessage({
            data: { type: "ready" },
            origin: "https://stream.peerbit.org",
            source: attackerIframe.contentWindow!,
        });
        expect(onReady).not.toHaveBeenCalled();
        host.stop();
    });

    it("accepts the expected iframe only and rejects malformed data", () => {
        const { host, iframe, onReady } = setupHost();
        dispatchMessage({
            data: { type: "ready", forged: true },
            origin: "https://stream.peerbit.org",
            source: iframe.contentWindow!,
        });
        expect(onReady).not.toHaveBeenCalled();

        dispatchMessage({
            data: { type: "ready" },
            origin: "https://stream.peerbit.org",
            source: iframe.contentWindow!,
        });
        expect(onReady).toHaveBeenCalledOnce();
        host.stop();
    });

    it("forwards only safe same-origin navigation", () => {
        const { host, iframe, onNavigate } = setupHost();
        const sendNavigation = (to: string) =>
            dispatchMessage({
                data: { type: "navigate", to },
                origin: "https://stream.peerbit.org",
                source: iframe.contentWindow!,
            });

        sendNavigation("https://attacker.example/phish");
        sendNavigation("javascript:alert(1)");
        sendNavigation("http://stream.peerbit.org/downgrade");
        expect(onNavigate).not.toHaveBeenCalled();

        sendNavigation("https://stream.peerbit.org/watch/abc#live");
        expect(onNavigate).toHaveBeenCalledOnce();
        expect(onNavigate).toHaveBeenCalledWith({
            type: "navigate",
            to: "https://stream.peerbit.org/watch/abc#live",
        });
        host.stop();
    });
});

describe("AppClient message trust", () => {
    it("applies parent events only from the expected source and origin", () => {
        vi.spyOn(globalThis.parent, "postMessage").mockImplementation(
            () => undefined
        );
        const onTheme = vi.fn();
        const client = new AppClient({
            targetOrigin: "https://giga.peerbit.org",
            onResize: vi.fn(),
            onTheme,
            useThemeClasses: true,
        });
        const attackerIframe = createIframe();

        dispatchMessage({
            data: { type: "theme", theme: "dark" },
            origin: "https://attacker.example",
            source: globalThis.parent,
        });
        dispatchMessage({
            data: { type: "theme", theme: "dark" },
            origin: "https://giga.peerbit.org",
            source: attackerIframe.contentWindow!,
        });
        expect(onTheme).not.toHaveBeenCalled();
        expect(document.documentElement.classList.contains("dark")).toBe(false);

        dispatchMessage({
            data: { type: "theme", theme: "dark" },
            origin: "https://giga.peerbit.org",
            source: globalThis.parent,
        });
        expect(onTheme).toHaveBeenCalledOnce();
        expect(document.documentElement.classList.contains("dark")).toBe(true);
        client.stop();
    });
});
