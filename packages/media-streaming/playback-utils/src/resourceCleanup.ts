export type RetryableCloseResource = {
    close: () => void | Promise<void>;
};

export type DurableCleanupOwner = object;

export type CleanupErrorReporter = (error: unknown) => void | Promise<void>;

const DEFAULT_CLOSE_ATTEMPT_TIMEOUT_MS = 5_000;

const normalizeCloseAttemptTimeout = (timeout: number | undefined) =>
    typeof timeout === "number" && Number.isFinite(timeout)
        ? Math.max(1, Math.floor(timeout))
        : DEFAULT_CLOSE_ATTEMPT_TIMEOUT_MS;

const reportCleanupError = (
    onError: CleanupErrorReporter | undefined,
    error: unknown
) => {
    try {
        // A void callback may still be implemented by an async function. The
        // reporter is intentionally detached, but its rejection must be
        // observed so reporting cannot create an unhandled rejection.
        void Promise.resolve(onError?.(error)).catch(() => {});
    } catch {
        // Cleanup ownership must not be lost because an error reporter itself
        // failed synchronously.
    }
};

const waitForCloseAttempts = (attempts: Promise<void>[], timeoutMs: number) => {
    if (attempts.length === 0) {
        return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        (
            timer as ReturnType<typeof setTimeout> & {
                unref?: () => void;
            }
        ).unref?.();
        void Promise.allSettled(attempts).then(finish);
    });
};

export const createDurableCleanupRegistry = (options?: {
    closeAttemptTimeoutMs?: number;
}) => {
    type Entry = {
        resource: RetryableCloseResource;
        reporters: Map<DurableCleanupOwner, CleanupErrorReporter>;
        attempt?: Promise<void>;
    };

    const entries = new Map<RetryableCloseResource, Entry>();
    const defaultCloseAttemptTimeoutMs = normalizeCloseAttemptTimeout(
        options?.closeAttemptTimeoutMs
    );

    const report = (entry: Entry, error: unknown) => {
        for (const onError of entry.reporters.values()) {
            reportCleanupError(onError, error);
        }
    };

    const adopt = (
        resources: Iterable<RetryableCloseResource>,
        options: {
            owner: DurableCleanupOwner;
            onError?: CleanupErrorReporter;
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

    const retry = (
        owner?: DurableCleanupOwner,
        retryOptions?: {
            resources?: Iterable<RetryableCloseResource>;
            closeAttemptTimeoutMs?: number;
        }
    ) => {
        const resources = retryOptions?.resources
            ? new Set(retryOptions.resources)
            : undefined;
        const candidates = [...entries.values()].filter(
            (entry) =>
                (!owner || entry.reporters.has(owner)) &&
                (!resources || resources.has(entry.resource))
        );
        const attempts = candidates.map((entry) => {
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
            // Publish the exact attempt before close() runs. Reentrant and
            // concurrent retries observe this promise instead of calling the
            // same resource twice.
            entry.attempt = attempt;
            return attempt;
        });
        return waitForCloseAttempts(
            attempts,
            normalizeCloseAttemptTimeout(
                retryOptions?.closeAttemptTimeoutMs ??
                    defaultCloseAttemptTimeoutMs
            )
        );
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
        onError?: CleanupErrorReporter;
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
    onError?: CleanupErrorReporter;
    closeAttemptTimeoutMs?: number;
    autoRetry?: {
        initialDelayMs?: number;
        maxDelayMs?: number;
        backoffFactor?: number;
        maxAttempts?: number;
    };
    durableOwner?: DurableCleanupOwner;
    durableRegistry?: DurableCleanupRegistry;
}) => {
    const registry = options?.durableRegistry ?? durableCleanupRegistry;
    const durableOwner = options?.durableOwner ?? {};
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const closeAttemptTimeoutMs =
        options?.closeAttemptTimeoutMs == null
            ? undefined
            : normalizeCloseAttemptTimeout(options.closeAttemptTimeoutMs);
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

    const resetAutomaticRetryBudget = () => {
        if (retryTimer != null) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
        }
        nextRetryDelay = initialRetryDelay;
        automaticRetryAttempts = 0;
    };

    const scheduleRetry = () => {
        if (registry.pendingCount(durableOwner) === 0 || retryTimer != null) {
            return;
        }
        if (
            !options?.autoRetry ||
            automaticRetryAttempts >= maximumAutomaticRetryAttempts
        ) {
            // The registry already retains the exact resource without a timer.
            // Later lifecycle, online, or visibility events retry it.
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
            void enqueueInternal([], false);
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
        explicitLifecycleAction: boolean
    ) => {
        if (explicitLifecycleAction) {
            // A later seek, replacement, or unmount can retry retained debt,
            // but automatic retries never replenish their own finite budget.
            resetAutomaticRetryBudget();
        }
        const resourcesToEnqueue = [...resources];
        registry.adopt(resourcesToEnqueue, {
            owner: durableOwner,
            onError: options?.onError,
        });

        return (async () => {
            if (explicitLifecycleAction) {
                // Any later cleanup activity is a useful quiet wake-up for
                // debt left behind by an already-unmounted owner. Start this
                // before the scoped barrier so exact attempts are shared.
                void registry.retry(undefined, {
                    closeAttemptTimeoutMs,
                });
            }

            // Enqueue waits only for the resources supplied by this caller.
            // That lets A.close() await enqueue(B) without the nested call also
            // waiting for A. retry() uses an owner-wide bounded barrier.
            await registry.retry(durableOwner, {
                resources:
                    resourcesToEnqueue.length > 0
                        ? resourcesToEnqueue
                        : undefined,
                closeAttemptTimeoutMs,
            });

            if (registry.pendingCount(durableOwner) === 0) {
                resetAutomaticRetryBudget();
            } else {
                scheduleRetry();
            }
        })();
    };

    const enqueue = (resources: Iterable<T>) =>
        enqueueInternal(resources, true);

    return {
        enqueue,
        retry: () => enqueueInternal([], true),
        pendingCount: () => registry.pendingCount(durableOwner),
        has: (resource: T) => registry.has(resource),
    };
};
