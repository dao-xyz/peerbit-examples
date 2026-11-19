import { type StdioOptions, spawn } from "node:child_process";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_GRACE_MS, exitWhenDone } from "../index.js";

const cliEntry = fileURLToPath(new URL("../bin.ts", import.meta.url));
const cliDirectory = fileURLToPath(new URL("../../", import.meta.url));

/**
 * A run still alive this long is killed and fails its test. A run whose peer
 * left a timer armed ends EXIT_GRACE_MS after its stop; without that, it
 * would live as long as the timer, here two hours.
 */
const DEADLINE_MS = 60_000;

/**
 * What the stub's whoami prints: far more than a pipe holds (64 KiB), so a
 * run that reads stdout late finds most of it still waiting in the process.
 */
const KEY_BYTES = 1 << 20;

/** What the stub peer's stop writes to stderr, as a dependency's logs. */
const STOP_LOG_LINES = 1 << 15;
const stopLog = Array.from(
    { length: STOP_LOG_LINES },
    (_, line) => `stub peer stopping: line ${line}\n`
).join("");

/**
 * The filesystem runtime the CLI loads, replaced through a loader as in
 * lazy-runtime.test.ts. Its peer's stop leaves a timer armed for two hours,
 * as libp2p's circuit-relay reservation store can leave its refresh timer
 * when a reservation is answered while the peer stops.
 */
const runtime = `data:text/javascript,${encodeURIComponent(`
export const encodePublicSignKey = () => "K".repeat(${KEY_BYTES});
export const Peerbit = {
    create: async () => ({
        identity: { publicKey: {} },
        bootstrap: async () => {},
        stop: async () => {
            process.stderr.write(
                Array.from(
                    { length: ${STOP_LOG_LINES} },
                    (_, line) => "stub peer stopping: line " + line + "\\n"
                ).join("")
            );
            setTimeout(() => {}, 2 * 60 * 60 * 1000);
        },
    }),
};
export const openSharedFs = async ({ address }) => ({
    address,
    awaitBootstrapConverged: async () => ({ verified: false }),
    bootstrapStatus: () => ({
        phase: "off",
        pendingDocs: 0,
        snapshotCoverageVerified: false,
        writeReady: true,
    }),
    conflicts: async () => [],
    namingConflicts: async () => [],
});
`)}`;
const loader = `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@peerbit/shared-fs") {
        return { url: ${JSON.stringify(runtime)}, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
`)}`;

/** Node options that load the stub runtime. */
const STUB_RUNTIME = ["--experimental-loader", loader];

/**
 * Node options that arm a timer for two hours as the process starts, as
 * the mount process tests do: it is still armed after Peerbit's stop.
 */
const ARMED_TIMER = [
    "--import",
    `data:text/javascript,${encodeURIComponent(
        "setTimeout(() => {}, 2 * 60 * 60 * 1000);"
    )}`,
];

/** What SIGNAL_GRACE_END writes to fd 3. */
const GRACE_ENDED = "grace ended\n";

/**
 * Node options that write GRACE_ENDED to fd 3, synchronously, when stdout
 * is given an empty chunk: the first thing exitOnceFlushed does once the
 * grace has ended. Nothing else writes an empty chunk to stdout.
 */
const SIGNAL_GRACE_END = [
    "--import",
    `data:text/javascript,${encodeURIComponent(`
import { writeSync } from "node:fs";
const write = process.stdout.write;
process.stdout.write = function (chunk, ...rest) {
    if (chunk === "") writeSync(3, ${JSON.stringify(GRACE_ENDED)});
    return write.call(this, chunk, ...rest);
};
`)}`,
];

type Run = {
    code: number | null;
    signal: NodeJS.Signals | null;
    /** Still alive at DEADLINE_MS: killed by the test. */
    killed: boolean;
    /**
     * When the test started reading stdout and stderr: at the start, once
     * the process wrote GRACE_ENDED, or once it exited.
     */
    readFrom: "start" | "grace" | "exit";
    stdout: string;
    stderr: string;
};

/**
 * Runs peerbit-fs with `nodeOptions` (by default, on the stub runtime);
 * settles once its pipes closed. With `readLate`, stdout and stderr are read
 * only once the process writes GRACE_ENDED to fd 3 or exits: until then,
 * what the pipes cannot hold waits in the process.
 */
const runCliProcess = (
    args: string[],
    nodeOptions = STUB_RUNTIME,
    { readLate = false } = {}
) =>
    new Promise<Run>((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [
                "--no-warnings",
                "--import",
                "tsx",
                ...nodeOptions,
                cliEntry,
                ...args,
            ],
            {
                cwd: cliDirectory,
                env: { ...process.env, FORCE_COLOR: "0" },
                // With `readLate`, fd 3 carries GRACE_ENDED.
                stdio: (readLate
                    ? ["ignore", "pipe", "pipe", "pipe"]
                    : ["ignore", "pipe", "pipe"]) satisfies StdioOptions,
            }
        );
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let readFrom: Run["readFrom"] | undefined;
        const read = (from: Run["readFrom"]) => {
            if (readFrom) return;
            readFrom = from;
            child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
            child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
        };
        if (readLate) {
            let signals = "";
            child.stdio[3]!.on("data", (chunk: Buffer) => {
                signals += chunk.toString("utf8");
                if (signals.includes(GRACE_ENDED)) read("grace");
            });
        } else read("start");
        child.once("exit", () => read("exit"));
        let killed = false;
        const deadline = setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
        }, DEADLINE_MS);
        child.once("error", (error) => {
            clearTimeout(deadline);
            reject(error);
        });
        child.once("close", (code, signal) => {
            clearTimeout(deadline);
            resolve({
                code,
                signal,
                killed,
                readFrom: readFrom ?? "exit",
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
            });
        });
    });

/**
 * A run, short enough to read in a failed assertion: stdout's length, and
 * what stderr holds before the stop's log, which it must end with.
 */
const outcome = (run: Run) => ({
    killed: run.killed,
    code: run.code,
    signal: run.signal,
    readFrom: run.readFrom,
    stdoutBytes: Buffer.byteLength(run.stdout),
    stderr: run.stderr.endsWith(stopLog)
        ? run.stderr.slice(0, -stopLog.length)
        : `no complete stop log after: ${run.stderr.slice(0, 1000)}`,
});

const UNVERIFIED_WARNING =
    "Conflict results reflect a settled local view without a verified full-replica bootstrap; do not treat absence as proof of no remote conflict.\n";

// The first three runs read stdout and stderr as the process writes them:
// they check that it exits, with its exit code and all of its output. That
// the exit waits for the output is checked by the late-read run, where a
// pipe write can wait in the process, and by the exitWhenDone unit test.
describe("peerbit-fs one-shot commands whose peer leaves a timer armed", () => {
    it("whoami exits 0 once its stop is done, with all of stdout and stderr written", async () => {
        const run = await runCliProcess(["whoami", "--directory", ""]);

        expect(outcome(run)).toEqual({
            killed: false,
            code: 0,
            signal: null,
            readFrom: "start",
            stdoutBytes: KEY_BYTES + 1,
            stderr: "",
        });
        expect(
            run.stdout === `${"K".repeat(KEY_BYTES)}\n`,
            "stdout is the key and a newline"
        ).toBe(true);
    });

    it("conflicts --fail-if-any keeps its exit status 4 and its output", async () => {
        const run = await runCliProcess([
            "conflicts",
            "zb2rh-stub",
            "--fail-if-any",
            "--directory",
            "",
        ]);

        expect(outcome(run)).toEqual({
            killed: false,
            code: 4,
            signal: null,
            readFrom: "start",
            stdoutBytes: "No conflicts\n".length,
            stderr: UNVERIFIED_WARNING,
        });
        expect(run.stdout).toBe("No conflicts\n");
    });

    it("whoami on the Peerbit runtime exits 0 once its stop is done, also with a timer armed", async () => {
        const run = await runCliProcess(
            ["whoami", "--directory", ""],
            ARMED_TIMER
        );

        expect(
            { killed: run.killed, code: run.code, signal: run.signal },
            run.stderr.slice(-1000)
        ).toEqual({ killed: false, code: 0, signal: null });
        expect(run.stdout).toMatch(/^[A-Za-z0-9+/]+=*\n$/);
    });

    // On Linux and macOS, what a pipe cannot hold waits in the process, and
    // process.exit drops it. This run reads neither pipe before the grace
    // has ended, so most of the key and of the stop's log are still waiting
    // then. On Windows, Node writes stdout and stderr to a pipe
    // synchronously: nothing waits to be dropped, and the process would
    // block until this test read the pipe, which it does only after the
    // grace.
    it.skipIf(process.platform === "win32")(
        "whoami writes all of stdout and stderr before it exits, read only once its grace has ended",
        async () => {
            const run = await runCliProcess(
                ["whoami", "--directory", ""],
                [...STUB_RUNTIME, ...SIGNAL_GRACE_END],
                { readLate: true }
            );

            expect(outcome(run)).toEqual({
                killed: false,
                code: 0,
                signal: null,
                readFrom: "grace",
                stdoutBytes: KEY_BYTES + 1,
                stderr: "",
            });
            expect(
                run.stdout === `${"K".repeat(KEY_BYTES)}\n`,
                "stdout is the key and a newline"
            ).toBe(true);
        }
    );
});

describe("exitWhenDone", () => {
    afterEach(() => {
        process.exitCode = undefined;
    });

    it("does not keep the process alive itself", () => {
        const host = { exit: vi.fn() };
        const timer = exitWhenDone(host as never, [], EXIT_GRACE_MS);
        try {
            expect(timer.hasRef()).toBe(false);
        } finally {
            clearTimeout(timer);
        }
        expect(host.exit).not.toHaveBeenCalled();
    });

    it("exits after the grace with the exit code set, once stdout and stderr have written what they hold", async () => {
        const held: (() => void)[] = [];
        let wake = () => {};
        const slow = () =>
            new Writable({
                write: (_chunk, _encoding, done) => {
                    held.push(done);
                    wake();
                },
            });
        /** Resolves once `count` writes wait to be released. */
        const writesHeld = (count: number) =>
            new Promise<void>((resolve) => {
                wake = () => held.length >= count && resolve();
                wake();
            });
        let exited = (_code: unknown) => {};
        const exit = new Promise((resolve) => (exited = resolve));
        const host = { exit: vi.fn((code?: number) => exited(code)) };
        const [stdout, stderr] = [slow(), slow()];
        stdout.write("No conflicts\n");
        process.exitCode = 4;

        exitWhenDone(host as never, [stdout, stderr], 0);
        // Only the line: nothing more is written before the grace has passed.
        expect(held.length).toBe(1);
        // The line, and stderr's empty write once the grace has passed;
        // stdout's waits behind its line. An exit ends the wait too.
        await Promise.race([writesHeld(2), exit]);
        expect(host.exit).not.toHaveBeenCalled();
        held.shift()!(); // stdout's line
        await Promise.race([writesHeld(2), exit]);
        expect(host.exit).not.toHaveBeenCalled();
        held.shift()!(); // stderr's empty write
        expect(host.exit).not.toHaveBeenCalled();
        held.shift()!(); // stdout's empty write
        expect(await exit).toBe(4);
        expect(host.exit).toHaveBeenCalledOnce();
    });
});
