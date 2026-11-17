import { spawn } from "node:child_process";
import { freemem, loadavg, tmpdir } from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";

// Test diagnostics only. A test attempt (with its hooks) that is still
// running after SHARED_FS_HANG_REPORT_MS gets one report of what its worker
// waits on, then a write+fsync probe of the disks from a fresh process. It
// reports and never decides: no result changes and no passing test waits.
// The clock, the timers and the stderr write are captured here, before a
// test can fake them or capture stderr.
const now = performance.now.bind(performance);
const writeStderr = process.stderr.write.bind(process.stderr);

export const DEFAULT_HANG_REPORT_MS = 30_000;
export const PROBE_DEADLINE_MS = 10_000;
export const PROBE_BYTES = 4096;
const MAX_TIMER_MS = 2 ** 31 - 1;
const DELAY_RESOLUTION_MS = 20;
const MAX_RUNTIMES = 8;
const MAX_RUNTIME_CHARS = 2_048;
const MAX_FIELD_CHARS = 512;

/** SHARED_FS_HANG_REPORT_MS: unset or invalid is 30 s, and 0 disables. */
export function hangReportMs(value) {
    if (value === undefined || String(value).trim() === "") {
        return DEFAULT_HANG_REPORT_MS;
    }
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 0) return DEFAULT_HANG_REPORT_MS;
    return Math.min(ms, MAX_TIMER_MS);
}

const round = (ms) => Math.round(ms * 10) / 10;

// The histogram records whole sampling intervals in ns; report how late
// the sampling timer was, in ms.
const lateness = (ns) => round(Math.max(0, ns / 1e6 - DELAY_RESOLUTION_MS));

function text(value) {
    if (value === undefined) return undefined;
    try {
        return String(value).slice(0, MAX_FIELD_CHARS);
    } catch {
        return "[unreadable]";
    }
}

function writeLine(event) {
    try {
        writeStderr(`${JSON.stringify(event)}\n`);
    } catch {
        // Report only.
    }
}

/**
 * Arms the report for one attempt; `identify()` gives its file, test,
 * attempt and state when it fires. Returns undefined when `ms` is 0, else
 * `stop()`, which disarms it and returns a promise that settles once the
 * probe line is written (it never rejects), or undefined if it never fired.
 */
export function watchAttempt(ms, identify) {
    if (!(ms > 0)) return undefined;
    const started = now();
    let delay;
    try {
        delay = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
        delay.enable();
    } catch {
        delay = undefined;
    }
    let output;
    const timer = setTimeout(() => {
        try {
            output = report(identify(), started, delay);
        } catch {
            // Report only: never fail or slow the test.
        }
    }, ms);
    timer.unref();
    return {
        stop() {
            clearTimeout(timer);
            delay?.disable();
            return output;
        },
    };
}

function report(identity, started, delay) {
    writeLine({
        event: "shared-fs.hang-report",
        ...identity,
        pid: process.pid,
        elapsedMs: round(now() - started),
        // Pending FSReqCallback or FSReqPromise entries are fs requests
        // that have not completed. Thread-pool work of a native addon
        // (LevelDB) is not listed: the probe below tells a stalled volume.
        resources: activeResources(),
        // A large max means the JS thread itself was blocked (a synchronous
        // call), not parked on an await.
        eventLoopDelayMs: delay && {
            max: lateness(delay.max),
            p99: lateness(delay.percentile(99)),
        },
        loadavg: loadavg().map(round),
        freememBytes: freemem(),
        rssBytes: process.memoryUsage.rss(),
        readiness: readinessRuntimes(),
    });
    // A child has its own libuv thread pool: a slow probe means the volume
    // stalled; a fast one next to pending fs requests means a product wait.
    return probeVolumes({ tmpdir: tmpdir(), cwd: process.cwd() }).then(
        (probe) =>
            writeLine({
                event: "shared-fs.hang-probe",
                file: identity.file,
                test: identity.test,
                attempt: identity.attempt,
                pid: process.pid,
                ...probe,
            }),
        () => {}
    );
}

function activeResources() {
    const counts = {};
    try {
        for (const name of process.getActiveResourcesInfo()) {
            counts[name] = (counts[name] ?? 0) + 1;
        }
    } catch {
        // Unavailable: report the rest.
    }
    return counts;
}

/**
 * The debug() of each live readiness runtime the library's test setup
 * registered (globalThis.__SFS_READINESS_SHADOW__), newest last, bounded.
 */
function readinessRuntimes() {
    const registry = globalThis.__SFS_READINESS_SHADOW__;
    if (!(registry?.runtimes instanceof Map)) return undefined;
    const live = [];
    for (const ref of registry.runtimes.values()) {
        const runtime = ref?.deref?.();
        if (runtime) live.push(runtime);
    }
    const shown = live.slice(-MAX_RUNTIMES);
    return {
        live: live.length,
        omitted: live.length - shown.length,
        runtimes: shown.map((runtime) => describeRuntime(registry, runtime)),
    };
}

function describeRuntime(registry, runtime) {
    const entry = {};
    try {
        const owner = registry.live?.get?.(runtime);
        if (owner) {
            entry.owner = { file: text(owner.file), test: text(owner.test) };
        }
    } catch {
        entry.owner = "[unreadable]";
    }
    try {
        const json = JSON.stringify(runtime.debug(), (_, value) =>
            typeof value === "bigint" ? value.toString() : value
        );
        if (json === undefined) entry.debug = null;
        else if (json.length <= MAX_RUNTIME_CHARS)
            entry.debug = JSON.parse(json);
        else entry.debugTruncated = json.slice(0, MAX_RUNTIME_CHARS);
    } catch (error) {
        entry.debugError = text(error?.message ?? error);
    }
    return entry;
}

// Runs in the probe process: per directory an open, a write, an fsync and
// a close, then one stdout line with the time they took (or the error),
// then the file's removal. Its worker may be gone by then (a passing
// attempt does not wait for its probe): a write to that pipe then fails
// with EPIPE, which must not end the probe before it removed its files.
// Plain source: Vitest transforms the runner's modules, so a function's
// toString() would ship rewritten import bindings.
const PROBE_SCRIPT = `
const { open, rm } = require("node:fs/promises");
const { join } = require("node:path");
process.stdout.on("error", () => {});
const say = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
say({ started: true });
const data = Buffer.alloc(${PROBE_BYTES}, 0x61);
process.argv.slice(1).forEach(async (directory, index) => {
    const file = join(directory, ".shared-fs-hang-probe-" + process.pid + "-" + index + ".tmp");
    const start = performance.now();
    try {
        const handle = await open(file, "w");
        try {
            await handle.writeFile(data);
            await handle.sync();
        } finally {
            await handle.close();
        }
        say({ index, ms: performance.now() - start });
    } catch (error) {
        say({ index, error: String(error?.code ?? error?.message) });
    }
    await rm(file, { force: true }).catch(() => {});
});
`;

/**
 * Writes and fsyncs PROBE_BYTES in each of `directories` ({ name: path })
 * from a child process, killed at `deadlineMs`. Resolves (never rejects)
 * with each latency in ms, an error, or "pending > N s". The child, its
 * pipe and the deadline are unref'd: the probe never keeps a worker alive.
 */
export function probeVolumes(
    directories,
    {
        deadlineMs = PROBE_DEADLINE_MS,
        script = PROBE_SCRIPT,
        spawnChild = spawn,
    } = {}
) {
    const pending = `pending > ${deadlineMs / 1000} s`;
    const names = Object.keys(directories);
    const probes = Object.fromEntries(
        names.map((name) => [
            name,
            { path: directories[name], writeFsyncMs: pending },
        ])
    );
    const result = { bytes: PROBE_BYTES, childStartMs: pending, probes };
    const started = now();
    return new Promise((resolve) => {
        let child;
        let timer;
        let settled = false;
        const settle = (unfinished) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (unfinished) {
                for (const probe of Object.values(probes)) {
                    if (probe.writeFsyncMs !== pending) continue;
                    delete probe.writeFsyncMs;
                    probe.error = unfinished;
                }
            }
            if (child && child.exitCode === null && child.signalCode === null) {
                try {
                    child.kill("SIGKILL");
                } catch {
                    // Already gone.
                }
            }
            resolve(result);
        };
        const onLine = (line) => {
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                return;
            }
            if (message?.started === true) {
                result.childStartMs = round(now() - started);
                return;
            }
            const probe = probes[names[message?.index]];
            if (!probe || probe.writeFsyncMs !== pending) return;
            if (typeof message.ms === "number") {
                probe.writeFsyncMs = round(message.ms);
            } else {
                delete probe.writeFsyncMs;
                probe.error = text(message.error);
            }
        };
        try {
            const env = { ...process.env };
            delete env.NODE_OPTIONS;
            child = spawnChild(
                process.execPath,
                ["-e", script, "--", ...names.map((name) => directories[name])],
                { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
            );
        } catch (error) {
            settle(`not started: ${text(error?.code ?? error?.message)}`);
            return;
        }
        timer = setTimeout(() => settle(), deadlineMs);
        timer.unref();
        child.unref();
        child.on("error", (error) =>
            settle(`not started: ${text(error?.code ?? error?.message)}`)
        );
        child.on("close", (code, signal) =>
            settle(`the probe exited (${signal ?? code}) first`)
        );
        const stdout = child.stdout;
        if (!stdout) return;
        stdout.unref?.();
        stdout.on("error", () => {});
        stdout.setEncoding("utf8");
        let buffered = "";
        stdout.on("data", (chunk) => {
            if (settled) return;
            buffered += chunk;
            let end;
            while ((end = buffered.indexOf("\n")) >= 0) {
                onLine(buffered.slice(0, end));
                buffered = buffered.slice(end + 1);
            }
            if (buffered.length > 4096) buffered = "";
        });
    });
}
