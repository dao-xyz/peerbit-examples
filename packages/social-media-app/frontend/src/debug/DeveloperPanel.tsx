import React, { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useDebugConfig } from "./DebugConfig";
import { useDeveloperConfig, setDeveloperOptions } from "./DeveloperConfig";
import { subscribeLogs } from "./debug";
import { setupPrettyConsole } from "./debug";
import { buildCommit } from "../utils";

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

export const DeveloperPanel: React.FC<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
    const dbg = useDebugConfig();
    const dev = useDeveloperConfig();
    const [entries, setEntries] = useState<Entry[]>([]);
    const [perf, setPerf] = useState<any[]>([]);

    useEffect(() => {
        const unsub = subscribeLogs((e: any) => {
            setEntries((prev) => {
                const next = [...prev, e];
                return next.length > 300 ? next.slice(next.length - 300) : next;
            });
        });
        const onPerfPublish = (e: Event) => {
            try {
                const detail = (e as CustomEvent).detail;
                setPerf((p) => [
                    ...p,
                    { type: "publish", detail, t: Date.now() },
                ]);
            } catch {}
        };
        const onPerfPeer = (e: Event) => {
            try {
                const detail = (e as CustomEvent).detail;
                setPerf((p) => [...p, { type: "peer", detail, t: Date.now() }]);
            } catch {}
        };
        window.addEventListener("perf:publish", onPerfPublish as any);
        window.addEventListener("perf:peer", onPerfPeer as any);
        return () => {
            unsub();
            window.removeEventListener("perf:publish", onPerfPublish as any);
            window.removeEventListener("perf:peer", onPerfPeer as any);
        };
    }, []);

    // If debug gets enabled by any means, ensure console is patched (deferred) to avoid render-phase updates
    useEffect(() => {
        try {
            if (dbg.enabled) {
                setTimeout(() => {
                    try {
                        setupPrettyConsole();
                    } catch {}
                }, 0);
            }
        } catch {}
    }, [dbg.enabled]);

    const setDbg = (
        partial: Partial<{
            enabled: boolean;
            captureEvents: boolean;
            perfEnabled: boolean;
        }>
    ) => {
        try {
            const g: any = window as any;
            g.__DBG = { ...(g.__DBG || {}), ...partial };
            if (partial.enabled !== undefined) {
                try {
                    window.localStorage.setItem(
                        "debug",
                        partial.enabled ? "true" : "false"
                    );
                } catch {}
                if (partial.enabled) {
                    try {
                        setTimeout(() => setupPrettyConsole(), 0);
                    } catch {}
                }
            }
            window.dispatchEvent(new Event("__DBG:changed"));
        } catch {}
    };

    const Controls = useMemo(
        () => (
            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <span>Debug enabled</span>
                    <input
                        type="checkbox"
                        data-testid="dbg-enabled-toggle"
                        checked={!!dbg.enabled}
                        onChange={(e) => setDbg({ enabled: e.target.checked })}
                    />
                </div>
                <div className="flex items-center justify-between">
                    <span>Capture events</span>
                    <input
                        type="checkbox"
                        data-testid="dbg-capture-toggle"
                        checked={!!dbg.captureEvents}
                        onChange={(e) =>
                            setDbg({ captureEvents: e.target.checked })
                        }
                    />
                </div>
                <div className="flex items-center justify-between">
                    <span>Perf instrumentation</span>
                    <input
                        type="checkbox"
                        data-testid="dbg-perf-toggle"
                        checked={!!dbg.perfEnabled}
                        onChange={(e) =>
                            setDbg({ perfEnabled: e.target.checked })
                        }
                    />
                </div>
                <div className="flex items-center justify-between">
                    <label htmlFor="reveal-timeout-input" className="mr-2">
                        Reveal timeout (ms)
                    </label>
                    <input
                        id="reveal-timeout-input"
                        type="number"
                        className="input input-sm w-32 p-1 rounded bg-neutral-100 dark:bg-neutral-900"
                        value={dev.revealTimeoutMs ?? ""}
                        placeholder="default"
                        onChange={(e) => {
                            const val = e.target.value;
                            const num = val === "" ? undefined : Number(val);
                            if (num === undefined || Number.isFinite(num)) {
                                setDeveloperOptions({ revealTimeoutMs: num });
                            }
                        }}
                    />
                </div>
                <div className="flex items-center justify-between">
                    <span>Clear logs</span>
                    <button
                        className="btn btn-sm"
                        onClick={() => setEntries([])}
                    >
                        Clear
                    </button>
                </div>
            </div>
        ),
        [dbg.enabled, dbg.captureEvents, dbg.perfEnabled, dev.revealTimeoutMs]
    );
    // Avoid noisy logs in tests

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                {/* Make overlay non-interactive to avoid accidental click blocking if it lingers */}
                <Dialog.Overlay
                    data-testid="developer-overlay"
                    className="fixed inset-0 backdrop-blur-sm z-[10001] pointer-events-none"
                    // Extra guard: ensure overlay never captures pointer events
                    style={{ pointerEvents: "none" }}
                />
                {/* Content remains interactive */}
                <Dialog.Content className="fixed inset-0 z-[10002] flex flex-col max-h-[100vh] min-h-0 pointer-events-auto">
                    <div className="flex items-center justify-between p-3 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 border-b border-neutral-200 dark:border-neutral-800">
                        <Dialog.Title className="font-semibold text-lg">
                            Developer
                        </Dialog.Title>
                        <Dialog.Close asChild>
                            <button className="btn btn-sm">Close</button>
                        </Dialog.Close>
                    </div>
                    <div className="grid grid-rows-[auto_1fr] gap-3 p-3 overflow-hidden h-full min-h-0 bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
                        <div className="rounded border border-neutral-200 dark:border-neutral-800 p-3">
                            <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
                                Version {buildCommit}
                            </div>
                            {Controls}
                        </div>
                        <div className="grid md:grid-cols-2 grid-cols-1 gap-3 overflow-hidden min-h-0">
                            <div className="rounded border border-neutral-200 dark:border-neutral-800 p-2 overflow-hidden flex flex-col min-h-0">
                                <strong className="mb-2">Logs</strong>
                                <div className="overflow-auto text-xs font-mono leading-5 flex-1">
                                    {entries.map((e) => (
                                        <div
                                            key={e.id}
                                            className="flex gap-2 items-start"
                                        >
                                            <span className="text-neutral-400 min-w-16">
                                                {e.time.toLocaleTimeString()}
                                            </span>
                                            <span
                                                style={{
                                                    color: "#111827",
                                                    background:
                                                        levelColor[e.level],
                                                    borderRadius: 4,
                                                    padding: "0 6px",
                                                    minWidth: 44,
                                                    textAlign: "center",
                                                    fontWeight: 700,
                                                }}
                                            >
                                                {e.level.toUpperCase()}
                                            </span>
                                            <span className="whitespace-pre-wrap">
                                                {e.args
                                                    .map((a) => {
                                                        try {
                                                            if (
                                                                typeof a ===
                                                                "string"
                                                            )
                                                                return a;
                                                            return JSON.stringify(
                                                                a
                                                            );
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
                            <div className="rounded border border-neutral-200 dark:border-neutral-800 p-2 overflow-hidden flex flex-col min-h-0">
                                <strong className="mb-2 block">
                                    Perf events
                                </strong>
                                <div className="text-xs font-mono leading-5 overflow-auto flex-1">
                                    {perf.map((p, i) => (
                                        <div key={i} className="mb-2">
                                            <div className="text-neutral-300">
                                                {new Date(
                                                    p.t
                                                ).toLocaleTimeString()}{" "}
                                                · {p.type}
                                            </div>
                                            <pre className="whitespace-pre-wrap break-words">
                                                {JSON.stringify(
                                                    p.detail,
                                                    null,
                                                    2
                                                )}
                                            </pre>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
};
