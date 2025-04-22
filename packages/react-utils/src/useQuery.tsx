import { useState, useEffect, useRef } from "react";
import {
    ClosedError,
    Documents,
    DocumentsChange,
    ResultsIterator,
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

export const useQuery = <
    T extends Record<string, any>,
    I extends Record<string, any>,
    R extends boolean | undefined = true,
    RT = R extends false ? WithContext<I> : WithContext<T>
>(
    db?: Documents<T, I>,
    options?: {
        resolve?: R;
        transform?: (result: WithContext<RT>) => Promise<WithContext<RT>>;
        debounce?: number;
        debug?: boolean | { id: string };
        reverse?: boolean;
        batchSize?: number; // You can set a default batch size here
        onChange?: {
            merge?:
                | boolean
                | ((
                      change: DocumentsChange<T>
                  ) =>
                      | DocumentsChange<T>
                      | Promise<DocumentsChange<T>>
                      | undefined); // if true, the iterator will be updated with new documents
            update?: (
                prev: WithContext<RT>[],
                change: DocumentsChange<T>
            ) => WithContext<RT>[];
        };
        local?: boolean; // if true, (default is true) the iterator will only return local documents
        remote?:
            | boolean
            | {
                  eager?: boolean;
              };
    } & QueryOptions
) => {
    const [all, setAll] = useState<WithContext<RT>[]>([]);
    const allRef = useRef<WithContext<RT>[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const loadingMoreRef = useRef(false);
    const iteratorRef = useRef<{
        id?: string;
        iterator: ResultsIterator<WithContext<RT>>;
    } | null>(null);
    const emptyResultsRef = useRef(false);

    const updateAll = (
        combined: WithContext<RT>[],
        fromChange?: DocumentsChange<any> | null
    ) => {
        logWithId(
            options,
            "Loading more items, new combined length",
            combined.length,
            "from change",
            fromChange
        );

        allRef.current = combined;

        setAll(combined);
    };

    const reset = () => {
        logWithId(options, "RESET FROM " + allRef.current.length);

        emptyResultsRef.current = false;
        !iteratorRef.current?.iterator.done() &&
            iteratorRef.current?.iterator?.close();
        iteratorRef.current = null;
        setAll([]);
        setIsLoading(false);
        loadingMoreRef.current = false;
        allRef.current = [];
    };

    // Initialize the iterator only once or when query changes
    useEffect(() => {
        if (!db || db.closed || options?.query === null) {
            reset();
            return;
        }
        const initIterator = () => {
            // Don't make this async, it will cause issues with the iterator refs
            try {
                // Initialize the iterator and load initial batch.

                emptyResultsRef.current = false;
                iteratorRef.current?.iterator.close();
                iteratorRef.current = {
                    id: options?.id,
                    iterator: db.index.iterate(options?.query ?? {}, {
                        local: options?.local ?? true,
                        remote: options?.remote ?? true,
                        resolve: options?.resolve as any,
                    }) as any as ResultsIterator<WithContext<RT>>,
                };

                logWithId(options, "Initializing iterator", options?.id);

                loadMore(); // initial load
            } catch (error) {
                console.error("Error initializing iterator", error);
            }
        };

        // Reset state when the db or query changes.
        reset();
        initIterator();

        let handleChange:
            | undefined
            | ((e: CustomEvent<DocumentsChange<T>>) => void | Promise<void>) =
            undefined;
        if (options?.onChange) {
            let mergeFunction =
                typeof options.onChange.merge === "function"
                    ? options.onChange.merge
                    : (change: DocumentsChange<T>) => change;
            handleChange = async (e: CustomEvent<DocumentsChange<T>>) => {
                // while we are iterating, we might get new documents.. so this method inserts them where they should be
                let filteredChange = await mergeFunction(e.detail);
                if (
                    !filteredChange ||
                    (filteredChange.added.length === 0 &&
                        filteredChange.removed.length === 0)
                ) {
                    return;
                }
                let merged: WithContext<RT>[] = [];
                if (options.onChange?.update) {
                    merged = [
                        ...options.onChange.update(
                            allRef.current,
                            filteredChange
                        ),
                    ];
                } else {
                    merged = await db.index.updateResults(
                        allRef.current,
                        filteredChange,
                        options?.query || {},
                        options?.resolve ?? true
                    );
                    const expectedDiff =
                        filteredChange.added.length -
                        filteredChange.removed.length;

                    if (
                        merged === allRef.current ||
                        (expectedDiff !== 0 &&
                            merged.length === allRef.current.length)
                    ) {
                        // no change
                        logWithId(options, "no change after merge");
                        return;
                    }
                }

                logWithId(options, "handleChange", {
                    added: e.detail.added.length,
                    removed: e.detail.removed.length,
                    merged: merged.length,
                    allRef: allRef.current.length,
                });

                updateAll(
                    options?.reverse ? merged.reverse() : merged,
                    e.detail
                );
            };
            db.events.addEventListener("change", handleChange);
        }

        return () => {
            handleChange &&
                db.events.removeEventListener("change", handleChange);
            reset();
        };
    }, [
        db?.closed ? undefined : db?.address,
        options?.id ? options?.id : options?.query,
        options?.resolve,
    ]);

    // Define the loadMore function
    const batchSize = options?.batchSize ?? 10;
    const loadMore = async () => {
        if (
            !iteratorRef.current ||
            emptyResultsRef.current ||
            iteratorRef.current.iterator.done() ||
            loadingMoreRef.current
        ) {
            logWithId(options, "loadMore: already loading or no more items", {
                isLoading,
                emptyResultsRef: emptyResultsRef.current,
                iteratorRef: !iteratorRef.current,
            });
            return;
        }
        const iterator = iteratorRef.current;

        setIsLoading(true);
        loadingMoreRef.current = true;
        try {
            // Fetch next batchSize number of items:
            await db?.log.waitForReplicators({ timeout: 1e4 });
            logWithId(
                options,
                "loadMore: loading more items for iterator" +
                    iteratorRef.current?.id
            );
            let newItems: WithContext<RT>[] = await iterator.iterator.next(
                batchSize
            );

            if (options?.transform) {
                newItems = await Promise.all(
                    newItems.map((item) => options.transform!(item))
                );
            }

            if (iteratorRef.current !== iterator) {
                // If the iterator has changed, we should not update the state
                // This can happen if the iterator was closed and a new one was created
                logWithId(options, "Iterator ref changed, not updating state", {
                    refBefore: iterator.id,
                    currentRef: iteratorRef.current?.id,
                });
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
                    logWithId(
                        options,
                        "no new items after dedup, not updating state. Prev length",
                        prev.length
                    );
                    return;
                }
                const combined = options?.reverse
                    ? [...newItemsNoHash.reverse(), ...prev]
                    : [...prev, ...newItemsNoHash];
                updateAll(combined, null);
            } else {
                logWithId(
                    options,
                    "no new items, not updating state for iterator" +
                        iteratorRef.current?.id +
                        " existing results length",
                    allRef.current.length
                );
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
            loadingMoreRef.current = false;
        }
    };

    return { items: all, loadMore, isLoading, empty: emptyResultsRef.current };
};
