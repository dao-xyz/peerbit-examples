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
});
