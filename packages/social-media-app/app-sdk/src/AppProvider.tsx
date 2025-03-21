import React, {
    createContext,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";
import { usePeer } from "@peerbit/react";
import { IframeNavigationEmitter } from "./navigation-emitter";
import { AppClient, AppMessage } from "./client-host";

export interface AppProviderProps {
    children: React.ReactNode;
    /**
     * When set to "emit-all", every navigation change in the iframe is sent to the parent.
     */
    navigation?: "emit-all" | "none";
    /**
     * Optional override for targetOrigin if not available in PeerContext.
     */
    targetOrigin?: string;

    /*
     Optional theme logic how to handle theme events sent by parent
     */
    theme?: {
        // add a dark or light class to the documentElement
        useClasses?: boolean;
    };
}

export interface AppContextType {
    /**
     * Manually set the loading state.
     * When called, it sends a loading event (either "loading" or "loaded") to the parent.
     */
    setLoading: (loading: boolean) => void;
    /**
     * Request the parent to switch the app into fullscreen or exit fullscreen.
     */
    setFullscreen: (state: "enter" | "exit") => void;
    /**
     * The current view mode as sent by the parent.
     * For example, the parent may send a "preview" event to ask the app to display as a thumbnail.
     */
    previewState: "thumbnail" | "full";
    /**
     * The current theme as sent by the parent.
     */
    theme: "light" | "dark";
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const useApp = () => {
    const context = useContext(AppContext);
    if (!context) {
        throw new Error("useApp must be used within an AppProvider");
    }
    return context;
};

export const AppProvider = ({
    children,
    navigation = "none",
    targetOrigin: targetOriginProp,
    theme: themeOptions,
}: AppProviderProps) => {
    const peerContext = usePeer();

    // Determine targetOrigin from PeerContext if available, or fallback.
    const targetOrigin =
        peerContext.type === "proxy"
            ? peerContext.targetOrigin
            : targetOriginProp || "*";

    // Create a ref for an AppClient instance to send events.
    const statusClientRef = useRef<AppClient | null>(null);

    // Manage view state that the parent sends to the app.
    const [previewState, setPreviewState] = useState<"thumbnail" | "full">(
        "full"
    );

    // Manage theme state sent by the parent.
    const [theme, setTheme] = useState<"light" | "dark">("light");

    // Initialize our status client and emit the initial loading state.
    useEffect(() => {
        if (targetOrigin && !statusClientRef.current) {
            statusClientRef.current = new AppClient({
                targetOrigin,
                onResize: () => {
                    // No-op for status events.
                },
                useThemeClasses: themeOptions?.useClasses,
            });
        }
        if (statusClientRef.current) {
            statusClientRef.current.send({
                type: "loading",
                state: peerContext.loading ? "loading" : "loaded",
            });
        }
    }, [targetOrigin, peerContext.loading]);

    // Listen for preview events from the parent.
    useEffect(() => {
        const handleEvent = (event: MessageEvent) => {
            const data = event.data as AppMessage;
            if (data.type === "preview") {
                setPreviewState(data.state);
            } else if (data.type === "theme") {
                setTheme(data.theme);
            }
        };
        window.addEventListener("message", handleEvent);
        return () => {
            window.removeEventListener("message", handleEvent);
        };
    }, []);

    const setLoading = (loading: boolean) => {
        if (statusClientRef.current) {
            statusClientRef.current.send({
                type: "loading",
                state: loading ? "loading" : "loaded",
            });
        }
    };

    const setFullscreen = (state: "enter" | "exit") => {
        if (statusClientRef.current) {
            statusClientRef.current.send({
                type: "fullscreen",
                state,
            });
        }
    };

    return (
        <AppContext.Provider
            value={{ setLoading, setFullscreen, previewState, theme }}
        >
            {navigation === "emit-all" && targetOrigin && (
                <IframeNavigationEmitter targetOrigin={targetOrigin} />
            )}
            {children}
        </AppContext.Provider>
    );
};
