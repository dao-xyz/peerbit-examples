import { describe, expect, it, vi } from "vitest";
import {
    boundedBackoffDelay,
    createBoundedRetryBudget,
    createKeyedRetryBackoff,
    createPlaybackGenerationLifecycle,
    reconcilePlaybackRequest,
    runProgressCallback,
} from "../playbackLifecycle.js";

describe("playback lifecycle", () => {
    it("backs resource retries off and recovers after a success", () => {
        let now = 1_000;
        const retry = createKeyedRetryBackoff<string>({
            initialDelayMs: 100,
            maximumDelayMs: 400,
            factor: 2,
            now: () => now,
        });

        expect(retry.canAttempt("video")).toBe(true);
        expect(retry.recordFailure("video")).toBe(100);
        expect(retry.canAttempt("video")).toBe(false);

        now += 100;
        expect(retry.canAttempt("video")).toBe(true);
        expect(retry.recordFailure("video")).toBe(200);
        now += 199;
        expect(retry.canAttempt("video")).toBe(false);
        now += 1;
        expect(retry.canAttempt("video")).toBe(true);

        retry.recordSuccess("video");
        expect(retry.canAttempt("video")).toBe(true);
        expect(retry.recordFailure("video")).toBe(100);
    });

    it("caps backoff delays", () => {
        const options = {
            initialDelayMs: 100,
            maximumDelayMs: 500,
            factor: 2,
        };
        expect(
            [0, 1, 2, 3, 20].map((attempt) =>
                boundedBackoffDelay(attempt, options)
            )
        ).toEqual([100, 200, 400, 500, 500]);
    });

    it("stops automatic retries when their budget is exhausted", () => {
        const retry = createBoundedRetryBudget({
            initialDelayMs: 100,
            maximumDelayMs: 500,
            factor: 2,
            maximumAttempts: 5,
        });

        expect([
            retry.nextDelay(),
            retry.nextDelay(),
            retry.nextDelay(),
            retry.nextDelay(),
            retry.nextDelay(),
        ]).toEqual([100, 200, 400, 500, 500]);
        expect(retry.exhausted()).toBe(true);
        expect(retry.nextDelay()).toBeUndefined();

        retry.reset();
        expect(retry.exhausted()).toBe(false);
        expect(retry.nextDelay()).toBe(100);
    });

    it("bounds playback reconciliation and inserts a positive delay", async () => {
        let request = 0;
        const apply = vi.fn(async () => {
            request += 1;
        });
        const sleep = vi.fn();

        await expect(
            reconcilePlaybackRequest({
                isCurrent: () => true,
                readRequest: () => ({ request, shouldPlay: request % 2 === 0 }),
                apply,
                maximumAttempts: 3,
                retryDelayMs: 10,
                sleep,
            })
        ).rejects.toThrow("did not settle");
        expect(apply).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenNthCalledWith(1, 10);
        expect(sleep).toHaveBeenNthCalledWith(2, 10);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it("retires deferred listener creation when natural onClose terminates its generation", async () => {
        const generation = 1;
        let currentGeneration = generation;
        let activeGeneration: number | undefined = generation;
        const controller = new AbortController();
        let releasePlay!: () => void;
        const deferredPlay = new Promise<void>((resolve) => {
            releasePlay = resolve;
        });
        const play = vi.fn(() => deferredPlay);
        const close = vi.fn();
        let installed = false;
        const lifecycle = createPlaybackGenerationLifecycle({
            generation,
            controller,
            currentGeneration: () => currentGeneration,
            advanceGeneration: () => {
                currentGeneration += 1;
            },
            activeGeneration: () => activeGeneration,
            clearActiveGeneration: () => {
                activeGeneration = undefined;
            },
        });

        const initialization = (async () => {
            await reconcilePlaybackRequest({
                isCurrent: lifecycle.isCurrent,
                readRequest: () => ({ request: 1, shouldPlay: true }),
                apply: play,
            });
            if (!lifecycle.isCurrent()) {
                await close();
                return;
            }
            installed = true;
        })();
        expect(play).toHaveBeenCalledOnce();

        expect(lifecycle.terminate("Playback completed")).toBe(true);
        expect(lifecycle.terminate("Playback completed twice")).toBe(false);
        expect(controller.signal.aborted).toBe(true);
        expect(currentGeneration).toBe(2);
        expect(activeGeneration).toBeUndefined();

        releasePlay();
        await initialization;

        expect(installed).toBe(false);
        expect(close).toHaveBeenCalledOnce();
    });

    it("settles a newer playback request without spinning", async () => {
        let request = 0;
        let shouldPlay = true;
        const applied: boolean[] = [];

        await expect(
            reconcilePlaybackRequest({
                isCurrent: () => true,
                readRequest: () => ({ request, shouldPlay }),
                apply: async (next) => {
                    applied.push(next);
                    if (applied.length === 1) {
                        request += 1;
                        shouldPlay = false;
                    }
                },
                sleep: () => {},
            })
        ).resolves.toBe(true);
        expect(applied).toEqual([true, false]);
    });

    it("contains progress failures so later chunks can recover", async () => {
        const failure = new Error("decoder unavailable");
        const onFailure = vi.fn(() => {
            throw new Error("UI reporter also failed");
        });
        const onProcessed = vi.fn();
        const onDeferred = vi.fn();

        await expect(
            runProgressCallback({
                isCurrent: () => true,
                process: async () => {
                    throw failure;
                },
                onFailure,
                onProcessed,
                onDeferred,
            })
        ).resolves.toBe("failed");
        expect(onFailure).toHaveBeenCalledWith(failure);

        await expect(
            runProgressCallback({
                isCurrent: () => true,
                process: async () => false,
                onFailure,
                onProcessed,
                onDeferred,
            })
        ).resolves.toBe("deferred");
        expect(onDeferred).toHaveBeenCalledOnce();

        await expect(
            runProgressCallback({
                isCurrent: () => true,
                process: async () => true,
                onFailure,
                onProcessed,
                onDeferred,
            })
        ).resolves.toBe("processed");
        expect(onProcessed).toHaveBeenCalledOnce();
    });
});
