type ProcessError = unknown;

type InstallOptions = {
    /**
     * Default: "warn"
     * - "warn": console.warn expected transient errors (message only)
     * - "silent": fully suppress expected transient errors
     */
    mode?: "warn" | "silent";
    /**
     * Default: false. If true, include stack traces for expected errors.
     */
    includeStack?: boolean;
    /**
     * Default: true. If true, log unexpected errors and set exitCode=1.
     */
    failOnUnexpected?: boolean;
};

const getErrorName = (error: ProcessError): string | undefined => {
    const anyError = error as any;
    // Custom `class FooError extends Error {}` defaults to name="Error".
    // Prefer the constructor name unless the runtime explicitly set `name`.
    if (typeof anyError?.name === "string" && anyError.name !== "Error") {
        return anyError.name;
    }
    if (typeof anyError?.constructor?.name === "string") {
        return anyError.constructor.name;
    }
    return typeof anyError?.name === "string" ? anyError.name : undefined;
};

const getErrorMessage = (error: ProcessError): string => {
    if (typeof error === "string") return error;
    const anyError = error as any;
    if (typeof anyError?.message === "string") return anyError.message;
    return String(error);
};

const getErrorStack = (error: ProcessError): string | undefined => {
    const anyError = error as any;
    return typeof anyError?.stack === "string" ? anyError.stack : undefined;
};

export const isPeerbitTransientDisconnectError = (error: ProcessError) => {
    // Keep this intentionally broad: the main goal is "don't treat disconnect-time
    // send failures as fatal" for a long-running replicator process.
    const name = getErrorName(error);
    if (
        name === "AbortError" ||
        name === "TimeoutError" ||
        name === "DeliveryError" ||
        name === "NotStartedError" ||
        name === "ClosedError"
    ) {
        return true;
    }

    // If the runtime throws AggregateError (Promise.any / Promise.allSettled etc),
    // treat as transient only when *all* inner errors are transient.
    if (
        typeof AggregateError !== "undefined" &&
        error instanceof AggregateError &&
        Array.isArray((error as any).errors)
    ) {
        return (error as any).errors.every(isPeerbitTransientDisconnectError);
    }

    return false;
};

export const installProcessErrorFilter = (options?: InstallOptions) => {
    const mode = options?.mode ?? "warn";
    const includeStack = options?.includeStack ?? false;
    const failOnUnexpected = options?.failOnUnexpected ?? true;

    let expected = 0;
    let unexpected = 0;
    const unexpectedErrors: ProcessError[] = [];

    const onUnhandledRejection = (reason: ProcessError, promise?: unknown) => {
        if (isPeerbitTransientDisconnectError(reason)) {
            expected++;
            if (mode !== "silent") {
                const msg = getErrorMessage(reason);
                // eslint-disable-next-line no-console
                console.warn(msg);
                if (includeStack) {
                    const stack = getErrorStack(reason);
                    if (stack) console.warn(stack);
                }
            }
            return;
        }

        unexpected++;
        unexpectedErrors.push(reason);
        // eslint-disable-next-line no-console
        console.error("[unhandledRejection]", reason);
        if (failOnUnexpected) process.exitCode = 1;
    };

    const onUncaughtException = (err: ProcessError) => {
        if (isPeerbitTransientDisconnectError(err)) {
            expected++;
            if (mode !== "silent") {
                const msg = getErrorMessage(err);
                // eslint-disable-next-line no-console
                console.warn(msg);
                if (includeStack) {
                    const stack = getErrorStack(err);
                    if (stack) console.warn(stack);
                }
            }
            return;
        }

        unexpected++;
        unexpectedErrors.push(err);
        // eslint-disable-next-line no-console
        console.error("[uncaughtException]", err);
        if (failOnUnexpected) process.exitCode = 1;
    };

    process.on("unhandledRejection", onUnhandledRejection);
    process.on("uncaughtException", onUncaughtException);

    return {
        counters: {
            get expected() {
                return expected;
            },
            get unexpected() {
                return unexpected;
            },
        },
        get unexpectedErrors() {
            return unexpectedErrors;
        },
        dispose: () => {
            process.off("unhandledRejection", onUnhandledRejection);
            process.off("uncaughtException", onUncaughtException);
        },
    };
};
