import { useState, useEffect, useRef } from "react";
import {
    ClosedError,
    Documents,
    DocumentsChange,
    ResultsIterator,
    SearchRequest,
    SearchRequestIndexed,
    WithContext,
} from "@peerbit/document";
import * as indexerTypes from "@peerbit/indexer-interface";

type QueryLike = {
    query?: indexerTypes.Query[] | indexerTypes.QueryLike;
    sort?: indexerTypes.Sort[] | indexerTypes.Sort | indexerTypes.SortLike;
};
type QueryOptions = { query: QueryLike; id: string };

const logWithId = (
    options: { debug?: boolean | { id: string } } | undefined,
    ...args: any[]
) => {
    if (!options?.debug) return;

    if (typeof options.debug === "boolean") {
        console.log(...args);
    } else if (typeof options.debug.id === "string") {
        console.log(options.debug.id, ...args);
    }
};

export const useLocalPaginated = <
    T extends Record<string, any>,
    I extends Record<string, any>,
    R extends boolean | undefined = true,
    RT = R extends false ? WithContext<I> : WithContext<T>
>(
    db?: Documents<T, I>,
    options?: {
        resolve?: R;
        transform?: (result: WithContext<RT>) => Promise<WithContext<RT>>;
        onChanges?: (all: RT[]) => void;
        debounce?: number;
        debug?: boolean | { id: string };
        reverse?: boolean;
        batchSize?: number; // You can set a default batch size here
    } & QueryOptions
) => {
    const [all, setAll] = useState<WithContext<RT>[]>([]);
    const allRef = useRef<WithContext<RT>[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const iteratorRef = useRef<ResultsIterator<WithContext<RT>> | null>(null);
    const emptyResultsRef = useRef(false);

    const updateAll = (combined: WithContext<RT>[]) => {
        if (options?.onChanges) {
            options?.onChanges?.(combined);
        }

        logWithId(
            options,
            "Loading more items, new combined length",
            combined.length
        );

        allRef.current = combined;

        setAll(combined);
    };

    const reset = () => {
        emptyResultsRef.current = false;
        setAll([]);
        setIsLoading(false);
        allRef.current = [];
    };

    // Initialize the iterator only once or when query changes
    useEffect(() => {
        if (!db || db.closed || options?.query === null) {
            reset();
            return;
        }
        const initIterator = () => {
            try {
                // Initialize the iterator and load initial batch.

                emptyResultsRef.current = false;
                iteratorRef.current?.close();
                iteratorRef.current = db.index.iterate(options?.query ?? {}, {
                    local: true,
                    remote: false,
                    resolve: options?.resolve as any,
                }) as any as ResultsIterator<WithContext<RT>>; // TODO types

                logWithId(options, "Initializing iterator");

                loadMore(); // initial load
            } catch (error) {
                console.error("Error initializing iterator", error);
            }
        };

        // Reset state when the db or query changes.
        reset();
        initIterator();

        const handleChange = async (e: CustomEvent<DocumentsChange<T>>) => {
            // while we are iterating, we might get new documents.. so this method inserts them where they should be
            let merged = await db.index.updateResults(
                allRef.current,
                e.detail,
                options?.query || {},
                options?.resolve ?? true
            );
            logWithId(
                options,
                "handleChange",
                merged.length,
                allRef.current.length
            );
            if (
                merged === allRef.current &&
                merged.length &&
                allRef.current.length === 0
            ) {
                // no change
            } else {
                updateAll(options?.reverse ? merged.reverse() : merged);
            }
        };

        db.events.addEventListener("change", handleChange);
        return () => {
            db.events.removeEventListener("change", handleChange);
            iteratorRef.current?.close();
            emptyResultsRef.current = false;
        };
    }, [
        db?.closed ? undefined : db?.rootAddress,
        options?.id,
        options?.query,
        options?.resolve,
    ]);

    // Define the loadMore function
    const loadMore = async () => {
        if (!iteratorRef.current || emptyResultsRef.current) {
            logWithId(options, "loadMore: already loading or no more items", {
                isLoading,
                emptyResultsRef: emptyResultsRef.current,
                iteratorRef: !iteratorRef.current,
            });
            return;
        }

        setIsLoading(true);
        try {
            // Fetch next batchSize number of items:
            let refBefore = iteratorRef.current;

            let newItems: WithContext<RT>[] = await iteratorRef.current.next(
                options?.batchSize ?? 10
            );

            if (options?.transform) {
                newItems = await Promise.all(
                    newItems.map((item) => options.transform!(item))
                );
            }

            if (iteratorRef.current !== refBefore) {
                // If the iterator has changed, we should not update the state
                // This can happen if the iterator was closed and a new one was created
                logWithId(options, "Iterator ref changed, not updating state");
                return;
            }

            emptyResultsRef.current = newItems.length === 0;

            if (newItems.length > 0) {
                let prev = allRef.current;
                let prevHash = new Set(prev.map((x) => x.__context.head));
                let newItemsNoHash = newItems.filter(
                    (x) => !prevHash.has(x.__context.head)
                );
                if (newItemsNoHash.length === 0) {
                    logWithId(options, "no new items, not updating state");
                    return;
                }
                const combined = options?.reverse
                    ? [...newItemsNoHash.reverse(), ...prev]
                    : [...prev, ...newItemsNoHash];
                updateAll(combined);
            } else {
                logWithId(options, "no new items, not updating state");
            }
        } catch (error) {
            if (error instanceof ClosedError) {
                // Handle closed database gracefully
                logWithId(options, "Database closed error");
            } else {
                throw error;
            }
        } finally {
            setIsLoading(false);
        }
    };

    return { items: all, loadMore, isLoading, empty: emptyResultsRef.current };
};
