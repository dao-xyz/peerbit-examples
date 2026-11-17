import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    DEFAULT_HANG_REPORT_MS,
    hangReportMs,
    probeVolumes,
} from "./hang-report.mjs";

const require = createRequire(import.meta.url);
const vitest = path.join(
    path.dirname(require.resolve("vitest/package.json")),
    "vitest.mjs"
);
const fixture = fileURLToPath(new URL("./fixtures", import.meta.url));

function run(pattern, mode = "strict", fault = "none", hangReportMs) {
    const environment = {
        ...process.env,
        NO_COLOR: "1",
        SHARED_FS_STRICT_FIXTURE: mode,
        SHARED_FS_STRICT_FIXTURE_FAULT: fault,
    };
    delete environment.FORCE_COLOR;
    delete environment.SHARED_FS_HANG_REPORT_MS;
    if (hangReportMs !== undefined) {
        environment.SHARED_FS_HANG_REPORT_MS = String(hangReportMs);
    }
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
            // A hang case runs into its timeout (0.6-3 s) and waits for its
            // probe (at most 10 s) before its failure line.
            timeout: hangReportMs === undefined ? 15_000 : 45_000,
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

test("a failure's stack keeps the frames past V8's default 10", () => {
    const result = run("deep failure stack");
    assert.equal(result.status, 1, result.stderr);
    const [failure] = result.find("shared-fs.first-attempt-failure");
    const { stack } = failure.errors[0];
    assert.match(stack, /DEEP_FAILURE_STACK/);
    const frames = stack.split(/\r?\n/).filter((line) => /^\s+at /.test(line));
    // 31 frames of the recursion, then the test's own: a 10-frame stack
    // ends inside the recursion.
    assert.ok(
        frames.filter((line) => /\bdescend\b/.test(line)).length >= 31,
        stack
    );
    assert.ok(frames.length > 31, stack);
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

// Where each event's line starts in a run's stderr (-1 when absent).
const lineAt = (result, event) => result.stderr.indexOf(`{"event":"${event}"`);

test("a hung test writes a hang report and a disk probe, then still fails as a timeout", () => {
    const result = run("hangs past the hang report", "strict", "none", 200);
    assert.equal(result.status, 1, result.stderr);
    const reports = result.find("shared-fs.hang-report");
    assert.equal(reports.length, 1, result.stderr);
    const [report] = reports;
    assert.equal(
        report.test,
        "strict CI fixture > hang report > hangs past the hang report"
    );
    assert.match(report.file, /cases\.spec\.mjs$/);
    assert.equal(report.attempt, 1);
    assert.equal(report.state, "run");
    // Due at 200 ms, it fired after the fixture's 50 ms sleep and 300 ms
    // synchronous block (a timer can fire about 1 ms early, so the bound
    // keeps a margin), and the event loop delay shows that block.
    assert.ok(report.elapsedMs >= 300, JSON.stringify(report));
    assert.ok(report.eventLoopDelayMs.max >= 250, JSON.stringify(report));
    assert.ok(report.eventLoopDelayMs.p99 >= 0, JSON.stringify(report));
    assert.ok(Number.isInteger(report.pid), JSON.stringify(report));
    for (const count of Object.values(report.resources)) {
        assert.ok(Number.isInteger(count) && count > 0, JSON.stringify(report));
    }
    assert.equal(report.loadavg.length, 3);
    assert.ok(report.freememBytes > 0 && report.rssBytes > 0);
    // Bounded: the newest eight of ten live runtimes, each debug() kept,
    // failed or cut to 2,048 characters.
    const { live, omitted, runtimes } = report.readiness;
    assert.deepEqual([live, omitted, runtimes.length], [10, 2, 8]);
    const [owned, throwing, oversized] = runtimes.slice(-3);
    assert.deepEqual(owned, {
        owner: { file: "owner.test.ts", test: "opened it" },
        debug: { armedTimers: 0, coordinator: { sessions: 1 } },
    });
    assert.deepEqual(throwing, { debugError: "DEBUG_UNAVAILABLE" });
    assert.equal(oversized.debugTruncated.length, 2_048);
    assert.ok(
        result.stderr
            .split(/\r?\n/)
            .find((line) => line.startsWith('{"event":"shared-fs.hang-report"'))
            .length < 32_768
    );

    const probes = result.find("shared-fs.hang-probe");
    assert.equal(probes.length, 1, result.stderr);
    const [probe] = probes;
    assert.equal(probe.test, report.test);
    assert.equal(probe.pid, report.pid);
    assert.equal(probe.bytes, 4096);
    assert.equal(probe.probes.tmpdir.path, tmpdir());
    for (const name of ["tmpdir", "cwd"]) {
        assert.equal(
            typeof probe.probes[name].writeFsyncMs,
            "number",
            JSON.stringify(probe)
        );
    }

    const [failure] = result.find("shared-fs.first-attempt-failure");
    assert.match(failure.errors[0].message, /Test timed out in 3000ms/);
    // A failed attempt's report and probe precede its failure line.
    const order = [
        "shared-fs.hang-report",
        "shared-fs.hang-probe",
        "shared-fs.first-attempt-failure",
    ].map((event) => lineAt(result, event));
    assert.ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2]);
});

test("a hung afterEach after a passing body is reported too", () => {
    const result = run(
        "passes, then its afterEach hangs",
        "strict",
        "none",
        200
    );
    assert.equal(result.status, 1, result.stderr);
    const reports = result.find("shared-fs.hang-report");
    assert.equal(reports.length, 1, result.stderr);
    const [report] = reports;
    assert.equal(
        report.test,
        "strict CI fixture > hang in an after hook > passes, then its afterEach hangs"
    );
    // The body passed; the after hooks were running.
    assert.equal(report.state, "pass");
    assert.equal(report.readiness, undefined);
    assert.equal(result.find("shared-fs.hang-probe").length, 1, result.stderr);
    const [failure] = result.find("shared-fs.first-attempt-failure");
    assert.match(failure.errors[0].message, /Hook timed out in 2000ms/);
});

test("a failed attempt waits for its probe before its failure line", () => {
    // Due 10 ms before the test's 600 ms timeout: the probe process is
    // still starting when the attempt fails.
    const result = run("times out while its probe runs", "strict", "none", 590);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.find("shared-fs.hang-report").length, 1, result.stderr);
    assert.equal(result.find("shared-fs.hang-probe").length, 1, result.stderr);
    const [failure] = result.find("shared-fs.first-attempt-failure");
    assert.match(failure.errors[0].message, /Test timed out in 600ms/);
    const order = [
        "shared-fs.hang-report",
        "shared-fs.hang-probe",
        "shared-fs.first-attempt-failure",
    ].map((event) => lineAt(result, event));
    assert.ok(
        order[0] >= 0 && order[0] < order[1] && order[1] < order[2],
        result.stderr
    );
});

test("an attempt's hang report is disarmed when the attempt ends", () => {
    // The fixture's afterAll keeps the worker running 1 s after the
    // attempt ended, past the 500 ms threshold.
    const result = run("passes before a slow afterAll", "strict", "none", 500);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 passed/);
    assert.equal(result.find("shared-fs.hang-report").length, 0, result.stderr);
    assert.equal(result.find("shared-fs.hang-probe").length, 0, result.stderr);
});

test("fast tests write no hang report or probe", () => {
    const result = run(
        "clean pass$|expected failure$|unused retry budget$",
        "strict",
        "none",
        2_000
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3 passed/);
    assert.equal(result.find("shared-fs.hang-report").length, 0);
    assert.equal(result.find("shared-fs.hang-probe").length, 0);
});

test("SHARED_FS_HANG_REPORT_MS=0 turns the hang report off", () => {
    const result = run("hangs past the hang report", "strict", "none", 0);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.find("shared-fs.hang-report").length, 0);
    assert.equal(result.find("shared-fs.hang-probe").length, 0);
    const [failure] = result.find("shared-fs.first-attempt-failure");
    assert.match(failure.errors[0].message, /Test timed out in 3000ms/);
});

test("the hang report threshold defaults to 30 s, and 0 turns it off", () => {
    assert.equal(DEFAULT_HANG_REPORT_MS, 30_000);
    for (const unset of [undefined, "", " ", "soon", "-1", "NaN"]) {
        assert.equal(hangReportMs(unset), 30_000, String(unset));
    }
    assert.equal(hangReportMs("0"), 0);
    assert.equal(hangReportMs("250"), 250);
    // Node fires a longer timeout after 1 ms.
    assert.equal(hangReportMs("1e12"), 2 ** 31 - 1);
});

// The probe unrefs its child, pipe and deadline so it never keeps a
// worker alive; these tests hold the event loop open themselves.
const held = async (promise) => {
    const alive = setInterval(() => {}, 1_000);
    try {
        return await promise;
    } finally {
        clearInterval(alive);
    }
};

test("a disk probe reports each directory's write+fsync time or its error", async () => {
    const missing = path.join(tmpdir(), `shared-fs-no-such-dir-${process.pid}`);
    const result = await held(probeVolumes({ tmpdir: tmpdir(), missing }));
    assert.equal(result.bytes, 4096);
    assert.equal(typeof result.childStartMs, "number", JSON.stringify(result));
    assert.equal(result.probes.tmpdir.path, tmpdir());
    assert.equal(
        typeof result.probes.tmpdir.writeFsyncMs,
        "number",
        JSON.stringify(result)
    );
    assert.deepEqual(result.probes.missing, { path: missing, error: "ENOENT" });
});

test("a disk probe still running at its deadline is reported pending and killed", async () => {
    const children = [];
    const result = await held(
        probeVolumes(
            { tmpdir: tmpdir(), cwd: process.cwd() },
            {
                deadlineMs: 500,
                // Never answers: a probe stuck behind a stalled volume.
                script: "setInterval(() => {}, 1_000)",
                spawnChild: (...args) => {
                    const child = spawn(...args);
                    children.push(child);
                    return child;
                },
            }
        )
    );
    assert.deepEqual(result, {
        bytes: 4096,
        childStartMs: "pending > 0.5 s",
        probes: {
            tmpdir: { path: tmpdir(), writeFsyncMs: "pending > 0.5 s" },
            cwd: { path: process.cwd(), writeFsyncMs: "pending > 0.5 s" },
        },
    });
    const [child] = children;
    assert.equal(child.killed, true);
    if (child.exitCode === null && child.signalCode === null) {
        await held(once(child, "exit"));
    }
});

test("a probe whose output nobody reads still finishes and removes its files", async () => {
    const directories = {
        first: mkdtempSync(path.join(tmpdir(), "shared-fs-probe-unread-")),
        second: mkdtempSync(path.join(tmpdir(), "shared-fs-probe-unread-")),
    };
    try {
        let child;
        const result = await held(
            probeVolumes(directories, {
                spawnChild: (...args) => {
                    child = spawn(...args);
                    // As when its worker exited first (a passing attempt
                    // does not wait for its probe): each write of the
                    // probe fails with EPIPE.
                    child.stdout.destroy();
                    return child;
                },
            })
        );
        // The probe settles when its process closed.
        assert.equal(child.exitCode, 0, JSON.stringify(result));
        for (const directory of Object.values(directories)) {
            assert.deepEqual(readdirSync(directory), [], directory);
        }
    } finally {
        for (const directory of Object.values(directories)) {
            rmSync(directory, { recursive: true, force: true });
        }
    }
});
