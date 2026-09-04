import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
    mountExternalNativeAdapter,
    resolveNativeIpcConcurrency,
} from "../external-native-adapter.js";

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
            "tcp://127.0.0.1:1",
            "/unused",
            { exitTimeoutMs: 100, spawnAdapter }
        );
        expect(spawnAdapter).toHaveBeenCalledWith(
            "ready-adapter",
            ["--endpoint", "tcp://127.0.0.1:1", "--mountpoint", "/unused"],
            { stdio: ["ignore", "pipe", "pipe"] }
        );
        await mounted.unmount();

        expect(child.kill).toHaveBeenCalledOnce();
        expect(child.kill).toHaveBeenCalledWith("SIGINT");
        expect(child.signalCode).toBe("SIGINT");
    });

    it("forwards an opt-in bounded IPC concurrency to the adapter", async () => {
        const child = new FakeChild();
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;
        queueMicrotask(() => {
            child.stdout.write("peerbit-shared-fs-native ready\n");
        });

        const mounted = await mountExternalNativeAdapter(
            "parallel-adapter",
            "tcp://127.0.0.1:2",
            "/parallel",
            { exitTimeoutMs: 100, ipcConcurrency: 4, spawnAdapter }
        );
        expect(spawnAdapter).toHaveBeenCalledWith(
            "parallel-adapter",
            [
                "--endpoint",
                "tcp://127.0.0.1:2",
                "--mountpoint",
                "/parallel",
                "--ipc-concurrency",
                "4",
            ],
            { stdio: ["ignore", "pipe", "pipe"] }
        );
        await mounted.unmount();
    });

    it.each([0, 17, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
        "rejects invalid IPC concurrency %s before spawning",
        async (ipcConcurrency) => {
            const spawnAdapter = vi.fn() as unknown as typeof spawn;
            await expect(
                mountExternalNativeAdapter(
                    "invalid-adapter",
                    "tcp://127.0.0.1:3",
                    "/invalid",
                    { ipcConcurrency, spawnAdapter }
                )
            ).rejects.toThrow(
                "native IPC concurrency must be an integer between 1 and 16"
            );
            expect(spawnAdapter).not.toHaveBeenCalled();
        }
    );

    it("accepts both IPC concurrency boundaries", () => {
        expect(resolveNativeIpcConcurrency(1)).toBe(1);
        expect(resolveNativeIpcConcurrency(16)).toBe(16);
    });

    it("stops and reaps a child that times out before readiness", async () => {
        const child = new FakeChild();
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;

        await expect(
            mountExternalNativeAdapter(
                "stalled-adapter",
                "tcp://127.0.0.1:1",
                "/unused",
                {
                    readinessTimeoutMs: 10,
                    exitTimeoutMs: 100,
                    spawnAdapter,
                }
            )
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
            "tcp://127.0.0.1:1",
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
            "tcp://127.0.0.1:1",
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
            "tcp://127.0.0.1:1",
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
            "tcp://127.0.0.1:1",
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
            mountExternalNativeAdapter(
                "unkillable-adapter",
                "tcp://127.0.0.1:1",
                "/unused",
                {
                    readinessTimeoutMs: 5,
                    exitTimeoutMs: 5,
                    spawnAdapter,
                }
            )
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
