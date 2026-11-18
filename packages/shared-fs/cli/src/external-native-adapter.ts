import {
    spawn,
    type ChildProcess,
    type SpawnOptionsWithStdioTuple,
    type StdioNull,
    type StdioPipe,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";

type AdapterSpawnOptions = SpawnOptionsWithStdioTuple<
    StdioNull,
    StdioPipe,
    StdioPipe
>;

type ExternalNativeAdapterOptions = {
    readinessTimeoutMs?: number;
    exitTimeoutMs?: number;
    spawnAdapter?: typeof spawn;
    /**
     * Opt-in NDJSON profile file for the adapter. It is passed through the
     * environment, never argv, so an adapter built before profiling existed
     * ignores it instead of rejecting an unknown flag.
     */
    profileFile?: string;
    /** How long an exit report waits for the rest of the adapter's stderr. */
    stderrDrainMs?: number;
};

export const NATIVE_ADAPTER_PROFILE_FILE_ENV =
    "PEERBIT_SHARED_FS_NATIVE_PROFILE_FILE";

/**
 * Carries the IPC server's token to the adapter. The environment, unlike
 * argv, is readable only by the same user.
 */
export const NATIVE_ADAPTER_IPC_TOKEN_ENV = "PEERBIT_SHARED_FS_IPC_TOKEN";

/**
 * The mount process's id. On Linux the adapter asks the kernel for SIGHUP when
 * that process exits, then checks it is still its parent, and unmounts on the
 * signal. Every adapter also unmounts when its IPC connection ends.
 */
export const NATIVE_ADAPTER_PARENT_PID_ENV = "PEERBIT_SHARED_FS_PARENT_PID";

/**
 * The exit status of a mount whose adapter exited after readiness without
 * being asked to (a crash, a kill, an out-of-memory kill): EX_SOFTWARE from
 * sysexits.h. The mount stops as on a shutdown request; a stop step that
 * fails or a write that was not saved still exits 1 instead, while 70 is kept
 * over 75 (persist-on-exit gave up) and 130 (stopped by a request).
 */
export const NATIVE_ADAPTER_FAILED_EXIT_CODE = 70;

/** How the adapter exited, with its last stderr lines, oldest first. */
export type NativeAdapterExit = {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string[];
};

/**
 * The adapter inherits the environment plus the IPC token and this process's
 * id. It profiles only when this mount asked for it: an explicit file is
 * set, and a value inherited from the CLI's own environment is removed.
 */
export const adapterSpawnOptions = (
    token: string,
    profileFile: string | undefined,
    environment: NodeJS.ProcessEnv = process.env,
    parentPid: number = process.pid
): AdapterSpawnOptions => {
    const env = {
        ...environment,
        [NATIVE_ADAPTER_IPC_TOKEN_ENV]: token,
        [NATIVE_ADAPTER_PARENT_PID_ENV]: String(parentPid),
    };
    if (profileFile === undefined) {
        delete env[NATIVE_ADAPTER_PROFILE_FILE_ENV];
    } else {
        env[NATIVE_ADAPTER_PROFILE_FILE_ENV] = profileFile;
    }
    return { stdio: ["ignore", "pipe", "pipe"], env };
};

const childExited = (child: ChildProcess) =>
    child.exitCode != null || child.signalCode != null;

/** Stderr lines an exit report keeps. */
const STDERR_TAIL_LINES = 20;
/** Characters kept of one stderr line. */
const STDERR_LINE_CHARS = 1_000;

/** Keeps the last `limit` lines of `stream`; returns them when called. */
const keepLastLines = (stream: NodeJS.ReadableStream, limit: number) => {
    const decoder = new StringDecoder("utf8");
    const lines: string[] = [];
    let partial = "";
    const add = (text: string) => {
        const parts = (partial + text).split("\n");
        partial = parts.pop()!.slice(-STDERR_LINE_CHARS);
        for (const line of parts)
            lines.push(line.replace(/\r$/, "").slice(0, STDERR_LINE_CHARS));
        lines.splice(0, lines.length - limit);
    };
    stream.on("data", (chunk: Buffer) => add(decoder.write(chunk)));
    stream.on("end", () => add(decoder.end()));
    return () => (partial ? [...lines, partial] : [...lines]).slice(-limit);
};

/** The report of an adapter that exited after readiness on its own. */
export const describeAdapterExit = ({
    code,
    signal,
    stderr,
}: NativeAdapterExit) => [
    `Native adapter exited after mount readiness: code=${code} signal=${signal}; ${
        code === 0
            ? "it was stopped outside this process, for example by unmounting the mountpoint. Stopping the mount."
            : `stopping the mount (exit status ${NATIVE_ADAPTER_FAILED_EXIT_CODE}).`
    }`,
    ...(stderr.length ? stderr : ["(none)"]).map(
        (line) => `native adapter stderr: ${line}`
    ),
];

/**
 * Prints the report and, unless the adapter exited 0 (it unmounted on a
 * request from outside this process), sets exit status 70: an exit status
 * already set (1) is kept.
 */
export const reportAdapterExit = (
    exit: NativeAdapterExit,
    log: (line: string) => void = (line) => console.error(line)
) => {
    for (const line of describeAdapterExit(exit)) log(line);
    if (exit.code !== 0) process.exitCode ||= NATIVE_ADAPTER_FAILED_EXIT_CODE;
};

type SignalResult =
    | { status: "exited" }
    | { status: "timeout" }
    | { status: "error"; error: Error };

const asError = (error: unknown) =>
    error instanceof Error ? error : new Error(String(error));

const signalAndWaitForChildExit = async (
    child: ChildProcess,
    signal: NodeJS.Signals,
    timeoutMs: number
): Promise<SignalResult> => {
    if (childExited(child)) {
        return { status: "exited" };
    }

    return new Promise<SignalResult>((resolve) => {
        let timeout: NodeJS.Timeout | undefined;
        let settled = false;
        let rejectedSignal: Error | undefined;
        const finish = (result: SignalResult) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeout != null) {
                clearTimeout(timeout);
            }
            child.off("exit", onExit);
            child.off("error", onError);
            resolve(result);
        };
        const onExit = () => {
            finish({ status: "exited" });
        };
        const onError = (error: Error) => {
            finish({ status: "error", error });
        };
        child.once("exit", onExit);
        child.once("error", onError);

        if (childExited(child)) {
            finish({ status: "exited" });
            return;
        }

        timeout = setTimeout(
            () =>
                finish(
                    rejectedSignal == null
                        ? { status: "timeout" }
                        : { status: "error", error: rejectedSignal }
                ),
            timeoutMs
        );
        try {
            if (!child.kill(signal)) {
                rejectedSignal = new Error(
                    `Native adapter process ${child.pid} rejected ${signal}`
                );
                // UV_ESRCH also returns false while Node's exit event may still
                // be pending. Keep waiting for that event, bounded by timeout.
            }
        } catch (error) {
            finish({ status: "error", error: asError(error) });
        }
    });
};

const stopChild = async (child: ChildProcess, timeoutMs: number) => {
    if (child.pid == null || childExited(child)) {
        return;
    }
    const signalErrors: Error[] = [];
    for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
        const result = await signalAndWaitForChildExit(
            child,
            signal,
            timeoutMs
        );
        if (result.status === "exited") {
            return;
        }
        if (result.status === "error") {
            signalErrors.push(result.error);
        }
    }
    const error = new Error(`Native adapter process ${child.pid} did not exit`);
    if (signalErrors.length > 0) {
        error.cause = new AggregateError(
            signalErrors,
            "Native adapter signal delivery failed"
        );
    }
    throw error;
};

export const mountExternalNativeAdapter = async (
    command: string,
    ipc: { endpoint: string; token: string },
    mountpoint: string,
    options: ExternalNativeAdapterOptions = {}
) => {
    const args = ["--endpoint", ipc.endpoint, "--mountpoint", mountpoint];
    if (process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER_DEBUG === "1") {
        args.push("--debug");
    }
    const child = (options.spawnAdapter ?? spawn)(
        command,
        args,
        adapterSpawnOptions(ipc.token, options.profileFile)
    );
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));

    // Listening from the spawn on, an exit is never missed. One that comes
    // while this process stops the adapter is expected and never reported.
    let stopping = false;
    const stderrTail = keepLastLines(child.stderr, STDERR_TAIL_LINES);
    // "close" follows "exit" once the adapter's stdout and stderr have ended.
    const closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve())
    );
    const exited = new Promise<NativeAdapterExit>((resolve) => {
        child.once("exit", (code, signal) => {
            if (stopping) return;
            // Its last lines may still be in the pipe; a process that it
            // started and that holds the pipe open is not waited for.
            const report = () => {
                clearTimeout(timer);
                resolve({ code, signal, stderr: stderrTail() });
            };
            const timer = setTimeout(report, options.stderrDrainMs ?? 1_000);
            void closed.then(report);
        });
    });

    try {
        await new Promise<void>((resolve, reject) => {
            let output = "";
            const readinessTimeoutMs = options.readinessTimeoutMs ?? 15_000;
            const timeout = setTimeout(() => {
                cleanup();
                reject(
                    new Error(
                        `Native adapter did not report readiness within ${readinessTimeoutMs} ms: ${command}`
                    )
                );
            }, readinessTimeoutMs);
            const cleanup = () => {
                clearTimeout(timeout);
                child.stdout.off("data", onStdout);
                child.off("error", onError);
                child.off("exit", onExit);
            };
            const onStdout = (chunk: Buffer) => {
                output += chunk.toString("utf8");
                process.stdout.write(chunk);
                if (output.includes("peerbit-shared-fs-native ready")) {
                    cleanup();
                    resolve();
                }
            };
            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };
            const onExit = (
                code: number | null,
                signal: NodeJS.Signals | null
            ) => {
                cleanup();
                reject(
                    new Error(
                        `Native adapter exited before mount readiness: code=${code} signal=${signal}`
                    )
                );
            };
            child.stdout.on("data", onStdout);
            child.once("error", onError);
            child.once("exit", onExit);
        });
    } catch (startError) {
        stopping = true;
        try {
            await stopChild(child, options.exitTimeoutMs ?? 5_000);
        } catch (stopError) {
            throw new AggregateError(
                [startError, stopError],
                "Native adapter startup failed and its process could not be stopped"
            );
        }
        throw startError;
    }

    return {
        mountpoint,
        /**
         * Settles when the adapter exits after readiness without being asked
         * to: a crash, a kill, or a stop from outside this process. Never
         * once unmount() began.
         */
        exited,
        async unmount() {
            stopping = true;
            await stopChild(child, options.exitTimeoutMs ?? 5_000);
        },
    };
};
