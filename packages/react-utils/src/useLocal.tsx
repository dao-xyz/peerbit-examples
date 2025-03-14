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
    } & QueryOptons
) => {
    // Local state to store results.
    const [all, setAll] = useState<RT[]>([]);

    // useRef to store the current search function.
    const changeListener = useRef<(() => void) | undefined>(undefined);

    // Effect that sets up the search function and listens for DB changes.
    useEffect(() => {
        if (!db || db.closed) {
            return;
        }

        // Define the search function.
        const _l = async (args?: any) => {
            try {
                const iterator = db.index.iterate(options?.query ?? {}, {
                    local: true,
                    remote: false,
                    resolve: options?.resolve as any,
                });
                const results: WithContext<RT>[] =
                    (await iterator.all()) as any; // TODO fix types
                // Update the state and call onChanges if provided.
                setAll(() => {
                    options?.onChanges?.(results);
                    return results;
                });
            } catch (error) {
                if (error instanceof ClosedError) {
                    // If the DB is closed, we ignore the error.
                    return;
                }
                throw error;
            }
        };
        const l = debounceLeadingTrailing(_l, options?.debounce ?? 1e3);

        // Update the ref with the latest search function.
        changeListener.current = l;

        // Run the search initially.
        l();

        // Add event listener for changes.
        db.events.addEventListener("change", l);

        // Cleanup the event listener on unmount or when dependencies change.
        return () => {
            db.events.removeEventListener("change", l);
            l.cancel();
        };
    }, [
        // Ensure the search function is updated when these dependencies change.
        db?.closed ? undefined : db?.address,
        options?.id,
        options?.resolve,
        options?.onChanges,
    ]);

    return all;
};
