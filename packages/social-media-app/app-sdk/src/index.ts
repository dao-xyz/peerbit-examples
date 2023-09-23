interface ResizeMessage {
    type: "size";
    width: number;
    height: number;
}

interface NavigationEvent {
    type: "navigate";
    to: string;
}

export class AppClient {
    private listener: (message: MessageEvent) => void;
    constructor(
        readonly properties: {
            targetOrigin: string;
            onResize: (event: MessageEvent<ResizeMessage>) => void;
        }
    ) {
        this.listener = (message) => {
            const data = message.data as ResizeMessage;
            if (data.type === "size") {
                properties.onResize(message);
            }
        };
        globalThis.addEventListener("message", this.listener);
    }

    send(message: ResizeMessage | NavigationEvent) {
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
        }
    ) {
        this.listener = (message) => {
            const data = message.data as ResizeMessage | NavigationEvent;
            if (data.type === "size") {
                properties.onResize(message);
            } else if (data.type === "navigate") {
                properties.onResize(message);
            }
        };
        globalThis.addEventListener("message", this.listener);
    }

    send(message: ResizeMessage | NavigationEvent) {
        if (!this.properties.iframe.contentWindow) {
            throw new Error("Missing content window");
        }
        this.properties.iframe.contentWindow.postMessage(message);
    }

    stop() {
        globalThis.removeEventListener("message", this.listener);
    }
}
