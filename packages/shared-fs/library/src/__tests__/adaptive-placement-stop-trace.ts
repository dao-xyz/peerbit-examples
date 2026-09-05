import { isPromise } from "node:util/types";

const POINTS = [
    "command.received",
    "command.dequeued",
    "ipc.reply.begin",
    "ipc.reply.end",
    "ipc.reply.error",
] as const;
const PHASES = [
    "peer.stop",
    "peer.bootstrapRecovery",
    "peer.handler.stop",
    "peer.storage.close",
    "peer.indexer.stop",
    "peer.libp2p.stop",
    "disk.scan",
] as const;
export type StopPoint = (typeof POINTS)[number];
export type StopPhase = (typeof PHASES)[number];
export type PlacementStopEvent = {
    label: StopPoint | StopPhase;
    state: "point" | "enter" | "fulfilled" | "rejected";
    atMs: number;
};
export type PlacementStopSnapshot = {
    events: PlacementStopEvent[];
    omittedEvents: number;
    pending: { label: StopPhase; count: number }[];
    elapsedMs: number;
};
export type PlacementStopTrace = {
    point(label: StopPoint): void;
    observe<T>(label: StopPhase, action: () => T): T;
    snapshot(): PlacementStopSnapshot;
};

const pointLabels = new Set<string>(POINTS);
const phaseLabels = new Set<string>(PHASES);
const MAX_EVENTS = 64;

// Test-only diagnostics: no errors, results, peer objects, or payloads are retained.
export const createPlacementStopTrace = ({
    emit,
    now = () => performance.now(),
}: {
    emit: (event: PlacementStopEvent) => void;
    now?: () => number;
}): PlacementStopTrace => {
    const events: PlacementStopEvent[] = [];
    const pending = new Map<StopPhase, number>();
    let omittedEvents = 0;
    let origin: number | undefined;
    let elapsedMs = 0;
    const elapsed = () => {
        try {
            const sample = now();
            if (Number.isFinite(sample)) {
                origin ??= sample;
                const delta = sample - origin;
                if (Number.isFinite(delta)) {
                    elapsedMs = Math.max(elapsedMs, delta);
                }
            }
        } catch {
            // A diagnostic clock must never change the observed operation.
        }
        return elapsedMs;
    };
    elapsed();
    const record = (
        label: PlacementStopEvent["label"],
        state: PlacementStopEvent["state"]
    ) => {
        const atMs = elapsed();
        if (events.length === MAX_EVENTS) {
            omittedEvents++;
            return;
        }
        const event = { label, state, atMs };
        events.push(event);
        try {
            emit({ ...event });
        } catch {
            // IPC/diagnostic failures do not replace stop results or errors.
        }
    };
    return {
        point(label) {
            if (pointLabels.has(label)) record(label, "point");
        },
        observe<T>(label: StopPhase, action: () => T): T {
            if (!phaseLabels.has(label)) return action();
            pending.set(label, (pending.get(label) ?? 0) + 1);
            record(label, "enter");
            const settle = (state: "fulfilled" | "rejected") => {
                const count = (pending.get(label) ?? 1) - 1;
                if (count === 0) pending.delete(label);
                else pending.set(label, count);
                record(label, state);
            };
            let result: T;
            try {
                result = action();
            } catch (error) {
                settle("rejected");
                throw error;
            }
            if (isPromise(result)) {
                // Side-channel only: do not await, wrap, or return the child promise.
                // Calling the intrinsic also avoids a replaced instance `.then`.
                try {
                    Promise.prototype.then.call(
                        result,
                        () => settle("fulfilled"),
                        () => settle("rejected")
                    );
                } catch {
                    // A nonstandard Promise species can prevent observation. Keep
                    // the phase pending rather than inventing an operation result.
                }
            } else {
                // Do not assimilate arbitrary thenables or inspect their getters.
                settle("fulfilled");
            }
            return result;
        },
        snapshot() {
            return {
                events: events.map((event) => ({ ...event })),
                omittedEvents,
                pending: PHASES.flatMap((label) => {
                    const count = pending.get(label);
                    return count ? [{ label, count }] : [];
                }),
                elapsedMs: elapsed(),
            };
        },
    };
};

// Only the harness's known instances are patched, never shared prototypes.
export const observePlacementStopMethods = (
    trace: PlacementStopTrace,
    targets: { target: object; key: string; phase: StopPhase }[]
): (() => void) => {
    const seen = new Map<object, Set<string>>();
    const methods = targets.map(({ target, key, phase }) => {
        const keys = seen.get(target) ?? new Set<string>();
        if (keys.has(key) || !phaseLabels.has(phase)) {
            throw new Error(`Invalid stop-trace method target: ${key}`);
        }
        keys.add(key);
        seen.set(target, keys);
        const original: unknown = Reflect.get(target, key);
        if (typeof original !== "function") {
            throw new Error(`Missing stop-trace method: ${key}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        const wrapper = function (this: unknown, ...args: unknown[]) {
            return trace.observe(phase, () =>
                Reflect.apply(original, this, args)
            );
        };
        return { target, key, descriptor, wrapper };
    });
    const installed: typeof methods = [];
    const restore = () => {
        for (const { target, key, descriptor, wrapper } of [
            ...installed,
        ].reverse()) {
            if (
                Object.getOwnPropertyDescriptor(target, key)?.value !== wrapper
            ) {
                continue;
            }
            if (descriptor) Object.defineProperty(target, key, descriptor);
            else Reflect.deleteProperty(target, key);
        }
    };
    try {
        for (const method of methods) {
            Object.defineProperty(method.target, method.key, {
                configurable: true,
                enumerable: method.descriptor?.enumerable ?? false,
                writable: true,
                value: method.wrapper,
            });
            installed.push(method);
        }
    } catch (error) {
        restore();
        throw error;
    }
    return restore;
};
