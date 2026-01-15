import React, {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import { isDebugEnabled } from "./debug";

export type DebugOptions = {
    enabled: boolean;
    parent?: string; // only log events for this parent canvas id
    captureEvents?: boolean; // push structured events into window.__DBG_EVENTS
    tags?: string[]; // optional future use for filtering
    perfEnabled?: boolean; // enable perf instrumentation
};

type Ctx = {
    options: DebugOptions;
};

const DebugConfigCtx = createContext<Ctx>({ options: { enabled: false } });

export const useDebugConfig = () => useContext(DebugConfigCtx).options;

export const DebugConfigProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    const compute = (): DebugOptions => {
        const g: any = typeof window !== "undefined" ? (window as any) : {};
        const globalDbg = (g.__DBG || {}) as Partial<DebugOptions> & {
            parent?: string;
        };
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
        const searchPerf = (() => {
            try {
                // Support both regular and hash-router query params
                const merged = new URLSearchParams(window.location.search);
                if (merged.has("perf")) return true;
                const hash = window.location.hash || "";
                const qIndex = hash.indexOf("?");
                if (qIndex === -1) return false;
                const hashQuery = hash.substring(qIndex + 1);
                const clean = hashQuery.replace(/^\/?/, "");
                return new URLSearchParams(clean).has("perf");
            } catch {
                return false;
            }
        })();
        const perfEnabled =
            typeof (globalDbg as any).perfEnabled === "boolean"
                ? (globalDbg as any).perfEnabled
                : typeof (globalDbg as any).perf === "boolean"
                  ? (globalDbg as any).perf
                  : searchPerf;
        g.__DBG = {
            ...globalDbg,
            enabled,
            parent,
            captureEvents,
            tags,
            perfEnabled,
            perf: perfEnabled,
        };
        return { enabled, parent, captureEvents, tags, perfEnabled };
    };

    const [options, setOptions] = useState<DebugOptions>(() => compute());

    useEffect(() => {
        const onChange = () => setOptions(compute());
        window.addEventListener("__DBG:changed", onChange as any);
        return () =>
            window.removeEventListener("__DBG:changed", onChange as any);
    }, []);

    return (
        <DebugConfigCtx.Provider value={{ options }}>
            {children}
        </DebugConfigCtx.Provider>
    );
};
