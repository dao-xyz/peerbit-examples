import { useState, useEffect, useRef, useReducer } from "react";
import {
    ClosedError,
    Documents,
    DocumentsChange,
    ResultsIterator,
    WithContext,
} from "@peerbit/document";
import * as indexerTypes from "@peerbit/indexer-interface";
import { AbortError } from "@peerbit/time";
import { NoPeersError } from "@peerbit/shared-log";
import { v4 as uuid } from "uuid";
import { WithIndexedContext } from "@peerbit/document/dist/src/search";
import { on } from "events";
/* ────────────── helper types ────────────── */
type QueryLike = {
    query?: indexerTypes.Query[] | indexerTypes.QueryLike;
    sort?: indexerTypes.Sort[] | indexerTypes.Sort | indexerTypes.SortLike;
};
type QueryOptions = { query: QueryLike; id?: string };

type RemoteQueryOptions = {
    warmup?: number;
    joining?: { waitFor?: number };
    eager?: boolean;
};

/* ────────────── main hook ────────────── */
export const useQuery = <
    T extends Record<string, any>,
    I extends Record<string, any>,
    R extends boolean | undefined = true,
    RT = R extends false ? WithContext<I> : WithIndexedContext<T, I>
>(
    db?: Documents<T, I>,
    options?: {
        resolve?: R;
        transform?: (r: RT) => Promise<RT>;
        debounce?: number;
        debug?: boolean | { id: string };
        reverse?: boolean;
        batchSize?: number;
        prefetch?: boolean;
        onChange?: {
            merge?:
                | boolean
                | ((
                      c: DocumentsChange<T, I>
                  ) =>
                      | DocumentsChange<T, I>
                      | Promise<DocumentsChange<T, I>>
                      | undefined);
            update?: (
                prev: RT[],
                change: DocumentsChange<T, I>
            ) => RT[] | Promise<RT[]>;
        };
        local?: boolean;
        remote?: boolean | RemoteQueryOptions;
    } & QueryOptions
) => {
    /* ── «Item» is the concrete element type flowing through the hook ── */
    type Item = RT;

    /* ────────────── state & refs ────────────── */
    const [all, setAll] = useState<Item[]>([]);
    const allRef = useRef<Item[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const loadingMoreRef = useRef<boolean>(false);
    const iteratorRef = useRef<{
        id?: string;
        iterator: ResultsIterator<Item>;
        itemsConsumed: number;
    } | null>(null);
    const emptyResultsRef = useRef(false);
    const closeControllerRef = useRef<AbortController | null>(null);
    const waitedOnceRef = useRef(false);

    const [id, setId] = useState<string | undefined>(undefined);

    const reverseRef = useRef(options?.reverse);
    useEffect(() => {
        reverseRef.current = options?.reverse;
    }, [options?.reverse]);

    /* ────────────── util ────────────── */
    const log = (...a: any[]) => {
        if (!options?.debug) return;
        if (typeof options.debug === "boolean") console.log(...a);
        else console.log(options.debug.id, ...a);
    };

    const updateAll = (combined: Item[]) => {
        allRef.current = combined;
        setAll(combined);
    };

    const reset = (
        fromRef: {
            id?: string;
            iterator: ResultsIterator<Item>;
        } | null
    ) => {
        const toClose = iteratorRef.current;
        if (toClose && fromRef && toClose !== fromRef) {
            return;
        }

        iteratorRef.current = null;

        closeControllerRef.current?.abort();
        closeControllerRef.current = new AbortController();
        emptyResultsRef.current = false;

        toClose?.iterator.close();

        allRef.current = [];
        setAll([]);

        setIsLoading(false);
        loadingMoreRef.current = false;
        log("Iterator reset", toClose?.id, fromRef?.id);
        setId(undefined);
    };

    useEffect(() => {
        waitedOnceRef.current = false;
    }, [db, options?.id ?? options?.query, options?.resolve, options?.reverse]);

    /* ────────────── effect: (re)create iterator ────────────── */
    useEffect(() => {
        if (!db || db.closed || options?.query == null) {
            reset(null);
            return;
        }

        const initIterator = () => {
            let id = options?.id ?? uuid();
            let remoteQueryOptions =
                options.remote == null || options.remote === false
                    ? false
                    : {
                          ...(typeof options.remote === "object"
                              ? options.remote
                              : {}),
                          joining:
                              typeof options.remote === "object" &&
                              options.remote.joining?.waitFor !== undefined
                                  ? {
                                        waitFor:
                                            options.remote.joining?.waitFor ??
                                            5e3,
                                        onMissedResults: ({ amount }) => {
                                            loadMore(amount, true);
                                        },
                                    }
                                  : undefined,
                      };
            const ref = {
                id,
                iterator: db.index.iterate(options.query ?? {}, {
                    local: options?.local ?? true,
                    remote: remoteQueryOptions,
                    resolve: options?.resolve,
                    signal: closeControllerRef.current?.signal,
                }) as ResultsIterator<Item>,
                itemsConsumed: 0,
            };
            iteratorRef.current = ref;
            if (options?.prefetch) {
                loadMore();
            }
            setId(id);

            log("Iterator initialised", ref.id);
            return ref;
        };

        reset(iteratorRef.current);
        const newIteratorRef = initIterator();

        /* live-merge listener (optional) */
        let handleChange:
            | ((e: CustomEvent<DocumentsChange<T, I>>) => void | Promise<void>)
            | undefined;

        if (options?.onChange && options.onChange.merge !== false) {
            const mergeFn =
                typeof options.onChange.merge === "function"
                    ? options.onChange.merge
                    : (c: DocumentsChange<T, I>) => c;

            handleChange = async (e: CustomEvent<DocumentsChange<T, I>>) => {
                log("Merge change", e.detail, "iterator", newIteratorRef.id);
                const filtered = await mergeFn(e.detail);
                if (
                    !filtered ||
                    (filtered.added.length === 0 &&
                        filtered.removed.length === 0)
                )
                    return;

                let merged: Item[];
                if (options.onChange?.update) {
                    merged = [
                        ...(await options.onChange?.update(
                            allRef.current,
                            filtered
                        )),
                    ];
                } else {
                    merged = await db.index.updateResults(
                        allRef.current as WithContext<RT>[],
                        filtered,
                        options.query || {},
                        options.resolve ?? true
                    );

                    log("After update", {
                        current: allRef.current,
                        merged,
                        filtered,
                        query: options.query,
                    });
                    const expectedDiff =
                        filtered.added.length - filtered.removed.length;

                    if (
                        merged === allRef.current ||
                        (expectedDiff !== 0 &&
                            merged.length === allRef.current.length)
                    ) {
                        // no change
                        log("no change after merge");
                        return;
                    }
                }

                updateAll(options?.reverse ? merged.reverse() : merged);
            };

            db.events.addEventListener("change", handleChange);
        }

        return () => {
            handleChange &&
                db.events.removeEventListener("change", handleChange);
            reset(newIteratorRef);
        };
    }, [
        db?.closed ? undefined : db?.address,
        options?.id ?? options?.query,
        options?.resolve,
        options?.reverse,
    ]);

    /* ────────────── loadMore (once-wait aware) ────────────── */
    const batchSize = options?.batchSize ?? 10;

    const shouldWait = (): boolean => {
        if (waitedOnceRef.current) {
            return false;
        }
        if (options?.remote === false) return false;
        if (options?.remote === true) return true;
        if (options?.remote == null) return true;
        if (typeof options?.remote === "object") {
            return true;
        }
        return true;
    };

    const markWaited = () => {
        waitedOnceRef.current = true;
    };

    const loadMore = async (
        n: number = batchSize,
        pollEvenIfWasEmpty = false
    ) => {
        const iterator = iteratorRef.current;
        if (
            !iterator ||
            (emptyResultsRef.current && !pollEvenIfWasEmpty) ||
            iterator.iterator.done() ||
            loadingMoreRef.current
        ) {
            return false;
        }

        setIsLoading(true);
        loadingMoreRef.current = true;

        try {
            /* ── optional replicate-wait ── */
            if (shouldWait()) {
                log("Wait for replicators", iterator.id);
                let t0 = Date.now();

                const warmup =
                    typeof options?.remote === "object" &&
                    typeof options?.remote.warmup === "number"
                        ? options?.remote.warmup
                        : undefined;

                if (warmup) {
                    await db?.log
                        .waitForReplicators({
                            timeout: warmup,
                            signal: closeControllerRef.current?.signal,
                        })
                        .catch((e) => {
                            if (
                                e instanceof AbortError ||
                                e instanceof NoPeersError
                            )
                                return;
                            console.warn("Remote replicators not ready", e);
                        })
                        .finally(() => {
                            log(
                                "Wait for replicators done",
                                iterator.id,
                                "time",
                                Date.now() - t0
                            );
                            markWaited();
                        });
                }
            } else {
                log("Skip wait for replicators", iterator.id);
            }

            /* ── fetch next batch ── */
            log("Retrieve next batch", iterator.id);

            let newItems = await iterator.iterator.next(n);

            if (options?.transform) {
                log("Transform start", iterator.id);

                newItems = await Promise.all(newItems.map(options.transform));
                log("Transform end", iterator.id);
            }

            /* iterator might have been reset while we were async… */

            if (iteratorRef.current !== iterator) {
                log("Iterator reset while loading more");
                return false;
            }

            iterator.itemsConsumed += newItems.length;

            emptyResultsRef.current = newItems.length === 0;

            if (newItems.length) {
                log(
                    "Loaded more items for iterator",
                    iterator.id,
                    "current id",
                    iteratorRef.current?.id,
                    "new items",
                    newItems.length,
                    "previous results",
                    allRef.current.length,
                    "batchSize",
                    batchSize,
                    "items consumed",
                    iterator.itemsConsumed
                );
                const prev = allRef.current;
                const dedup = new Set(
                    prev.map((x) => (x as any).__context.head)
                );
                const unique = newItems.filter(
                    (x) => !dedup.has((x as any).__context.head)
                );
                if (!unique.length) return;

                const combined = reverseRef.current
                    ? [...unique.reverse(), ...prev]
                    : [...prev, ...unique];
                updateAll(combined);
            } else {
                log("No new items", iterator.id);
            }
            return !iterator.iterator.done();
        } catch (e) {
            if (!(e instanceof ClosedError)) throw e;
        } finally {
            setIsLoading(false);
            loadingMoreRef.current = false;
        }
    };

    /* ────────────── public API ────────────── */
    return {
        items: all,
        loadMore,
        isLoading,
        empty: () => emptyResultsRef.current,
        id: id,
    };
};
