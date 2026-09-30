import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
    adapterSpawnOptions,
    mountExternalNativeAdapter,
    NATIVE_ADAPTER_IPC_TOKEN_ENV,
    NATIVE_ADAPTER_PROFILE_FILE_ENV,
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
                this.signalCode = signal;
                this.emit("exit", null, signal);
            });
        }
        return signal !== this.falseOnSignal;
    });

    constructor(
        options: {
            exitOnSignal?: NodeJS.Signals | null;
            falseOnSignal?: NodeJS.Signals;
            errorOnSignal?: NodeJS.Signals;
        } = {}
    ) {
        super();
        this.exitOnSignal =
            options.exitOnSignal === null
                ? undefined
                : (options.exitOnSignal ?? "SIGINT");
        this.falseOnSignal = options.falseOnSignal;
        this.errorOnSignal = options.errorOnSignal;
    }
}

describe("external native adapter lifecycle", () => {
    it("passes the opt-in profile file through the environment, not argv", async () => {
        const child = new FakeChild();
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;
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
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;
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

    it("does not let inherited variables enable profiling or replace the token", () => {
        const inherited = {
            PATH: "/bin",
            [NATIVE_ADAPTER_PROFILE_FILE_ENV]: "/stale/native-adapter.ndjson",
            [NATIVE_ADAPTER_IPC_TOKEN_ENV]: "stale-token",
        };
        const options = adapterSpawnOptions(ipc.token, undefined, inherited);
        expect(options).toEqual({
            stdio: ["ignore", "pipe", "pipe"],
            env: { PATH: "/bin", [NATIVE_ADAPTER_IPC_TOKEN_ENV]: ipc.token },
        });
        // The caller's environment object is not mutated.
        expect(inherited).toEqual({
            PATH: "/bin",
            [NATIVE_ADAPTER_PROFILE_FILE_ENV]: "/stale/native-adapter.ndjson",
            [NATIVE_ADAPTER_IPC_TOKEN_ENV]: "stale-token",
        });
        // An explicit profile file replaces the inherited value.
        expect(
            adapterSpawnOptions(
                ipc.token,
                "/profiles/native-adapter.ndjson",
                inherited
            ).env
        ).toEqual({
            PATH: "/bin",
            [NATIVE_ADAPTER_PROFILE_FILE_ENV]:
                "/profiles/native-adapter.ndjson",
            [NATIVE_ADAPTER_IPC_TOKEN_ENV]: ipc.token,
        });
    });

    it("stops and reaps a ready child during unmount", async () => {
        const child = new FakeChild();
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;
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
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;
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
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;
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
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;
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
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;
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
