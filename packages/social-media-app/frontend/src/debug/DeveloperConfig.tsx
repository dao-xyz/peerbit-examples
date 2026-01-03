import React, {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";

export type DeveloperOptions = {
    /** If set, overrides default reveal timeout for posts (milliseconds) */
    revealTimeoutMs?: number;
    /** Enables verbose scroll restoration logging */
    scrollRestoreDebug?: boolean;
};

type Ctx = {
    options: DeveloperOptions;
};

const DeveloperConfigCtx = createContext<Ctx>({ options: {} });

export const useDeveloperConfig = () => useContext(DeveloperConfigCtx).options;

export const DeveloperConfigProvider: React.FC<{
    children: React.ReactNode;
}> = ({ children }) => {
    const compute = (): DeveloperOptions => {
        const g: any = typeof window !== "undefined" ? (window as any) : {};
        const mergedParams = (() => {
            try {
                const merged = new URLSearchParams(window.location.search);
                const hash = window.location.hash || "";
                const qIndex = hash.indexOf("?");
                if (qIndex !== -1) {
                    const hashQuery = hash
                        .substring(qIndex + 1)
                        .replace(/^\/?/, "");
                    const hashParams = new URLSearchParams(hashQuery);
                    hashParams.forEach((v, k) => {
                        if (!merged.has(k)) merged.set(k, v);
                    });
                }
                return merged;
            } catch {
                return new URLSearchParams();
            }
        })();
        const global = (g.__DEV as DeveloperOptions) || {};
        const fromUrl = (() => {
            const v = mergedParams.get("devRevealTimeout");
            if (v == null || v === "") return {} as DeveloperOptions;
            const n = Number(v);
            return Number.isFinite(n)
                ? ({ revealTimeoutMs: n } as DeveloperOptions)
                : ({} as DeveloperOptions);
        })();
        const fromUrlBool = (() => {
            const v = mergedParams.get("devScrollRestoreDebug");
            if (v == null || v === "") return {} as DeveloperOptions;
            const on = v === "1" || v.toLowerCase() === "true";
            return { scrollRestoreDebug: on } as DeveloperOptions;
        })();
        const options: DeveloperOptions = {
            revealTimeoutMs:
                typeof global.revealTimeoutMs === "number"
                    ? global.revealTimeoutMs
                    : typeof fromUrl.revealTimeoutMs === "number"
                      ? fromUrl.revealTimeoutMs
                      : undefined,
            scrollRestoreDebug:
                typeof global.scrollRestoreDebug === "boolean"
                    ? global.scrollRestoreDebug
                    : typeof fromUrlBool.scrollRestoreDebug === "boolean"
                      ? fromUrlBool.scrollRestoreDebug
                      : undefined,
        };
        // sync back to global for easy ad-hoc tweaking
        g.__DEV = { ...(g.__DEV || {}), ...options };
        return options;
    };

    const [options, setOptions] = useState<DeveloperOptions>(() => compute());

    useEffect(() => {
        const onChange = () => setOptions(compute());
        window.addEventListener("__DEV:changed", onChange as any);
        window.addEventListener("hashchange", onChange as any);
        window.addEventListener("popstate", onChange as any);
        return () => {
            window.removeEventListener("__DEV:changed", onChange as any);
            window.removeEventListener("hashchange", onChange as any);
            window.removeEventListener("popstate", onChange as any);
        };
    }, []);

    const value = useMemo(() => ({ options }), [options]);

    return (
        <DeveloperConfigCtx.Provider value={value}>
            {children}
        </DeveloperConfigCtx.Provider>
    );
};

export const setDeveloperOptions = (partial: Partial<DeveloperOptions>) => {
    try {
        const g: any = window as any;
        const next: DeveloperOptions = { ...(g.__DEV || {}), ...partial };
        g.__DEV = next;
        // update URL hash query params so refresh persists settings
        try {
            const hash = window.location.hash || "";
            const qIndex = hash.indexOf("?");
            const base = qIndex === -1 ? hash : hash.substring(0, qIndex);
            const queryStr = qIndex === -1 ? "" : hash.substring(qIndex + 1);
            const params = new URLSearchParams(queryStr);
            {
                const key = "devRevealTimeout";
                if (next.revealTimeoutMs == null) params.delete(key);
                else params.set(key, String(next.revealTimeoutMs));
            }
            {
                const key = "devScrollRestoreDebug";
                if (next.scrollRestoreDebug == null) params.delete(key);
                else
                    params.set(key, next.scrollRestoreDebug ? "1" : "0");
            }
            const newQuery = params.toString();
            const url = new URL(window.location.href);
            url.hash = base + (newQuery ? "?" + newQuery : "");
            window.history.replaceState(
                window.history.state,
                "",
                url.toString()
            );
        } catch {}
        window.dispatchEvent(new Event("__DEV:changed"));
    } catch {}
};
