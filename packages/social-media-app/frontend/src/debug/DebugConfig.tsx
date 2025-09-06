import React, { createContext, useContext, useMemo } from "react";
import { isDebugEnabled } from "./debug";

export type DebugOptions = {
    enabled: boolean;
    parent?: string; // only log events for this parent canvas id
    captureEvents?: boolean; // push structured events into window.__DBG_EVENTS
    tags?: string[]; // optional future use for filtering
};

type Ctx = {
    options: DebugOptions;
};

const DebugConfigCtx = createContext<Ctx>({ options: { enabled: false } });

export const useDebugConfig = () => useContext(DebugConfigCtx).options;

export const DebugConfigProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    const options = useMemo<DebugOptions>(() => {
        const g: any = typeof window !== "undefined" ? (window as any) : {};
        const globalDbg = (g.__DBG || {}) as Partial<DebugOptions> & {
            parent?: string;
        };
        // Back-compat alias: __DBG_PARENT
        const parent = globalDbg.parent || g.__DBG_PARENT;
        const enabled =
            typeof globalDbg.enabled === "boolean"
                ? globalDbg.enabled
                : isDebugEnabled();
        const captureEvents =
            typeof globalDbg.captureEvents === "boolean"
                ? globalDbg.captureEvents
                : enabled;
        const tags = Array.isArray(globalDbg.tags) ? globalDbg.tags : undefined;
        return { enabled, parent, captureEvents, tags };
    }, []);

    return (
        <DebugConfigCtx.Provider value={{ options }}>
            {children}
        </DebugConfigCtx.Provider>
    );
};
