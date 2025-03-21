export interface ResizeMessage {
    type: "size";
    width: number;
    height: number;
}

export interface NavigationEvent {
    type: "navigate";
    to: string;
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
    | ThemeEvent;

export class AppClient {
    private listener: (message: MessageEvent) => void;
    constructor(
        readonly properties: {
            targetOrigin: string;
            onResize: (event: MessageEvent<ResizeMessage>) => void;
            onTheme?: (event: MessageEvent<ThemeEvent>) => void;
            useThemeClasses?: boolean;
        }
    ) {
        this.listener = (message) => {
            const data = message.data as AppMessage;
            // For now, we only handle size events (and others can be handled by custom listeners).
            if (data.type === "size") {
                properties.onResize(message);
            }
            if (data.type === "theme" && properties.onTheme) {
                properties.onTheme(message);
                if (properties.useThemeClasses) {
                    if (data.theme === "dark") {
                        document.documentElement.classList.add("dark");
                    } else {
                        document.documentElement.classList.remove("dark");
                    }
                }
            }
        };
        globalThis.addEventListener("message", this.listener);
    }

    send(message: AppMessage) {
        (globalThis.top || globalThis).postMessage(
            message,
            this.properties.targetOrigin
        );
    }

    stop() {
        globalThis.removeEventListener("message", this.listener);
    }
}

export class AppHost {
    private listener: (message: MessageEvent) => void;
    constructor(
        readonly properties: {
            iframe: HTMLIFrameElement;
            onResize: (event: MessageEvent<ResizeMessage>) => void;
            onNavigate: (event: MessageEvent<NavigationEvent>) => void;
            // Optionally, you can add onFullscreen or onPreview handlers here as well.
        }
    ) {
        this.listener = (message) => {
            const data = message.data as AppMessage;
            if (data.type === "size") {
                properties.onResize(message);
            } else if (data.type === "navigate") {
                properties.onNavigate(message);
            }
            // Additional events can be handled here if needed.
        };
        globalThis.addEventListener("message", this.listener);
    }

    send(message: AppMessage) {
        if (!this.properties.iframe.contentWindow) {
            throw new Error("Missing content window");
        }
        this.properties.iframe.contentWindow.postMessage(message);
    }

    stop() {
        globalThis.removeEventListener("message", this.listener);
    }
}
