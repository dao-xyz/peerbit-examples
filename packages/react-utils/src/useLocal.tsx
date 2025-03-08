import {
    ClosedError,
    Documents,
    Query,
    SearchRequest,
    Sort,
    WithContext,
} from "@peerbit/document";
import { useEffect, useRef, useState } from "react";

export const useLocal = <
    T extends Record<string, any>,
    I extends Record<string, any>,
    R extends boolean | undefined = true,
    RT = R extends false ? I : T
>(
    db?: Documents<T, I>,
    options?: {
        query?: {
            query?:
                | Query[]
                | Query
                | Record<
                      string,
                      | string
                      | number
                      | bigint
                      | Uint8Array
                      | boolean
                      | null
                      | undefined
                  >;
            sort?: Sort[] | Sort;
            fetch?: number;
        };
        resolve?: R;
        onChanges?: (all: RT[]) => void;
    }
) => {
    // Local state to store results.
    const [all, setAll] = useState<RT[]>([]);

    // useRef to store the current search function.
    const changeListener = useRef<(() => void) | undefined>(undefined);

    // Effect that reacts when the query in options changes.
    useEffect(() => {
        // Trigger the search function if it exists.
        changeListener.current?.();
    }, [options?.query]);

    // Effect that sets up the search function and listens for DB changes.
    useEffect(() => {
        if (!db || db.closed) {
            return;
        }

        // Define the search function.
        const l = async () => {
            try {
                const results: WithContext<RT>[] = (await db.index.search(
                    new SearchRequest(options?.query),
                    {
                        local: true,
                        remote: false,
                        resolve: options?.resolve as any,
                    }
                )) as any; // TODO fix types
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

        // Update the ref with the latest search function.
        changeListener.current = l;

        // Run the search initially.
        l();

        // Add event listener for changes.
        db.events.addEventListener("change", l);

        // Cleanup the event listener on unmount or when dependencies change.
        return () => {
            db.events.removeEventListener("change", l);
        };
    }, [
        // Ensure the search function is updated when these dependencies change.
        db?.closed ? undefined : db?.address,
        options?.query,
        options?.resolve,
        options?.onChanges,
    ]);

    return all;
};
