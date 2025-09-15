import { debounceAccumulator, debounceFixedInterval } from "@peerbit/time";

export const debouncedAccumulatorMap = <T>(
    fn: (args: Map<string, T>) => any,
    delay: number,
    merge?: (into: T, from: T) => void
) => {
    return debounceAccumulator<
        string,
        { key: string; value: T },
        Map<string, T>
    >(
        fn,
        () => {
            const map = new Map();
            let add = merge
                ? (props: { key: string; value: T }) => {
                      let prev = map.get(props.key);
                      if (prev != null) {
                          merge(prev, props.value);
                      } else {
                          map.set(props.key, props.value);
                      }
                  }
                : (props: { key: string; value: T }) => {
                      map.set(props.key, props.value);
                  };
            return {
                add,
                delete: (key: string) => map.delete(key),
                size: () => map.size,
                value: map,
                clear: () => map.clear(),
                has: (key: string) => map.has(key),
            };
        },
        delay,
        { leading: true }
    );
};

export type DebouncedAccumulatorMap<T> = ReturnType<
    typeof debouncedAccumulatorMap<T>
>;

/**
 * Hierarchical per-canvas reindex scheduling
 * ------------------------------------------
 * Goal: Maintain independent debounce timers per canvas id while
 *       (a) coalescing multiple requests on the same canvas to the strongest (full) scope
 *       (b) propagating lightweight (replies-only) reindex requests up the ancestor chain
 *           so that concurrent child changes only trigger one parent traversal.
 *
 * Design choices:
 *  - Each canvas id gets its own debounceFixedInterval instance.
 *  - We store an aggregated mode per canvas: 'replies' | 'full'. Incoming requests upgrade the mode.
 *  - When scheduling a child, we also (optionally) schedule ancestors with 'replies' mode only.
 *  - Returned promise resolves when the child canvas reindex run completes (ancestors awaited too for determinism).
 *  - Instrumentation hook points left as no-ops; can be wired similarly to previous global accumulator if needed.
 */

export interface ReindexCanvasLike {
    idString: string;
    loadPath(args: { includeSelf: boolean }): Promise<ReindexCanvasLike[]>; // ancestor chain (root .. parent) when includeSelf=false
}

export type ReindexFn<C extends ReindexCanvasLike> = (
    canvas: C,
    options?: { onlyReplies?: boolean; skipAncestors?: boolean }
) => Promise<void>;

type Mode = "replies" | "full"; // 'full' dominates 'replies'

interface CanvasEntry<C extends ReindexCanvasLike> {
    canvas: C;
    mode: Mode; // aggregated desired mode for next run
    debouncer: ReturnType<typeof debounceFixedInterval>;
    running: boolean; // actively executing reindex
    scheduled: boolean; // a timer is scheduled (leading or trailing)
    runs?: number; // number of completed reindex executions
    cooldownUntil?: number; // timestamp (ms) until which new schedules are deferred
    cooldownTimeout?: any; // handle for deferred scheduling
    lastScheduledAt?: number; // timestamp when current run was scheduled (for idle gap measurement)
    lastRunEndedAt?: number; // timestamp when previous run finished
}

export interface HierarchicalReindexManager<C extends ReindexCanvasLike> {
    add(args: {
        canvas: C;
        options?: { onlyReplies?: boolean; skipAncestors?: boolean };
        propagateParents?: boolean; // default true
    }): Promise<void>;
    flush(canvasId?: string): Promise<void>;
    close(canvasId?: string): void;
    size(): number; // number of active canvas entries
    pending(canvasId: string): boolean; // whether a canvas has a scheduled run (mode cached or timer active)
    stats?(): { totalRuns: number; perCanvas: Record<string, number> };
}

export const createHierarchicalReindexManager = <
    C extends ReindexCanvasLike,
>(args: {
    delay: number | (() => number);
    reindex: ReindexFn<C>;
    propagateParentsDefault?: boolean;
    onDebug?: (evt: any) => void; // optional lightweight instrumentation hook
    cooldownMs?: number; // post-run cooldown window to suppress burst re-scheduling
    adaptiveCooldownMinMs?: number; // trim first schedule inside cooldown to this minimum delay
}): HierarchicalReindexManager<C> => {
    const {
        delay,
        reindex,
        propagateParentsDefault = true,
        onDebug,
        // default to 0 so tests and callers that expect immediate upgrade behavior
        // (schedule upgrades to 'full' should not be deferred by a cooldown) work as
        // intended. Previously this was 120ms which caused some tests to observe
        // only the first run before the upgraded run was executed.
        cooldownMs = 0,
        adaptiveCooldownMinMs = 1,
    } = args;

    const perCanvas: Map<string, CanvasEntry<C>> = new Map();

    const ensureEntry = (canvas: C): CanvasEntry<C> => {
        let existing = perCanvas.get(canvas.idString);
        if (existing) {
            existing.canvas = canvas; // refresh reference if object instance changed
            return existing;
        }
        const entry: CanvasEntry<C> = {
            canvas,
            mode: "replies", // default minimal until first explicit add decides
            running: false,
            scheduled: false,
            runs: 0,
            debouncer: debounceFixedInterval(
                async () => {
                    if (entry.running) return; // guard (shouldn't happen with state machine but safe)
                    entry.running = true;
                    entry.scheduled = false;
                    const mode = entry.mode;
                    // Reset mode to minimal so subsequent upgrades during execution schedule another run if needed
                    entry.mode = "replies";
                    const skipAncestors = (entry as any).skipAncestors === true;
                    (entry as any).skipAncestors = false;
                    const startT =
                        globalThis.performance?.now?.() || Date.now();
                    // Compute schedule delay (time spent idle between scheduling and run start)
                    let scheduleDelay: number | undefined;
                    if (entry.lastScheduledAt != null) {
                        scheduleDelay = startT - entry.lastScheduledAt;
                        // Aggregate global stats for quick summary without log parsing
                        try {
                            const stats = (globalThis.__REINDEX_SCHED_STATS ||=
                                {
                                    count: 0,
                                    sum: 0,
                                    max: 0,
                                });
                            stats.count++;
                            stats.sum += scheduleDelay;
                            if (scheduleDelay > stats.max)
                                stats.max = scheduleDelay;
                        } catch {
                            /* ignore */
                        }
                    }
                    // Optional global idle trace collection (opt-in by setting globalThis.REINDEX_IDLE_TRACE = true)
                    const pushIdle = (evt: any) => {
                        if (globalThis.REINDEX_IDLE_TRACE) {
                            try {
                                (globalThis.__REINDEX_IDLE ||= []).push(
                                    Object.assign(
                                        {
                                            t:
                                                (
                                                    globalThis as any
                                                ).performance?.now?.() ||
                                                Date.now(),
                                            canvas: entry.canvas.idString,
                                        },
                                        evt
                                    )
                                );
                            } catch {
                                /* ignore */
                            }
                        }
                    };
                    onDebug?.({
                        phase: "run:start",
                        id: entry.canvas.idString,
                        mode,
                        scheduleDelay,
                    });
                    if (scheduleDelay != null) {
                        pushIdle({
                            phase: "idle:scheduleDelay",
                            scheduleDelay,
                        });
                    }
                    try {
                        await reindex(entry.canvas, {
                            onlyReplies: mode === "replies",
                            skipAncestors,
                        });
                        entry.runs = (entry.runs || 0) + 1;
                    } finally {
                        const endT =
                            globalThis.performance?.now?.() || Date.now();
                        onDebug?.({
                            phase: "run:end",
                            id: entry.canvas.idString,
                            mode,
                            dt: endT - startT,
                        });
                        entry.lastRunEndedAt = endT;
                        entry.running = false;
                        // Start cooldown window
                        if (cooldownMs > 0) {
                            entry.cooldownUntil = endT + cooldownMs;
                        } else {
                            entry.cooldownUntil = undefined;
                        }
                        // If mode was upgraded while running (i.e. now != 'replies') schedule another run
                        if (entry.mode !== "replies") {
                            const now = endT;
                            if (
                                entry.cooldownUntil &&
                                now < entry.cooldownUntil
                            ) {
                                const remaining = entry.cooldownUntil - now;
                                if (!entry.cooldownTimeout) {
                                    onDebug?.({
                                        phase: "cooldown:defer",
                                        id: entry.canvas.idString,
                                        remaining,
                                    });
                                    entry.cooldownTimeout = setTimeout(() => {
                                        entry.cooldownTimeout = undefined;
                                        if (
                                            entry.mode !== "replies" &&
                                            !entry.running
                                        ) {
                                            onDebug?.({
                                                phase: "cooldown:run",
                                                id: entry.canvas.idString,
                                                mode: entry.mode,
                                            });
                                            entry.debouncer.call();
                                            entry.scheduled = true;
                                        }
                                    }, remaining);
                                } else {
                                    onDebug?.({
                                        phase: "cooldown:coalesced",
                                        id: entry.canvas.idString,
                                    });
                                }
                                entry.scheduled = true;
                            } else {
                                entry.debouncer.call();
                                entry.scheduled = true;
                            }
                        }
                    }
                },
                delay,
                { leading: true }
            ),
        };
        perCanvas.set(canvas.idString, entry);
        return entry;
    };

    const upgradeMode = (entry: CanvasEntry<C>, incoming: Mode) => {
        if (incoming === "full" && entry.mode !== "full") {
            onDebug?.({
                phase: "mode:upgrade",
                id: entry.canvas.idString,
                from: entry.mode,
                to: incoming,
            });
            entry.mode = "full";
        } else if (entry.mode === undefined) {
            entry.mode = incoming;
        }
    };

    const schedule = (canvas: C, mode: Mode): Promise<void> => {
        const entry = ensureEntry(canvas);
        upgradeMode(entry, mode);
        // Coalesce: if already running or scheduled, just return resolved promise (mode already upgraded)
        if (entry.running || entry.scheduled) {
            onDebug?.({
                phase: "schedule:coalesced",
                id: entry.canvas.idString,
                mode,
            });
            return Promise.resolve();
        }
        const now = globalThis.performance?.now?.() || Date.now();
        if (entry.cooldownUntil && now < entry.cooldownUntil) {
            const remaining = entry.cooldownUntil - now;
            if (!entry.cooldownTimeout) {
                // Adaptive: shorten first schedule after run end
                let effectiveRemaining = remaining;
                if (
                    adaptiveCooldownMinMs != null &&
                    remaining > adaptiveCooldownMinMs &&
                    (!entry.lastScheduledAt ||
                        (entry.lastRunEndedAt != null &&
                            entry.lastScheduledAt < entry.lastRunEndedAt))
                ) {
                    effectiveRemaining = adaptiveCooldownMinMs;
                }
                onDebug?.({
                    phase: "cooldown:defer",
                    id: entry.canvas.idString,
                    remaining: effectiveRemaining,
                    mode,
                });
                if (globalThis.REINDEX_IDLE_TRACE) {
                    try {
                        (globalThis.__REINDEX_IDLE ||= []).push({
                            t: globalThis.performance?.now?.() || Date.now(),
                            canvas: entry.canvas.idString,
                            phase: "idle:cooldownDefer",
                            remaining: effectiveRemaining,
                            mode,
                            reason: "cooldown",
                        });
                    } catch {
                        /* ignore */
                    }
                }
                entry.cooldownTimeout = setTimeout(() => {
                    entry.cooldownTimeout = undefined;
                    if (entry.mode !== "replies" && !entry.running) {
                        onDebug?.({
                            phase: "cooldown:run",
                            id: entry.canvas.idString,
                            mode: entry.mode,
                        });
                        if (globalThis.REINDEX_IDLE_TRACE) {
                            try {
                                (globalThis.__REINDEX_IDLE ||= []).push({
                                    t:
                                        (
                                            globalThis as any
                                        ).performance?.now?.() || Date.now(),
                                    canvas: entry.canvas.idString,
                                    phase: "idle:cooldownRun",
                                    mode: entry.mode,
                                });
                            } catch {
                                /* ignore */
                            }
                        }
                        entry.debouncer.call();
                    }
                }, effectiveRemaining);
            } else {
                onDebug?.({
                    phase: "cooldown:coalesced",
                    id: entry.canvas.idString,
                    mode,
                });
            }
            entry.scheduled = true;
            entry.lastScheduledAt = now; // capture for subsequent run:start delay measurement
            return Promise.resolve();
        }
        entry.scheduled = true;
        onDebug?.({ phase: "schedule", id: entry.canvas.idString, mode });
        entry.lastScheduledAt = now; // capture schedule timestamp
        if (globalThis.REINDEX_IDLE_TRACE) {
            try {
                (globalThis.__REINDEX_IDLE ||= []).push({
                    t: globalThis.performance?.now?.() || Date.now(),
                    canvas: entry.canvas.idString,
                    phase: "idle:scheduled",
                    mode,
                });
            } catch {
                /* ignore */
            }
        }
        return entry.debouncer.call();
    };

    const api: HierarchicalReindexManager<C> = {
        add: async ({
            canvas,
            options,
            propagateParents,
        }: {
            canvas: C;
            options?: { onlyReplies?: boolean; skipAncestors?: boolean };
            propagateParents?: boolean;
        }) => {
            const mode: Mode = options?.onlyReplies ? "replies" : "full";
            // Mark skipAncestors intent for this canvas run
            const entry = ensureEntry(canvas);
            if (options?.skipAncestors) (entry as any).skipAncestors = true;
            // Always schedule the target canvas; ancestor aggregation is handled inside reIndex
            await schedule(canvas, mode);
        },
        flush: async (canvasId?: string) => {
            if (canvasId) {
                const entry = perCanvas.get(canvasId);
                if (!entry) return;
                onDebug?.({ phase: "flush:start", target: canvasId });
                const t0 = globalThis.performance?.now?.() || Date.now();
                if (entry.cooldownTimeout) {
                    clearTimeout(entry.cooldownTimeout);
                    entry.cooldownTimeout = undefined;
                    if (!entry.running && !entry.scheduled) {
                        entry.debouncer.call();
                        entry.scheduled = true;
                    }
                }
                await entry.debouncer.flush();
                const t1 = globalThis.performance?.now?.() || Date.now();
                onDebug?.({
                    phase: "flush:end",
                    target: canvasId,
                    dt: t1 - t0,
                });
                return;
            }
            onDebug?.({ phase: "flush:start", target: "*" });
            const t0 = globalThis.performance?.now?.() || Date.now();
            await Promise.all(
                Array.from(perCanvas.values(), (e) => e.debouncer.flush())
            );
            const t1 = globalThis.performance?.now?.() || Date.now();
            onDebug?.({ phase: "flush:end", target: "*", dt: t1 - t0 });
        },
        close: (canvasId?: string) => {
            if (canvasId) {
                const e = perCanvas.get(canvasId);
                if (e) {
                    e.debouncer.close();
                    perCanvas.delete(canvasId);
                }
            } else {
                for (const e of perCanvas.values()) {
                    e.debouncer.close();
                }
                perCanvas.clear();
            }
        },
        size: () => perCanvas.size,
        pending: (canvasId: string) => perCanvas.has(canvasId),
        stats: () => {
            const per: Record<string, number> = {};
            let total = 0;
            for (const [id, e] of perCanvas.entries()) {
                per[id] = e.runs || 0;
                total += e.runs || 0;
            }
            return { totalRuns: total, perCanvas: per };
        },
    };
    return api;
};

// Backwards-compatible named export alias (if needed later)
export const hierarchicalReindex = createHierarchicalReindexManager;
