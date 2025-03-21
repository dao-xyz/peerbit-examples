// @giga-app/sdk/src/HostProvider.tsx
import React, { createContext, useContext, useEffect, useRef } from "react";
import {
    AppHost,
    AppMessage,
    ResizeMessage,
    NavigationEvent,
} from "./client-host";

export interface HostProviderProps {
    children: React.ReactNode;
    /**
     * A ref to the iframe element that hosts the embedded app.
     */
    iframeRef: React.RefObject<HTMLIFrameElement>;
    /**
     * Optional callback for handling resize messages from the app.
     */
    onResize?: (message: MessageEvent<ResizeMessage>) => void;
    /**
     * Optional callback for handling navigation messages from the app.
     */
    onNavigate?: (message: MessageEvent<NavigationEvent>) => void;
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

export const HostProvider = ({
    children,
    iframeRef,
    onResize,
    onNavigate,
}: HostProviderProps) => {
    const hostRef = useRef<AppHost | null>(null);

    useEffect(() => {
        if (!iframeRef.current) return;
        hostRef.current = new AppHost({
            iframe: iframeRef.current,
            onResize:
                onResize ||
                ((message) => console.log("AppHost resize:", message.data)),
            onNavigate:
                onNavigate ||
                ((message) => console.log("AppHost navigate:", message.data)),
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
        <HostContext.Provider value={{ send }}>{children}</HostContext.Provider>
    );
};
