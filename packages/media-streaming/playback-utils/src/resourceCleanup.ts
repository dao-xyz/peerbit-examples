export type RetryableCloseResource = {
    close: () => void | Promise<void>;
};

export const createRetryableResourceDrain = <
    T extends RetryableCloseResource,
>(options?: {
    onError?: (error: unknown) => void;
}) => {
    const pending = new Set<T>();
    let drain: Promise<void> = Promise.resolve();

    const report = (error: unknown) => {
        try {
            options?.onError?.(error);
        } catch {
            // Cleanup ownership must not be lost because an error reporter
            // itself failed.
        }
    };

    const enqueue = (resources: Iterable<T>) => {
        for (const resource of resources) {
            pending.add(resource);
        }
        const previousDrain = drain;
        drain = previousDrain
            .catch(report)
            .then(async () => {
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
            })
            .catch(report);
        return drain;
    };

    return {
        enqueue,
        retry: () => enqueue([]),
        pendingCount: () => pending.size,
    };
};
