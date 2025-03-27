import { ClosedError, Documents, WithContext } from "@peerbit/document";
import { useEffect, useRef, useState } from "react";
import * as indexerTypes from "@peerbit/indexer-interface";

type QueryLike = {
    query?: indexerTypes.Query[] | indexerTypes.QueryLike;
    sort?: indexerTypes.Sort[] | indexerTypes.Sort | indexerTypes.SortLike;
};
type QueryOptons = {
    query: QueryLike;
    id: string;
};
function debounceLeadingTrailing<T extends (this: any, ...args: any[]) => void>(
    func: T,
    delay: number
): ((this: ThisParameterType<T>, ...args: Parameters<T>) => void) & {
    cancel: () => void;
} {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastArgs: Parameters<T> | null = null;
    let lastThis: any;
    let pendingTrailing = false;

    const debounced = function (
        this: ThisParameterType<T>,
        ...args: Parameters<T>
    ) {
        if (!timeoutId) {
            // Leading call: no timer means this is the first call in this period.
            func.apply(this, args);
        } else {
            // Subsequent calls during the delay mark that a trailing call is needed.
            pendingTrailing = true;
        }
        // Always update with the most recent context and arguments.
        lastArgs = args;
        lastThis = this;

        // Reset the timer.
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => {
            timeoutId = null;
            // If there were any calls during the delay, call the function on the trailing edge.
            if (pendingTrailing && lastArgs) {
                func.apply(lastThis, lastArgs);
            }
            // Reset the trailing flag after the trailing call.
            pendingTrailing = false;
        }, delay);
    } as ((this: ThisParameterType<T>, ...args: Parameters<T>) => void) & {
        cancel: () => void;
    };

    debounced.cancel = () => {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        pendingTrailing = false;
    };

    return debounced;
}

export const useLocal = <
    T extends Record<string, any>,
    I extends Record<string, any>,
    R extends boolean | undefined = true,
    RT = R extends false ? WithContext<I> : WithContext<T>
>(
    db?: Documents<T, I>,
    options?: {
        resolve?: R;
        onChanges?: (all: RT[]) => void;
        debounce?: number;
        debug?: boolean; // add debug option here
    } & QueryOptons
) => {
    const [all, setAll] = useState<RT[]>([]);
    const emptyResultsRef = useRef(false);
    const changeListener = useRef<(() => void) | undefined>(undefined);

    useEffect(() => {
        if (!db || db.closed) {
            return;
        }

        const _l = async (args?: any) => {
            try {
                const iterator = db.index.iterate(options?.query ?? {}, {
                    local: true,
                    remote: false,
                    resolve: options?.resolve as any,
                });
                const results: WithContext<RT>[] =
                    (await iterator.all()) as any;
                emptyResultsRef.current = results.length === 0;
                if (options?.debug) {
                    console.log("Search results:", results);
                }
                setAll(() => {
                    options?.onChanges?.(results);
                    return results;
                });
            } catch (error) {
                if (error instanceof ClosedError) {
                    return;
                }
                throw error;
            }
        };

        const debounced = debounceLeadingTrailing(
            _l,
            options?.debounce ?? 1000
        );

        const handleChange = () => {
            if (options?.debug) {
                console.log(
                    "Event triggered: emptyResultsRef =",
                    emptyResultsRef.current
                );
            }
            if (emptyResultsRef.current) {
                debounced.cancel();
                if (options?.debug) {
                    console.log(
                        "Empty results detected. Bypassing debounce for immediate search."
                    );
                }
                _l();
            } else {
                if (options?.debug) {
                    console.log("Non-empty results. Using debounced search.");
                }
                debounced();
            }
        };

        changeListener.current = handleChange;
        debounced();
        db.events.addEventListener("change", handleChange);

        return () => {
            db.events.removeEventListener("change", handleChange);
            debounced.cancel();
        };
    }, [
        db?.closed ? undefined : db?.address,
        options?.id,
        options?.resolve,
        options?.onChanges,
    ]);

    return all;
};
