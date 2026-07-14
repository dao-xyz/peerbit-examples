export interface ResizeMessage {
    type: "size";
    width: number;
    height: number;
}

export interface NavigationEvent {
    type: "navigate";
    to: string;
}

export interface ReadyEvent {
    type: "ready";
}

export interface LoadingEvent {
    type: "loading";
    state: "loading" | "loaded";
}

export interface FullscreenEvent {
    type: "fullscreen";
    state: "enter" | "exit";
}

export interface PreviewEvent {
    type: "preview";
    state: "thumbnail" | "full";
}

/**
 * New ThemeEvent - the parent can send this event to tell the app which theme to use.
 */
export interface ThemeEvent {
    type: "theme";
    theme: "light" | "dark";
}

// The union type of all messages.
export type AppMessage =
    | ResizeMessage
    | NavigationEvent
    | LoadingEvent
    | FullscreenEvent
    | PreviewEvent
    | ThemeEvent
    | ReadyEvent;

const MAX_NAVIGATION_URL_LENGTH = 8_192;
const MAX_FRAME_DIMENSION = 100_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
    value: Record<string, unknown>,
    keys: readonly string[]
) => {
    const actualKeys = Object.keys(value);
    return (
        actualKeys.length === keys.length &&
        keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    );
};

/**
 * postMessage data is untrusted even when TypeScript knows the sender's type.
 * Keep the wire format deliberately small and reject unknown properties.
 */
export const isAppMessage = (value: unknown): value is AppMessage => {
    if (!isRecord(value) || typeof value.type !== "string") {
        return false;
    }

    switch (value.type) {
        case "size":
            return (
                hasExactKeys(value, ["type", "width", "height"]) &&
                typeof value.width === "number" &&
                Number.isFinite(value.width) &&
                value.width >= 0 &&
                value.width <= MAX_FRAME_DIMENSION &&
                typeof value.height === "number" &&
                Number.isFinite(value.height) &&
                value.height >= 0 &&
                value.height <= MAX_FRAME_DIMENSION
            );
        case "navigate":
            return (
                hasExactKeys(value, ["type", "to"]) &&
                typeof value.to === "string" &&
                value.to.length > 0 &&
                value.to.length <= MAX_NAVIGATION_URL_LENGTH
            );
        case "ready":
            return hasExactKeys(value, ["type"]);
        case "loading":
            return (
                hasExactKeys(value, ["type", "state"]) &&
                (value.state === "loading" || value.state === "loaded")
            );
        case "fullscreen":
            return (
                hasExactKeys(value, ["type", "state"]) &&
                (value.state === "enter" || value.state === "exit")
            );
        case "preview":
            return (
                hasExactKeys(value, ["type", "state"]) &&
                (value.state === "thumbnail" || value.state === "full")
            );
        case "theme":
            return (
                hasExactKeys(value, ["type", "theme"]) &&
                (value.theme === "light" || value.theme === "dark")
            );
        default:
            return false;
    }
};

const isLocalDevelopmentHostname = (hostname: string) =>
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".test");

/** Normalize an app URL to the only origin that may exchange messages. */
export const normalizeAppOrigin = (value: string): string => {
    if (value.trim() === "" || value === "*" || value === "null") {
        throw new TypeError("A concrete app origin is required");
    }

    const url = new URL(value);
    const secure =
        url.protocol === "https:" ||
        (url.protocol === "http:" && isLocalDevelopmentHostname(url.hostname));
    if (
        !secure ||
        url.origin === "null" ||
        url.username !== "" ||
        url.password !== ""
    ) {
        throw new TypeError(
            "App messaging requires a credential-free HTTPS origin (HTTP is limited to local development origins)"
        );
    }
    return url.origin;
};

/**
 * Resolve the single origin used by both the rendered iframe and its
 * authenticated message channel. Persisted iframe metadata is untrusted: an
 * attacker must not be able to pair a privileged original source with a
 * different URL that the browser actually loads.
 */
export const normalizeMatchingAppOrigin = (
    currentSource: string,
    originalSource: string
): string => {
    const currentOrigin = normalizeAppOrigin(currentSource);
    const originalOrigin = normalizeAppOrigin(originalSource);

    if (currentOrigin !== originalOrigin) {
        throw new TypeError(
            "The iframe source must remain on its original app origin"
        );
    }

    return originalOrigin;
};

export interface IframeCapabilities {
    permissions: readonly string[];
    resizer: boolean;
}

/**
 * Capabilities are granted only to an app selected from the host's curated
 * registry. Arbitrary frames remain usable, but receive neither Permissions
 * Policy grants nor the iframe-resizer control channel.
 */
export const resolveIframeCapabilities = (properties: {
    trusted: boolean;
    permissions?: readonly string[];
    resizerRequested?: boolean;
    resizerAllowed?: boolean;
}): IframeCapabilities => ({
    permissions: properties.trusted ? (properties.permissions ?? []) : [],
    resizer:
        properties.trusted &&
        properties.resizerAllowed === true &&
        properties.resizerRequested === true,
});

export const resolveParentOrigin = (
    explicitOrigin: string | undefined,
    referrer: string
): string | undefined => {
    const explicit = explicitOrigin?.trim();
    if (explicit) {
        return normalizeAppOrigin(explicit);
    }

    if (!referrer.trim()) {
        return undefined;
    }
    try {
        return normalizeAppOrigin(referrer);
    } catch {
        // An absent/opaque/insecure referrer cannot establish a trust boundary.
        return undefined;
    }
};

/**
 * Child-driven navigation is restricted to an absolute URL on the app's
 * original origin. This prevents a trusted iframe from turning a persisted
 * Giga frame into a javascript:, credential-bearing, or cross-origin URL.
 */
export const isSafeNavigationTarget = (
    value: string,
    expectedOrigin: string
): boolean => {
    try {
        const destination = new URL(value);
        return (
            normalizeAppOrigin(destination.href) === expectedOrigin &&
            destination.username === "" &&
            destination.password === ""
        );
    } catch {
        return false;
    }
};

export class AppClient {
    private listener: (message: MessageEvent) => void;
    private parentWindow: Window;
    private targetOrigin: string;
    constructor(
        readonly properties: {
            targetOrigin: string;
            onResize: (event: MessageEvent<ResizeMessage>) => void;
            onTheme?: (event: MessageEvent<ThemeEvent>) => void;
            onPreview?: (event: MessageEvent<PreviewEvent>) => void;
            useThemeClasses?: boolean;
        }
    ) {
        this.targetOrigin = normalizeAppOrigin(properties.targetOrigin);
        this.parentWindow = globalThis.parent;
        import("@iframe-resizer/child");
        this.listener = (message) => {
            if (
                message.source !== this.parentWindow ||
                message.origin !== this.targetOrigin ||
                !isAppMessage(message.data)
            ) {
                return;
            }

            const data = message.data;
            // For now, we only handle size events (and others can be handled by custom listeners).
            if (data.type === "size") {
                properties.onResize(message as MessageEvent<ResizeMessage>);
            }
            if (data.type === "theme") {
                properties.onTheme?.(message as MessageEvent<ThemeEvent>);
                if (properties.useThemeClasses) {
                    if (data.theme === "dark") {
                        document.documentElement.classList.add("dark");
                    } else {
                        document.documentElement.classList.remove("dark");
                    }
                }
            }
            if (data.type === "preview") {
                properties.onPreview?.(message as MessageEvent<PreviewEvent>);
            }
        };
        globalThis.addEventListener("message", this.listener);

        this.send({ type: "ready" });
    }

    send(message: AppMessage) {
        if (!isAppMessage(message)) {
            throw new TypeError("Invalid app message");
        }
        this.parentWindow.postMessage(message, this.targetOrigin);
    }

    stop() {
        globalThis.removeEventListener("message", this.listener);
    }
}

export class AppHost {
    private listener: (message: MessageEvent) => void;

    private targetOrigin: string;
    constructor(
        readonly properties: {
            iframeOriginalSource: string;
            iframe: HTMLIFrameElement;
            onResize: (event: ResizeMessage) => void;
            onNavigate: (event: NavigationEvent) => void;
            onReady: () => void;
            // Optionally, you can add onFullscreen or onPreview handlers here as well.
        }
    ) {
        this.targetOrigin = normalizeAppOrigin(properties.iframeOriginalSource);

        this.listener = (message) => {
            if (
                !properties.iframe.contentWindow ||
                message.source !== properties.iframe.contentWindow ||
                message.origin !== this.targetOrigin ||
                !isAppMessage(message.data)
            ) {
                return;
            }

            const data = message.data;
            /* if (data.type === "size") { // Handled by the iframeresizer lib
                properties.onResize(message.data);
            } else  */ if (
                data.type === "navigate" &&
                isSafeNavigationTarget(data.to, this.targetOrigin)
            ) {
                properties.onNavigate(data);
            } else if (data.type === "ready") {
                properties.onReady();
            }

            // Additional events can be handled here if needed.
        };
        globalThis.addEventListener("message", this.listener);
    }

    send(message: AppMessage) {
        if (!isAppMessage(message)) {
            throw new TypeError("Invalid app message");
        }
        if (!this.properties.iframe.contentWindow) {
            throw new Error("Missing content window");
        }
        this.properties.iframe.contentWindow.postMessage(message, {
            targetOrigin: this.targetOrigin,
        });
    }

    stop() {
        globalThis.removeEventListener("message", this.listener);
    }
}
