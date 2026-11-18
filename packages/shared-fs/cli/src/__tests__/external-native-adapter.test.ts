import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    adapterSpawnOptions,
    describeAdapterExit,
    mountExternalNativeAdapter,
    NATIVE_ADAPTER_FAILED_EXIT_CODE,
    NATIVE_ADAPTER_IPC_TOKEN_ENV,
    NATIVE_ADAPTER_PARENT_PID_ENV,
    NATIVE_ADAPTER_PROFILE_FILE_ENV,
    reportAdapterExit,
    type NativeAdapterExit,
} from "../external-native-adapter.js";

const ipc = { endpoint: "tcp://127.0.0.1:1", token: "ipc-token-secret" };

class FakeChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly pid = 42;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    private readonly exitOnSignal: NodeJS.Signals | undefined;
    private readonly falseOnSignal: NodeJS.Signals | undefined;
    private readonly errorOnSignal: NodeJS.Signals | undefined;
    private readonly exitCodeOnSignal: number | undefined;
    readonly kill = vi.fn((signal: NodeJS.Signals) => {
        if (signal === this.errorOnSignal) {
            queueMicrotask(() => {
                this.emit(
                    "error",
                    new Error(`failed to deliver ${signal} to child`)
                );
            });
            return false;
        }
        if (signal === this.exitOnSignal) {
            queueMicrotask(() => {
                if (this.exitCodeOnSignal === undefined) {
                    this.signalCode = signal;
                    this.emit("exit", null, signal);
                } else {
                    this.exitCode = this.exitCodeOnSignal;
                    this.emit("exit", this.exitCodeOnSignal, null);
                }
            });
        }
        return signal !== this.falseOnSignal;
    });

    constructor(
        options: {
            exitOnSignal?: NodeJS.Signals | null;
            falseOnSignal?: NodeJS.Signals;
            errorOnSignal?: NodeJS.Signals;
            /** Handles the signal and exits with this code, as the adapter does. */
            exitCodeOnSignal?: number;
        } = {}
    ) {
        super();
        this.exitOnSignal =
            options.exitOnSignal === null
                ? undefined
                : (options.exitOnSignal ?? "SIGINT");
        this.falseOnSignal = options.falseOnSignal;
        this.errorOnSignal = options.errorOnSignal;
        this.exitCodeOnSignal = options.exitCodeOnSignal;
    }

    /** Exits unasked, as Node reports it: "exit", then "close" once stdio ended. */
    exitUnasked(code: number | null, signal: NodeJS.Signals | null) {
        this.exitCode = code;
        this.signalCode = signal;
        this.emit("exit", code, signal);
        this.stdout.end();
        this.stderr.end();
        this.stderr.once("end", () => this.emit("close", code, signal));
        this.stderr.resume();
    }
}

/**
 * Spawns `child` as the adapter. A later spawn is the adapter's
 * `--clear-dead-mount`: `clear` (by default, nothing to clear) runs it.
 */
const spawning = (
    child: FakeChild,
    clear: (clearing: FakeChild) => void = (clearing) =>
        clearing.exitUnasked(0, null)
) =>
    vi.fn((_command: string, args: string[]) => {
        if (!args.includes("--clear-dead-mount"))
            return child as unknown as ChildProcess;
        const clearing = new FakeChild();
        queueMicrotask(() => clear(clearing));
        return clearing as unknown as ChildProcess;
    }) as unknown as typeof spawn;

/** A ready adapter, mounted; its stderr is not echoed to this process's. */
const mountReady = async (
    child: FakeChild,
    options: {
        stderrDrainMs?: number;
        exitTimeoutMs?: number;
        clearDeadMount?: boolean;
        spawnAdapter?: typeof spawn;
    } = {}
) => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    queueMicrotask(() => {
        child.stdout.write("peerbit-shared-fs-native ready\n");
    });
    return mountExternalNativeAdapter("crashing-adapter", ipc, "/unused", {
        exitTimeoutMs: 100,
        spawnAdapter: spawning(child),
        ...options,
    });
};

/** Whether `promise` has settled once pending callbacks have run. */
const settled = async (promise: Promise<unknown>) => {
    let done = false;
    void promise.then(
        () => (done = true),
        () => (done = true)
    );
    await new Promise((resolve) => setImmediate(resolve));
    return done;
};

describe("external native adapter lifecycle", () => {
    it("passes the opt-in profile file through the environment, not argv", async () => {
        const child = new FakeChild();
        const spawnAdapter = spawning(child);
        queueMicrotask(() => {
            child.stdout.write("peerbit-shared-fs-native ready\n");
        });

        const mounted = await mountExternalNativeAdapter(
            "profiled-adapter",
            ipc,
            "/unused",
            {
                exitTimeoutMs: 100,
                profileFile: "/profiles/native-adapter.ndjson",
                spawnAdapter,
            }
        );
        await mounted.unmount();

        // An adapter built before profiling existed must still start: argv is
        // unchanged and the file is only visible through its environment.
        expect(spawnAdapter).toHaveBeenCalledWith(
            "profiled-adapter",
            ["--endpoint", "tcp://127.0.0.1:1", "--mountpoint", "/unused"],
            {
                stdio: ["ignore", "pipe", "pipe"],
                env: expect.objectContaining({
                    [NATIVE_ADAPTER_IPC_TOKEN_ENV]: ipc.token,
                    [NATIVE_ADAPTER_PROFILE_FILE_ENV]:
                        "/profiles/native-adapter.ndjson",
                }),
            }
        );
        expect(NATIVE_ADAPTER_PROFILE_FILE_ENV).toBe(
            "PEERBIT_SHARED_FS_NATIVE_PROFILE_FILE"
        );
    });

    it("passes the IPC token through the environment, never argv", async () => {
        const child = new FakeChild();
        const spawnAdapter = spawning(child);
        queueMicrotask(() => {
            child.stdout.write("peerbit-shared-fs-native ready\n");
        });

        const mounted = await mountExternalNativeAdapter(
            "plain-adapter",
            ipc,
            "/unused",
            { exitTimeoutMs: 100, spawnAdapter }
        );
        await mounted.unmount();

        // Other local users can list a process's arguments, but not its
        // environment.
        expect(spawnAdapter).toHaveBeenCalledWith(
            "plain-adapter",
            ["--endpoint", "tcp://127.0.0.1:1", "--mountpoint", "/unused"],
            {
                stdio: ["ignore", "pipe", "pipe"],
                env: expect.objectContaining({
                    [NATIVE_ADAPTER_IPC_TOKEN_ENV]: ipc.token,
                }),
            }
        );
        const [, args] = vi.mocked(spawnAdapter).mock.calls[0];
        expect(JSON.stringify(args)).not.toContain(ipc.token);
        expect(NATIVE_ADAPTER_IPC_TOKEN_ENV).toBe(
            "PEERBIT_SHARED_FS_IPC_TOKEN"
        );
    });

    it("does not let inherited variables enable profiling or replace the token or parent", () => {
        const inherited = {
            PATH: "/bin",
            [NATIVE_ADAPTER_PROFILE_FILE_ENV]: "/stale/native-adapter.ndjson",
            [NATIVE_ADAPTER_IPC_TOKEN_ENV]: "stale-token",
            [NATIVE_ADAPTER_PARENT_PID_ENV]: "1",
        };
        const options = adapterSpawnOptions(ipc.token, undefined, inherited);
        expect(options).toEqual({
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                PATH: "/bin",
                [NATIVE_ADAPTER_IPC_TOKEN_ENV]: ipc.token,
                [NATIVE_ADAPTER_PARENT_PID_ENV]: String(process.pid),
            },
        });
        // The caller's environment object is not mutated.
        expect(inherited).toEqual({
            PATH: "/bin",
            [NATIVE_ADAPTER_PROFILE_FILE_ENV]: "/stale/native-adapter.ndjson",
            [NATIVE_ADAPTER_IPC_TOKEN_ENV]: "stale-token",
            [NATIVE_ADAPTER_PARENT_PID_ENV]: "1",
        });
        // An explicit profile file replaces the inherited value.
        expect(
            adapterSpawnOptions(
                ipc.token,
                "/profiles/native-adapter.ndjson",
                inherited,
                4242
            ).env
        ).toEqual({
            PATH: "/bin",
            [NATIVE_ADAPTER_PROFILE_FILE_ENV]:
                "/profiles/native-adapter.ndjson",
            [NATIVE_ADAPTER_IPC_TOKEN_ENV]: ipc.token,
            [NATIVE_ADAPTER_PARENT_PID_ENV]: "4242",
        });
        expect(NATIVE_ADAPTER_PARENT_PID_ENV).toBe(
            "PEERBIT_SHARED_FS_PARENT_PID"
        );
    });

    it("stops and reaps a ready child during unmount", async () => {
        const child = new FakeChild();
        const spawnAdapter = spawning(child);
        queueMicrotask(() => {
            child.stdout.write("peerbit-shared-fs-native ready\n");
        });

        const mounted = await mountExternalNativeAdapter(
            "ready-adapter",
            ipc,
            "/unused",
            { exitTimeoutMs: 100, spawnAdapter }
        );
        await mounted.unmount();

        expect(child.kill).toHaveBeenCalledOnce();
        expect(child.kill).toHaveBeenCalledWith("SIGINT");
        expect(child.signalCode).toBe("SIGINT");
    });

    it("stops and reaps a child that times out before readiness", async () => {
        const child = new FakeChild();
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;

        await expect(
            mountExternalNativeAdapter("stalled-adapter", ipc, "/unused", {
                readinessTimeoutMs: 10,
                exitTimeoutMs: 100,
                spawnAdapter,
            })
        ).rejects.toThrow(
            "Native adapter did not report readiness within 10 ms"
        );

        expect(spawnAdapter).toHaveBeenCalledOnce();
        expect(child.kill).toHaveBeenCalledOnce();
        expect(child.kill).toHaveBeenCalledWith("SIGINT");
        expect(child.signalCode).toBe("SIGINT");
    });

    it("escalates through SIGKILL when gentler signals are ignored", async () => {
        const child = new FakeChild({ exitOnSignal: "SIGKILL" });
        const spawnAdapter = spawning(child);
        queueMicrotask(() => {
            child.stdout.write("peerbit-shared-fs-native ready\n");
        });

        const mounted = await mountExternalNativeAdapter(
            "stubborn-adapter",
            ipc,
            "/unused",
            { exitTimeoutMs: 5, spawnAdapter }
        );
        await mounted.unmount();

        expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
            "SIGINT",
            "SIGTERM",
            "SIGKILL",
        ]);
        expect(child.signalCode).toBe("SIGKILL");
    });

    it("accepts a pending exit after signal delivery returns false", async () => {
        const child = new FakeChild({
            exitOnSignal: "SIGINT",
            falseOnSignal: "SIGINT",
        });
        const spawnAdapter = spawning(child);
        queueMicrotask(() => {
            child.stdout.write("peerbit-shared-fs-native ready\n");
        });

        const mounted = await mountExternalNativeAdapter(
            "rejecting-adapter",
            ipc,
            "/unused",
            { exitTimeoutMs: 100, spawnAdapter }
        );
        await mounted.unmount();

        expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
            "SIGINT",
        ]);
        expect(child.signalCode).toBe("SIGINT");
    });

    it("escalates when a rejected signal has no matching exit", async () => {
        const child = new FakeChild({
            exitOnSignal: "SIGTERM",
            falseOnSignal: "SIGINT",
        });
        const spawnAdapter = spawning(child);
        queueMicrotask(() => {
            child.stdout.write("peerbit-shared-fs-native ready\n");
        });

        const mounted = await mountExternalNativeAdapter(
            "rejecting-adapter",
            ipc,
            "/unused",
            { exitTimeoutMs: 5, spawnAdapter }
        );
        await mounted.unmount();

        expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
            "SIGINT",
            "SIGTERM",
        ]);
        expect(child.signalCode).toBe("SIGTERM");
    });

    it("handles emitted signal errors and escalates", async () => {
        const child = new FakeChild({
            exitOnSignal: "SIGTERM",
            errorOnSignal: "SIGINT",
        });
        const spawnAdapter = spawning(child);
        queueMicrotask(() => {
            child.stdout.write("peerbit-shared-fs-native ready\n");
        });

        const mounted = await mountExternalNativeAdapter(
            "erroring-adapter",
            ipc,
            "/unused",
            { exitTimeoutMs: 100, spawnAdapter }
        );
        await mounted.unmount();

        expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
            "SIGINT",
            "SIGTERM",
        ]);
        expect(child.signalCode).toBe("SIGTERM");
    });

    it("preserves startup and cleanup failures when a child never exits", async () => {
        const child = new FakeChild({ exitOnSignal: null });
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;

        await expect(
            mountExternalNativeAdapter("unkillable-adapter", ipc, "/unused", {
                readinessTimeoutMs: 5,
                exitTimeoutMs: 5,
                spawnAdapter,
            })
        ).rejects.toMatchObject({
            name: "AggregateError",
            message:
                "Native adapter startup failed and its process could not be stopped",
            errors: [
                expect.objectContaining({
                    message: expect.stringContaining(
                        "did not report readiness"
                    ),
                }),
                expect.objectContaining({
                    message: "Native adapter process 42 did not exit",
                }),
            ],
        });
        expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
            "SIGINT",
            "SIGTERM",
            "SIGKILL",
        ]);
    });
});

describe("an adapter that exits after mount readiness", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        process.exitCode = undefined;
    });

    it("is reported with its exit and last stderr lines, the partial last line included", async () => {
        const child = new FakeChild();
        const mounted = await mountReady(child);
        child.stderr.write("peerbit-shared-fs-native: first\n");
        // A multibyte character split across two chunks, and CRLF.
        const bytes = Buffer.from("second \u00e9\r\nunfinished");
        child.stderr.write(bytes.subarray(0, 8));
        child.stderr.write(bytes.subarray(8));
        child.exitUnasked(null, "SIGKILL");
        expect(await mounted.exited).toEqual({
            code: null,
            signal: "SIGKILL",
            stderr: [
                "peerbit-shared-fs-native: first",
                "second \u00e9",
                "unfinished",
            ],
        });
    });

    it("keeps the last 20 stderr lines", async () => {
        const child = new FakeChild();
        const mounted = await mountReady(child);
        for (let line = 1; line <= 25; line++)
            child.stderr.write(`line ${line}\n`);
        child.exitUnasked(2, null);
        const exit = await mounted.exited;
        expect(exit.stderr).toEqual(
            Array.from({ length: 20 }, (_, i) => `line ${i + 6}`)
        );
    });

    it("waits for stderr written before the exit to arrive, then gives up on a pipe held open", async () => {
        const child = new FakeChild();
        const mounted = await mountReady(child, { stderrDrainMs: 50 });
        // "exit" comes first; the last line is still in the pipe.
        child.exitCode = 1;
        child.emit("exit", 1, null);
        expect(await settled(mounted.exited)).toBe(false);
        child.stderr.write("panic: out of memory\n");
        // The pipe stays open (a process the adapter started holds it).
        expect(await mounted.exited).toEqual({
            code: 1,
            signal: null,
            stderr: ["panic: out of memory"],
        });
    });

    it("is not reported when this process stopped it", async () => {
        const child = new FakeChild();
        const mounted = await mountReady(child);
        await mounted.unmount();
        child.emit("close", null, "SIGINT");
        expect(child.signalCode).toBe("SIGINT");
        expect(await settled(mounted.exited)).toBe(false);
    });

    it("sets exit status 70 unless it exited 0, keeping a status already set", () => {
        const lines: string[] = [];
        const crash: NativeAdapterExit = {
            code: null,
            signal: "SIGKILL",
            stderr: [],
        };
        reportAdapterExit(crash, (line) => lines.push(line));
        expect(process.exitCode).toBe(NATIVE_ADAPTER_FAILED_EXIT_CODE);
        expect(NATIVE_ADAPTER_FAILED_EXIT_CODE).toBe(70);
        expect(lines).toEqual([
            "Native adapter exited after mount readiness: code=null signal=SIGKILL; stopping the mount (exit status 70).",
            "native adapter stderr: (none)",
        ]);

        // Unmounted from outside: stops, as asked, with no failure.
        process.exitCode = undefined;
        reportAdapterExit({ code: 0, signal: null, stderr: ["bye"] }, () => {});
        expect(process.exitCode).toBeUndefined();
        expect(
            describeAdapterExit({ code: 0, signal: null, stderr: ["bye"] })
        ).toEqual([
            "Native adapter exited after mount readiness: code=0 signal=null; it was stopped outside this process, for example by unmounting the mountpoint. Stopping the mount.",
            "native adapter stderr: bye",
        ]);

        // A failure already reported (exit status 1) is kept.
        process.exitCode = 1;
        reportAdapterExit({ ...crash, code: 2, signal: null }, () => {});
        expect(process.exitCode).toBe(1);
    });
});

describe("the mount an adapter leaves when it exits without unmounting", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        process.exitCode = undefined;
    });

    const CLEARED =
        "peerbit-shared-fs-native: unmounted the disconnected mount that an earlier adapter left at /unused";

    /** A ready adapter whose --clear-dead-mount says `lines` and exits `code`. */
    const mountClearing = async (
        child: FakeChild,
        lines: string[],
        code = 0,
        options: { clearDeadMount?: boolean } = { clearDeadMount: true }
    ) => {
        const spawnAdapter = spawning(child, (clearing) => {
            for (const line of lines) clearing.stderr.write(`${line}\n`);
            clearing.exitUnasked(code, null);
        });
        const mounted = await mountReady(child, { spawnAdapter, ...options });
        return { mounted, spawnAdapter };
    };

    it("is cleared by the adapter's --clear-dead-mount once it was killed, which gets neither the token nor the parent", async () => {
        // Inherited by this process: the clear must not pass them on.
        vi.stubEnv(NATIVE_ADAPTER_IPC_TOKEN_ENV, "stale-token");
        vi.stubEnv(NATIVE_ADAPTER_PARENT_PID_ENV, "1");
        vi.stubEnv(NATIVE_ADAPTER_PROFILE_FILE_ENV, "/stale/native.ndjson");
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const child = new FakeChild();
        const { mounted, spawnAdapter } = await mountClearing(child, [CLEARED]);
        child.exitUnasked(null, "SIGKILL");
        await mounted.exited;
        expect(spawnAdapter).toHaveBeenCalledTimes(1);
        // The stop that follows an exit starts with unmount().
        await mounted.unmount();
        expect(spawnAdapter).toHaveBeenCalledTimes(2);
        const [command, args, options] = vi.mocked(spawnAdapter).mock
            .calls[1] as unknown as [string, string[], { env: object }];
        expect([command, args]).toEqual([
            "crashing-adapter",
            ["--clear-dead-mount", "--mountpoint", "/unused"],
        ]);
        expect(options).toMatchObject({ stdio: ["ignore", "ignore", "pipe"] });
        for (const name of [
            NATIVE_ADAPTER_IPC_TOKEN_ENV,
            NATIVE_ADAPTER_PARENT_PID_ENV,
            NATIVE_ADAPTER_PROFILE_FILE_ENV,
        ])
            expect(options.env, name).not.toHaveProperty(name);
        expect(errors.mock.calls).toEqual([[CLEARED]]);
    });

    it("is cleared after an unmount that had to kill the adapter", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const child = new FakeChild({ exitOnSignal: "SIGKILL" });
        const { mounted, spawnAdapter } = await mountClearing(child, [CLEARED]);
        await mounted.unmount();
        expect(child.signalCode).toBe("SIGKILL");
        expect(spawnAdapter).toHaveBeenCalledTimes(2);
        expect(vi.mocked(spawnAdapter).mock.calls[1][1]).toEqual([
            "--clear-dead-mount",
            "--mountpoint",
            "/unused",
        ]);
    });

    it("is left alone when the adapter unmounted and exited 0: on this process's unmount or from outside", async () => {
        const stopped = new FakeChild({ exitCodeOnSignal: 0 });
        const first = await mountClearing(stopped, [CLEARED]);
        await first.mounted.unmount();
        expect(stopped.exitCode).toBe(0);
        expect(first.spawnAdapter).toHaveBeenCalledTimes(1);

        const outside = new FakeChild();
        const second = await mountClearing(outside, [CLEARED]);
        outside.exitUnasked(0, null);
        await second.mounted.exited;
        await second.mounted.unmount();
        expect(second.spawnAdapter).toHaveBeenCalledTimes(1);
    });

    it("is left to WinFsp on Windows, which removes the drive of an adapter that exited", async () => {
        const child = new FakeChild();
        const { mounted, spawnAdapter } = await mountClearing(
            child,
            [CLEARED],
            0,
            { clearDeadMount: false }
        );
        child.exitUnasked(1, null);
        await mounted.exited;
        await mounted.unmount();
        expect(spawnAdapter).toHaveBeenCalledTimes(1);
    });

    it("fails the unmount with the reason when it may not or could not be cleared", async () => {
        const refusal =
            "/unused is disconnected (stat /unused: transport endpoint is not connected), but it is not a mount that a peerbit-fs adapter of this user left: type fuse.sshfs, source me@host, mounted by user 1000. Unmount it (fusermount3 -u /unused), then mount again";
        const child = new FakeChild();
        const { mounted } = await mountClearing(child, [refusal], 1);
        child.exitUnasked(null, "SIGKILL");
        await mounted.exited;
        await expect(mounted.unmount()).rejects.toThrow(
            `Could not clear /unused, which the native adapter left disconnected: ${refusal}`
        );
    });

    it("gives up on a clear that does not finish, and kills it", async () => {
        const child = new FakeChild();
        let clearing: FakeChild | undefined;
        const spawnAdapter = spawning(child, (started) => (clearing = started));
        const mounted = await mountReady(child, {
            spawnAdapter,
            clearDeadMount: true,
            exitTimeoutMs: 20,
        });
        child.exitUnasked(null, "SIGKILL");
        await mounted.exited;
        await expect(mounted.unmount()).rejects.toThrow(
            "Could not clear /unused, which the native adapter left disconnected: it did not finish within 20 ms"
        );
        expect(clearing?.kill).toHaveBeenCalledWith("SIGKILL");
    });
});
