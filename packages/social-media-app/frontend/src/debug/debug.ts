// Lightweight debug utilities: detects debug mode and prettifies console output.

export type LogLevel = "debug" | "info" | "warn" | "error" | "log";

let debugEnabled: boolean | null = null;

export const isDebugEnabled = () => {
    if (debugEnabled !== null) return debugEnabled;
    try {
        // Support both regular and hash router query parameters
        const rawSearch =
            window.location.search ||
            (window.location.hash.includes("?")
                ? window.location.hash.split("?")[1]
                : "");
        const params = new URLSearchParams(rawSearch);
        const qp = params.get("debug");
        const ls = window.localStorage.getItem("debug");
        const env = import.meta.env?.VITE_DEBUG;
        debugEnabled =
            qp === "1" ||
            qp === "true" ||
            ls === "1" ||
            ls === "true" ||
            env === true ||
            env === "true";
    } catch {
        debugEnabled = false;
    }
    return debugEnabled;
};

type LogEntry = { id: number; time: Date; level: LogLevel; args: unknown[] };

type Subscriber = (entry: LogEntry) => void;

const subscribers = new Set<Subscriber>();
let nextId = 1;

export const subscribeLogs = (fn: Subscriber) => {
    subscribers.add(fn);
    // React expects cleanup to return void; wrap deletion.
    return () => {
        try {
            subscribers.delete(fn);
        } catch {}
    };
};

const emit = (level: LogLevel, args: unknown[]) => {
    const entry: LogEntry = { id: nextId++, time: new Date(), level, args };
    subscribers.forEach((s) => s(entry));
};

// Patch console in debug mode to add a styled prefix and emit to overlay store.
export const setupPrettyConsole = () => {
    if (!isDebugEnabled()) return;
    if ((window as any).__pretty_console_patched__) return;
    (window as any).__pretty_console_patched__ = true;

    const style =
        "color:#6EE7B7;background:#064E3B;border-radius:4px;padding:1px 6px;margin-right:6px;font-weight:600;";
    const tsStyle = "color:#999;";

    const wrap =
        (level: LogLevel, original: (...a: any[]) => void) =>
        (...args: any[]) => {
            const ts =
                new Date().toISOString().split("T")[1]?.replace("Z", "") || "";
            try {
                emit(level, args);
            } catch {}
            try {
                original(`%cDBG%c ${ts}`, style, tsStyle, ...args);
            } catch {
                original("[DBG]", ...args);
            }
        };

    const c = window.console;
    c.log = wrap("log", c.log.bind(c));
    c.debug = wrap("debug", c.debug ? c.debug.bind(c) : c.log.bind(c));
    c.info = wrap("info", c.info ? c.info.bind(c) : c.log.bind(c));
    c.warn = wrap("warn", c.warn ? c.warn.bind(c) : c.log.bind(c));
    c.error = wrap("error", c.error ? c.error.bind(c) : c.log.bind(c));
};

export const debugLog = (...args: unknown[]) => {
    if (!isDebugEnabled()) return;
    // Using console.log ensures we consistently apply the pretty wrapper above
    // and also shows in the overlay.
    // eslint-disable-next-line no-console
    console.log(...args);
};

// Structured debug events for tests and overlays
export type DebugEvent = {
    source: string;
    name: string;
    [key: string]: unknown;
};

export const emitDebugEvent = (event: DebugEvent) => {
    try {
        const w: any = typeof window !== "undefined" ? (window as any) : {};
        const g: any = w && w.top ? w.top : w;
        if (!Array.isArray(g.__DBG_EVENTS)) g.__DBG_EVENTS = [];
        if (w && w !== g && w.__DBG_EVENTS !== g.__DBG_EVENTS) {
            try {
                w.__DBG_EVENTS = g.__DBG_EVENTS;
            } catch {
                /* ignore */
            }
        }
        g.__DBG_EVENTS.push(event);
        g.__DBG_EVENTS_COUNT = (g.__DBG_EVENTS_COUNT ?? 0) + 1;
        try {
            console.debug("[DBG_EVT]", event.source, event.name);
        } catch {}
    } catch {}
};
