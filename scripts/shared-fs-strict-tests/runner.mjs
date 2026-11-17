import { VitestTestRunner } from "vitest/runners";
import { firstFailureEvidence } from "./error-evidence.mjs";
import { hangReportMs, watchAttempt } from "./hang-report.mjs";

// A first failure's stack is often the only record of which call failed,
// and V8 keeps 10 frames by default: a failure inside a shared helper
// (readiness-trust 35 + M1, macOS CI) lost every frame above the helper's
// retry loop, so its log could not say which step called it. Every worker
// of the strict gate loads this runner before any test file.
Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 50);

const MAX_TEXT = 16_384;

// A hung test's only record used to be "Test timed out": no pending await,
// nothing on the disk. See hang-report.mjs.
const HANG_REPORT_MS = hangReportMs(process.env.SHARED_FS_HANG_REPORT_MS);

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
    #hangWatches = new Map();

    async onBeforeTryTask(task, options) {
        const diagnostic = (task.meta.sharedFsStrict ??= {
            version: 1,
            retries: 0,
            firstFailureReported: false,
        });
        if (options.retry > 0) diagnostic.retries++;
        // Armed until onAfterRetryTask, so it also covers the attempt's
        // beforeEach, afterEach and onTestFinished hooks.
        this.#hangWatches.get(task)?.stop();
        const watch = watchAttempt(HANG_REPORT_MS, () => ({
            ...identity(task),
            attempt: options.retry + 1,
            // "run": beforeEach or the body; "pass"/"fail": the after hooks.
            state: task.result?.state,
        }));
        if (watch) this.#hangWatches.set(task, watch);
        else this.#hangWatches.delete(task);
        await super.onBeforeTryTask(task, options);
    }

    async onAfterRetryTask(task, options) {
        const hangReport = this.#hangWatches.get(task)?.stop();
        this.#hangWatches.delete(task);
        // A failed attempt's probe (at most its 10 s deadline) is written
        // before its failure line; a passing attempt never waits for it.
        if (hangReport && task.result?.state === "fail" && !task.fails) {
            await hangReport;
        }
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
