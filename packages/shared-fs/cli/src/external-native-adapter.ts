import { spawn, type ChildProcess } from "node:child_process";

type ExternalNativeAdapterOptions = {
    readinessTimeoutMs?: number;
    exitTimeoutMs?: number;
    spawnAdapter?: typeof spawn;
    profile?: boolean;
};

const childExited = (child: ChildProcess) =>
    child.exitCode != null || child.signalCode != null;

type SignalResult =
    | { status: "exited" }
    | { status: "timeout" }
    | { status: "error"; error: Error };

const asError = (error: unknown) =>
    error instanceof Error ? error : new Error(String(error));

const signalAndWaitForChildExit = async (
    child: ChildProcess,
    signal: NodeJS.Signals,
    timeoutMs: number
): Promise<SignalResult> => {
    if (childExited(child)) {
        return { status: "exited" };
    }

    return new Promise<SignalResult>((resolve) => {
        let settled = false;
        let rejectedSignal: Error | undefined;
        const finish = (result: SignalResult) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            child.off("exit", onExit);
            child.off("error", onError);
            resolve(result);
        };
        const onExit = () => {
            finish({ status: "exited" });
        };
        const onError = (error: Error) => {
            finish({ status: "error", error });
        };
        const timeout = setTimeout(
            () =>
                finish(
                    rejectedSignal == null
                        ? { status: "timeout" }
                        : { status: "error", error: rejectedSignal }
                ),
            timeoutMs
        );
        child.once("exit", onExit);
        child.once("error", onError);

        if (childExited(child)) {
            finish({ status: "exited" });
            return;
        }

        try {
            if (!child.kill(signal)) {
                rejectedSignal = new Error(
                    `Native adapter process ${child.pid} rejected ${signal}`
                );
                // UV_ESRCH also returns false while Node's exit event may still
                // be pending. Keep waiting for that event, bounded by timeout.
            }
        } catch (error) {
            finish({ status: "error", error: asError(error) });
        }
    });
};

const stopChild = async (child: ChildProcess, timeoutMs: number) => {
    if (child.pid == null || childExited(child)) {
        return;
    }
    const signalErrors: Error[] = [];
    for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
        const result = await signalAndWaitForChildExit(
            child,
            signal,
            timeoutMs
        );
        if (result.status === "exited") {
            return;
        }
        if (result.status === "error") {
            signalErrors.push(result.error);
        }
    }
    const error = new Error(`Native adapter process ${child.pid} did not exit`);
    if (signalErrors.length > 0) {
        error.cause = new AggregateError(
            signalErrors,
            "Native adapter signal delivery failed"
        );
    }
    throw error;
};

export const mountExternalNativeAdapter = async (
    command: string,
    endpoint: string,
    mountpoint: string,
    options: ExternalNativeAdapterOptions = {}
) => {
    const args = ["--endpoint", endpoint, "--mountpoint", mountpoint];
    if (process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER_DEBUG === "1") {
        args.push("--debug");
    }
    if (options.profile) {
        args.push("--profile");
    }
    const child = (options.spawnAdapter ?? spawn)(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));

    try {
        await new Promise<void>((resolve, reject) => {
            let output = "";
            const readinessTimeoutMs = options.readinessTimeoutMs ?? 15_000;
            const timeout = setTimeout(() => {
                cleanup();
                reject(
                    new Error(
                        `Native adapter did not report readiness within ${readinessTimeoutMs} ms: ${command}`
                    )
                );
            }, readinessTimeoutMs);
            const cleanup = () => {
                clearTimeout(timeout);
                child.stdout.off("data", onStdout);
                child.off("error", onError);
                child.off("exit", onExit);
            };
            const onStdout = (chunk: Buffer) => {
                output += chunk.toString("utf8");
                process.stdout.write(chunk);
                if (output.includes("peerbit-shared-fs-native ready")) {
                    cleanup();
                    resolve();
                }
            };
            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };
            const onExit = (
                code: number | null,
                signal: NodeJS.Signals | null
            ) => {
                cleanup();
                reject(
                    new Error(
                        `Native adapter exited before mount readiness: code=${code} signal=${signal}`
                    )
                );
            };
            child.stdout.on("data", onStdout);
            child.once("error", onError);
            child.once("exit", onExit);
        });
    } catch (startError) {
        try {
            await stopChild(child, options.exitTimeoutMs ?? 5_000);
        } catch (stopError) {
            throw new AggregateError(
                [startError, stopError],
                "Native adapter startup failed and its process could not be stopped"
            );
        }
        throw startError;
    }

    return {
        mountpoint,
        async unmount() {
            await stopChild(child, options.exitTimeoutMs ?? 5_000);
        },
    };
};
