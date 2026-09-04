import { setTimeout as delay } from "node:timers/promises";

/** @internal */
export type MountReadinessWaitOptions = {
    timeout: number;
    signal: AbortSignal;
};

/** @internal */
export type MountReadinessLifecycleOptions = {
    readableFirst: boolean;
    timeoutMs: number;
    isWriteReady: () => boolean;
    awaitWriteReady: (options: MountReadinessWaitOptions) => Promise<void>;
    awaitReadable?: (options: MountReadinessWaitOptions) => Promise<void>;
    mount: () => Promise<void>;
    waitForShutdown: (signal: AbortSignal) => Promise<void>;
    cleanup: () => Promise<void>;
    onMounted?: (writeReady: boolean) => void;
    onWritePending?: () => void;
    onWriteReady?: () => void;
};

type LifecycleOutcome =
    | { source: "readable" | "ready" | "shutdown"; ok: true }
    | {
          source: "readable" | "ready" | "shutdown";
          ok: false;
          error: unknown;
      };

const codedError = (code: "EINVAL" | "ETIMEDOUT", message: string) =>
    Object.assign(new Error(message), { code });

type ReadableMountStatus = {
    phase: string;
    writeReady?: boolean;
    lastFailure?: string;
    legacyPromotionEligible?: boolean;
};

const readableViewAvailable = (status: ReadableMountStatus) => {
    if (status.phase === "fetching") {
        return false;
    }
    if (status.phase !== "off") {
        return true;
    }
    // `off` is initially undecided; these fields prove a settled off posture.
    return (
        status.writeReady === true ||
        status.legacyPromotionEligible === true ||
        status.lastFailure !== undefined
    );
};

/** @internal Wait until bootstrap installs a readable overlay or falls back. */
export const waitForReadableMountView = async (
    status: () => ReadableMountStatus,
    options: MountReadinessWaitOptions
) => {
    if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
        throw codedError(
            "EINVAL",
            "readable-first mount timeout must be a positive finite number"
        );
    }
    const deadline = Date.now() + options.timeout;
    while (!readableViewAvailable(status())) {
        if (options.signal.aborted) {
            throw (
                options.signal.reason ??
                new Error("readable-first bootstrap wait was aborted")
            );
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw codedError(
                "ETIMEDOUT",
                "timed out waiting for a readable initial filesystem view"
            );
        }
        try {
            await delay(Math.min(25, remaining), undefined, {
                signal: options.signal,
            });
        } catch (error) {
            if (options.signal.aborted) {
                throw options.signal.reason ?? error;
            }
            throw error;
        }
    }
};

/** @internal Own one CLI mount's readiness, shutdown, and cleanup. */
export const runMountReadinessLifecycle = async (
    options: MountReadinessLifecycleOptions
) => {
    const deadline = Date.now() + options.timeoutMs;
    const readinessAbort = new AbortController();
    const shutdownAbort = new AbortController();
    let readableOutcome: Promise<LifecycleOutcome> | undefined;
    let readinessOutcome: Promise<LifecycleOutcome> | undefined;
    let shutdownOutcome: Promise<LifecycleOutcome> | undefined;
    let shutdownSettled = false;
    let shutdownFailed = false;
    let shutdownFailure: unknown;
    let failure: unknown;

    const remainingTimeout = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw codedError(
                "ETIMEDOUT",
                "timed out awaiting shared filesystem write readiness"
            );
        }
        return remaining;
    };

    const startReadinessWait = () =>
        (readinessOutcome ??= Promise.resolve()
            .then(() =>
                options.awaitWriteReady({
                    timeout: options.readableFirst
                        ? remainingTimeout()
                        : options.timeoutMs,
                    signal: readinessAbort.signal,
                })
            )
            .then(
                (): LifecycleOutcome => ({ source: "ready", ok: true }),
                (error): LifecycleOutcome => ({
                    source: "ready",
                    ok: false,
                    error,
                })
            ));

    const startReadableWait = () =>
        (readableOutcome ??= Promise.resolve()
            .then(() =>
                options.awaitReadable?.({
                    timeout: remainingTimeout(),
                    signal: readinessAbort.signal,
                })
            )
            .then(
                (): LifecycleOutcome => ({ source: "readable", ok: true }),
                (error): LifecycleOutcome => ({
                    source: "readable",
                    ok: false,
                    error,
                })
            ));

    const startShutdownWait = () =>
        (shutdownOutcome ??= Promise.resolve()
            .then(() => options.waitForShutdown(shutdownAbort.signal))
            .then(
                (): LifecycleOutcome => {
                    shutdownSettled = true;
                    readinessAbort.abort(
                        new Error("mount shutdown was requested")
                    );
                    return { source: "shutdown", ok: true };
                },
                (error): LifecycleOutcome => {
                    shutdownSettled = true;
                    shutdownFailed = true;
                    shutdownFailure = error;
                    readinessAbort.abort(error);
                    return {
                        source: "shutdown",
                        ok: false,
                        error,
                    };
                }
            ));

    const requireSuccess = async (outcome: Promise<LifecycleOutcome>) => {
        const result = await outcome;
        if (!result.ok) {
            throw result.error;
        }
        return result.source;
    };

    try {
        if (!options.readableFirst) {
            await requireSuccess(startReadinessWait());
            await options.mount();
            options.onMounted?.(true);
            await requireSuccess(startShutdownWait());
        } else {
            if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
                throw codedError(
                    "EINVAL",
                    "readable-first mount timeout must be a positive finite number"
                );
            }
            const shutdown = startShutdownWait();
            let continueLifecycle = true;
            const initial = await Promise.race([startReadableWait(), shutdown]);
            if (!initial.ok) {
                if (
                    initial.source === "readable" &&
                    shutdownSettled &&
                    !shutdownFailed
                ) {
                    continueLifecycle = false;
                } else {
                    throw initial.error;
                }
            } else if (initial.source === "shutdown") {
                continueLifecycle = false;
            }

            if (continueLifecycle && !shutdownSettled) {
                // Startup may be unabortable: join it, then honor shutdown.
                await options.mount();
                if (shutdownSettled) {
                    if (shutdownFailed) {
                        throw shutdownFailure;
                    }
                    continueLifecycle = false;
                }
            }

            if (continueLifecycle) {
                // The one deadline includes adapter startup.
                remainingTimeout();
                const readyAtMount = options.isWriteReady();
                options.onMounted?.(readyAtMount);
                if (readyAtMount) {
                    await requireSuccess(shutdown);
                } else {
                    options.onWritePending?.();
                    const first = await Promise.race([
                        startReadinessWait(),
                        shutdown,
                    ]);
                    if (!first.ok) {
                        if (
                            !(
                                first.source === "ready" &&
                                shutdownSettled &&
                                !shutdownFailed
                            )
                        ) {
                            throw first.error;
                        }
                    } else if (first.source === "ready" && !shutdownSettled) {
                        options.onWriteReady?.();
                        await requireSuccess(shutdown);
                    }
                }
            }
        }
    } catch (error) {
        failure = error;
    }

    // Join caught background outcomes before releasing their owners.
    shutdownAbort.abort();
    readinessAbort.abort(
        new Error("mount shut down before write readiness completed")
    );
    if (readableOutcome) await readableOutcome;
    if (readinessOutcome) await readinessOutcome;
    if (shutdownOutcome) await shutdownOutcome;
    try {
        await options.cleanup();
    } catch (cleanupError) {
        if (failure === undefined) {
            failure = cleanupError;
        } else {
            failure = new AggregateError(
                [failure, cleanupError],
                "Mount failed and cleanup did not complete"
            );
        }
    }

    if (failure !== undefined) {
        throw failure;
    }
};
