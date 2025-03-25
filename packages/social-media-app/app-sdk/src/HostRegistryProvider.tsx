// HostRegistry.tsx
import React, { createContext, useContext, useState, useCallback } from "react";
import { AppMessage } from "./client-host";

export interface HostRegistryContextType {
    registerHost: (send: (message: AppMessage) => void) => void;
    unregisterHost: (send: (message: AppMessage) => void) => void;
    broadcast: (message: AppMessage) => void;
}

const HostRegistryContext = createContext<HostRegistryContextType | null>(null);

export const useHostRegistry = () => {
    const context = useContext(HostRegistryContext);
    if (!context) {
        throw new Error(
            "useHostRegistry must be used within a HostRegistryProvider"
        );
    }
    return context;
};

export const HostRegistryProvider: React.FC<any> = ({ children }) => {
    const [hosts, setHosts] = useState<Array<(message: AppMessage) => void>>(
        []
    );

    const registerHost = useCallback((send: (message: AppMessage) => void) => {
        setHosts((prev) => [...prev, send]);
    }, []);

    const unregisterHost = useCallback(
        (send: (message: AppMessage) => void) => {
            setHosts((prev) => prev.filter((s) => s !== send));
        },
        []
    );

    const broadcast = useCallback(
        (message: AppMessage) => {
            hosts.forEach((send) => send(message));
        },
        [hosts]
    );

    return (
        <HostRegistryContext.Provider
            value={{ registerHost, unregisterHost, broadcast }}
        >
            {children}
        </HostRegistryContext.Provider>
    );
};
