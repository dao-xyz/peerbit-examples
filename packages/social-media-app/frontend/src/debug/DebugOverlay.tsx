import React, { useEffect, useMemo, useState } from "react";
import { isDebugEnabled, subscribeLogs } from "./debug";

type Entry = {
    id: number;
    time: Date;
    level: "debug" | "info" | "warn" | "error" | "log";
    args: unknown[];
};

const levelColor: Record<Entry["level"], string> = {
    debug: "#93C5FD",
    info: "#A7F3D0",
    warn: "#FDE68A",
    error: "#FCA5A5",
    log: "#E5E7EB",
};

export const DebugOverlay: React.FC = () => {
    const [open, setOpen] = useState(false);
    const [entries, setEntries] = useState<Entry[]>([]);

    useEffect(() => {
        if (!isDebugEnabled()) return;
        const unsub = subscribeLogs((e: any) => {
            setEntries((prev) => {
                const next = [...prev, e];
                // keep last 300 lines to avoid memory growth
                return next.length > 300 ? next.slice(next.length - 300) : next;
            });
        });
        return () => unsub();
    }, []);

    const button = useMemo(
        () => (
            <button
                onClick={() => setOpen((s) => !s)}
                style={{
                    position: "fixed",
                    bottom: 12,
                    right: 12,
                    zIndex: 999999,
                    background: "#111827",
                    color: "white",
                    borderRadius: 8,
                    padding: "6px 10px",
                    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
                    opacity: 0.8,
                }}
                aria-label="Toggle debug log overlay"
            >
                {open ? "Hide Logs" : "Show Logs"}
            </button>
        ),
        [open]
    );

    if (!isDebugEnabled()) return null;

    return (
        <>
            {button}
            {open && (
                <div
                    style={{
                        position: "fixed",
                        bottom: 48,
                        right: 12,
                        width: "min(720px, 95vw)",
                        height: "40vh",
                        background: "rgba(17, 24, 39, 0.95)",
                        color: "#E5E7EB",
                        border: "1px solid #374151",
                        borderRadius: 8,
                        padding: 8,
                        zIndex: 999998,
                        display: "flex",
                        flexDirection: "column",
                        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                    }}
                >
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                        }}
                    >
                        <strong style={{ flex: 1 }}>Debug Logs</strong>
                        <button
                            onClick={() => setEntries([])}
                            style={{
                                border: "1px solid #4B5563",
                                borderRadius: 6,
                                padding: "2px 8px",
                                background: "transparent",
                                color: "#D1D5DB",
                            }}
                        >
                            Clear
                        </button>
                    </div>
                    <div
                        style={{
                            marginTop: 6,
                            overflow: "auto",
                            fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                            fontSize: 12,
                            lineHeight: 1.4,
                            flex: 1,
                            whiteSpace: "pre-wrap",
                        }}
                    >
                        {entries.map((e) => (
                            <div
                                key={e.id}
                                style={{
                                    display: "flex",
                                    gap: 8,
                                    alignItems: "flex-start",
                                }}
                            >
                                <span
                                    style={{ color: "#9CA3AF", minWidth: 64 }}
                                >
                                    {e.time.toLocaleTimeString()}
                                </span>
                                <span
                                    style={{
                                        color: "#111827",
                                        background: levelColor[e.level],
                                        borderRadius: 4,
                                        padding: "0 6px",
                                        minWidth: 44,
                                        textAlign: "center",
                                        fontWeight: 700,
                                    }}
                                >
                                    {e.level.toUpperCase()}
                                </span>
                                <span>
                                    {e.args
                                        .map((a) => {
                                            try {
                                                if (typeof a === "string")
                                                    return a;
                                                return JSON.stringify(a);
                                            } catch {
                                                return String(a);
                                            }
                                        })
                                        .join(" ")}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </>
    );
};
