export type PlaybackRequestSnapshot = {
    request: number;
    shouldPlay: boolean;
};

export const fencePlaybackGeneration = (options: {
    generation: number;
    controller: AbortController;
    currentGeneration: () => number;
    advanceGeneration: () => void;
    activeGeneration: () => number | undefined;
    clearActiveGeneration: () => void;
    reason: string;
}) => {
    if (options.currentGeneration() === options.generation) {
        options.advanceGeneration();
    }
    if (options.activeGeneration() === options.generation) {
        options.clearActiveGeneration();
    }
    options.controller.abort(options.reason);
};

export const createPlaybackGenerationLifecycle = (options: {
    generation: number;
    controller: AbortController;
    currentGeneration: () => number;
    advanceGeneration: () => void;
    activeGeneration: () => number | undefined;
    clearActiveGeneration: () => void;
}) => {
    let terminal = false;
    const isBaseCurrent = () =>
        !options.controller.signal.aborted &&
        options.currentGeneration() === options.generation &&
        options.activeGeneration() === options.generation;

    return {
        isCurrent: () => !terminal && isBaseCurrent(),
        terminate: (reason: string) => {
            const wasCurrent = !terminal && isBaseCurrent();
            if (!terminal) {
                terminal = true;
                fencePlaybackGeneration({ ...options, reason });
            }
            return wasCurrent;
        },
    };
};

export type BackoffOptions = {
    initialDelayMs: number;
    maximumDelayMs: number;
    factor: number;
};

export const boundedBackoffDelay = (
    attempt: number,
    options: BackoffOptions
) => {
    const initialDelay = Math.max(1, options.initialDelayMs);
    const maximumDelay = Math.max(initialDelay, options.maximumDelayMs);
    const factor = Math.max(1, options.factor);
    const exponent = Math.max(0, Math.floor(attempt));
    return Math.min(maximumDelay, initialDelay * factor ** exponent);
};

export const createBoundedRetryBudget = (
    options: BackoffOptions & { maximumAttempts: number }
) => {
    const maximumAttempts = Math.max(0, Math.floor(options.maximumAttempts));
    let attempt = 0;

    return {
        nextDelay: () => {
            if (attempt >= maximumAttempts) {
                return undefined;
            }
            const delay = boundedBackoffDelay(attempt, options);
            attempt += 1;
            return delay;
        },
        exhausted: () => attempt >= maximumAttempts,
        reset: () => {
            attempt = 0;
        },
    };
};

export const createKeyedRetryBackoff = <Key>(options?: {
    initialDelayMs?: number;
    maximumDelayMs?: number;
    factor?: number;
    now?: () => number;
}) => {
    const backoffOptions: BackoffOptions = {
        initialDelayMs: options?.initialDelayMs ?? 100,
        maximumDelayMs: options?.maximumDelayMs ?? 5_000,
        factor: options?.factor ?? 2,
    };
    const now = options?.now ?? Date.now;
    const failures = new Map<
        Key,
        { consecutiveFailures: number; retryAt: number }
    >();

    return {
        canAttempt: (key: Key) => {
            const failure = failures.get(key);
            return !failure || now() >= failure.retryAt;
        },
        recordFailure: (key: Key) => {
            const previousFailures =
                failures.get(key)?.consecutiveFailures ?? 0;
            const consecutiveFailures = Math.min(
                Number.MAX_SAFE_INTEGER,
                previousFailures + 1
            );
            const delayMs = boundedBackoffDelay(
                consecutiveFailures - 1,
                backoffOptions
            );
            failures.set(key, {
                consecutiveFailures,
                retryAt: now() + delayMs,
            });
            return delayMs;
        },
        recordSuccess: (key: Key) => {
            failures.delete(key);
        },
        clear: () => {
            failures.clear();
        },
    };
};

const wait = (delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs));

export const reconcilePlaybackRequest = async (options: {
    isCurrent: () => boolean;
    readRequest: () => PlaybackRequestSnapshot;
    apply: (shouldPlay: boolean) => void | Promise<void>;
    isApplied?: (shouldPlay: boolean) => boolean;
    maximumAttempts?: number;
    retryDelayMs?: number;
    sleep?: (delayMs: number) => void | Promise<void>;
    notAppliedMessage?: (shouldPlay: boolean) => string;
    unstableMessage?: string;
}) => {
    const maximumAttempts = Math.max(
        1,
        Math.floor(options.maximumAttempts ?? 4)
    );
    const retryDelayMs = Math.max(1, options.retryDelayMs ?? 16);
    const sleep = options.sleep ?? wait;

    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
        if (!options.isCurrent()) {
            return false;
        }
        const request = options.readRequest();
        if (!options.isApplied?.(request.shouldPlay)) {
            await options.apply(request.shouldPlay);
        }
        if (!options.isCurrent()) {
            return false;
        }

        const latestRequest = options.readRequest();
        if (
            request.request === latestRequest.request &&
            request.shouldPlay === latestRequest.shouldPlay
        ) {
            if (options.isApplied && !options.isApplied(request.shouldPlay)) {
                throw new Error(
                    options.notAppliedMessage?.(request.shouldPlay) ??
                        "The media resource did not apply the requested playback state"
                );
            }
            return true;
        }

        if (attempt + 1 < maximumAttempts) {
            await sleep(retryDelayMs);
        }
    }

    if (options.isCurrent()) {
        throw new Error(
            options.unstableMessage ??
                "The requested playback state did not settle"
        );
    }
    return false;
};

export type ProgressCallbackResult =
    | "processed"
    | "deferred"
    | "failed"
    | "stale";

export const runProgressCallback = async (options: {
    isCurrent: () => boolean;
    process: () => boolean | Promise<boolean>;
    onProcessed?: () => void | Promise<void>;
    onDeferred?: () => void | Promise<void>;
    onFailure: (error: unknown) => void | Promise<void>;
}): Promise<ProgressCallbackResult> => {
    if (!options.isCurrent()) {
        return "stale";
    }

    try {
        const processed = await options.process();
        if (!options.isCurrent()) {
            return "stale";
        }
        if (!processed) {
            await options.onDeferred?.();
            return "deferred";
        }
        await options.onProcessed?.();
        return "processed";
    } catch (error) {
        if (!options.isCurrent()) {
            return "stale";
        }
        try {
            await options.onFailure(error);
        } catch {
            // Streaming iterators await progress callbacks. Reporting failures
            // must not turn a recoverable media failure into iterator failure.
        }
        return "failed";
    }
};
