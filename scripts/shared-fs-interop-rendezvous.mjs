#!/usr/bin/env node

// Rendezvous for the Shared FS Cross-OS Interop workflow.
//
// Each peer job (the Linux seed and every joiner) completes a step named
// "Report interop presence" once it has built and is ready to start its
// node, then runs this script, which returns once the job of every expected
// peer has completed that step. Only then does a peer start its node, so
// every peer's interop window starts at about the same time, however long
// one of them queued for a runner.
//
// The script polls this run's jobs (gh api .../actions/runs/<id>/jobs, which
// needs `actions: read`). A peer's job is the one whose name ends in
// "(<machine>)". The script fails:
// - at once, when another peer's job has already finished: that peer can no
//   longer take part. A re-run of only some jobs lists each job it did not
//   re-run as finished, under the new attempt's number and creation time but
//   with the times and steps of the attempt that ran it. Such a job finished
//   before this one was created, and the script asks for a re-run of all
//   jobs;
// - when the arrival budget runs out, counted from when the peer jobs were
//   created, naming the peers that are not ready;
// - at once, when listing the jobs fails in a way that a retry cannot fix:
//   HTTP 401, 403 other than a rate limit, 404, or gh without a token.
//   Other failed listings (network errors, timeouts, HTTP 5xx and 429, rate
//   limits) are retried;
// - after a grace period, when an expected peer has no job in this run, or
//   this job's own presence step never shows up (a renamed job or step).
//
// Each poll is one REST request on the job's GITHUB_TOKEN, and every job in
// the repository shares that token's 1,000 requests an hour. So a peer polls
// every --poll-seconds while its wait is short, and every
// --slow-poll-seconds once it has waited --slow-after-seconds: by then it is
// waiting for a runner, which takes minutes.
//
// Usage:
//   node scripts/shared-fs-interop-rendezvous.mjs --machine <machine>
//     --expected <machine,...> [--arrival-timeout-minutes 45]
//     [--poll-seconds 10] [--slow-poll-seconds 30] [--slow-after-seconds 180]
//     [--report-seconds 60] [--grace-seconds 120]
//     [--presence-step "Report interop presence"]
// Reads GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT; gh reads
// GH_TOKEN.

import { execFile } from "node:child_process";

const PRESENCE_STEP = "Report interop presence";

const parseArgs = (args) => {
    const value = (name) => {
        const index = args.indexOf(name);
        return index === -1 ? undefined : args[index + 1];
    };
    const seconds = (name, fallback, unit = 1) => {
        const raw = value(name);
        if (raw === undefined) {
            return fallback * unit * 1000;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error(
                `${name} must be a positive number, got ${JSON.stringify(raw)}`
            );
        }
        return parsed * unit * 1000;
    };
    const machine = value("--machine");
    if (!machine) {
        throw new Error("--machine is required");
    }
    const expected = (value("--expected") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    if (!expected.includes(machine)) {
        throw new Error(
            `--expected (${expected.join(",")}) must include --machine (${machine})`
        );
    }
    return {
        machine,
        expected,
        arrivalMs: seconds("--arrival-timeout-minutes", 45, 60),
        pollMs: seconds("--poll-seconds", 10),
        slowPollMs: seconds("--slow-poll-seconds", 30),
        slowAfterMs: seconds("--slow-after-seconds", 180),
        reportMs: seconds("--report-seconds", 60),
        graceMs: seconds("--grace-seconds", 120),
        presenceStep: value("--presence-step") ?? PRESENCE_STEP,
    };
};

/**
 * Runs gh. A failure carries the first line gh printed as its message, all
 * of it as `output`, gh's exit code and the HTTP status, when gh names one:
 * `gh api` prints "gh: <message> (HTTP <status>)", other commands "HTTP
 * <status>: <message> (<url>)".
 */
const gh = (args) =>
    new Promise((resolve, reject) => {
        execFile(
            "gh",
            args,
            {
                timeout: 60_000,
                maxBuffer: 32 * 1024 * 1024,
                windowsHide: true,
            },
            (error, stdout, stderr) => {
                if (error) {
                    const detail =
                        String(stderr ?? "").trim() ||
                        (error.killed
                            ? `gh ${args[0]} timed out`
                            : error.message);
                    reject(
                        Object.assign(new Error(detail.split("\n")[0]), {
                            output: detail,
                            code: error.code,
                            status: Number(
                                /\bHTTP (\d{3})\b/.exec(detail)?.[1] ?? NaN
                            ),
                        })
                    );
                    return;
                }
                resolve(stdout);
            }
        );
    });

const listJobs = async (repository, runId) => {
    const stdout = await gh([
        "api",
        `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`,
    ]);
    let body;
    try {
        body = JSON.parse(stdout);
    } catch {
        throw new Error("gh api returned invalid JSON");
    }
    if (!Array.isArray(body?.jobs)) {
        throw new Error("gh api returned no jobs list");
    }
    return body.jobs;
};

/**
 * Why a gh call that failed with `error` would fail again however often it
 * were retried, or undefined when a retry may succeed: a network error, a
 * timeout, HTTP 5xx or 429, or a 403 for a rate limit.
 */
const permanentFailure = (error, action, { repository, runId }) => {
    if (error.code === "ENOENT") {
        return "gh is not installed on this runner";
    }
    // gh exits with 4 when it has no token.
    if (error.code === 4) {
        return `${action} failed, gh has no token (${error.message}): the step needs GH_TOKEN`;
    }
    if (error.status === 401) {
        return `${action} failed (${error.message}): GH_TOKEN is not a valid token`;
    }
    if (error.status === 403 && !/rate limit/i.test(error.output ?? "")) {
        return `${action} was refused (${error.message}): the workflow's token needs the "actions: read" permission`;
    }
    if (error.status === 404) {
        return `${action} found no run ${runId} in ${repository} (${error.message}): GITHUB_REPOSITORY and GITHUB_RUN_ID must name this run, and the workflow's token needs the "actions: read" permission`;
    }
    return undefined;
};

/**
 * The job of `machine`, or the names of the jobs that claim it when there
 * are several. The default jobs listing holds one record per job, so each
 * peer must have exactly one.
 */
const jobOf = (jobs, machine) => {
    const matches = jobs.filter(
        (job) =>
            typeof job?.name === "string" && job.name.endsWith(`(${machine})`)
    );
    return matches.length > 1
        ? { ambiguous: matches.map((job) => job.name) }
        : { job: matches[0] };
};

const presenceOf = (job, stepName) =>
    (job?.steps ?? []).find(
        (step) =>
            step?.name === stepName &&
            step.status === "completed" &&
            step.conclusion === "success"
    );

const duration = (ms) => {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
};

const describe = (peer) => {
    const { job, machine } = peer;
    if (!job) {
        return `${machine} (no job named "... (${machine})" in this run)`;
    }
    if (job.status === "completed") {
        return `${machine} (${job.name}: finished, ${job.conclusion ?? "no conclusion"}${peer.earlier ? ", in an earlier run attempt" : ""})`;
    }
    if (!job.runner_name) {
        return `${machine} (${job.name}: ${job.status}, waiting for a runner)`;
    }
    return `${machine} (${job.name}: ${job.status} on ${job.runner_name}, still setting up)`;
};

// Workflow command data must not carry raw newlines or percent signs.
const escapeData = (text) =>
    String(text)
        .replace(/%/g, "%25")
        .replace(/\r/g, "%0D")
        .replace(/\n/g, "%0A");

const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const repository = process.env.GITHUB_REPOSITORY;
    const runId = process.env.GITHUB_RUN_ID;
    if (!repository || !runId) {
        throw new Error("GITHUB_REPOSITORY and GITHUB_RUN_ID are required");
    }
    const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT) || 1;

    const say = (message) =>
        console.log(
            `${new Date().toISOString()} [rendezvous ${options.machine}] ${message}`
        );
    const fail = (message) => {
        console.log(
            `::error title=Interop rendezvous (${options.machine})::${escapeData(message)}`
        );
        process.exitCode = 1;
    };

    const startedAt = Date.now();
    // The arrival budget counts from when the peer jobs were created (this
    // job's created_at), so every peer gives up at the same moment. Until a
    // listing shows it, count from now.
    let since = startedAt;
    let sinceLabel = "this step started";
    let lastPeers;
    let lastError;
    let lastReport = -Infinity;
    let lastErrorReport = -Infinity;
    let slowed = false;
    const announced = new Set();

    say(
        `waiting until ${options.expected.join(", ")} report "${options.presenceStep}", for at most ${duration(options.arrivalMs)} after the peer jobs were created`
    );
    for (;;) {
        let peers;
        try {
            const jobs = await listJobs(repository, runId);
            peers = options.expected.map((machine) => ({
                machine,
                ...jobOf(jobs, machine),
            }));
            lastError = undefined;
        } catch (error) {
            const permanent = permanentFailure(
                error,
                "listing this run's jobs",
                { repository, runId }
            );
            if (permanent) {
                fail(permanent);
                return;
            }
            lastError = error;
            if (Date.now() - lastErrorReport >= options.reportMs) {
                say(
                    `could not list this run's jobs (${error.message}); retrying`
                );
                lastErrorReport = Date.now();
            }
        }

        const now = Date.now();
        if (peers) {
            const self = peers.find((peer) => peer.machine === options.machine);
            const created = Date.parse(self.job?.created_at ?? "");
            if (Number.isFinite(created)) {
                since = created;
                sinceLabel = "the peer jobs were created";
            }
            for (const peer of peers) {
                // A job that finished before this one was created ran in an
                // earlier attempt: a re-run of only some jobs lists it again,
                // under this attempt, with that attempt's times and steps.
                // Its presence is not this attempt's.
                peer.earlier =
                    peer !== self &&
                    peer.job?.status === "completed" &&
                    Date.parse(peer.job.completed_at ?? "") < created;
                peer.ready =
                    peer.job && !peer.earlier
                        ? presenceOf(peer.job, options.presenceStep)
                        : undefined;
            }
            lastPeers = peers;

            const ambiguous = peers.find((peer) => peer.ambiguous);
            if (ambiguous) {
                fail(
                    `several jobs end in "(${ambiguous.machine})": ${ambiguous.ambiguous.join(", ")}; each peer needs exactly one`
                );
                return;
            }

            for (const peer of peers) {
                if (peer.ready && !announced.has(peer.machine)) {
                    announced.add(peer.machine);
                    const readyAt = Date.parse(peer.ready.completed_at ?? "");
                    say(
                        `${peer.machine} is ready (${peer.job.name}${Number.isFinite(readyAt) ? `, ${duration(readyAt - since)} after ${sinceLabel}` : ""})`
                    );
                }
            }

            const missing = peers.filter((peer) => !peer.ready);
            const done = peers.filter(
                (peer) => peer !== self && peer.job?.status === "completed"
            );
            // Name a peer left over from an earlier attempt first: only a
            // re-run of all jobs brings it back.
            const finished = done.find((peer) => peer.earlier) ?? done[0];
            if (finished) {
                const { job, machine } = finished;
                const conclusion = job.conclusion ?? "no conclusion";
                const reason = finished.earlier
                    ? `${job.name} finished (${conclusion}) in an earlier run attempt, so ${machine} cannot take part in attempt ${runAttempt}: re-run all jobs, not only the failed ones`
                    : `${job.name} finished (${conclusion}) ${finished.ready ? "after it reported presence, before every peer was ready" : "before it reported presence"}, so ${machine} cannot take part in the interop`;
                const others = missing.filter((peer) => peer !== finished);
                fail(
                    `${reason}${others.length > 0 ? `; also not ready: ${others.map(describe).join("; ")}` : ""}`
                );
                return;
            }

            if (missing.length === 0) {
                say(
                    `every peer is ready, ${duration(now - since)} after ${sinceLabel}; starting the interop`
                );
                return;
            }

            if (now - startedAt >= options.graceMs) {
                const unknown = missing.filter((peer) => !peer.job);
                if (unknown.length > 0) {
                    fail(
                        `no job for ${unknown.map((peer) => peer.machine).join(", ")} in this run after ${duration(now - startedAt)}: a peer's job name must end in "(<machine>)"`
                    );
                    return;
                }
                if (!self.ready) {
                    fail(
                        `this job (${self.job.name}) has not shown a completed "${options.presenceStep}" step after ${duration(now - startedAt)}; that step must run, under that name, before this one`
                    );
                    return;
                }
            }

            if (now - lastReport >= options.reportMs) {
                lastReport = now;
                say(
                    `${duration(now - since)} after ${sinceLabel}, waiting for ${missing.map(describe).join("; ")}`
                );
            }
        }

        const deadline = since + options.arrivalMs;
        if (now >= deadline) {
            const budget = duration(options.arrivalMs);
            if (!lastPeers) {
                fail(
                    `could not list this run's jobs within ${budget}: ${lastError?.message ?? "no response"}`
                );
                return;
            }
            const missing = lastPeers.filter((peer) => !peer.ready);
            fail(
                `not every peer was ready ${budget} after ${sinceLabel}; not ready: ${missing.map(describe).join("; ")}. A hosted runner can queue for a long time (macOS arm64 under capacity constraints): re-run the workflow, or raise arrival_timeout_minutes in a manual run${lastError ? `. The last jobs listing failed: ${lastError.message}` : ""}`
            );
            return;
        }
        if (!slowed && now - startedAt >= options.slowAfterMs) {
            slowed = true;
            say(
                `still waiting after ${duration(now - startedAt)}; polling every ${options.slowPollMs / 1000}s from now on`
            );
        }
        await new Promise((resolve) =>
            setTimeout(
                resolve,
                Math.min(
                    slowed ? options.slowPollMs : options.pollMs,
                    deadline - now
                )
            )
        );
    }
};

main().catch((error) => {
    console.log(
        `::error title=Interop rendezvous::${escapeData(error instanceof Error ? error.message : String(error))}`
    );
    process.exitCode = 1;
});
