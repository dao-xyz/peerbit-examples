// Test-only diagnostics. Never retain upstream event objects or import their runtime.
const MAX_NAMES = 128;
const MAX_NAME_LENGTH = 96;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
// Recent Node versions expose lazy Error.stack through one native getter.
// Recognize that exact function, not arbitrary accessors or source strings.
const nativeStackGetter = Object.getOwnPropertyDescriptor(
    new Error(),
    "stack"
)?.get;

type ReadResult = { value?: unknown; unreadable?: true };
const dataField = (
    input: unknown,
    key: string,
    inherited = false
): ReadResult => {
    if (input === null || typeof input !== "object") return {};
    try {
        let object: object | null = input;
        for (let depth = 0; object && depth < (inherited ? 6 : 1); depth++) {
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            if (
                key === "stack" &&
                nativeStackGetter &&
                descriptor?.get === nativeStackGetter
            )
                return { value: nativeStackGetter.call(input) };
            if (descriptor)
                return "value" in descriptor
                    ? { value: descriptor.value }
                    : { unreadable: true };
            object = inherited ? Object.getPrototypeOf(object) : null;
        }
    } catch {
        return { unreadable: true };
    }
    return {};
};

export type PlacementProfileEvent = {
    name: string;
    count: number;
    timedCount: number;
    sumMs: number;
    maxMs: number;
};

/** maxEvents bounds distinct event names, not the number of observations. */
export const createPlacementProfile = (options?: { maxEvents?: number }) => {
    const requested = dataField(options, "maxEvents").value;
    const maxEvents =
        typeof requested === "number" &&
        Number.isSafeInteger(requested) &&
        requested >= 0
            ? Math.min(requested, MAX_NAMES)
            : MAX_NAMES;
    const events = new Map<string, PlacementProfileEvent>();
    let total = 0;
    let invalid = 0;
    let dropped = 0;
    let saturated = false;
    const add = (left: number, right = 1) => {
        if (left > MAX_COUNTER - right) {
            saturated = true;
            return MAX_COUNTER;
        }
        return left + right;
    };
    return {
        sink(event: unknown): void {
            total = add(total);
            try {
                const name = dataField(event, "name").value;
                if (
                    typeof name !== "string" ||
                    name.length > MAX_NAME_LENGTH ||
                    !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(name)
                ) {
                    invalid = add(invalid);
                    return;
                }
                const duration = dataField(event, "durationMs");
                const timed =
                    typeof duration.value === "number" &&
                    Number.isFinite(duration.value) &&
                    duration.value >= 0 &&
                    duration.value <= MAX_COUNTER;
                // Missing timings are legitimate count-only events. Invalid
                // timings still count the named event, but never enter sums.
                if (
                    duration.unreadable ||
                    (duration.value !== undefined && !timed)
                )
                    invalid = add(invalid);
                let bucket = events.get(name);
                if (!bucket) {
                    if (events.size >= maxEvents) {
                        dropped = add(dropped);
                        return;
                    }
                    bucket = {
                        name,
                        count: 0,
                        timedCount: 0,
                        sumMs: 0,
                        maxMs: 0,
                    };
                    events.set(name, bucket);
                }
                bucket.count = add(bucket.count);
                if (timed) {
                    const ms = duration.value as number;
                    bucket.timedCount = add(bucket.timedCount);
                    bucket.sumMs = add(bucket.sumMs, ms);
                    bucket.maxMs = Math.max(bucket.maxMs, ms);
                }
            } catch {
                // Instrumentation must never interfere with the operation.
                invalid = add(invalid);
            }
        },
        snapshot() {
            return {
                total,
                invalid,
                dropped,
                maxEvents,
                saturated,
                events: [...events.values()].map((event) => ({ ...event })),
            };
        },
    };
};

export type PlacementErrorInfo = {
    name: string;
    message: string;
    stack?: string;
    localCommitSucceeded?: boolean;
    retrySafe?: boolean;
    nativeCommitApplied?: boolean;
    committedHashes?: string[];
    committedHashesOmitted?: number;
    committedCids?: string[];
    committedCidsOmitted?: number;
    failedCids?: string[];
    failedCidsOmitted?: number;
    cause?: PlacementErrorInfo;
    errors?: PlacementErrorInfo[];
    errorsOmitted?: number;
    truncated?: string[];
};

const MAX_ERROR_NODES = 16;
const MAX_ERROR_DEPTH = 4;
const MAX_ARRAY_ITEMS = 16;
const MAX_AGGREGATE_ITEMS = 4;
// JSON escaping uses at most six bytes per retained UTF-16 code unit. This
// shared budget plus bounded nodes/arrays/field names stays below 128 KiB.
const MAX_ERROR_CHARACTERS = 12_000;
const primitiveMessage = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value === null) return "null";
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    if (value === undefined) return "undefined";
    return `[${typeof value}]`;
};

/** Detached JSON-safe evidence; custom accessors and arbitrary properties are ignored. */
export const errorInfo = (error: unknown): PlacementErrorInfo => {
    let characters = MAX_ERROR_CHARACTERS;
    let nodes = 0;
    const ancestors = new WeakSet<object>();
    const omittedCount = (value: unknown) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
            ? value
            : 0;
    const stop = (reason: string): PlacementErrorInfo => ({
        name: "ErrorInfoTruncated",
        message: `[${reason}]`,
        truncated: [reason],
    });
    const visit = (input: unknown, depth: number): PlacementErrorInfo => {
        if (depth > MAX_ERROR_DEPTH) return stop("depth");
        if (nodes >= MAX_ERROR_NODES) return stop("nodes");
        const object = input !== null && typeof input === "object";
        if (object && ancestors.has(input)) return stop("cycle");
        nodes++;
        if (object) ancestors.add(input);
        const truncated: string[] = [];
        const read = (key: string) => {
            const result = dataField(input, key, true);
            if (result.unreadable) truncated.push(`${key}:unreadable`);
            return result.value;
        };
        const text = (value: string, limit: number, field: string) => {
            const length = Math.min(value.length, limit, characters);
            characters -= length;
            if (length < value.length) truncated.push(field);
            return value.slice(0, length);
        };
        const name = read("name");
        const message = read("message");
        const result: PlacementErrorInfo = {
            name: text(typeof name === "string" ? name : "Error", 128, "name"),
            message: text(
                typeof message === "string" ? message : primitiveMessage(input),
                4_096,
                "message"
            ),
        };
        const stack = read("stack");
        if (typeof stack === "string")
            result.stack = text(stack, 8_192, "stack");
        for (const key of [
            "localCommitSucceeded",
            "retrySafe",
            "nativeCommitApplied",
        ] as const) {
            const value = read(key);
            if (typeof value === "boolean") result[key] = value;
        }
        const array = (key: string) => {
            const value = read(key);
            try {
                if (!Array.isArray(value)) return;
                const length = dataField(value, "length");
                if (length.unreadable) {
                    truncated.push(`${key}:unreadable`);
                    return;
                }
                return { value, length: omittedCount(length.value) };
            } catch {
                truncated.push(`${key}:unreadable`);
                return;
            }
        };
        // A worker's detached record can become the parent's Error.cause.
        // Retain known truncation labels, never arbitrary remote strings.
        const previousTruncation = array("truncated");
        if (previousTruncation)
            for (let i = 0; i < Math.min(previousTruncation.length, 32); i++) {
                const label = dataField(
                    previousTruncation.value,
                    String(i)
                ).value;
                if (
                    typeof label === "string" &&
                    label.length <= 48 &&
                    /^(?:(?:name|message|stack|localCommitSucceeded|retrySafe|nativeCommitApplied|committedHashes|committedCids|failedCids|cause|errors|truncated|committedHashesOmitted|committedCidsOmitted|failedCidsOmitted|errorsOmitted)(?::(?:unreadable|item))?|depth|nodes|cycle|unreadable)$/.test(
                        label
                    )
                )
                    truncated.push(label);
            }
        for (const key of [
            "committedHashes",
            "committedCids",
            "failedCids",
        ] as const) {
            const values = array(key);
            if (!values) continue;
            const output: string[] = [];
            for (let i = 0; i < Math.min(values.length, MAX_ARRAY_ITEMS); i++) {
                const value = dataField(values.value, String(i));
                if (typeof value.value === "string")
                    output.push(text(value.value, 256, key));
                else truncated.push(`${key}:item`);
            }
            result[key] = output;
            const omittedKey = `${key}Omitted` as const;
            const omitted = Math.min(
                MAX_COUNTER,
                values.length - output.length + omittedCount(read(omittedKey))
            );
            if (omitted) result[omittedKey] = omitted;
        }
        const cause = read("cause");
        if (cause !== undefined) result.cause = visit(cause, depth + 1);
        const errors = array("errors");
        if (errors) {
            result.errors = [];
            const count = Math.min(errors.length, MAX_AGGREGATE_ITEMS);
            for (let i = 0; i < count; i++) {
                const child = dataField(errors.value, String(i));
                result.errors.push(
                    child.unreadable
                        ? stop("unreadable")
                        : visit(child.value, depth + 1)
                );
            }
            const omitted = Math.min(
                MAX_COUNTER,
                errors.length - count + omittedCount(read("errorsOmitted"))
            );
            if (omitted) result.errorsOmitted = omitted;
        }
        if (truncated.length) result.truncated = [...new Set(truncated)];
        if (object) ancestors.delete(input);
        return result;
    };
    return visit(error, 0);
};
