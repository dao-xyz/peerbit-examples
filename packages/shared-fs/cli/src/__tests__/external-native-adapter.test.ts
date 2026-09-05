import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { mountExternalNativeAdapter } from "../external-native-adapter.js";

const deferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const waitFor = async (assertion: () => void) => {
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            assertion();
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    assertion();
};

const attachedProbe = () =>
    vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);

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
        const controller = new AbortController();
        const addListener = vi.spyOn(controller.signal, "addEventListener");
        const removeListener = vi.spyOn(
            controller.signal,
            "removeEventListener"
        );
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
            {
                exitTimeoutMs: 100,
                signal: controller.signal,
                spawnAdapter,
                probe: attachedProbe(),
            }
        );
        await mounted.unmount();

        expect(child.kill).toHaveBeenCalledOnce();
        expect(child.kill).toHaveBeenCalledWith("SIGINT");
        expect(child.signalCode).toBe("SIGINT");
        expect(addListener).toHaveBeenCalledTimes(2);
        expect(removeListener).toHaveBeenCalledTimes(2);
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
                    probe: attachedProbe(),
                }
            )
        ).rejects.toThrow("Mount readiness timeout: /unused");

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
            {
                exitTimeoutMs: 5,
                spawnAdapter,
                probe: attachedProbe(),
            }
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
            {
                exitTimeoutMs: 100,
                spawnAdapter,
                probe: attachedProbe(),
            }
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
            {
                exitTimeoutMs: 5,
                spawnAdapter,
                probe: attachedProbe(),
            }
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
            {
                exitTimeoutMs: 100,
                spawnAdapter,
                probe: attachedProbe(),
            }
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
                    probe: attachedProbe(),
                }
            )
        ).rejects.toMatchObject({
            name: "AggregateError",
            message:
                "Native adapter startup failed and its process could not be stopped",
            errors: [
                expect.objectContaining({
                    message: expect.stringContaining("readiness timeout"),
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

    it("waits for a delayed WinFsp namespace after the adapter ready signal", async () => {
        const child = new FakeChild();
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;
        const namespacePublished = deferred<boolean>();
        const mountVisibilityProbe = vi
            .fn<() => Promise<boolean>>()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false)
            .mockImplementationOnce(() => namespacePublished.promise);
        queueMicrotask(() => {
            child.stdout.write("peerbit-shared-fs-native ready\n");
        });

        let settled = false;
        const mounting = mountExternalNativeAdapter(
            "delayed-winfsp-adapter",
            "tcp://127.0.0.1:1",
            "Q:",
            {
                readinessTimeoutMs: 1_000,
                exitTimeoutMs: 100,
                spawnAdapter,
                probe: mountVisibilityProbe,
            }
        );
        void mounting.then(() => {
            settled = true;
        });

        await waitFor(() =>
            expect(mountVisibilityProbe).toHaveBeenCalledTimes(3)
        );
        expect(settled).toBe(false);
        namespacePublished.resolve(true);

        const mounted = await mounting;
        expect(mounted.mountpoint).toBe("Q:");
        expect(child.kill).not.toHaveBeenCalled();
        await mounted.unmount();
    });

    it("times out and reaps a child whose mount namespace never appears", async () => {
        const child = new FakeChild();
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;
        const mountVisibilityProbe = vi.fn(async () => false);
        queueMicrotask(() => {
            child.stdout.write("peerbit-shared-fs-native ready\n");
        });

        await expect(
            mountExternalNativeAdapter(
                "unpublished-winfsp-adapter",
                "tcp://127.0.0.1:1",
                "Q:",
                {
                    readinessTimeoutMs: 20,
                    exitTimeoutMs: 100,
                    spawnAdapter,
                    probe: mountVisibilityProbe,
                }
            )
        ).rejects.toThrow("Mount readiness timeout: Q:");
        expect(mountVisibilityProbe).toHaveBeenCalled();
        expect(child.kill).toHaveBeenCalledOnce();
        expect(child.kill).toHaveBeenCalledWith("SIGINT");
        expect(child.signalCode).toBe("SIGINT");
    });

    it("does not retry a semantic mount-visibility error", async () => {
        const child = new FakeChild();
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;
        const denied = Object.assign(new Error("mount access denied"), {
            code: "EACCES",
        });
        const mountVisibilityProbe = vi
            .fn<() => Promise<boolean>>()
            .mockResolvedValueOnce(false)
            .mockRejectedValue(denied);
        queueMicrotask(() => {
            child.stdout.write("peerbit-shared-fs-native ready\n");
        });

        await expect(
            mountExternalNativeAdapter(
                "denied-winfsp-adapter",
                "tcp://127.0.0.1:1",
                "Q:",
                {
                    readinessTimeoutMs: 1_000,
                    exitTimeoutMs: 100,
                    spawnAdapter,
                    probe: mountVisibilityProbe,
                }
            )
        ).rejects.toBe(denied);
        expect(mountVisibilityProbe).toHaveBeenCalledTimes(2);
        expect(child.kill).toHaveBeenCalledOnce();
        expect(child.kill).toHaveBeenCalledWith("SIGINT");
    });

    it("rejects a pre-existing sentinel before spawning", async () => {
        const spawnAdapter = vi.fn() as unknown as typeof spawn;

        await expect(
            mountExternalNativeAdapter("adapter", "endpoint", "/mount", {
                spawnAdapter,
                probe: async () => true,
            })
        ).rejects.toThrow("Mount sentinel exists: /mount");
        expect(spawnAdapter).not.toHaveBeenCalled();
    });

    it("times out a hung preflight without a late spawn", async () => {
        const spawnAdapter = vi.fn() as unknown as typeof spawn;
        const preflight = deferred<boolean>();

        await expect(
            mountExternalNativeAdapter("adapter", "endpoint", "/mount", {
                readinessTimeoutMs: 10,
                spawnAdapter,
                probe: () => preflight.promise,
            })
        ).rejects.toThrow("Mount preflight timeout: /mount");
        expect(spawnAdapter).not.toHaveBeenCalled();

        preflight.resolve(false);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(spawnAdapter).not.toHaveBeenCalled();
    });

    it("aborts and reaps startup while namespace attachment is pending", async () => {
        const child = new FakeChild();
        const spawnAdapter = vi.fn(
            () => child as unknown as ChildProcess
        ) as unknown as typeof spawn;
        const attachment = deferred<boolean>();
        const probe = vi
            .fn<() => Promise<boolean>>()
            .mockResolvedValueOnce(false)
            .mockImplementationOnce(() => attachment.promise);
        const controller = new AbortController();
        const reason = new Error("shutdown during mount startup");
        queueMicrotask(() => {
            child.stdout.write("peerbit-shared-fs-native ready\n");
        });

        const mounting = mountExternalNativeAdapter(
            "adapter",
            "endpoint",
            "Q:",
            {
                readinessTimeoutMs: 1_000,
                exitTimeoutMs: 100,
                signal: controller.signal,
                spawnAdapter,
                probe,
            }
        );
        await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
        controller.abort(reason);

        await expect(mounting).rejects.toBe(reason);
        expect(child.kill).toHaveBeenCalledWith("SIGINT");
        expect(child.signalCode).toBe("SIGINT");
    });

    it("reports an unexpected child exit after mount readiness", async () => {
        const child = new FakeChild();
        queueMicrotask(() => {
            child.stdout.write("peerbit-shared-fs-native ready\n");
        });
        const mounted = await mountExternalNativeAdapter(
            "adapter",
            "endpoint",
            "/mount",
            {
                spawnAdapter: vi.fn(
                    () => child as unknown as ChildProcess
                ) as unknown as typeof spawn,
                probe: attachedProbe(),
            }
        );

        child.exitCode = 9;
        child.emit("exit", 9, null);
        await expect(mounted.failure).rejects.toThrow(
            "Native adapter exited after mount readiness: code=9 signal=null"
        );
    });
});
