export type RefreshContext<TProgram> = {
    generation: number;
    program: TProgram;
};

export type CancellableScheduledCall<TArgs> = ((args?: TArgs) => void) & {
    cancel(): void;
};

export type CoalescedRefreshQueue<TSource> = {
    current: TSource | null;
};

export const queueCoalescedRefresh = <TSource>(
    queue: CoalescedRefreshQueue<TSource>,
    source: TSource
) => {
    queue.current = source;
};

export const drainCoalescedRefreshQueue = async <TSource>(
    queue: CoalescedRefreshQueue<TSource>,
    isActive: () => boolean,
    refresh: (source: TSource) => Promise<void> | void
) => {
    while (isActive() && queue.current != null) {
        const source = queue.current;
        queue.current = null;
        await refresh(source);
    }
};

export const isRefreshContextActive = <TProgram>(
    current: RefreshContext<TProgram | null>,
    expected: RefreshContext<TProgram>,
    enabled = true
) =>
    enabled &&
    current.generation === expected.generation &&
    current.program === expected.program;

export const createRefreshContextGuard =
    <TProgram>(
        getCurrentContext: () => RefreshContext<TProgram | null>,
        expected: RefreshContext<TProgram>
    ) =>
    () =>
        isRefreshContextActive(getCurrentContext(), expected);

export const bindRefreshContext =
    <TProgram, TArgs>(
        getCurrentContext: () => RefreshContext<TProgram | null>,
        context: RefreshContext<TProgram>,
        refresh: (
            args: TArgs | undefined,
            context: RefreshContext<TProgram>
        ) => Promise<void> | void
    ) =>
    async (args?: TArgs) => {
        const current = getCurrentContext();
        if (!isRefreshContextActive(current, context)) {
            return;
        }
        await refresh(args, context);
    };

export const callEvenInterval = <TArgs>(
    func: (args?: TArgs) => Promise<void> | void,
    delay: number,
    onError: (error: unknown) => void = (error) => {
        console.warn("Scheduled refresh failed", error);
    }
): CancellableScheduledCall<TArgs> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let promise: Promise<void> | undefined;
    let queued = false;
    let cancelled = false;
    let latestArgs: TArgs | undefined;

    const schedule = () => {
        if (cancelled || timer || promise || !queued) {
            return;
        }
        timer = setTimeout(async () => {
            timer = undefined;
            if (cancelled) {
                return;
            }
            queued = false;
            const args = latestArgs;
            promise = Promise.resolve().then(() => func(args));
            try {
                await promise;
            } catch (error) {
                if (!cancelled) {
                    onError(error);
                }
            } finally {
                promise = undefined;
                schedule();
            }
        }, delay);
    };

    const scheduled = ((args?: TArgs) => {
        if (cancelled) {
            return;
        }
        latestArgs = args;
        queued = true;
        schedule();
    }) as CancellableScheduledCall<TArgs>;
    scheduled.cancel = () => {
        cancelled = true;
        queued = false;
        latestArgs = undefined;
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
    return scheduled;
};
