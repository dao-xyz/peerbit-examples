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

        if (options?.debug) {
            let dbgId =
                typeof options.debug === "boolean"
                    ? undefined
                    : options.debug.id;
            console.log(
                "Loading more items, new combined length",
                dbgId,
                combined.length
            );
        }

        const dedub = new Set<string>();
        for (const item of combined) {
            if ("idString" in item) {
                if (dedub.has(item.idString as string)) {
                    throw new Error("Duplicate item found in iterator");
                }
                dedub.add(item.idString as string);
            }
        }
        allRef.current = combined;

        setAll(combined);
    };

    // Initialize the iterator only once or when query changes
    useEffect(() => {
        if (!db || db.closed || options?.query === null) {
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

                if (options?.debug) {
                    let dbgId =
                        typeof options.debug === "boolean"
                            ? undefined
                            : options.debug.id;
                    console.log("Create new iterator", dbgId);
                }

                loadMore(); // initial load
            } catch (error) {
                console.error("Error initializing iterator", error);
            }
        };

        // Reset state when the db or query changes.

        console.log("RESET FROM", all.length);
        setAll([]);
        allRef.current = [];

        initIterator();

        const handleChange = async (e: CustomEvent<DocumentsChange<T>>) => {
            // while we are iterating, we might get new documents.. so this method inserts them where they should be
            let merged = await db.index.updateResults(
                allRef.current,
                e.detail,
                options?.query || {},
                options?.resolve ?? true
            );
            console.log(
                "merge result",
                "change: " +
                    (merged === allRef.current &&
                        merged.length &&
                        allRef.current.length === 0),
                merged,
                all,
                e.detail,
                allRef.current
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
        };
    }, [
        db?.closed ? undefined : db?.rootAddress,
        options?.id,
        options?.query,
        options?.resolve,
    ]);

    // Define the loadMore function
    const loadMore = async () => {
        if (!iteratorRef.current || isLoading || emptyResultsRef.current)
            return;

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
                    return;
                }
                const combined = options?.reverse
                    ? [...newItemsNoHash.reverse(), ...prev]
                    : [...prev, ...newItemsNoHash];
                updateAll(combined);
            }
        } catch (error) {
            if (error instanceof ClosedError) {
                // Handle closed database gracefully
            } else {
                throw error;
            }
        } finally {
            setIsLoading(false);
        }
    };

    return { items: all, loadMore, isLoading, empty: emptyResultsRef.current };
};
