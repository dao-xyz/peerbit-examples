import {
    createRetryableResourceDrain,
    type CleanupErrorReporter,
    type DurableCleanupOwner,
    type DurableCleanupRegistry,
    type RetryableCloseResource,
} from "@peerbit/media-streaming-web";

export type ViewerPlaybackCleanupOptions = {
    durableOwner: DurableCleanupOwner;
    durableRegistry?: DurableCleanupRegistry;
    onError?: CleanupErrorReporter;
    closeAttemptTimeoutMs?: number;
    autoRetry?: {
        initialDelayMs?: number;
        maxDelayMs?: number;
        backoffFactor?: number;
        maxAttempts?: number;
    };
};

/**
 * Retires viewer-owned resources through the durable cleanup registry.
 *
 * `retire` has a bounded wait even when a resource's `close()` promise never
 * settles. Its return value is the exact subset still owned by the registry,
 * allowing the caller to surface cleanup debt without pinning its work queue.
 */
export const createViewerPlaybackCleanup = <T extends RetryableCloseResource>(
    options: ViewerPlaybackCleanupOptions
) => {
    const drain = createRetryableResourceDrain<T>({
        durableOwner: options.durableOwner,
        durableRegistry: options.durableRegistry,
        onError: options.onError,
        closeAttemptTimeoutMs: options.closeAttemptTimeoutMs,
        autoRetry: options.autoRetry,
    });

    const retire = async (resources: Iterable<T>) => {
        const exactResources = [...new Set(resources)];
        if (exactResources.length === 0) {
            return [];
        }

        await drain.enqueue(exactResources);
        return exactResources.filter((resource) => drain.has(resource));
    };

    const retry = async () => {
        await drain.retry();
        return drain.pendingCount();
    };

    return {
        retire,
        retry,
        has: drain.has,
        pendingCount: drain.pendingCount,
    };
};

/**
 * Owns every resource constructed by one mounted viewer, including candidates
 * that have not completed their first play/pause reconciliation yet.
 *
 * Retirement marks handles synchronously before starting bounded cleanup. A
 * stale creation continuation can therefore ask to retire the same candidate
 * again without issuing a second close after the first attempt has completed.
 */
export const createViewerPlaybackCoordinator = <
    T extends RetryableCloseResource,
>(
    options: Omit<ViewerPlaybackCleanupOptions, "durableOwner"> & {
        durableOwner?: DurableCleanupOwner;
    } = {}
) => {
    // Deliberately unique by default: debt from an unmounted viewer remains in
    // the global durable registry, but cannot become a fatal startup barrier
    // for a different mount.
    const cleanup = createViewerPlaybackCleanup<T>({
        ...options,
        durableOwner: options.durableOwner ?? {},
    });
    const owned = new Set<T>();
    // Keep a weak mount-scoped tombstone so late async continuations cannot
    // close a successfully retired candidate twice without retaining every
    // completed seek's resources for the lifetime of the mount. Genuinely
    // pending debt remains strongly owned by the durable registry itself.
    const retired = new WeakSet<T>();

    const register = (resource: T) => {
        if (retired.has(resource)) {
            return false;
        }
        owned.add(resource);
        return true;
    };

    const detach = (resources: Iterable<T>) => {
        const detached: T[] = [];
        for (const resource of new Set(resources)) {
            owned.delete(resource);
            if (retired.has(resource)) {
                continue;
            }
            retired.add(resource);
            detached.push(resource);
        }
        return detached;
    };

    const detachAll = (additionalResources: Iterable<T> = []) =>
        detach([...owned, ...additionalResources]);

    const retireDetached = (resources: Iterable<T>) =>
        cleanup.retire(resources);

    const retire = (resources: Iterable<T>) =>
        retireDetached(detach(resources));

    const retireAll = async (additionalResources: Iterable<T> = []) => {
        const newlyDetached = detachAll(additionalResources);
        // retry() snapshots this viewer's prior durable debt synchronously;
        // retireDetached() then adopts newly-owned handles. Both exact barriers
        // are bounded, and the final count observes their combined outcome.
        await Promise.all([cleanup.retry(), retireDetached(newlyDetached)]);
        return cleanup.pendingCount();
    };

    return {
        register,
        isOwned: (resource: T) => owned.has(resource),
        ownedCount: () => owned.size,
        detach,
        detachAll,
        retireDetached,
        retire,
        retireAll,
        retry: cleanup.retry,
        hasPending: cleanup.has,
        pendingCount: cleanup.pendingCount,
    };
};

export const retireOpenedPlaybackForGeneration = <T>(options: {
    isCurrent: () => boolean;
    resource: T | undefined;
    retireExact: (resource: T) => void | Promise<void>;
    retireCurrentGeneration: (resource: T | undefined) => void | Promise<void>;
}) => {
    if (!options.isCurrent()) {
        // A stale iterate() may reject before yielding a handle. Replacement
        // resources can already be published on the new generation's queue,
        // so stale/no-handle cleanup must be a strict no-op.
        return options.resource
            ? Promise.resolve(options.retireExact(options.resource))
            : Promise.resolve();
    }
    return Promise.resolve(options.retireCurrentGeneration(options.resource));
};

export const createGenerationTaskRegistry = <Key, Task>() => {
    let tasks = new Map<Key, Task>();

    return {
        beginGeneration: () => {
            tasks = new Map<Key, Task>();
        },
        get: (key: Key) => tasks.get(key),
        set: (key: Key, task: Task) => tasks.set(key, task),
        deleteIfCurrent: (key: Key, task: Task) => {
            if (tasks.get(key) !== task) {
                return false;
            }
            return tasks.delete(key);
        },
        size: () => tasks.size,
    };
};
