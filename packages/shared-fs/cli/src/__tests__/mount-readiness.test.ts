import {
    createSharedFsMountBackend,
    type SharedFsMountBackendTarget,
} from "@peerbit/shared-fs";
import { describe, expect, it, vi } from "vitest";
import {
    runMountReadinessLifecycle,
    waitForReadableMountView,
} from "../mount-readiness.js";

const deferred = <T = void>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
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

const waitForAbort = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
    });

const fakeBackendTarget = (writeReady: () => boolean) => {
    const mkdir = vi.fn(async () => {});
    const target: SharedFsMountBackendTarget = {
        bootstrapStatus: () => ({
            phase: writeReady() ? "converged" : "overlay-active",
            writeReady: writeReady(),
        }),
        readFile: async () => undefined,
        readVersion: async () => undefined,
        writeFile: async () => undefined,
        mkdir,
        rm: async () => {},
        rename: async () => {},
        list: async () => [],
        versions: async () => [],
        conflicts: async () => [],
        stat: async () => undefined,
    };
    return { backend: createSharedFsMountBackend(target), mkdir };
};

describe("CLI mount readiness lifecycle", () => {
    it("preserves the default ready-before-mount ordering", async () => {
        const readiness = deferred();
        const shutdown = deferred();
        const events: string[] = [];

        const running = runMountReadinessLifecycle({
            readableFirst: false,
            timeoutMs: 120_000,
            isWriteReady: () => false,
            awaitWriteReady: async () => {
                events.push("await-ready");
                await readiness.promise;
            },
            mount: async () => {
                events.push("mount");
            },
            waitForShutdown: async () => {
                events.push("await-shutdown");
                await shutdown.promise;
            },
            cleanup: async () => {
                events.push("cleanup");
            },
            onMounted: () => {
                events.push("mounted");
            },
            onWritePending: () => {
                events.push("pending");
            },
        });

        await waitFor(() => expect(events).toEqual(["await-ready"]));
        readiness.resolve();
        await waitFor(() =>
            expect(events).toEqual([
                "await-ready",
                "mount",
                "mounted",
                "await-shutdown",
            ])
        );
        shutdown.resolve();
        await running;
        expect(events).toEqual([
            "await-ready",
            "mount",
            "mounted",
            "await-shutdown",
            "cleanup",
        ]);
    });

    it("keeps a default readiness timeout from exposing the mount", async () => {
        const timeout = Object.assign(new Error("readiness timed out"), {
            code: "ETIMEDOUT",
        });
        const mount = vi.fn(async () => {});
        const cleanup = vi.fn(async () => {});

        await expect(
            runMountReadinessLifecycle({
                readableFirst: false,
                timeoutMs: 25,
                isWriteReady: () => false,
                awaitWriteReady: async () => {
                    throw timeout;
                },
                mount,
                waitForShutdown: async () => {},
                cleanup,
            })
        ).rejects.toBe(timeout);
        expect(mount).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("does not manufacture a pending phase for an already-ready readable-first mount", async () => {
        const shutdown = deferred();
        const awaitWriteReady = vi.fn(async () => {});
        const onWritePending = vi.fn();
        const onWriteReady = vi.fn();
        const onMounted = vi.fn();
        const cleanup = vi.fn(async () => {});

        const running = runMountReadinessLifecycle({
            readableFirst: true,
            timeoutMs: 120_000,
            isWriteReady: () => true,
            awaitWriteReady,
            mount: async () => {},
            waitForShutdown: async () => {
                await shutdown.promise;
            },
            cleanup,
            onMounted,
            onWritePending,
            onWriteReady,
        });

        await waitFor(() => expect(onMounted).toHaveBeenCalledWith(true));
        shutdown.resolve();
        await running;
        expect(onMounted).toHaveBeenCalledWith(true);
        expect(awaitWriteReady).not.toHaveBeenCalled();
        expect(onWritePending).not.toHaveBeenCalled();
        expect(onWriteReady).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("mounts readable-first behind EAGAIN and transitions only after genuine readiness", async () => {
        let writeReady = false;
        const readable = deferred();
        const readiness = deferred();
        const shutdown = deferred();
        const pending = deferred();
        const writable = deferred();
        const events: string[] = [];
        const { backend, mkdir } = fakeBackendTarget(() => writeReady);

        const running = runMountReadinessLifecycle({
            readableFirst: true,
            timeoutMs: 120_000,
            isWriteReady: () => writeReady,
            awaitWriteReady: async () => {
                events.push("await-ready");
                await readiness.promise;
            },
            awaitReadable: async () => {
                events.push("await-readable");
                await readable.promise;
            },
            mount: async () => {
                events.push("mount");
            },
            waitForShutdown: async () => {
                events.push("await-shutdown");
                await shutdown.promise;
            },
            cleanup: async () => {
                events.push("cleanup");
            },
            onMounted: (ready) => {
                events.push(ready ? "mounted-writable" : "mounted-readable");
            },
            onWritePending: () => {
                events.push("pending");
                pending.resolve();
            },
            onWriteReady: () => {
                events.push("writable");
                writable.resolve();
            },
        });

        await waitFor(() =>
            expect(events).toEqual(["await-shutdown", "await-readable"])
        );
        readable.resolve();
        await pending.promise;
        await expect(backend.getattr("/")).resolves.toMatchObject({
            kind: "directory",
        });
        await expect(backend.readdir("/")).resolves.toContainEqual({
            name: ".peerbit-conflicts",
            kind: "directory",
        });
        const pendingMutations = [
            () =>
                backend.open("/blocked", {
                    write: true,
                    create: true,
                }),
            () => backend.truncate("/blocked", 0),
            () => backend.mkdir("/blocked"),
            () => backend.rmdir("/blocked"),
            () => backend.rename("/blocked", "/renamed"),
            () => backend.unlink("/blocked"),
        ];
        for (const mutation of pendingMutations) {
            await expect(mutation()).rejects.toMatchObject({
                code: "EAGAIN",
            });
        }
        expect(mkdir).not.toHaveBeenCalled();

        writeReady = true;
        readiness.resolve();
        await writable.promise;
        await expect(backend.mkdir("/accepted")).resolves.toBeUndefined();
        expect(mkdir).toHaveBeenCalledWith("/accepted");

        shutdown.resolve();
        await running;
        expect(events).toEqual([
            "await-shutdown",
            "await-readable",
            "mount",
            "mounted-readable",
            "pending",
            "await-ready",
            "writable",
            "cleanup",
        ]);
    });

    it("does not expose readable-first when the initial tree times out", async () => {
        const timeout = Object.assign(new Error("readable view timed out"), {
            code: "ETIMEDOUT",
        });
        const mount = vi.fn(async () => {});
        const awaitWriteReady = vi.fn(async () => {});
        const cleanup = vi.fn(async () => {});

        await expect(
            runMountReadinessLifecycle({
                readableFirst: true,
                timeoutMs: 25,
                isWriteReady: () => false,
                awaitReadable: async () => {
                    throw timeout;
                },
                awaitWriteReady,
                mount,
                waitForShutdown: waitForAbort,
                cleanup,
            })
        ).rejects.toBe(timeout);
        expect(mount).not.toHaveBeenCalled();
        expect(awaitWriteReady).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("detaches and cancels its shutdown waiter after a readiness timeout", async () => {
        const timeout = Object.assign(new Error("readiness timed out"), {
            code: "ETIMEDOUT",
        });
        let readinessSignal: AbortSignal | undefined;
        let shutdownSignal: AbortSignal | undefined;
        let shutdownWaitCancelled = false;
        const cleanup = vi.fn(async () => {});

        const running = runMountReadinessLifecycle({
            readableFirst: true,
            timeoutMs: 25,
            isWriteReady: () => false,
            awaitWriteReady: async ({ signal }) => {
                readinessSignal = signal;
                throw timeout;
            },
            mount: async () => {},
            waitForShutdown: (signal) => {
                shutdownSignal = signal;
                return new Promise((resolve) => {
                    signal.addEventListener(
                        "abort",
                        () => {
                            shutdownWaitCancelled = true;
                            resolve();
                        },
                        { once: true }
                    );
                });
            },
            cleanup,
        });

        await expect(running).rejects.toBe(timeout);
        expect(readinessSignal?.aborted).toBe(true);
        expect(shutdownSignal?.aborted).toBe(true);
        expect(shutdownWaitCancelled).toBe(true);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("aborts and joins a pending readiness wait before shutdown cleanup", async () => {
        const shutdown = deferred();
        let readinessSignal: AbortSignal | undefined;
        let pendingWaiters = 0;
        const events: string[] = [];

        const running = runMountReadinessLifecycle({
            readableFirst: true,
            timeoutMs: 120_000,
            isWriteReady: () => false,
            awaitWriteReady: ({ signal }) => {
                readinessSignal = signal;
                pendingWaiters++;
                return new Promise((_, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => {
                            events.push("readiness-aborted");
                            pendingWaiters--;
                            reject(signal.reason);
                        },
                        { once: true }
                    );
                });
            },
            mount: async () => {
                events.push("mount");
            },
            waitForShutdown: async () => {
                events.push("await-shutdown");
                await shutdown.promise;
            },
            cleanup: async () => {
                expect(pendingWaiters).toBe(0);
                events.push("cleanup");
            },
            onWritePending: () => {
                events.push("pending");
            },
        });

        await waitFor(() => expect(events).toContain("pending"));
        shutdown.resolve();
        await running;
        expect(readinessSignal?.aborted).toBe(true);
        expect(pendingWaiters).toBe(0);
        expect(events).toEqual([
            "await-shutdown",
            "mount",
            "pending",
            "readiness-aborted",
            "cleanup",
        ]);
    });

    it("observes shutdown during the pre-mount readable-view wait", async () => {
        const mount = vi.fn(async () => {});
        const awaitWriteReady = vi.fn(async () => {});
        const cleanup = vi.fn(async () => {});
        let readableSignal: AbortSignal | undefined;

        await runMountReadinessLifecycle({
            readableFirst: true,
            timeoutMs: 120_000,
            isWriteReady: () => false,
            awaitReadable: ({ signal }) => {
                readableSignal = signal;
                return new Promise((_, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => reject(signal.reason),
                        { once: true }
                    );
                });
            },
            awaitWriteReady,
            mount,
            waitForShutdown: async () => {},
            cleanup,
        });

        expect(readableSignal?.aborted).toBe(true);
        expect(mount).not.toHaveBeenCalled();
        expect(awaitWriteReady).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("aborts and joins adapter startup after shutdown", async () => {
        const adapterStarted = deferred();
        const shutdown = deferred();
        const awaitWriteReady = vi.fn(async () => {});
        const onMounted = vi.fn();
        const onWritePending = vi.fn();
        const events: string[] = [];

        const running = runMountReadinessLifecycle({
            readableFirst: true,
            timeoutMs: 120_000,
            isWriteReady: () => false,
            awaitReadable: async () => {},
            awaitWriteReady,
            mount: ({ signal }) => {
                events.push("adapter-started");
                adapterStarted.resolve();
                return new Promise((_, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => {
                            events.push("adapter-aborted");
                            reject(signal.reason);
                        },
                        { once: true }
                    );
                });
            },
            waitForShutdown: async () => {
                events.push("await-shutdown");
                await shutdown.promise;
                events.push("shutdown");
            },
            cleanup: async () => {
                events.push("cleanup");
            },
            onMounted,
            onWritePending,
        });

        await adapterStarted.promise;
        shutdown.resolve();
        await waitFor(() => expect(events).toContain("shutdown"));
        await running;

        expect(events).toEqual([
            "await-shutdown",
            "adapter-started",
            "shutdown",
            "adapter-aborted",
            "cleanup",
        ]);
        expect(onMounted).not.toHaveBeenCalled();
        expect(onWritePending).not.toHaveBeenCalled();
        expect(awaitWriteReady).not.toHaveBeenCalled();
    });

    it("bounds and aborts a never-settling adapter startup", async () => {
        const awaitWriteReady = vi.fn(async () => {});
        const onMounted = vi.fn();
        const cleanup = vi.fn(async () => {});

        const startedAt = Date.now();
        await expect(
            runMountReadinessLifecycle({
                readableFirst: true,
                timeoutMs: 20,
                isWriteReady: () => true,
                awaitReadable: async () => {},
                awaitWriteReady,
                mount: ({ signal }) =>
                    new Promise((_, reject) => {
                        signal.addEventListener(
                            "abort",
                            () => reject(signal.reason),
                            { once: true }
                        );
                    }),
                waitForShutdown: waitForAbort,
                cleanup,
                onMounted,
            })
        ).rejects.toMatchObject({ code: "ETIMEDOUT" });
        expect(Date.now() - startedAt).toBeLessThan(500);

        expect(onMounted).not.toHaveBeenCalled();
        expect(awaitWriteReady).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("cleans partially created adapter resources when mounting fails", async () => {
        const mountFailure = new Error("adapter startup failed");
        const awaitWriteReady = vi.fn(async () => {});
        const waitForShutdown = vi.fn(waitForAbort);
        const cleanup = vi.fn(async () => {});

        await expect(
            runMountReadinessLifecycle({
                readableFirst: true,
                timeoutMs: 120_000,
                isWriteReady: () => false,
                awaitWriteReady,
                mount: async () => {
                    throw mountFailure;
                },
                waitForShutdown,
                cleanup,
            })
        ).rejects.toBe(mountFailure);
        expect(awaitWriteReady).not.toHaveBeenCalled();
        expect(waitForShutdown).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("cleans up when a mounted adapter exits unexpectedly", async () => {
        const adapterFailure = deferred<never>();
        const failure = new Error("adapter exited");
        const cleanup = vi.fn(async () => {});
        const onMounted = vi.fn();
        const running = runMountReadinessLifecycle({
            readableFirst: true,
            timeoutMs: 1_000,
            isWriteReady: () => true,
            awaitReadable: async () => {},
            awaitWriteReady: async () => {},
            mount: async () => ({ failure: adapterFailure.promise }),
            waitForShutdown: waitForAbort,
            cleanup,
            onMounted,
        });

        await waitFor(() => expect(onMounted).toHaveBeenCalledOnce());
        adapterFailure.reject(failure);
        await expect(running).rejects.toBe(failure);
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it("keeps observing adapter failure after write readiness", async () => {
        const adapterFailure = deferred<never>();
        const readiness = deferred();
        const writable = deferred();
        const failure = new Error("adapter exited after writable");
        const cleanup = vi.fn(async () => {});
        const running = runMountReadinessLifecycle({
            readableFirst: true,
            timeoutMs: 1_000,
            isWriteReady: () => false,
            awaitReadable: async () => {},
            awaitWriteReady: async () => readiness.promise,
            mount: async () => ({ failure: adapterFailure.promise }),
            waitForShutdown: waitForAbort,
            cleanup,
            onWriteReady: () => writable.resolve(),
        });

        readiness.resolve();
        await writable.promise;
        adapterFailure.reject(failure);
        await expect(running).rejects.toBe(failure);
        expect(cleanup).toHaveBeenCalledOnce();
    });
});

describe("readable-first tree wait", () => {
    it("does not mistake the asynchronous auto-bootstrap decision for a settled off phase", async () => {
        const status: {
            phase: string;
            lastFailure?: string;
        } = { phase: "off" };
        const controller = new AbortController();
        let settled = false;
        const waiting = waitForReadableMountView(() => status, {
            timeout: 1_000,
            signal: controller.signal,
        });
        void waiting.then(() => {
            settled = true;
        });

        setTimeout(() => {
            status.phase = "fetching";
        }, 5);
        setTimeout(() => {
            status.phase = "overlay-active";
        }, 10);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        await expect(waiting).resolves.toBeUndefined();
    });

    it("exposes explicit plain-join and unverified fallback views", async () => {
        const controller = new AbortController();
        await expect(
            waitForReadableMountView(
                () => ({
                    phase: "off",
                    lastFailure: "no usable snapshot was found",
                }),
                { timeout: 1_000, signal: controller.signal }
            )
        ).resolves.toBeUndefined();
        await expect(
            waitForReadableMountView(() => ({ phase: "unverified" }), {
                timeout: 1_000,
                signal: controller.signal,
            })
        ).resolves.toBeUndefined();
    });

    it("bounds and aborts the pre-mount readable-view wait", async () => {
        const timeoutController = new AbortController();
        await expect(
            waitForReadableMountView(() => ({ phase: "fetching" }), {
                timeout: 1,
                signal: timeoutController.signal,
            })
        ).rejects.toMatchObject({ code: "ETIMEDOUT" });

        const abortController = new AbortController();
        const reason = new Error("operator cancelled");
        const aborted = waitForReadableMountView(
            () => ({ phase: "fetching" }),
            { timeout: 1_000, signal: abortController.signal }
        );
        abortController.abort(reason);
        await expect(aborted).rejects.toBe(reason);
    });
});
