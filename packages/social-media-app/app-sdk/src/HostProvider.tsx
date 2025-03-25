import React, { createContext, useContext, useEffect, useRef } from "react";
import {
    AppHost,
    AppMessage,
    ResizeMessage,
    NavigationEvent,
} from "./client-host";
import IFrameResizer from "./IFrameResizer";

export interface HostProviderProps {
    /**
     * A function child that receives the iframe ref.
     */
    children: (
        iframeRef: React.RefObject<HTMLIFrameElement>
    ) => React.ReactNode;
    /**
     * Optional callback for handling resize messages from the app.
     */
    onResize?: (message: ResizeMessage) => void;
    /**
     * Optional callback for handling navigation messages from the app.
     */
    onNavigate?: (message: NavigationEvent) => void;
}

export interface HostContextType {
    /**
     * Send a message to the embedded app.
     */
    send: (message: AppMessage) => void;
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
    children,
    onResize,
    onNavigate,
}) => {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const hostRef = useRef<AppHost | null>(null);

    useEffect(() => {
        if (!iframeRef.current) return;
        hostRef.current = new AppHost({
            iframe: iframeRef.current,
            onResize:
                onResize ||
                ((message) => console.log("AppHost resize:", message)),
            onNavigate:
                onNavigate ||
                ((message) => console.log("AppHost navigate:", message)),
        });
        return () => {
            hostRef.current?.stop();
            hostRef.current = null;
        };
    }, [iframeRef.current]);

    const send = (message: AppMessage) => {
        if (!hostRef.current) {
            throw new Error("HostProvider is not initialized");
        }
        hostRef.current.send(message);
    };

    return (
        <HostContext.Provider value={{ send }}>
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
