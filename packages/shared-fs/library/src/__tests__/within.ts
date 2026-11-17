/** A step deadline: far above a step's normal time (under 1 s). */
export const STEP_DEADLINE_MS = 60_000;

/**
 * Test-only: `promise`, or a rejection naming `label` once `ms` passed, for
 * a step with no deadline of its own (an on-disk peer's create, open,
 * write or close). A stalled step then fails by name instead of with the
 * test's anonymous timeout. The deadline only gives up, and it is cleared
 * as soon as `promise` settles. It does fail a step slower than `ms` that
 * the test's own timeout would have let finish (60-120 s of a 120 s test).
 */
export const within = <T>(
    label: string,
    promise: Promise<T>,
    ms = STEP_DEADLINE_MS
): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`${label}: still pending after ${ms} ms`)),
            ms
        );
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};
