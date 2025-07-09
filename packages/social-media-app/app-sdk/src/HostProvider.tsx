import React, {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    AppHost,
    AppMessage,
    ResizeMessage,
    NavigationEvent,
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
    children,
    onResize,
    onNavigate,
}) => {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const hostRef = useRef<AppHost | null>(null);
    const { registerHost, unregisterHost } = useHostRegistry();
    const registeredFn = useRef<((args: any) => any) | undefined>(undefined);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        if (!iframeRef.current) return;
        hostRef.current = new AppHost({
            iframeOriginalSource,
            iframe: iframeRef.current,
            onResize:
                onResize ||
                ((message) => console.log("AppHost resize:", message)),
            onNavigate:
                onNavigate ||
                ((message) => console.log("AppHost navigate:", message)),
            onReady: () => {
                setReady(true);
            },
        });
        // Register this host's send function.
        if (hostRef.current) {
            registeredFn.current = hostRef.current.send.bind(hostRef.current);
            registerHost(registeredFn.current);
        }

        return () => {
            if (hostRef.current) {
                registeredFn.current && unregisterHost(registeredFn.current);
                hostRef.current.stop();
                hostRef.current = null;
            }
        };
    }, [iframeRef.current]);

    const send = hostRef.current
        ? (message: AppMessage) => {
              hostRef.current?.send(message);
          }
        : undefined;

    const context = useMemo(() => {
        return {
            send,
            ready,
        };
    }, [send, ready]);

    return (
        <HostContext.Provider value={context}>
            <IFrameResizer
                license="GPLv3"
                iframeRef={iframeRef}
                onResize={(evt) => {
                    onResize?.({
                        height: evt.height,
                        width: evt.width,
                        type: "size",
                    });
                }}
            >
                {children(iframeRef)}
            </IFrameResizer>
        </HostContext.Provider>
    );
};
