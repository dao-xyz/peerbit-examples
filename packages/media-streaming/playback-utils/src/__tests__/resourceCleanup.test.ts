import { describe, expect, it, vi } from "vitest";
import { createRetryableResourceDrain } from "../resourceCleanup";

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
});
