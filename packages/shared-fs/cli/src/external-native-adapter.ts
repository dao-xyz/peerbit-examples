import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type ExternalNativeAdapterOptions = {
    readinessTimeoutMs?: number;
    exitTimeoutMs?: number;
    signal?: AbortSignal;
    spawnAdapter?: typeof spawn;
    probe?: (mountpoint: string) => Promise<boolean>;
};

const childExited = (child: ChildProcess) =>
    child.exitCode != null || child.signalCode != null;

type SignalResult =
    | { status: "exited" }
    | { status: "timeout" }
    | { status: "error"; error: Error };

const asError = (error: unknown) =>
    error instanceof Error ? error : new Error(String(error));

const probeMount = (mountpoint: string) =>
    access(join(mountpoint, ".peerbit-conflicts")).then(
        () => true,
        (error: any) => {
            if (error?.code === "ENOENT") return false;
            throw error;
        }
    );

const signalAndWaitForChildExit = async (
    child: ChildProcess,
    signal: NodeJS.Signals,
    timeoutMs: number
): Promise<SignalResult> => {
    if (childExited(child)) {
        return { status: "exited" };
    }

    return new Promise<SignalResult>((resolve) => {
        let timeout: NodeJS.Timeout | undefined;
        let settled = false;
        let rejectedSignal: Error | undefined;
        const finish = (result: SignalResult) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeout != null) {
                clearTimeout(timeout);
            }
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
        child.once("exit", onExit);
        child.once("error", onError);

        if (childExited(child)) {
            finish({ status: "exited" });
            return;
        }

        timeout = setTimeout(
            () =>
                finish(
                    rejectedSignal == null
                        ? { status: "timeout" }
                        : { status: "error", error: rejectedSignal }
                ),
            timeoutMs
        );
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
    const timeoutMs = options.readinessTimeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    const probe = options.probe ?? probeMount;
    let abortPreflight!: () => void;
    const aborted = new Promise<never>((_, reject) => {
        abortPreflight = () =>
            reject(
                asError(options.signal?.reason ?? new Error("Mount aborted"))
            );
        options.signal?.aborted
            ? abortPreflight()
            : options.signal?.addEventListener("abort", abortPreflight, {
                  once: true,
              });
    });
    let preflightTimer = 0;
    const preflight = await Promise.race([
        probe(mountpoint),
        aborted,
        new Promise<undefined>((resolve) => {
            preflightTimer = setTimeout(
                resolve,
                Math.max(0, deadline - Date.now())
            );
        }),
    ]).finally(() => {
        clearTimeout(preflightTimer);
        options.signal?.removeEventListener("abort", abortPreflight);
    });
    if (preflight == null) {
        throw new Error(`Mount preflight timeout: ${mountpoint}`);
    }
    if (preflight) {
        throw new Error(`Mount sentinel exists: ${mountpoint}`);
    }
    if (options.signal?.aborted) {
        throw asError(options.signal.reason);
    }
    const args = ["--endpoint", endpoint, "--mountpoint", mountpoint];
    if (process.env.PEERBIT_SHARED_FS_NATIVE_ADAPTER_DEBUG === "1") {
        args.push("--debug");
    }
    const child = (options.spawnAdapter ?? spawn)(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));

    try {
        await new Promise<void>((resolve, reject) => {
            let output = "";
            let settled = false;
            const timeout = setTimeout(
                () => {
                    finish(new Error(`Mount readiness timeout: ${mountpoint}`));
                },
                Math.max(0, deadline - Date.now())
            );
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                child.stdout.off("data", onStdout);
                child.off("error", finish);
                child.off("exit", onExit);
                options.signal?.removeEventListener("abort", onAbort);
                error == null ? resolve() : reject(error);
            };
            const onAbort = () =>
                finish(
                    asError(
                        options.signal?.reason ?? new Error("Mount aborted")
                    )
                );
            const onStdout = (chunk: Buffer) => {
                output += chunk.toString("utf8");
                process.stdout.write(chunk);
                if (output.includes("peerbit-shared-fs-native ready")) {
                    child.stdout.off("data", onStdout);
                    void (async () => {
                        while (!settled && !(await probe(mountpoint))) {
                            await delay(25);
                        }
                        finish();
                    })().catch(finish);
                }
            };
            const onExit = (
                code: number | null,
                signal: NodeJS.Signals | null
            ) => {
                finish(
                    new Error(
                        `Native adapter exited before mount readiness: code=${code} signal=${signal}`
                    )
                );
            };
            child.stdout.on("data", onStdout);
            child.once("error", finish);
            child.once("exit", onExit);
            if (options.signal?.aborted) onAbort();
            else
                options.signal?.addEventListener("abort", onAbort, {
                    once: true,
                });
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

    let rejectFailure!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => {
        rejectFailure = reject;
    });
    void failure.catch(() => {});
    const onFailure = (error: unknown) => rejectFailure(asError(error));
    const onUnexpectedExit = (
        code: number | null,
        signal: NodeJS.Signals | null
    ) =>
        onFailure(
            new Error(
                `Native adapter exited after mount readiness: code=${code} signal=${signal}`
            )
        );
    child.once("error", onFailure);
    child.once("exit", onUnexpectedExit);
    if (childExited(child)) {
        onUnexpectedExit(child.exitCode, child.signalCode);
    }

    return {
        failure,
        mountpoint,
        async unmount() {
            child.off("error", onFailure);
            child.off("exit", onUnexpectedExit);
            await stopChild(child, options.exitTimeoutMs ?? 5_000);
        },
    };
};
