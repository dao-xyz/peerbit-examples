import { VitestTestRunner } from "vitest/runners";
import { firstFailureEvidence } from "./error-evidence.mjs";

// A first failure's stack is often the only record of which call failed,
// and V8 keeps 10 frames by default: a failure inside a shared helper
// (readiness-trust 35 + M1, macOS CI) lost every frame above the helper's
// retry loop, so its log could not say which step called it. Every worker
// of the strict gate loads this runner before any test file.
Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 50);

const MAX_TEXT = 16_384;

function bounded(value) {
    const text = String(value ?? "");
    return text.length > MAX_TEXT
        ? `${text.slice(0, MAX_TEXT)}\n[shared-fs diagnostic truncated]`
        : text;
}

function identity(task) {
    const names = [task.name];
    for (
        let suite = task.suite;
        suite && suite !== task.file;
        suite = suite.suite
    ) {
        names.unshift(suite.name);
    }
    return {
        file: bounded(task.file.filepath),
        test: bounded(names.join(" > ")),
    };
}

// Opt-in CI instrumentation: keep Vitest's assertions, hooks and retry behavior.
// The ordinary reporter only receives a final test result and can hide errors
// from a successful retry. This hook runs after cleanup, before the next try.
export default class SharedFsStrictRunner extends VitestTestRunner {
    async onBeforeTryTask(task, options) {
        const diagnostic = (task.meta.sharedFsStrict ??= {
            version: 1,
            retries: 0,
            firstFailureReported: false,
        });
        if (options.retry > 0) diagnostic.retries++;
        await super.onBeforeTryTask(task, options);
    }

    async onAfterRetryTask(task, options) {
        await super.onAfterRetryTask?.(task, options);
        const diagnostic = task.meta.sharedFsStrict;
        if (
            task.result?.state !== "fail" ||
            (task.fails && !task.retry) ||
            diagnostic.firstFailureReported
        ) {
            return;
        }
        diagnostic.firstFailureReported = true;
        const errors = task.result.errors ?? [];
        const event = {
            event: "shared-fs.first-attempt-failure",
            ...identity(task),
            attempt: options.retry + 1,
            repeat: options.repeats,
            ...firstFailureEvidence(errors),
        };
        // Bypass Vitest's captured console. Wait for the entire stderr write:
        // synchronous writes to a pipe can be partial for a large stack. The
        // next attempt cannot start (or crash) before this diagnostic flushes.
        await new Promise((resolve, reject) => {
            process.stderr.write(`${JSON.stringify(event)}\n`, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }
}
