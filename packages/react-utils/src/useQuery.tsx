import { useState, useEffect, useRef } from "react";
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

/* ────────────── helper types ────────────── */
type QueryLike = {
    query?: indexerTypes.Query[] | indexerTypes.QueryLike;
    sort?: indexerTypes.Sort[] | indexerTypes.Sort | indexerTypes.SortLike;
};
type QueryOptions = { query: QueryLike; id: string };

type WaitForReplicatorsOption =
    | boolean
    | "once"
    | { type?: "once"; timeout?: number };

/* ────────────── main hook ────────────── */
export const useQuery = <
    T extends Record<string, any>,
    I extends Record<string, any>,
    R extends boolean | undefined = true,
    RT = R extends false ? WithContext<I> : WithContext<T>
>(
    db?: Documents<T, I>,
    options?: {
        resolve?: R;
        waitForReplicators?: WaitForReplicatorsOption;
        transform?: (r: RT) => Promise<RT>;
        debounce?: number;
        debug?: boolean | { id: string };
        reverse?: boolean;
        batchSize?: number;
        onChange?: {
            merge?:
                | boolean
                | ((
                      c: DocumentsChange<T>
                  ) =>
                      | DocumentsChange<T>
                      | Promise<DocumentsChange<T>>
                      | undefined);
            update?: (prev: RT[], change: DocumentsChange<T>) => RT[];
        };
        local?: boolean;
        remote?:
            | boolean
            | {
                  eager?: boolean;
              };
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
    } | null>(null);
    const emptyResultsRef = useRef(false);
    const closeControllerRef = useRef<AbortController | null>(null);
    const waitedOnceRef = useRef(false);

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
        if (iteratorRef.current && iteratorRef.current !== fromRef) return;
        closeControllerRef.current?.abort();
        closeControllerRef.current = new AbortController();
        waitedOnceRef.current = false;
        emptyResultsRef.current = false;

        iteratorRef.current?.iterator.close();
        iteratorRef.current = null;
        allRef.current = [];
        setAll([]);
        setIsLoading(false);
        loadingMoreRef.current = false;
    };

    /* ────────────── effect: (re)create iterator ────────────── */
    useEffect(() => {
        if (!db || db.closed || options?.query == null) {
            reset(null);
            return;
        }

        const initIterator = () => {
            const ref = {
                id: options.id,
                iterator: db.index.iterate(options.query ?? {}, {
                    local: options?.local ?? true,
                    remote: options?.remote ?? true,
                    resolve: options?.resolve,
                }) as ResultsIterator<Item>,
            };
            iteratorRef.current = ref;
            log("Iterator initialised", ref.id);
            loadMore(); // initial batch
            return ref;
        };

        reset(iteratorRef.current);
        const newIteratorRef = initIterator();

        /* live-merge listener (optional) */
        let handleChange:
            | ((e: CustomEvent<DocumentsChange<T>>) => void | Promise<void>)
            | undefined;

        if (options?.onChange && options.onChange.merge !== false) {
            const mergeFn =
                typeof options.onChange.merge === "function"
                    ? options.onChange.merge
                    : (c: DocumentsChange<T>) => c;

            handleChange = async (e: CustomEvent<DocumentsChange<T>>) => {
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
                        ...options.onChange?.update(allRef.current, filtered),
                    ];
                } else {
                    merged = await db.index.updateResults(
                        allRef.current as WithContext<RT>[],
                        filtered,
                        options.query || {},
                        options.resolve ?? true
                    );

                    log(options, "After update", allRef.current, merged);
                    const expectedDiff =
                        filtered.added.length - filtered.removed.length;

                    if (
                        merged === allRef.current ||
                        (expectedDiff !== 0 &&
                            merged.length === allRef.current.length)
                    ) {
                        // no change
                        log(options, "no change after merge");
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
    ]);

    /* ────────────── loadMore (once-wait aware) ────────────── */
    const batchSize = options?.batchSize ?? 10;

    const shouldWait = (): boolean => {
        if (options?.waitForReplicators === false) return false;
        if (options?.waitForReplicators === true) return true;
        if (options?.waitForReplicators === "once")
            return !waitedOnceRef.current;
        if (
            typeof options?.waitForReplicators === "object" &&
            options.waitForReplicators.type === "once"
        )
            return !waitedOnceRef.current;
        return true;
    };

    const waitTimeout =
        typeof options?.waitForReplicators === "object" &&
        typeof options.waitForReplicators.timeout === "number"
            ? options.waitForReplicators.timeout
            : 5_000;

    const markWaited = () => {
        if (
            options?.waitForReplicators === "once" ||
            (typeof options?.waitForReplicators === "object" &&
                options.waitForReplicators.type === "once")
        )
            waitedOnceRef.current = true;
    };

    const loadMore = async () => {
        if (
            !iteratorRef.current ||
            emptyResultsRef.current ||
            iteratorRef.current.iterator.done() ||
            loadingMoreRef.current
        )
            return;

        const iterator = iteratorRef.current;
        setIsLoading(true);
        loadingMoreRef.current = true;

        try {
            /* ── optional replicate-wait ── */
            if (shouldWait()) {
                await db?.log
                    .waitForReplicators({
                        timeout: waitTimeout,
                        signal: closeControllerRef.current?.signal,
                    })
                    .catch((e) => {
                        if (
                            e instanceof AbortError ||
                            e instanceof NoPeersError
                        )
                            return;
                        console.warn("Remote replicators not ready", e);
                    });
                markWaited();
            }

            /* ── fetch next batch ── */
            let newItems = await iterator.iterator.next(batchSize);

            if (options?.transform)
                newItems = await Promise.all(newItems.map(options.transform));

            /* iterator might have been reset while we were async… */
            if (iteratorRef.current !== iterator) return;

            emptyResultsRef.current = newItems.length === 0;

            if (newItems.length) {
                const prev = allRef.current;
                const dedup = new Set(
                    prev.map((x) => (x as any).__context.head)
                );
                const unique = newItems.filter(
                    (x) => !dedup.has((x as any).__context.head)
                );
                if (!unique.length) return;

                const combined = options?.reverse
                    ? [...unique.reverse(), ...prev]
                    : [...prev, ...unique];
                updateAll(combined);
            }
        } catch (e) {
            if (!(e instanceof ClosedError)) throw e;
        } finally {
            setIsLoading(false);
            loadingMoreRef.current = false;
        }
    };

    /* ────────────── public API ────────────── */
    return { items: all, loadMore, isLoading, empty: emptyResultsRef.current };
};
