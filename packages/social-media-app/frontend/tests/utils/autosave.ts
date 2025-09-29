import type { Page } from "@playwright/test";

export type CanvasSaveStats = {
    eventCount: number;
    totalRects: number;
};

const collectStats = (input: any, canvasId: string | null): CanvasSaveStats => {
    let events: any[] = [];
    if (Array.isArray(input)) {
        events = input;
    } else if (input && typeof input === "object") {
        // fall through to empty array
    } else if (typeof input === "undefined") {
        events = [];
    }

    let eventCount = 0;
    let totalRects = 0;

    for (const evt of events) {
        if (!evt) continue;
        if (evt.source !== "CanvasWrapper" || evt.name !== "save:done") {
            continue;
        }
        if (canvasId && evt.canvasId !== canvasId) {
            continue;
        }

        eventCount += 1;
        const count = typeof evt.count === "number" ? evt.count : 0;
        totalRects += count;
    }

    return { eventCount, totalRects };
};

export const getCanvasSaveStats = async (
    page: Page,
    options?: { canvasId?: string }
): Promise<CanvasSaveStats> => {
    const { canvasId } = options ?? {};

    const events = await page.evaluate(() => {
        const w: any = window as any;
        const topWin: any = w.top || w;
        if (Array.isArray(topWin?.__DBG_EVENTS)) {
            return topWin.__DBG_EVENTS;
        }
        if (Array.isArray(w.__DBG_EVENTS)) {
            return w.__DBG_EVENTS;
        }
        return [];
    });

    return collectStats(events, canvasId ?? null);
};

type WaitForCanvasSaveDeltaOptions = {
    minRectDelta?: number;
    minEventDelta?: number;
    canvasId?: string;
    timeout?: number;
    baseline?: CanvasSaveStats;
};

export const waitForCanvasSaveDelta = async (
    page: Page,
    options?: WaitForCanvasSaveDeltaOptions
): Promise<CanvasSaveStats> => {
    const {
        minRectDelta = 1,
        minEventDelta = 0,
        canvasId,
        timeout = 15000,
    } = options ?? {};

    const baseline = options?.baseline
        ? options.baseline
        : await getCanvasSaveStats(page, { canvasId });

    const handle = await page.waitForFunction<
        CanvasSaveStats | null,
        {
            canvasId: string | null;
            targetRectDelta: number;
            targetEventDelta: number;
            baselineRects: number;
            baselineEvents: number;
        }
    >(
        (args: {
            canvasId: string | null;
            targetRectDelta: number;
            targetEventDelta: number;
            baselineRects: number;
            baselineEvents: number;
        }) => {
            const w: any = typeof window !== "undefined" ? (window as any) : {};
            const topWin: any = w.top || w;
            const events = Array.isArray(topWin?.__DBG_EVENTS)
                ? topWin.__DBG_EVENTS
                : Array.isArray(w.__DBG_EVENTS)
                  ? w.__DBG_EVENTS
                  : [];

            let eventCount = 0;
            let totalRects = 0;
            for (const evt of events) {
                if (!evt) continue;
                if (
                    evt.source !== "CanvasWrapper" ||
                    evt.name !== "save:done"
                ) {
                    continue;
                }
                if (args.canvasId && evt.canvasId !== args.canvasId) {
                    continue;
                }
                eventCount += 1;
                const count = typeof evt.count === "number" ? evt.count : 0;
                totalRects += count;
            }

            const rectDelta = totalRects - args.baselineRects;
            const eventDelta = eventCount - args.baselineEvents;

            if (
                rectDelta >= args.targetRectDelta &&
                eventDelta >= args.targetEventDelta
            ) {
                return { eventCount, totalRects };
            }

            return null;
        },
        {
            canvasId: canvasId ?? null,
            targetRectDelta: minRectDelta,
            targetEventDelta: minEventDelta,
            baselineRects: baseline.totalRects,
            baselineEvents: baseline.eventCount,
        },
        { timeout }
    );

    const result = await handle.jsonValue();
    if (!result) {
        throw new Error("waitForCanvasSaveDelta resolved without stats");
    }
    return result;
};
