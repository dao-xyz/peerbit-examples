import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const vitest = path.join(
    path.dirname(require.resolve("vitest/package.json")),
    "vitest.mjs"
);
const fixture = fileURLToPath(new URL("./fixtures", import.meta.url));

function run(pattern, mode = "strict", fault = "none") {
    const environment = {
        ...process.env,
        NO_COLOR: "1",
        SHARED_FS_STRICT_FIXTURE: mode,
        SHARED_FS_STRICT_FIXTURE_FAULT: fault,
    };
    delete environment.FORCE_COLOR;
    const result = spawnSync(
        process.execPath,
        [
            vitest,
            "run",
            "--root",
            fixture,
            "--config",
            path.join(fixture, "vitest.config.mjs"),
            // This must not conceal a per-test retry: it is the original bug.
            "--retry=0",
            "--testNamePattern",
            pattern,
            "--no-color",
        ],
        {
            cwd: fixture,
            env: environment,
            encoding: "utf8",
            timeout: 15_000,
            maxBuffer: 2 * 1024 * 1024,
        }
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    const events = result.stderr
        .split(/\r?\n/)
        .filter((line) => line.startsWith('{"event":"shared-fs.'))
        .map((line) => JSON.parse(line));
    const find = (name) => events.filter((event) => event.event === name);
    return { ...result, events, find };
}

test("a successful retry retains the first stack before the next attempt and fails strict CI", () => {
    const ordinary = run("retry eventually passes", "plain");
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.doesNotMatch(ordinary.stderr, /ORIGINAL_FIRST_FAILURE_STACK/);

    const strict = run("retry eventually passes");
    assert.equal(strict.status, 1, strict.stderr);
    const [failure] = strict.find("shared-fs.first-attempt-failure");
    assert.equal(failure.test, "strict CI fixture > retry eventually passes");
    assert.match(failure.file, /cases\.spec\.mjs$/);
    assert.equal(failure.attempt, 1);
    assert.match(failure.errors[0].stack, /ORIGINAL_FIRST_FAILURE_STACK/);
    assert.match(failure.errors[0].stack, /cases\.spec\.mjs:\d+:\d+/);
    assert.ok(
        strict.stderr.indexOf("ORIGINAL_FIRST_FAILURE_STACK") <
            strict.stderr.indexOf("SECOND_ATTEMPT_STARTED")
    );
    const [retry] = strict.find("shared-fs.strict-retry");
    assert.equal(retry.retries, 1);
    assert.equal(retry.outcome, "passed");
    assert.match(strict.stdout, /1 passed/);
    assert.deepEqual(strict.find("shared-fs.strict-summary"), [
        {
            event: "shared-fs.strict-summary",
            retriedTests: 1,
            missingInstrumentation: 0,
        },
    ]);
});

test("nested receipt evidence survives an eventual pass and flushes before retry", () => {
    const result = run("nested receipt eventually succeeds");
    assert.equal(result.status, 1, result.stderr);
    const [failure] = result.find("shared-fs.first-attempt-failure");
    assert.match(failure.errors[0].stack, /ORIGINAL_RECEIPT_WRAPPER_STACK/);
    const cause = failure.errors[0].cause;
    assert.match(cause.stack, /ORIGINAL_RECEIPT_CAUSE_STACK/);
    assert.equal(cause.localCommitSucceeded, true);
    assert.equal(cause.retrySafe, false);
    assert.equal(cause.nativeCommitApplied, true);
    assert.ok(
        result.stderr.indexOf("ORIGINAL_RECEIPT_CAUSE_STACK") <
            result.stderr.indexOf("NESTED_SECOND_ATTEMPT_STARTED")
    );
    assert.equal(result.find("shared-fs.strict-retry")[0].outcome, "passed");
});

test("body and all peer-cleanup failures remain visible after a successful retry", () => {
    const result = run("retry after body and cleanup failure");
    assert.equal(result.status, 1, result.stderr);
    const [failure] = result.find("shared-fs.first-attempt-failure");
    assert.match(failure.errors[0].stack, /ORIGINAL_BODY_STACK/);
    const cleanup = failure.errors.find(
        (error) => error.name === "AggregateError"
    );
    assert.ok(cleanup, JSON.stringify(failure));
    assert.match(cleanup.errors[0].stack, /ORIGINAL_PEER_STOP_STACK/);
    assert.equal(cleanup.errors[1].valueType, "undefined");
    assert.match(result.stderr, /FINAL_PEER_STOP_ATTEMPTED/);
    assert.ok(
        result.stderr.indexOf("ORIGINAL_PEER_STOP_STACK") <
            result.stderr.indexOf("CLEANUP_SECOND_ATTEMPT_STARTED")
    );
    assert.equal(result.find("shared-fs.strict-retry")[0].outcome, "passed");
});

test("clean passes, expected failures and unused retry budgets remain successful", () => {
    const result = run("clean pass$|expected failure$|unused retry budget$");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3 passed/);
    assert.equal(result.find("shared-fs.first-attempt-failure").length, 0);
    assert.equal(result.find("shared-fs.strict-retry").length, 0);
});

test("expected failures with a retry budget fail strict CI only for actual retries", () => {
    const result = run("expected failure with actual retries");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /1 passed/);
    const [retry] = result.find("shared-fs.strict-retry");
    assert.equal(retry.retries, 1);
    assert.equal(retry.outcome, "passed");
    const [failure] = result.find("shared-fs.first-attempt-failure");
    assert.match(failure.errors[0].stack, /EXPECTED_FAILURE_RETRIED_BY_VITEST/);
});

test("ordinary failures keep their existing nonzero outcome", () => {
    const result = run("ordinary failure");
    assert.equal(result.status, 1, result.stderr);
    const [failure] = result.find("shared-fs.first-attempt-failure");
    assert.match(failure.errors[0].stack, /ORDINARY_FAILURE_STACK/);
    assert.equal(result.find("shared-fs.strict-retry").length, 0);
});

test("retry-then-skip cannot erase the strict retry outcome", () => {
    const result = run("retry then skips");
    assert.equal(result.status, 1, result.stderr);
    const [retry] = result.find("shared-fs.strict-retry");
    assert.equal(retry.retries, 1);
    assert.equal(retry.outcome, "skipped");
});

for (const hook of ["before", "after"]) {
    test(`a failing ${hook}Each hook retains its original stack`, () => {
        const result = run(`retry passes after ${hook} hook fails`);
        assert.equal(result.status, 1, result.stderr);
        const [failure] = result.find("shared-fs.first-attempt-failure");
        assert.match(
            failure.errors[0].stack,
            new RegExp(`ORIGINAL_${hook.toUpperCase()}_HOOK_STACK`)
        );
        assert.equal(
            result.find("shared-fs.strict-retry")[0].outcome,
            "passed"
        );
    });
}

test("multiple retries emit the original failure only once", () => {
    const result = run("exhausted retries");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.find("shared-fs.first-attempt-failure").length, 1);
    const [retry] = result.find("shared-fs.strict-retry");
    assert.equal(retry.retries, 2);
    assert.equal(retry.outcome, "failed");
});

test("diagnostics bound large errors and explicitly mark omitted content", () => {
    const result = run("bounded first failure");
    assert.equal(result.status, 1, result.stderr);
    const [failure] = result.find("shared-fs.first-attempt-failure");
    assert.equal(failure.errors.length, 4);
    assert.equal(failure.omittedErrors, 2);
    assert.ok(JSON.stringify(failure).length < 70_000);
    for (const error of failure.errors) {
        assert.match(error.stack, /\[shared-fs diagnostic truncated\]$/);
    }
});

test("a missing worker runner fails closed instead of claiming a strict pass", () => {
    const result = run("clean pass", "reporter-only");
    assert.equal(result.status, 1, result.stderr);
    const [summary] = result.find("shared-fs.strict-summary");
    assert.equal(summary.missingInstrumentation, 1);
});

for (const fault of ["setup", "collection"]) {
    test(`${fault} errors retain the ordinary failure and its original stack`, () => {
        const result = run("", "strict", fault);
        assert.equal(result.status, 1, result.stderr);
        assert.match(
            result.stderr,
            new RegExp(`ORIGINAL_${fault.toUpperCase()}_ERROR_STACK`)
        );
        assert.equal(
            result.find("shared-fs.strict-summary")[0].missingInstrumentation,
            0
        );
    });
}

test("suite setup failures retain their original stack", () => {
    const result = run("unreachable test after suite setup failure");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /ORIGINAL_BEFORE_ALL_STACK/);
    assert.doesNotMatch(result.stderr, /Error: MUST_NOT_RUN/);
    assert.equal(
        result.find("shared-fs.strict-summary")[0].missingInstrumentation,
        0
    );
});
