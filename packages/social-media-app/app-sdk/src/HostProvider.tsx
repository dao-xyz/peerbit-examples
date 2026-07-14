import React, {
    useCallback,
    createContext,
    useContext,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    AppHost,
    AppMessage,
    ResizeMessage,
    NavigationEvent,
    normalizeMatchingAppOrigin,
} from "./client-host";
import IFrameResizer from "./IFrameResizer";
import { useHostRegistry } from "./HostRegistryProvider"; // import the registry hook

export interface HostProviderProps {
    /**
     * A function child that receives the iframe ref.
     */
    children: (
        iframeRef: React.RefObject<HTMLIFrameElement | null>
    ) => React.ReactNode;
    /**
     * Optional callback for handling resize messages from the app.
     */
    onResize?: (message: ResizeMessage) => void;
    /**
     * Optional callback for handling navigation messages from the app.
     */
    onNavigate?: (message: NavigationEvent) => void;

    /**
     * The original source of the iframe. Before any navigation.
     */
    iframeOriginalSource: string;

    /**
     * The URL currently rendered by the iframe. Supplying it lets the host
     * reject an origin mismatch and reset readiness for document navigations.
     * It defaults to iframeOriginalSource for backwards compatibility.
     */
    iframeSource?: string;

    /**
     * Enable iframe-resizer only after the host has explicitly trusted the
     * embedded app and its child integration.
     */
    enableResizer?: boolean;
}

export interface HostContextType {
    /**
     * Send a message to the embedded app.
     */
    send?: (message: AppMessage) => void;

    /**
     * Is the client ready?
     */
    ready: boolean;
}

const HostContext = createContext<HostContextType | undefined>(undefined);

export const useHost = () => {
    const context = useContext(HostContext);
    if (!context) {
        throw new Error("useHost must be used within a HostProvider");
    }
    return context;
};

export const HostProvider: React.FC<HostProviderProps> = ({
    iframeOriginalSource,
    iframeSource,
    children,
    onResize,
    onNavigate,
    enableResizer = false,
}) => {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const hostRef = useRef<AppHost | null>(null);
    const { registerHost, unregisterHost } = useHostRegistry();
    const currentSource = iframeSource ?? iframeOriginalSource;
    const targetOrigin = normalizeMatchingAppOrigin(
        currentSource,
        iframeOriginalSource
    );
    const documentUrl = new URL(currentSource);
    // A fragment navigation retains the same Window/document and readiness.
    documentUrl.hash = "";
    const documentSource = documentUrl.href;
    const configuration = useMemo(
        () => ({
            targetOrigin,
            documentSource,
            onResize,
            onNavigate,
            enableResizer,
        }),
        [targetOrigin, documentSource, onResize, onNavigate, enableResizer]
    );
    const [activeHost, setActiveHost] = useState<{
        configuration: typeof configuration;
        host: AppHost;
        send: (message: AppMessage) => void;
    } | null>(null);
    const [readyHost, setReadyHost] = useState<AppHost | null>(null);

    // Install and tear down the authenticated listener in the layout phase.
    // React destroys the prior layout effect before descendants can emit
    // messages for the newly committed source, closing the passive-effect
    // window where a departing document could reach stale callbacks.
    useLayoutEffect(() => {
        const iframe = iframeRef.current;
        if (!iframe) return;

        const host = new AppHost({
            iframeOriginalSource: configuration.targetOrigin,
            iframe,
            onResize:
                configuration.onResize ||
                ((message) => console.log("AppHost resize:", message)),
            onNavigate:
                configuration.onNavigate ||
                ((message) => console.log("AppHost navigate:", message)),
            onReady: () => {
                if (hostRef.current === host) {
                    setReadyHost(host);
                }
            },
        });
        const send = host.send.bind(host);
        hostRef.current = host;
        registerHost(send);
        setActiveHost({ configuration, host, send });

        return () => {
            unregisterHost(send);
            host.stop();
            if (hostRef.current === host) {
                hostRef.current = null;
            }
        };
    }, [configuration, registerHost, unregisterHost]);

    // A prop change invalidates the old host during render, before effects run.
    // This prevents children from observing stale readiness or sending through
    // the previous origin/callback configuration.
    const currentHost =
        activeHost?.configuration === configuration ? activeHost : undefined;
    const send = currentHost?.send;
    const ready = currentHost !== undefined && readyHost === currentHost.host;

    const context = useMemo(() => {
        return {
            send,
            ready,
        };
    }, [send, ready]);

    const handleResizerResize = useCallback(
        (evt: { height: number; width: number }) => {
            onResize?.({
                height: evt.height,
                width: evt.width,
                type: "size",
            });
        },
        [onResize]
    );

    const iframe = children(iframeRef);

    return (
        <HostContext.Provider value={context}>
            {enableResizer ? (
                <IFrameResizer
                    license="GPLv3"
                    iframeRef={iframeRef}
                    onResize={handleResizerResize}
                >
                    {iframe}
                </IFrameResizer>
            ) : (
                iframe
            )}
        </HostContext.Provider>
    );
};
