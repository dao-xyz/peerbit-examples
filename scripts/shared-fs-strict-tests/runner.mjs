import { VitestTestRunner } from "vitest/runners";

const MAX_ERRORS = 4;
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
            errors: errors.slice(0, MAX_ERRORS).map((error) => ({
                name: bounded(error.name),
                message: bounded(error.message),
                stack: bounded(error.stack),
            })),
            omittedErrors: Math.max(0, errors.length - MAX_ERRORS),
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
