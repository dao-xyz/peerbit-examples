import {
    type AbstractFile,
    type Files,
    isLargeFileLike,
} from "@peerbit/please-lib";

type PendingReadyResolverOptions<TProgram, TValue> = {
    attemptTimeoutMs?: number;
    expiryCooldownMs?: number;
    maxEntries?: number;
    maxLifetimeMs?: number;
    retryDelayMs?: number;
    resolve: (
        key: string,
        program: TProgram,
        signal: AbortSignal,
        attemptTimeoutMs: number
    ) => Promise<TValue | undefined>;
    isActive: (key: string, program: TProgram) => boolean;
    onReady: (key: string, program: TProgram, value: TValue) => void;
    onError?: (key: string, program: TProgram, error: unknown) => void;
    onExpired?: (key: string, program: TProgram) => void;
};

type PendingTask<TProgram> = {
    program: TProgram;
    controller: AbortController;
    promise: Promise<void>;
};

export type PendingReadyStartResult =
    | { status: "started"; promise: Promise<void> }
    | { status: "existing"; promise: Promise<void> }
    | { status: "cooldown"; reason: "expired"; retryAt: number }
    | { status: "capacity"; activeCount: number; maxEntries: number };

export type PendingReadyResolver<TProgram> = {
    readonly size: number;
    readonly cooldownSize: number;
    start(key: string, program: TProgram): PendingReadyStartResult;
    cancel(key: string, program?: TProgram): boolean;
    cancelProgram(program: TProgram): number;
    cancelAll(): number;
};

const waitForRetry = (delayMs: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal.aborted || delayMs <= 0) {
            resolve();
            return;
        }
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
        };
        const timer = setTimeout(finish, delayMs);
        signal.addEventListener("abort", finish, { once: true });
    });

export const createPendingReadyResolver = <TProgram, TValue>(
    options: PendingReadyResolverOptions<TProgram, TValue>
): PendingReadyResolver<TProgram> => {
    const attemptTimeoutMs = options.attemptTimeoutMs ?? 1_500;
    const maxEntries = Math.max(1, options.maxEntries ?? 64);
    const maxLifetimeMs = Math.max(1, options.maxLifetimeMs ?? 5 * 60_000);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 350);
    const expiryCooldownMs = Math.max(
        0,
        options.expiryCooldownMs ?? maxLifetimeMs
    );
    const tasks = new Map<TProgram, Map<string, PendingTask<TProgram>>>();
    const cooldowns = new Map<TProgram, Map<string, number>>();
    let taskCount = 0;

    const deleteTask = (
        key: string,
        program: TProgram,
        expected?: PendingTask<TProgram>
    ) => {
        const programTasks = tasks.get(program);
        const task = programTasks?.get(key);
        if (!task || (expected && task !== expected)) {
            return undefined;
        }
        programTasks!.delete(key);
        taskCount -= 1;
        if (programTasks!.size === 0) {
            tasks.delete(program);
        }
        return task;
    };

    const clearCooldown = (key: string, program: TProgram) => {
        const programCooldowns = cooldowns.get(program);
        const cleared = programCooldowns?.delete(key) ?? false;
        if (programCooldowns?.size === 0) {
            cooldowns.delete(program);
        }
        return cleared;
    };

    const pruneExpiredCooldowns = (now = Date.now()) => {
        for (const [program, programCooldowns] of cooldowns) {
            for (const [key, retryAt] of programCooldowns) {
                if (now >= retryAt) {
                    programCooldowns.delete(key);
                }
            }
            if (programCooldowns.size === 0) {
                cooldowns.delete(program);
            }
        }
    };

    const cancel = (key: string, program?: TProgram) => {
        let cleared = false;
        if (program != null) {
            const task = deleteTask(key, program);
            if (task) {
                task.controller.abort();
                cleared = true;
            }
            return clearCooldown(key, program) || cleared;
        }
        for (const targetProgram of new Set([
            ...tasks.keys(),
            ...cooldowns.keys(),
        ])) {
            const task = deleteTask(key, targetProgram);
            if (task) {
                task.controller.abort();
                cleared = true;
            }
            cleared = clearCooldown(key, targetProgram) || cleared;
        }
        return cleared;
    };

    const start = (key: string, program: TProgram) => {
        const now = Date.now();
        pruneExpiredCooldowns(now);
        const existing = tasks.get(program)?.get(key);
        if (existing) {
            return { status: "existing", promise: existing.promise } as const;
        }
        const retryAt = cooldowns.get(program)?.get(key);
        if (retryAt != null) {
            return {
                status: "cooldown",
                reason: "expired",
                retryAt,
            } as const;
        }
        if (taskCount >= maxEntries) {
            return {
                status: "capacity",
                activeCount: taskCount,
                maxEntries,
            } as const;
        }

        const controller = new AbortController();
        const task: PendingTask<TProgram> = {
            program,
            controller,
            promise: Promise.resolve(),
        };
        let programTasks = tasks.get(program);
        if (!programTasks) {
            programTasks = new Map();
            tasks.set(program, programTasks);
        }
        programTasks.set(key, task);
        taskCount += 1;
        const startedAt = now;
        task.promise = (async () => {
            try {
                while (
                    !controller.signal.aborted &&
                    options.isActive(key, program)
                ) {
                    if (Date.now() - startedAt >= maxLifetimeMs) {
                        if (expiryCooldownMs > 0) {
                            let programCooldowns = cooldowns.get(program);
                            if (!programCooldowns) {
                                programCooldowns = new Map();
                                cooldowns.set(program, programCooldowns);
                            }
                            programCooldowns.set(
                                key,
                                Date.now() + expiryCooldownMs
                            );
                        }
                        options.onExpired?.(key, program);
                        return;
                    }
                    try {
                        const ready = await options.resolve(
                            key,
                            program,
                            controller.signal,
                            attemptTimeoutMs
                        );
                        if (
                            controller.signal.aborted ||
                            !options.isActive(key, program)
                        ) {
                            return;
                        }
                        if (ready != null) {
                            clearCooldown(key, program);
                            options.onReady(key, program, ready);
                            return;
                        }
                    } catch (error) {
                        if (controller.signal.aborted) {
                            return;
                        }
                        options.onError?.(key, program, error);
                    }
                    await waitForRetry(retryDelayMs, controller.signal);
                }
            } finally {
                deleteTask(key, program, task);
            }
        })();
        return { status: "started", promise: task.promise } as const;
    };

    return {
        get size() {
            return taskCount;
        },
        get cooldownSize() {
            pruneExpiredCooldowns();
            let size = 0;
            for (const programCooldowns of cooldowns.values()) {
                size += programCooldowns.size;
            }
            return size;
        },
        start,
        cancel,
        cancelProgram(program) {
            const programTasks = tasks.get(program);
            const cancelled = programTasks?.size ?? 0;
            if (programTasks) {
                tasks.delete(program);
                taskCount -= cancelled;
                for (const task of programTasks.values()) {
                    task.controller.abort();
                }
            }
            cooldowns.delete(program);
            return cancelled;
        },
        cancelAll() {
            const count = taskCount;
            const activeTasks = [...tasks.values()].flatMap((programTasks) => [
                ...programTasks.values(),
            ]);
            tasks.clear();
            cooldowns.clear();
            taskCount = 0;
            for (const task of activeTasks) {
                task.controller.abort();
            }
            return count;
        },
    };
};

export const resolveRemoteReadyRoot = async (
    program: Files,
    id: string,
    signal: AbortSignal,
    attemptTimeoutMs: number
): Promise<AbstractFile | undefined> => {
    const from = await program.getReadPeerHints();
    signal.throwIfAborted();
    const candidate = (await program.files.index.get(id, {
        local: false,
        signal,
        remote: {
            timeout: attemptTimeoutMs,
            strategy: "always" as any,
            throwOnMissing: false,
            retryMissingResponses: true,
            replicate: false,
            from,
        },
    })) as AbstractFile | undefined;
    signal.throwIfAborted();
    return candidate && isLargeFileLike(candidate) && candidate.ready
        ? candidate
        : undefined;
};
