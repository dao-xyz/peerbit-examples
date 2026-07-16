import { createDurableCleanupRegistry } from "@peerbit/media-streaming-web";
import PQueue from "p-queue";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createGenerationTaskRegistry,
    createViewerPlaybackCleanup,
    createViewerPlaybackCoordinator,
    retireOpenedPlaybackForGeneration,
} from "./viewerPlaybackCleanup";

afterEach(() => {
    vi.useRealTimers();
});

describe("viewer playback cleanup", () => {
    it("bounds a never-settling playback-control close without duplicating it", async () => {
        vi.useFakeTimers();
        const control = {
            track: { idString: "audio" },
            close: vi.fn(() => new Promise<void>(() => {})),
        };
        const readyControl = {
            track: { idString: "video" },
            close: vi.fn().mockResolvedValue(undefined),
        };
        const cleanup = createViewerPlaybackCleanup<
            typeof control | typeof readyControl
        >({
            durableOwner: {},
            durableRegistry: createDurableCleanupRegistry({
                closeAttemptTimeoutMs: 10,
            }),
            closeAttemptTimeoutMs: 10,
        });

        const retirement = cleanup.retire([control]);
        await vi.advanceTimersByTimeAsync(10);

        await expect(retirement).resolves.toEqual([control]);
        await expect(cleanup.retire([readyControl])).resolves.toEqual([]);
        expect(readyControl.close).toHaveBeenCalledOnce();

        const retry = cleanup.retry();
        await vi.advanceTimersByTimeAsync(10);
        await expect(retry).resolves.toBe(1);
        expect(control.close).toHaveBeenCalledOnce();
    });

    it("bounds a never-settling iterator close and retains its exact handle", async () => {
        vi.useFakeTimers();
        const iterator = {
            paused: false,
            close: vi.fn(() => new Promise<void>(() => {})),
        };
        const cleanup = createViewerPlaybackCleanup<typeof iterator>({
            durableOwner: {},
            durableRegistry: createDurableCleanupRegistry({
                closeAttemptTimeoutMs: 10,
            }),
            closeAttemptTimeoutMs: 10,
        });

        const retirement = cleanup.retire([iterator]);
        await vi.advanceTimersByTimeAsync(10);
        await expect(retirement).resolves.toEqual([iterator]);

        const overlappingRetirement = cleanup.retire([iterator]);
        await vi.advanceTimersByTimeAsync(10);
        await expect(overlappingRetirement).resolves.toEqual([iterator]);
        expect(iterator.close).toHaveBeenCalledOnce();
        expect(cleanup.pendingCount()).toBe(1);
    });
});

describe("viewer playback coordinator", () => {
    it("isolates a new viewer from an old viewer's hung durable debt", async () => {
        vi.useFakeTimers();
        const registry = createDurableCleanupRegistry({
            closeAttemptTimeoutMs: 10,
        });
        const hung = {
            close: vi.fn(() => new Promise<void>(() => {})),
        };
        const oldViewer = createViewerPlaybackCoordinator<typeof hung>({
            durableRegistry: registry,
            closeAttemptTimeoutMs: 10,
        });
        oldViewer.register(hung);

        const oldRetirement = oldViewer.retireAll();
        await vi.advanceTimersByTimeAsync(10);
        await expect(oldRetirement).resolves.toBe(1);
        expect(oldViewer.pendingCount()).toBe(1);
        expect(registry.pendingCount()).toBe(1);

        const ready = { close: vi.fn().mockResolvedValue(undefined) };
        const newViewer = createViewerPlaybackCoordinator<typeof ready>({
            durableRegistry: registry,
            closeAttemptTimeoutMs: 10,
        });
        await expect(newViewer.retry()).resolves.toBe(0);
        newViewer.register(ready);
        await expect(newViewer.retireAll()).resolves.toBe(0);

        expect(ready.close).toHaveBeenCalledOnce();
        expect(hung.close).toHaveBeenCalledOnce();
        expect(newViewer.pendingCount()).toBe(0);
        expect(registry.pendingCount()).toBe(1);

        // Finish detached global wake barriers before restoring real timers.
        await vi.advanceTimersByTimeAsync(10);
    });

    it("retires a discovered candidate outside a queue stuck in play", async () => {
        vi.useFakeTimers();
        const registry = createDurableCleanupRegistry({
            closeAttemptTimeoutMs: 10,
        });
        const candidate = {
            play: vi.fn(() => new Promise<void>(() => {})),
            close: vi.fn(() => new Promise<void>(() => {})),
        };
        const coordinator = createViewerPlaybackCoordinator<typeof candidate>({
            durableRegistry: registry,
            closeAttemptTimeoutMs: 10,
        });
        const queue = new PQueue({ concurrency: 1 });
        let queuedTransitionSettled = false;
        const queuedTransition = queue.add(async () => {
            // This is the construction boundary used by View: publish before
            // awaiting the initial playback reconciliation.
            coordinator.register(candidate);
            await candidate.play();
        });
        void queuedTransition.finally(() => {
            queuedTransitionSettled = true;
        });
        await Promise.resolve();
        expect(coordinator.ownedCount()).toBe(1);

        // Unmount cleanup is deliberately not enqueued behind queuedTransition.
        const unmountCleanup = coordinator.retireAll();
        await vi.advanceTimersByTimeAsync(10);
        await expect(unmountCleanup).resolves.toBe(1);

        expect(candidate.close).toHaveBeenCalledOnce();
        expect(coordinator.ownedCount()).toBe(0);
        expect(coordinator.pendingCount()).toBe(1);
        expect(registry.pendingCount()).toBe(1);
        expect(queuedTransitionSettled).toBe(false);
        expect(queue.pending).toBe(1);
    });

    it("tombstones an unmounted candidate before a stale creation resumes", async () => {
        let resolvePlay!: () => void;
        const play = new Promise<void>((resolve) => {
            resolvePlay = resolve;
        });
        const candidate = {
            play: vi.fn(() => play),
            close: vi.fn().mockResolvedValue(undefined),
        };
        const coordinator = createViewerPlaybackCoordinator<typeof candidate>();
        const creation = (async () => {
            coordinator.register(candidate);
            await candidate.play();
            if (!coordinator.isOwned(candidate)) {
                await coordinator.retire([candidate]);
                return undefined;
            }
            return candidate;
        })();
        await Promise.resolve();

        await expect(coordinator.retireAll()).resolves.toBe(0);
        const replacement = {
            play: vi.fn().mockResolvedValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
        };
        coordinator.register(replacement);
        resolvePlay();
        await expect(creation).resolves.toBeUndefined();

        expect(candidate.close).toHaveBeenCalledOnce();
        expect(coordinator.isOwned(candidate)).toBe(false);
        expect(coordinator.isOwned(replacement)).toBe(true);
        expect(replacement.close).not.toHaveBeenCalled();

        await expect(coordinator.retireAll()).resolves.toBe(0);
        expect(replacement.close).toHaveBeenCalledOnce();
    });
});

describe("viewer generation wiring", () => {
    it("ignores a late stale iterate rejection after replacement resources publish", async () => {
        const replacement = {
            close: vi.fn().mockResolvedValue(undefined),
        };
        const coordinator =
            createViewerPlaybackCoordinator<typeof replacement>();
        coordinator.register(replacement);
        const retireExact = vi.fn(async (resource: typeof replacement) => {
            await coordinator.retire([resource]);
        });
        const retireCurrentGeneration = vi.fn(async () => {
            await coordinator.retireAll();
        });
        let rejectOldIterate!: (error: unknown) => void;
        const oldIterate = new Promise<typeof replacement>(
            (_resolve, reject) => {
                rejectOldIterate = reject;
            }
        );
        const oldContinuation = (async () => {
            let oldIterator: typeof replacement | undefined;
            try {
                oldIterator = await oldIterate;
            } catch {
                await retireOpenedPlaybackForGeneration({
                    isCurrent: () => false,
                    resource: oldIterator,
                    retireExact,
                    retireCurrentGeneration,
                });
            }
        })();

        rejectOldIterate(new Error("old iterate failed"));
        await oldContinuation;

        expect(retireExact).not.toHaveBeenCalled();
        expect(retireCurrentGeneration).not.toHaveBeenCalled();
        expect(coordinator.isOwned(replacement)).toBe(true);
        expect(replacement.close).not.toHaveBeenCalled();

        await coordinator.retireAll();
    });

    it("lets a new generation create the same track while old play is hung", async () => {
        let resolveOldPlay!: () => void;
        const oldPlay = new Promise<void>((resolve) => {
            resolveOldPlay = resolve;
        });
        let oldSettled = false;
        const oldCreation = (async () => {
            await oldPlay;
            oldSettled = true;
            return "old";
        })();
        const creations = createGenerationTaskRegistry<
            string,
            Promise<string>
        >();
        creations.set("same-track", oldCreation);
        void oldCreation.finally(() => {
            creations.deleteIfCurrent("same-track", oldCreation);
        });

        creations.beginGeneration();
        let replacementCreation = creations.get("same-track");
        if (!replacementCreation) {
            replacementCreation = Promise.resolve("replacement");
            creations.set("same-track", replacementCreation);
        }

        await expect(replacementCreation).resolves.toBe("replacement");
        expect(oldSettled).toBe(false);
        expect(creations.get("same-track")).toBe(replacementCreation);

        resolveOldPlay();
        await oldCreation;
        await Promise.resolve();
        expect(creations.get("same-track")).toBe(replacementCreation);
    });
});
