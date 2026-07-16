export type RetryableCloseResource = {
    close: () => void | Promise<void>;
};

export type DurableCleanupOwner = object;

export const createDurableCleanupRegistry = () => {
    type Entry = {
        resource: RetryableCloseResource;
        reporters: Map<DurableCleanupOwner, (error: unknown) => void>;
        attempt?: Promise<void>;
    };

    const entries = new Map<RetryableCloseResource, Entry>();

    const report = (entry: Entry, error: unknown) => {
        for (const onError of entry.reporters.values()) {
            try {
                onError(error);
            } catch {
                // A reporter cannot make durable cleanup lose ownership.
            }
        }
    };

    const adopt = (
        resources: Iterable<RetryableCloseResource>,
        options: {
            owner: DurableCleanupOwner;
            onError?: (error: unknown) => void;
        }
    ) => {
        for (const resource of resources) {
            let entry = entries.get(resource);
            if (!entry) {
                entry = { resource, reporters: new Map() };
                entries.set(resource, entry);
            }
            if (options.onError) {
                entry.reporters.set(options.owner, options.onError);
            } else if (!entry.reporters.has(options.owner)) {
                entry.reporters.set(options.owner, () => {});
            }
        }
    };

    const retry = (owner?: DurableCleanupOwner) => {
        const candidates = [...entries.values()].filter(
            (entry) => !owner || entry.reporters.has(owner)
        );
        return Promise.allSettled(
            candidates.map((entry) => {
                if (entry.attempt) {
                    return entry.attempt;
                }
                const attempt = Promise.resolve()
                    .then(() => entry.resource.close())
                    .then(() => {
                        if (entries.get(entry.resource) === entry) {
                            entries.delete(entry.resource);
                        }
                    })
                    .catch((error) => report(entry, error))
                    .finally(() => {
                        if (entry.attempt === attempt) {
                            entry.attempt = undefined;
                        }
                    });
                entry.attempt = attempt;
                return attempt;
            })
        ).then(() => {});
    };

    return {
        adopt,
        retry,
        has: (resource: RetryableCloseResource) => entries.has(resource),
        pendingCount: (owner?: DurableCleanupOwner) =>
            owner
                ? [...entries.values()].filter((entry) =>
                      entry.reporters.has(owner)
                  ).length
                : entries.size,
    };
};

export type DurableCleanupRegistry = ReturnType<
    typeof createDurableCleanupRegistry
>;

const durableCleanupRegistry = createDurableCleanupRegistry();

export const adoptDurableCleanup = (
    resources: Iterable<RetryableCloseResource>,
    options: {
        owner: DurableCleanupOwner;
        onError?: (error: unknown) => void;
    }
) => durableCleanupRegistry.adopt(resources, options);

export const retryDurableCleanup = (owner?: DurableCleanupOwner) =>
    durableCleanupRegistry.retry(owner);

export const durableCleanupPendingCount = (owner?: DurableCleanupOwner) =>
    durableCleanupRegistry.pendingCount(owner);

const retryDurableCleanupWhenUseful = () => {
    if (durableCleanupRegistry.pendingCount() > 0) {
        void durableCleanupRegistry.retry();
    }
};

if (typeof window !== "undefined") {
    window.addEventListener("online", retryDurableCleanupWhenUseful);
}
if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            retryDurableCleanupWhenUseful();
        }
    });
}

export const createRetryableResourceDrain = <
    T extends RetryableCloseResource,
>(options?: {
    onError?: (error: unknown) => void;
    autoRetry?: {
        initialDelayMs?: number;
        maxDelayMs?: number;
        backoffFactor?: number;
        maxAttempts?: number;
    };
    durableOwner?: DurableCleanupOwner;
    durableRegistry?: DurableCleanupRegistry;
}) => {
    const pending = new Set<T>();
    const registry = options?.durableRegistry ?? durableCleanupRegistry;
    const durableOwner = options?.durableOwner ?? {};
    let drain: Promise<void> = Promise.resolve();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const initialRetryDelay = Math.max(
        1,
        options?.autoRetry?.initialDelayMs ?? 100
    );
    const maximumRetryDelay = Math.max(
        initialRetryDelay,
        options?.autoRetry?.maxDelayMs ?? 5_000
    );
    const retryBackoffFactor = Math.max(
        1,
        options?.autoRetry?.backoffFactor ?? 2
    );
    const maximumAutomaticRetryAttempts = Math.max(
        0,
        Math.floor(options?.autoRetry?.maxAttempts ?? 8)
    );
    let nextRetryDelay = initialRetryDelay;
    let automaticRetryAttempts = 0;

    const report = (error: unknown) => {
        try {
            options?.onError?.(error);
        } catch {
            // Cleanup ownership must not be lost because an error reporter
            // itself failed.
        }
    };

    const resetAutomaticRetryBudget = () => {
        if (retryTimer != null) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
        }
        nextRetryDelay = initialRetryDelay;
        automaticRetryAttempts = 0;
    };

    const adoptPendingCleanup = () => {
        if (pending.size === 0) {
            return;
        }
        registry.adopt(pending, {
            owner: durableOwner,
            onError: options?.onError,
        });
        pending.clear();
    };

    const scheduleRetry = () => {
        if (pending.size === 0 || retryTimer != null) {
            return;
        }
        if (
            !options?.autoRetry ||
            automaticRetryAttempts >= maximumAutomaticRetryAttempts
        ) {
            // The module-level registry retains the exact resource without a
            // timer. Later lifecycle, online, or visibility events retry it.
            adoptPendingCleanup();
            return;
        }
        const delay = nextRetryDelay;
        automaticRetryAttempts += 1;
        nextRetryDelay = Math.min(
            maximumRetryDelay,
            Math.max(initialRetryDelay, delay * retryBackoffFactor)
        );
        retryTimer = setTimeout(() => {
            retryTimer = undefined;
            void enqueueInternal([], false, false);
        }, delay);
        // Do not keep a Node.js process alive solely for browser-oriented
        // cleanup debt. Browsers return a numeric timer without `unref`.
        (
            retryTimer as ReturnType<typeof setTimeout> & {
                unref?: () => void;
            }
        ).unref?.();
    };

    const enqueueInternal = (
        resources: Iterable<T>,
        explicitLifecycleAction: boolean,
        awaitDurableRetry: boolean
    ) => {
        if (explicitLifecycleAction) {
            // A later seek, replacement, or unmount can retry retained debt,
            // but automatic retries never replenish their own finite budget.
            resetAutomaticRetryBudget();
        }
        const resourcesToEnqueue = [...resources];
        let includesAdoptedResource = false;
        for (const resource of resourcesToEnqueue) {
            if (registry.has(resource)) {
                includesAdoptedResource = true;
                registry.adopt([resource], {
                    owner: durableOwner,
                    onError: options?.onError,
                });
            } else {
                pending.add(resource);
            }
        }
        const previousDrain = drain;
        drain = previousDrain
            .catch(report)
            .then(async () => {
                let durableRetry: Promise<void> | undefined;
                if (explicitLifecycleAction) {
                    // Any later cleanup activity is a useful quiet wake-up for
                    // debt left behind by an already-unmounted owner.
                    void registry.retry();
                    durableRetry = registry.retry(durableOwner);
                }
                const resourcesToClose = [...pending];
                const results = await Promise.allSettled(
                    resourcesToClose.map((resource) =>
                        Promise.resolve().then(() => resource.close())
                    )
                );
                for (let i = 0; i < results.length; i++) {
                    const result = results[i];
                    if (result.status === "fulfilled") {
                        pending.delete(resourcesToClose[i]);
                    } else {
                        // Leave the resource in the set. A later generation or
                        // unmount drain will retry only the failed close.
                        report(result.reason);
                    }
                }
                if (pending.size === 0) {
                    resetAutomaticRetryBudget();
                } else {
                    scheduleRetry();
                }
                if (
                    durableRetry &&
                    (awaitDurableRetry || includesAdoptedResource)
                ) {
                    await durableRetry;
                }
            })
            .catch(report);
        return drain;
    };

    const enqueue = (resources: Iterable<T>) =>
        enqueueInternal(resources, true, false);

    return {
        enqueue,
        retry: () => enqueueInternal([], true, true),
        pendingCount: () => pending.size + registry.pendingCount(durableOwner),
        has: (resource: T) => pending.has(resource) || registry.has(resource),
    };
};
