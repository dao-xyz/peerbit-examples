import { describe, expect, it, vi } from "vitest";
import {
    createDurableCleanupRegistry,
    createRetryableResourceDrain,
} from "../resourceCleanup";

describe("retryable resource drain", () => {
    it("checkpoints successful closes and retries only failed resources", async () => {
        const failure = new Error("synthetic close failure");
        const successful = {
            close: vi.fn().mockResolvedValue(undefined),
        };
        const failOnce = {
            close: vi
                .fn()
                .mockRejectedValueOnce(failure)
                .mockResolvedValueOnce(undefined),
        };
        const onError = vi.fn();
        const drain = createRetryableResourceDrain({ onError });

        await drain.enqueue([successful, failOnce]);
        expect(drain.pendingCount()).toBe(1);
        expect(successful.close).toHaveBeenCalledOnce();
        expect(failOnce.close).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(failure);

        await drain.retry();
        expect(drain.pendingCount()).toBe(0);
        expect(successful.close).toHaveBeenCalledOnce();
        expect(failOnce.close).toHaveBeenCalledTimes(2);
    });

    it("retains cleanup ownership across more than one failed retry", async () => {
        const failure = new Error("persistent synthetic close failure");
        const failTwice = {
            close: vi
                .fn()
                .mockRejectedValueOnce(failure)
                .mockRejectedValueOnce(failure)
                .mockResolvedValueOnce(undefined),
        };
        const onError = vi.fn();
        const drain = createRetryableResourceDrain({ onError });

        await drain.enqueue([failTwice]);
        await drain.retry();
        expect(drain.pendingCount()).toBe(1);
        expect(failTwice.close).toHaveBeenCalledTimes(2);

        await drain.retry();
        expect(drain.pendingCount()).toBe(0);
        expect(failTwice.close).toHaveBeenCalledTimes(3);
        expect(onError).toHaveBeenCalledTimes(2);
    });

    it("keeps retrying retained cleanup after its caller goes away", async () => {
        vi.useFakeTimers();
        try {
            const failure = new Error("transient terminal close failure");
            const failTwice = {
                close: vi
                    .fn()
                    .mockRejectedValueOnce(failure)
                    .mockRejectedValueOnce(failure)
                    .mockResolvedValueOnce(undefined),
            };
            const drain = createRetryableResourceDrain({
                autoRetry: {
                    initialDelayMs: 10,
                    maxDelayMs: 20,
                    backoffFactor: 2,
                },
            });

            await drain.enqueue([failTwice]);
            expect(drain.pendingCount()).toBe(1);

            await vi.advanceTimersByTimeAsync(10);
            expect(failTwice.close).toHaveBeenCalledTimes(2);
            expect(drain.pendingCount()).toBe(1);

            await vi.advanceTimersByTimeAsync(20);
            expect(failTwice.close).toHaveBeenCalledTimes(3);
            expect(drain.pendingCount()).toBe(0);

            await vi.advanceTimersByTimeAsync(100);
            expect(failTwice.close).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it("bounds automatic retries and retains debt for a later explicit retry", async () => {
        vi.useFakeTimers();
        try {
            const failure = new Error("persistent close failure");
            const resource = {
                close: vi.fn().mockRejectedValue(failure),
            };
            const drain = createRetryableResourceDrain({
                autoRetry: {
                    initialDelayMs: 0,
                    maxDelayMs: 2,
                    backoffFactor: 2,
                    maxAttempts: 3,
                },
            });

            await drain.enqueue([resource]);
            expect(resource.close).toHaveBeenCalledOnce();

            await vi.advanceTimersByTimeAsync(0);
            expect(resource.close).toHaveBeenCalledOnce();

            await vi.advanceTimersByTimeAsync(5);
            expect(resource.close).toHaveBeenCalledTimes(4);
            expect(drain.pendingCount()).toBe(1);

            await vi.advanceTimersByTimeAsync(100);
            expect(resource.close).toHaveBeenCalledTimes(4);

            resource.close.mockResolvedValueOnce(undefined);
            await drain.retry();
            expect(resource.close).toHaveBeenCalledTimes(5);
            expect(drain.pendingCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps exhausted unmount cleanup reachable for an external retry", async () => {
        vi.useFakeTimers();
        try {
            const failure = new Error("temporarily unable to close");
            const resource = {
                close: vi
                    .fn()
                    .mockRejectedValueOnce(failure)
                    .mockRejectedValueOnce(failure)
                    .mockResolvedValueOnce(undefined),
            };
            const registry = createDurableCleanupRegistry();
            const owner = {};
            {
                const unmountedDrain = createRetryableResourceDrain({
                    durableRegistry: registry,
                    durableOwner: owner,
                    autoRetry: {
                        initialDelayMs: 10,
                        maxDelayMs: 10,
                        maxAttempts: 1,
                    },
                });

                await unmountedDrain.enqueue([resource]);
                await vi.advanceTimersByTimeAsync(10);
                expect(resource.close).toHaveBeenCalledTimes(2);
                expect(unmountedDrain.pendingCount()).toBe(1);
                expect(registry.pendingCount(owner)).toBe(1);
            }

            // The component-local drain is now out of scope. The registry,
            // unlike that collectible closure, still owns the exact handle.
            await vi.advanceTimersByTimeAsync(100);
            expect(resource.close).toHaveBeenCalledTimes(2);

            const laterLifecycle = createRetryableResourceDrain({
                durableRegistry: registry,
                durableOwner: owner,
            });
            const wakeResource = {
                close: vi.fn().mockResolvedValue(undefined),
            };
            await laterLifecycle.enqueue([wakeResource]);
            await Promise.resolve();
            expect(resource.close).toHaveBeenCalledTimes(3);
            expect(wakeResource.close).toHaveBeenCalledOnce();
            expect(registry.pendingCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not let one hung durable close block another owner", async () => {
        const registry = createDurableCleanupRegistry();
        const hungOwner = {};
        const readyOwner = {};
        const hung = {
            close: vi.fn(() => new Promise<void>(() => {})),
        };
        const ready = {
            close: vi.fn().mockResolvedValue(undefined),
        };
        registry.adopt([hung], { owner: hungOwner });
        registry.adopt([ready], { owner: readyOwner });

        void registry.retry(hungOwner);
        await registry.retry(readyOwner);

        expect(hung.close).toHaveBeenCalledOnce();
        expect(ready.close).toHaveBeenCalledOnce();
        expect(registry.pendingCount(hungOwner)).toBe(1);
        expect(registry.pendingCount(readyOwner)).toBe(0);
    });

    it("allows one close to await cleanup enqueued from inside itself", async () => {
        const registry = createDurableCleanupRegistry({
            closeAttemptTimeoutMs: 100,
        });
        const owner = {};
        const second = {
            close: vi.fn().mockResolvedValue(undefined),
        };
        let drain: ReturnType<typeof createRetryableResourceDrain>;
        const first = {
            close: vi.fn(async () => {
                await drain.enqueue([second]);
            }),
        };
        drain = createRetryableResourceDrain({
            durableRegistry: registry,
            durableOwner: owner,
            closeAttemptTimeoutMs: 100,
        });

        await drain.enqueue([first]);

        expect(first.close).toHaveBeenCalledOnce();
        expect(second.close).toHaveBeenCalledOnce();
        expect(drain.pendingCount()).toBe(0);
    });

    it("bounds same-resource reentrancy without closing concurrently", async () => {
        vi.useFakeTimers();
        try {
            const registry = createDurableCleanupRegistry({
                closeAttemptTimeoutMs: 10,
            });
            const owner = {};
            let drain: ReturnType<typeof createRetryableResourceDrain>;
            const resource = {
                close: vi.fn(async () => {
                    await drain.enqueue([resource]);
                }),
            };
            drain = createRetryableResourceDrain({
                durableRegistry: registry,
                durableOwner: owner,
                closeAttemptTimeoutMs: 10,
            });

            const cleanup = drain.enqueue([resource]);
            await vi.advanceTimersByTimeAsync(10);
            await cleanup;
            await Promise.resolve();

            expect(resource.close).toHaveBeenCalledOnce();
            expect(drain.pendingCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps a hung exact attempt owned while later cleanup proceeds", async () => {
        vi.useFakeTimers();
        try {
            const registry = createDurableCleanupRegistry({
                closeAttemptTimeoutMs: 10,
            });
            const owner = {};
            const hung = {
                close: vi.fn(() => new Promise<void>(() => {})),
            };
            const ready = {
                close: vi.fn().mockResolvedValue(undefined),
            };
            const drain = createRetryableResourceDrain({
                durableRegistry: registry,
                durableOwner: owner,
                closeAttemptTimeoutMs: 10,
            });

            const firstCleanup = drain.enqueue([hung]);
            await vi.advanceTimersByTimeAsync(10);
            await firstCleanup;
            expect(drain.pendingCount()).toBe(1);

            await drain.enqueue([ready]);
            expect(ready.close).toHaveBeenCalledOnce();

            const retry = drain.retry();
            await vi.advanceTimersByTimeAsync(10);
            await retry;
            expect(hung.close).toHaveBeenCalledOnce();
            expect(drain.pendingCount()).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("retries the same resource only after its timed-out attempt rejects", async () => {
        vi.useFakeTimers();
        try {
            const failure = new Error("late close failure");
            let rejectFirst!: (error: unknown) => void;
            const resource = {
                close: vi
                    .fn()
                    .mockImplementationOnce(
                        () =>
                            new Promise<void>((_resolve, reject) => {
                                rejectFirst = reject;
                            })
                    )
                    .mockResolvedValueOnce(undefined),
            };
            const registry = createDurableCleanupRegistry({
                closeAttemptTimeoutMs: 10,
            });
            const owner = {};
            const drain = createRetryableResourceDrain({
                durableRegistry: registry,
                durableOwner: owner,
                closeAttemptTimeoutMs: 10,
            });

            const firstCleanup = drain.enqueue([resource]);
            await vi.advanceTimersByTimeAsync(10);
            await firstCleanup;

            const overlappingRetry = drain.retry();
            expect(resource.close).toHaveBeenCalledOnce();
            rejectFirst(failure);
            await overlappingRetry;
            expect(resource.close).toHaveBeenCalledOnce();
            expect(drain.pendingCount()).toBe(1);

            await drain.retry();
            expect(resource.close).toHaveBeenCalledTimes(2);
            expect(drain.pendingCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("contains rejected async cleanup error reporters", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => unhandled.push(error);
        process.on("unhandledRejection", onUnhandled);
        try {
            const closeFailure = new Error("close failed");
            const reporterFailure = new Error("reporter failed");
            const registryReporter = vi.fn(async () => {
                throw reporterFailure;
            });
            const drainReporter = vi.fn(async () => {
                throw reporterFailure;
            });

            const registry = createDurableCleanupRegistry();
            const owner = {};
            registry.adopt(
                [{ close: vi.fn().mockRejectedValue(closeFailure) }],
                { owner, onError: registryReporter }
            );
            await registry.retry(owner);

            const drain = createRetryableResourceDrain({
                durableRegistry: createDurableCleanupRegistry(),
                onError: drainReporter,
            });
            await drain.enqueue([
                { close: vi.fn().mockRejectedValue(closeFailure) },
            ]);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));

            expect(registryReporter).toHaveBeenCalledWith(closeFailure);
            expect(drainReporter).toHaveBeenCalledWith(closeFailure);
            expect(unhandled).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});
