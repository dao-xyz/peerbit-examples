import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Test-only: records the timers armed through the global setTimeout and
 * setInterval between `watchTimers()` and `stop()`, with the frame that
 * armed each (M1 plan 10.5, SPEC4 9.4(6)). A timer is classified by the
 * nearest frame above the global call, so a dependency's timer armed in a
 * call chain this package started (pubsub delivering a READY notice) stays
 * the dependency's bounded work, as in peer-stop-timers.test.ts:
 *
 * - `own`: that frame is this package's code (`src/`, not its tests);
 * - `readiness`: that frame is in `src/readiness/` (the Timers port and
 *   anything else there), or inside one of the readiness host functions
 *   of `src/index.ts` (`READINESS_HOST`: the decision, the flip, the join's
 *   start, the phase clause and its triggers, and the sidecar they
 *   persist through).
 *
 * The host functions are located by their line ranges in `src/index.ts`
 * (vitest maps stack frames to the source), so a closure inside one, which
 * V8 reports without a name, still counts. Restores the globals on stop();
 * a watch left running is stopped by the next one.
 */

/** The readiness host of `src/index.ts` (SPEC4 1.2). */
export const READINESS_HOST = [
    "markWriteReady",
    "commitWriteReady",
    "startReadinessJoin",
    "readinessPhaseSettled",
    "setBootstrapPhase",
    "trackBootstrapDecision",
    "settleWriteReadinessDecision",
    "serializeWriteReadinessTransition",
    "emitReadinessSession",
    "readBootstrapState",
    "replaceBootstrapState",
    "writeBootstrapState",
] as const;

const INDEX_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
const OWN_FRAME =
    /[\\/]shared-fs[\\/]library[\\/](?:src|lib)[\\/](?!__tests__)/;
const READINESS_FRAME =
    /[\\/]shared-fs[\\/]library[\\/](?:src|lib)[\\/]readiness[\\/]/;
const INDEX_FRAME = /[\\/]shared-fs[\\/]library[\\/]src[\\/]index\.ts:(\d+):/;
const THIS_FILE = /readiness-timer-watch\.ts:/;

/** 1-based [first, last] lines of each host method's body. */
const hostRanges = (() => {
    const lines = readFileSync(INDEX_PATH, "utf8").split("\n");
    const ranges: Array<{ name: string; first: number; last: number }> = [];
    for (const name of READINESS_HOST) {
        const start = lines.findIndex((line) =>
            new RegExp(`^    private (?:async )?${name}[<(]`).test(line)
        );
        if (start < 0) {
            throw new Error(`readiness-timer-watch: no ${name} in index.ts`);
        }
        const end = lines.findIndex((line, i) => i > start && line === "    }");
        ranges.push({ name, first: start + 1, last: end + 1 });
    }
    return ranges;
})();

/** The host function whose body holds `line` of `src/index.ts`, if any. */
export const hostFunctionAt = (line: number) =>
    hostRanges.find(({ first, last }) => line >= first && line <= last)?.name;

export interface ArmedTimer {
    kind: "setTimeout" | "setInterval";
    ms: number;
    /** The nearest frame above the global call. */
    frame: string;
    /** For `readiness`: the host function or readiness file it names. */
    where?: string;
}

const classify = (frame: string) => {
    const own = OWN_FRAME.test(frame);
    if (!own) return { own, readiness: undefined };
    if (READINESS_FRAME.test(frame)) {
        return {
            own,
            readiness: frame.match(/readiness[\\/]([\w-]+\.ts)/)?.[1] ?? frame,
        };
    }
    const line = frame.match(INDEX_FRAME)?.[1];
    return {
        own,
        readiness: line === undefined ? undefined : hostFunctionAt(+line),
    };
};

let active: (() => void) | undefined;

export const watchTimers = () => {
    active?.();
    const real = {
        setTimeout: globalThis.setTimeout,
        setInterval: globalThis.setInterval,
    };
    const own: ArmedTimer[] = [];
    const readiness: ArmedTimer[] = [];
    let total = 0;
    const wrap =
        (kind: ArmedTimer["kind"]) =>
        (callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
            total++;
            const limit = Error.stackTraceLimit;
            Error.stackTraceLimit = 20;
            const frames = (new Error().stack ?? "").split("\n").slice(1);
            Error.stackTraceLimit = limit;
            const frame =
                frames.find((line) => !THIS_FILE.test(line))?.trim() ?? "";
            const { own: isOwn, readiness: where } = classify(frame);
            const armed: ArmedTimer = { kind, ms: Number(ms ?? 0), frame };
            if (isOwn) own.push(armed);
            if (where !== undefined) readiness.push({ ...armed, where });
            return (real[kind] as any)(callback, ms, ...args);
        };
    Object.assign(globalThis, {
        setTimeout: wrap("setTimeout"),
        setInterval: wrap("setInterval"),
    });
    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        Object.assign(globalThis, real);
        if (active === stop) active = undefined;
    };
    active = stop;
    return {
        /** Timers this package's code armed directly. */
        own,
        /** Timers readiness code armed directly. */
        readiness,
        /** Every timer armed through the globals while watching. */
        get total() {
            return total;
        },
        stop,
    };
};
