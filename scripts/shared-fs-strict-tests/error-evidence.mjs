// Test diagnostics only: never copy arbitrary error properties or invoke their
// stringification hooks. Top-level fields retain the original runner limits.
const MAX_ERRORS = 4;
const MAX_TEXT = 16_384;
const MAX_DEPTH = 4;
const MAX_NESTED_NODES = 16;
const MAX_EXTRA_TEXT = 32_768;
const TRUNCATED = "\n[shared-fs diagnostic truncated]";
const COMMIT_FLAGS = [
    "localCommitSucceeded",
    "retrySafe",
    "nativeCommitApplied",
];

export function firstFailureEvidence(errors) {
    const counters = {
        captureErrors: 0,
        truncatedFields: 0,
        truncatedNodes: 0,
    };
    const ancestors = new WeakSet();
    let nestedNodes = 0;
    let extraText = MAX_EXTRA_TEXT;
    const unreadable = Symbol("unreadable");
    const read = (object, key) => {
        try {
            return object[key];
        } catch {
            counters.captureErrors++;
            return unreadable;
        }
    };
    const has = (object, key) => {
        try {
            return key in object;
        } catch {
            counters.captureErrors++;
            return false;
        }
    };
    const array = (value) => {
        try {
            return Array.isArray(value);
        } catch {
            counters.captureErrors++;
            return false;
        }
    };
    const arrayLength = (value) => {
        const length = read(value, "length");
        if (Number.isSafeInteger(length) && length >= 0) return length;
        // Throwing getters are already counted by read; malformed values must
        // also be visible instead of looking like a clean empty collection.
        if (length !== unreadable) counters.captureErrors++;
        return undefined;
    };
    const text = (value, root) => {
        let result;
        if (value === unreadable) result = "[unreadable diagnostic field]";
        else if (value == null) result = "";
        else if (typeof value === "object" || typeof value === "function")
            result = "[non-primitive diagnostic field]";
        else result = String(value);
        const limit = root ? MAX_TEXT : Math.min(MAX_TEXT, extraText);
        if (!root) extraText -= Math.min(result.length, limit);
        if (result.length <= limit) return result;
        counters.truncatedFields++;
        return result.slice(0, limit) + TRUNCATED;
    };
    const truncated = (reason) => {
        counters.truncatedNodes++;
        return { truncated: reason };
    };
    const errorInfo = (error, depth = 0) => {
        if (depth > MAX_DEPTH) return truncated("depth");
        if (depth > 0 && nestedNodes++ >= MAX_NESTED_NODES)
            return truncated("node-budget");
        if (error === unreadable) return truncated("unreadable");
        if (
            error === null ||
            (typeof error !== "object" && typeof error !== "function")
        ) {
            return {
                name: "",
                message: text(String(error), depth === 0),
                stack: "",
                valueType: error === null ? "null" : typeof error,
            };
        }
        if (ancestors.has(error)) return truncated("cycle");
        ancestors.add(error);
        try {
            const result = {
                name: text(read(error, "name"), depth === 0),
                message: text(read(error, "message"), depth === 0),
                stack: text(read(error, "stack"), depth === 0),
            };
            for (const key of COMMIT_FLAGS) {
                const value = read(error, key);
                if (typeof value === "boolean") result[key] = value;
            }
            if (has(error, "cause"))
                result.cause = errorInfo(read(error, "cause"), depth + 1);
            const children = read(error, "errors");
            if (array(children)) {
                const length = arrayLength(children);
                if (length !== undefined) {
                    result.errors = [];
                    const count = Math.min(MAX_ERRORS, length);
                    for (let index = 0; index < count; index++) {
                        result.errors.push(
                            errorInfo(read(children, index), depth + 1)
                        );
                    }
                    result.omittedErrors = Math.max(0, length - count);
                }
            }
            return result;
        } finally {
            ancestors.delete(error);
        }
    };
    const list = array(errors) ? errors : [errors];
    const count = arrayLength(list) ?? 0;
    const result = [];
    for (let index = 0; index < Math.min(MAX_ERRORS, count); index++) {
        result.push(errorInfo(read(list, index)));
    }
    return {
        errors: result,
        omittedErrors: Math.max(0, count - MAX_ERRORS),
        errorEvidence: counters,
    };
}
