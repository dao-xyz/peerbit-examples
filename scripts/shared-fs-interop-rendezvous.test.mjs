// Runs scripts/shared-fs-interop-rendezvous.mjs against a fake gh: a PATH
// shim that answers each `gh api` call with the next canned listing of this
// run's jobs (the last one repeats), and records its arguments.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
    new URL("./shared-fs-interop-rendezvous.mjs", import.meta.url)
);

// Call n gets response n (the last one repeats): response-<n>.json on
// stdout, or error-<n>.txt on stderr with exit status 1.
const FAKE_GH = `#!/bin/sh
dir="$FAKE_GH_DIR"
n=$(cat "$dir/count" 2>/dev/null || echo 0)
echo $((n + 1)) > "$dir/count"
printf '%s\\n' "$*" >> "$dir/calls.log"
last=$(cat "$dir/last")
if [ "$n" -gt "$last" ]; then n=$last; fi
if [ -f "$dir/error-$n.txt" ]; then
    cat "$dir/error-$n.txt" >&2
    exit 1
fi
cat "$dir/response-$n.json"
`;

// The peer jobs of an attempt are created together, when the plan job
// finishes, so a job is created when its test began unless it says
// otherwise.
let testStarted = new Date();

const test = (name, run) =>
    nodeTest(
        name,
        {
            skip:
                process.platform === "win32" &&
                "the fake gh is a POSIX shell script",
        },
        (t) => {
            testStarted = new Date();
            return run(t);
        }
    );

const PRESENCE = "Report interop presence";

let nextId = 1;
/**
 * A job as the default jobs listing (filter=latest) shows it: created at
 * `created`, on a runner from `started` unless it never got one, built (and
 * present, when `ready`) at `readyAt`, and finished at `completed` once its
 * status is "completed". `rendezvous` numbers it with the run attempt.
 */
const job = (
    name,
    {
        status = "in_progress",
        conclusion = null,
        ready = false,
        runner = status !== "queued",
        created = testStarted,
        started = created,
        readyAt = started,
        completed = new Date(),
    } = {}
) => {
    const id = nextId++;
    return {
        id,
        name,
        status,
        conclusion,
        created_at: created.toISOString(),
        // A job that never got a runner shows its creation time, as run
        // 44119409037's macOS job did.
        started_at: (runner ? started : created).toISOString(),
        completed_at: status === "completed" ? completed.toISOString() : null,
        runner_name: runner ? `GitHub Actions ${id}` : null,
        steps: !runner
            ? []
            : [
                  {
                      name: "Build shared-fs packages",
                      status: "completed",
                      conclusion: "success",
                      number: 6,
                      completed_at: readyAt.toISOString(),
                  },
                  ...(ready
                      ? [
                            {
                                name: PRESENCE,
                                status: "completed",
                                conclusion: "success",
                                number: 7,
                                completed_at: readyAt.toISOString(),
                            },
                        ]
                      : []),
              ],
    };
};

/**
 * A job that a re-run of only some jobs did not re-run, as the listing of
 * the new attempt shows it (seen on microsoft/vscode runs 44175873032 and
 * 44173326667): created when the re-run began (`rerun`), but with the
 * status, times and steps of the attempt that ran it from `ran` (built a
 * minute later, finished 15 minutes later).
 */
const carriedOver = (
    name,
    { ran, rerun = testStarted, conclusion = "success", ready = true }
) => ({
    ...job(name, {
        status: "completed",
        conclusion,
        ready,
        created: ran,
        readyAt: new Date(ran.getTime() + 60_000),
        completed: new Date(ran.getTime() + 15 * 60_000),
    }),
    created_at: rerun.toISOString(),
});

const plan = () =>
    job("Plan interop peers", { status: "completed", conclusion: "success" });
const seed = (options) => job("Seed peer (linux)", options);
const joiner = (machine, options) => job(`Join peer (${machine})`, options);

/**
 * Runs the rendezvous as `machine` (linux unless --machine is passed) with
 * short intervals; `responses` are the fake gh's answers, in call order.
 */
const rendezvous = async (t, responses, args = [], env = {}) => {
    const dir = await mkdtemp(path.join(tmpdir(), "interop-rendezvous-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(path.join(dir, "gh"), FAKE_GH);
    await chmod(path.join(dir, "gh"), 0o755);
    // The default listing numbers every job with the latest attempt, a job
    // that a re-run of only some jobs carried over included.
    const attempt = Number(env.GITHUB_RUN_ATTEMPT ?? "1");
    for (const [index, response] of responses.entries()) {
        if (response.error) {
            await writeFile(
                path.join(dir, `error-${index}.txt`),
                `${response.error}\n`
            );
        } else {
            await writeFile(
                path.join(dir, `response-${index}.json`),
                JSON.stringify({
                    total_count: response.length,
                    jobs: response.map((entry) => ({
                        ...entry,
                        run_attempt: attempt,
                    })),
                })
            );
        }
    }
    await writeFile(path.join(dir, "last"), String(responses.length - 1));

    const options = new Map([
        ["--machine", "linux"],
        ["--expected", "linux,macos,windows"],
        ["--poll-seconds", "0.05"],
        ["--slow-poll-seconds", "0.05"],
        ["--slow-after-seconds", "600"],
        ["--report-seconds", "0.25"],
        ["--grace-seconds", "0.6"],
        ["--arrival-timeout-minutes", "0.1"],
    ]);
    for (let index = 0; index < args.length; index += 2) {
        options.set(args[index], args[index + 1]);
    }
    const started = Date.now();
    const result = await new Promise((resolve) => {
        execFile(
            process.execPath,
            [script, ...[...options].flat()],
            {
                env: {
                    ...process.env,
                    PATH: `${dir}${path.delimiter}${process.env.PATH}`,
                    FAKE_GH_DIR: dir,
                    GITHUB_REPOSITORY: "dao-xyz/peerbit-examples",
                    GITHUB_RUN_ID: "123",
                    GITHUB_RUN_ATTEMPT: "1",
                    ...env,
                },
            },
            (error, stdout, stderr) =>
                resolve({ code: error ? error.code : 0, stdout, stderr })
        );
    });
    const elapsedMs = Date.now() - started;
    const calls = (
        await readFile(path.join(dir, "calls.log"), "utf8").catch(() => "")
    )
        .split("\n")
        .filter(Boolean);
    const lines = result.stdout.split("\n").filter(Boolean);
    for (const line of [
        ...lines,
        ...result.stderr.split("\n").filter(Boolean),
    ]) {
        t.diagnostic(line);
    }
    t.diagnostic(
        `exit ${result.code} after ${elapsedMs} ms and ${calls.length} gh call(s)`
    );
    return { ...result, lines, calls, elapsedMs };
};

const errors = (lines) => lines.filter((line) => line.startsWith("::error"));

test("returns at once when every peer is already present", async (t) => {
    const { code, lines, calls } = await rendezvous(t, [
        [
            plan(),
            seed({ ready: true }),
            joiner("macos", { ready: true }),
            joiner("windows", { ready: true }),
        ],
    ]);
    assert.equal(code, 0);
    assert.deepEqual(calls, [
        "api repos/dao-xyz/peerbit-examples/actions/runs/123/jobs?per_page=100",
    ]);
    assert.deepEqual(errors(lines), []);
    assert.match(
        lines[0],
        /waiting until linux, macos, windows report "Report interop presence", for at most 0m06s after the peer jobs were created$/
    );
    assert.match(lines.at(-1), /every peer is ready.*starting the interop$/);
    for (const machine of ["linux", "macos", "windows"]) {
        assert.ok(
            lines.some((line) => line.includes(`] ${machine} is ready (`)),
            machine
        );
    }
});

test("waits for a peer that arrives late, then returns", async (t) => {
    const waiting = [
        plan(),
        seed({ ready: true }),
        joiner("macos", { status: "queued" }),
        joiner("windows", { ready: true }),
    ];
    const building = [
        plan(),
        seed({ ready: true }),
        joiner("macos"),
        joiner("windows", { ready: true }),
    ];
    const arrived = [
        plan(),
        seed({ ready: true }),
        joiner("macos", { ready: true }),
        joiner("windows", { ready: true }),
    ];
    const { code, lines, calls } = await rendezvous(t, [
        ...Array(6).fill(waiting),
        ...Array(6).fill(building),
        arrived,
    ]);
    assert.equal(code, 0);
    assert.equal(calls.length, 13);
    assert.deepEqual(errors(lines), []);
    const waits = lines.filter((line) => line.includes("waiting for macos"));
    assert.ok(waits.length >= 1, "reports the missing peer");
    assert.ok(
        waits.every((line) => !/waiting for .*(linux|windows) \(/.test(line)),
        "reports only the missing peer"
    );
    assert.match(waits[0], /Join peer \(macos\): queued, waiting for a runner/);
    assert.ok(lines.some((line) => line.includes("] macos is ready (")));
    assert.match(lines.at(-1), /every peer is ready/);
});

test("meets a peer that queued 16.5 minutes inside the default budget", async (t) => {
    // Run 44169123431, in minutes after its peer jobs were created at
    // 20:25:24Z: the seed got a runner at 0.17 and built by 0.7, Windows at
    // 0.8 and 2.2, macOS at 16.5 and 18.7. Before the rendezvous, Windows'
    // window ran out at 12.5 and the seed's job hit its 20-minute limit.
    const created = new Date(Date.now() - 18.7 * 60_000);
    const at = (minutes) => new Date(created.getTime() + minutes * 60_000);
    const linux = seed({
        created,
        started: at(0.17),
        readyAt: at(0.7),
        ready: true,
    });
    const windows = joiner("windows", {
        created,
        started: at(0.8),
        readyAt: at(2.2),
        ready: true,
    });
    const { code, lines } = await rendezvous(
        t,
        [
            [
                plan(),
                linux,
                joiner("macos", { created, status: "queued" }),
                windows,
            ],
            [
                plan(),
                linux,
                joiner("macos", { created, started: at(16.5) }),
                windows,
            ],
            [
                plan(),
                linux,
                joiner("macos", {
                    created,
                    started: at(16.5),
                    readyAt: at(18.7),
                    ready: true,
                }),
                windows,
            ],
        ],
        ["--arrival-timeout-minutes", "45"]
    );
    assert.equal(code, 0);
    assert.deepEqual(errors(lines), []);
    assert.ok(
        lines.some((line) =>
            line.endsWith(
                "] macos is ready (Join peer (macos), 18m42s after the peer jobs were created)"
            )
        )
    );
    assert.match(
        lines.at(-1),
        /every peer is ready, 18m4\ds after the peer jobs were created; starting the interop$/
    );
});

test("polls less often once the wait is long", async (t) => {
    const { code, lines, calls } = await rendezvous(
        t,
        [
            [
                plan(),
                seed({ ready: true }),
                joiner("macos", { status: "queued" }),
                joiner("windows", { ready: true }),
            ],
        ],
        [
            "--slow-after-seconds",
            "0.3",
            "--slow-poll-seconds",
            "0.5",
            "--arrival-timeout-minutes",
            "0.03",
        ]
    );
    assert.equal(code, 1);
    const slowed = lines.filter((line) =>
        line.includes("; polling every 0.5s from now on")
    );
    assert.equal(slowed.length, 1);
    assert.match(slowed[0], /still waiting after 0m0\ds/);
    // 1.8 s: at most 0.3 s of 50 ms polls, then 1.5 s of 500 ms polls.
    assert.ok(calls.length <= 12, `${calls.length} gh calls`);
});

test("reports the missing peers at most once per report interval", async (t) => {
    const { code, lines, elapsedMs } = await rendezvous(
        t,
        [
            [
                plan(),
                seed({ ready: true }),
                joiner("macos", { status: "queued" }),
                joiner("windows", { status: "queued" }),
            ],
        ],
        ["--arrival-timeout-minutes", "0.025"]
    );
    assert.equal(code, 1);
    const waits = lines.filter((line) =>
        / after (this step started|the peer jobs were created), waiting for /.test(
            line
        )
    );
    assert.ok(waits.length >= 2, `${waits.length} status lines`);
    assert.ok(
        waits.length <= Math.ceil(elapsedMs / 250) + 1,
        `${waits.length} status lines in ${elapsedMs} ms`
    );
    assert.match(waits[0], /waiting for macos \(.*\); windows \(/);
});

test("fails at once when a sibling peer's job failed before presence", async (t) => {
    const { code, lines, calls } = await rendezvous(t, [
        [
            plan(),
            seed({ ready: true }),
            joiner("macos", { status: "queued" }),
            joiner("windows", { status: "completed", conclusion: "failure" }),
        ],
    ]);
    assert.equal(code, 1);
    assert.equal(calls.length, 1);
    const [error] = errors(lines);
    assert.match(
        error,
        /^::error title=Interop rendezvous \(linux\)::Join peer \(windows\) finished \(failure\) before it reported presence, so windows cannot take part/
    );
    assert.match(
        error,
        /also not ready: macos \(Join peer \(macos\): queued, waiting for a runner\)/
    );
});

test("fails at once when a runner never came and the job was cancelled", async (t) => {
    // Run 44119409037: the peer jobs were created at 15:53:11Z; macOS never
    // got a runner and GitHub cancelled its job at 16:11:57Z.
    const created = new Date(Date.now() - 18.77 * 60_000);
    const { code, lines } = await rendezvous(
        t,
        [
            [
                plan(),
                seed({ created, started: created, ready: true }),
                joiner("macos", {
                    created,
                    status: "completed",
                    conclusion: "cancelled",
                    runner: false,
                }),
                joiner("windows", { created, ready: true }),
            ],
        ],
        ["--machine", "windows", "--arrival-timeout-minutes", "45"]
    );
    assert.equal(code, 1);
    const [error] = errors(lines);
    assert.match(
        error,
        /Join peer \(macos\) finished \(cancelled\) before it reported presence, so macos cannot take part in the interop$/
    );
    assert.doesNotMatch(error, /earlier run attempt/);
});

test("fails when a present sibling gave up before every peer was ready", async (t) => {
    const { code, lines } = await rendezvous(
        t,
        [
            [
                plan(),
                seed({
                    status: "completed",
                    conclusion: "failure",
                    ready: true,
                }),
                joiner("macos", { status: "queued" }),
                joiner("windows", { ready: true }),
            ],
        ],
        ["--machine", "windows"]
    );
    assert.equal(code, 1);
    assert.match(
        errors(lines)[0],
        /Seed peer \(linux\) finished \(failure\) after it reported presence, before every peer was ready/
    );
});

test("names an earlier attempt when only some jobs were re-run", async (t) => {
    // Attempt 1 ran 40 minutes ago, and only macOS failed; "Re-run failed
    // jobs" re-ran macOS alone. The listing numbers the seed and Windows
    // with attempt 2 and shows them created with it, finished and present.
    const ran = new Date(Date.now() - 40 * 60_000);
    const { code, lines } = await rendezvous(
        t,
        [
            [
                carriedOver("Plan interop peers", { ran, ready: false }),
                carriedOver("Seed peer (linux)", { ran }),
                joiner("macos", { ready: true }),
                carriedOver("Join peer (windows)", { ran }),
            ],
        ],
        ["--machine", "macos"],
        { GITHUB_RUN_ATTEMPT: "2" }
    );
    assert.equal(code, 1);
    const [error] = errors(lines);
    assert.match(
        error,
        /::Seed peer \(linux\) finished \(success\) in an earlier run attempt, so linux cannot take part in attempt 2: re-run all jobs, not only the failed ones; /
    );
    assert.match(
        error,
        /also not ready: windows \(Join peer \(windows\): finished, success, in an earlier run attempt\)$/
    );
    assert.ok(lines.some((line) => line.includes("] macos is ready (")));
    assert.ok(
        !lines.some((line) => /\] (linux|windows) is ready \(/.test(line)),
        "an earlier attempt's presence is not this attempt's"
    );
});

test("names a peer left over from an earlier attempt before one that failed in this attempt", async (t) => {
    // Attempt 1: the seed and macOS failed and Windows passed; attempt 2
    // re-ran the seed and macOS, and macOS failed again before its presence.
    const ran = new Date(Date.now() - 40 * 60_000);
    const { code, lines } = await rendezvous(
        t,
        [
            [
                carriedOver("Plan interop peers", { ran, ready: false }),
                seed({ ready: true }),
                joiner("macos", { status: "completed", conclusion: "failure" }),
                carriedOver("Join peer (windows)", { ran }),
            ],
        ],
        [],
        { GITHUB_RUN_ATTEMPT: "2" }
    );
    assert.equal(code, 1);
    const [error] = errors(lines);
    assert.match(
        error,
        /::Join peer \(windows\) finished \(success\) in an earlier run attempt, so windows cannot take part in attempt 2: re-run all jobs, not only the failed ones; also not ready: macos \(Join peer \(macos\): finished, failure\)$/
    );
});

test("meets every peer when a re-run kept only the plan job", async (t) => {
    // "Re-run failed jobs" after every peer failed: the plan job is carried
    // over from attempt 1, and every peer job runs again in attempt 2.
    const ran = new Date(Date.now() - 40 * 60_000);
    const { code, lines } = await rendezvous(
        t,
        [
            [
                carriedOver("Plan interop peers", { ran, ready: false }),
                seed({ ready: true }),
                joiner("macos", { ready: true }),
                joiner("windows", { ready: true }),
            ],
        ],
        ["--machine", "windows"],
        { GITHUB_RUN_ATTEMPT: "2" }
    );
    assert.equal(code, 0);
    assert.deepEqual(errors(lines), []);
    assert.match(lines.at(-1), /every peer is ready/);
});

test("fails when the arrival budget runs out, naming who never arrived", async (t) => {
    const { code, lines, elapsedMs } = await rendezvous(
        t,
        [
            [
                plan(),
                seed({ ready: true }),
                joiner("macos", { status: "queued" }),
                joiner("windows", { ready: true }),
            ],
        ],
        ["--arrival-timeout-minutes", "0.02"]
    );
    assert.equal(code, 1);
    assert.ok(elapsedMs >= 1_000, `gave up after ${elapsedMs} ms`);
    const [error] = errors(lines);
    assert.match(
        error,
        /not every peer was ready 0m01s after the peer jobs were created; not ready: macos \(Join peer \(macos\): queued, waiting for a runner\)\./
    );
    assert.doesNotMatch(error, /not ready: .*(linux|windows) \(/);
    assert.match(
        error,
        /re-run the workflow, or raise arrival_timeout_minutes/
    );
});

test("counts the arrival budget from when the peer jobs were created", async (t) => {
    const created = new Date(Date.now() - 60_000);
    const { code, lines, calls } = await rendezvous(
        t,
        [
            [
                plan(),
                seed({ ready: true, created }),
                joiner("macos", { status: "queued", created }),
                joiner("windows", { ready: true, created }),
            ],
        ],
        ["--arrival-timeout-minutes", "0.5"]
    );
    assert.equal(code, 1);
    assert.equal(calls.length, 1, "the budget was already spent");
    assert.match(errors(lines)[0], /not every peer was ready 0m30s after/);
});

test("retries when listing the jobs fails", async (t) => {
    const { code, lines, calls } = await rendezvous(t, [
        { error: "HTTP 502: Bad Gateway" },
        { error: "HTTP 502: Bad Gateway" },
        [
            plan(),
            seed({ ready: true }),
            joiner("macos", { ready: true }),
            joiner("windows", { ready: true }),
        ],
    ]);
    assert.equal(code, 0);
    assert.equal(calls.length, 3);
    assert.ok(
        lines.some((line) =>
            line.includes("could not list this run's jobs (HTTP 502")
        )
    );
});

test("fails after the grace period when a peer has no job", async (t) => {
    const { code, lines, elapsedMs } = await rendezvous(t, [
        [plan(), seed({ ready: true }), joiner("windows", { ready: true })],
    ]);
    assert.equal(code, 1);
    assert.ok(elapsedMs >= 600, `failed after ${elapsedMs} ms`);
    assert.match(
        errors(lines)[0],
        /no job for macos in this run after 0m0\ds: a peer's job name must end in "\(<machine>\)"$/
    );
});

test("fails after the grace period when its own presence never shows", async (t) => {
    const { code, lines } = await rendezvous(t, [
        [
            plan(),
            seed(),
            joiner("macos", { ready: true }),
            joiner("windows", { ready: true }),
        ],
    ]);
    assert.equal(code, 1);
    assert.match(
        errors(lines)[0],
        /this job \(Seed peer \(linux\)\) has not shown a completed "Report interop presence" step/
    );
});

test("refuses two jobs that claim the same machine", async (t) => {
    const { code, lines } = await rendezvous(t, [
        [
            plan(),
            seed({ ready: true }),
            joiner("macos", { ready: true }),
            job("Lint (macos)"),
            joiner("windows", { ready: true }),
        ],
    ]);
    assert.equal(code, 1);
    assert.match(
        errors(lines)[0],
        /several jobs end in "\(macos\)": Join peer \(macos\), Lint \(macos\)/
    );
});

test("refuses two jobs of the same name for one machine", async (t) => {
    const { code, lines } = await rendezvous(t, [
        [
            plan(),
            seed({ ready: true }),
            joiner("macos", { ready: true }),
            joiner("macos", { status: "queued" }),
            joiner("windows", { ready: true }),
        ],
    ]);
    assert.equal(code, 1);
    assert.match(
        errors(lines)[0],
        /several jobs end in "\(macos\)": Join peer \(macos\), Join peer \(macos\); each peer needs exactly one$/
    );
});

test("rejects an expected list without its own machine", async (t) => {
    const { code, lines, calls } = await rendezvous(
        t,
        [[plan()]],
        ["--expected", "macos,windows"]
    );
    assert.equal(code, 1);
    assert.equal(calls.length, 0);
    assert.match(
        errors(lines)[0],
        /--expected \(macos,windows\) must include --machine \(linux\)/
    );
});
