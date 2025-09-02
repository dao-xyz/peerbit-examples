import { useState, useEffect, useRef, useMemo } from "react";
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
import { WithIndexedContext } from "@peerbit/document";

type QueryOptions = { query: QueryLike; id?: string };

/* ────────────── helper types ────────────── */
export type QueryLike = {
    /** Mongo-style selector or array of selectors */
    query?: indexerTypes.QueryLike | indexerTypes.Query[];
    /** Sort definition compatible with `@peerbit/indexer-interface` */
    sort?: indexerTypes.SortLike | indexerTypes.Sort | indexerTypes.Sort[];
};

/**
 * All the non-DB-specific options supported by the original single-DB hook.
 * They stay fully backward-compatible.
 */
export type UseQuerySharedOptions<T, I, R extends boolean | undefined, RT> = {
    /* original behavioural flags */
    resolve?: R;
    transform?: (r: RT) => Promise<RT>;
    debounce?: number;
    debug?: boolean | { id: string };
    reverse?: boolean;
    batchSize?: number;
    prefetch?: boolean;
    ignoreUpdates?: boolean;
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
    remote?:
        | boolean
        | {
              warmup?: number;
              joining?: { waitFor?: number };
              eager?: boolean;
          };
} & QueryOptions;

/* ────────────────────────── Main Hook ────────────────────────── */
/**
 * `useQuery` – unified hook that accepts **either**
 *   1. a single `Documents` instance
 *   2. an array of `Documents` instances
 *   3. *or* omits the first argument and provides `dbs` inside the `options` object.
 *
 * It supersedes the original single-DB version as well as the experimental
 * `useMultiQuery` so callers never have to choose between two APIs.
 */
export const useQuery = <
    T extends Record<string, any>,
    I extends Record<string, any>,
    R extends boolean | undefined = true,
    RT = R extends false ? WithContext<I> : WithIndexedContext<T, I>
>(
    /** Single DB or list of DBs. 100 % backward-compatible with the old single param. */
    dbOrDbs: Documents<T, I> | Documents<T, I>[] | undefined,
    options: UseQuerySharedOptions<T, I, R, RT>
) => {
    /* ─────── internal type alias for convenience ─────── */
    type Item = RT;

    /* ────────────── normalise DBs input ────────────── */
    const dbs = useMemo<(Documents<T, I> | undefined)[]>(() => {
        if (Array.isArray(dbOrDbs)) return dbOrDbs;
        if (dbOrDbs) return [dbOrDbs];
        return [];
    }, [dbOrDbs]);

    /* ────────────── state & refs ────────────── */
    const [all, setAll] = useState<Item[]>([]);
    const allRef = useRef<Item[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const iteratorRefs = useRef<
        {
            id: string;
            db: Documents<T, I>;
            iterator: ResultsIterator<Item>;
            itemsConsumed: number;
        }[]
    >([]);
    const emptyResultsRef = useRef(false);
    const closeControllerRef = useRef<AbortController | null>(null);
    const waitedOnceRef = useRef(false);

    /* keep an id mostly for debugging – mirrors original behaviour */
    const [id, setId] = useState<string | undefined>(options.id);

    const reverseRef = useRef(options.reverse);
    useEffect(() => {
        reverseRef.current = options.reverse;
    }, [options.reverse]);

    /* ────────────── utilities ────────────── */
    const log = (...a: any[]) => {
        if (!options.debug) return;
        if (typeof options.debug === "boolean") console.log(...a);
        else console.log(options.debug.id, ...a);
    };

    const updateAll = (combined: Item[]) => {
        allRef.current = combined;
        setAll(combined);
    };

    const reset = () => {
        iteratorRefs.current.forEach(({ iterator }) => iterator.close());
        iteratorRefs.current = [];

        closeControllerRef.current?.abort();
        closeControllerRef.current = new AbortController();
        emptyResultsRef.current = false;
        waitedOnceRef.current = false;

        allRef.current = [];
        setAll([]);
        setIsLoading(false);
        log("Iterators reset");
    };

    /* ────────── rebuild iterators when db list / query etc. change ────────── */
    useEffect(() => {
        /* derive canonical list of open DBs */
        const openDbs = dbs.filter((d): d is Documents<T, I> =>
            Boolean(d && !d.closed)
        );
        const { query, resolve } = options;

        if (!openDbs.length || query == null) {
            reset();
            return;
        }

        reset();
        const abortSignal = closeControllerRef.current?.signal;

        iteratorRefs.current = openDbs.map((db) => {
            const iterator = db.index.iterate(query ?? {}, {
                local: options.local ?? true,
                remote: options.remote ?? undefined,
                resolve,
                signal: abortSignal,
            }) as ResultsIterator<Item>;

            const ref = { id: uuid(), db, iterator, itemsConsumed: 0 };
            log("Iterator init", ref.id, "db", db.address);
            return ref;
        });

        /* prefetch if requested */
        if (options.prefetch) void loadMore();
        /* store a deterministic id (useful for external keys) */
        setId(uuid());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        dbs.map((d) => d?.address).join("|"),
        options.query,
        options.resolve,
        options.reverse,
    ]);

    /* ────────────── loadMore implementation ────────────── */
    const batchSize = options.batchSize ?? 10;

    const shouldWait = (): boolean => {
        if (waitedOnceRef.current) return false;
        if (options.remote === false) return false;
        return true; // mimic original behaviour – wait once if remote allowed
    };

    const markWaited = () => {
        waitedOnceRef.current = true;
    };

    const loadMore = async (n: number = batchSize): Promise<boolean> => {
        const iterators = iteratorRefs.current;
        if (!iterators.length || emptyResultsRef.current) return false;

        setIsLoading(true);
        try {
            /* one-time replicator warm-up across all DBs */
            if (shouldWait()) {
                if (
                    typeof options.remote === "object" &&
                    options.remote.warmup
                ) {
                    await Promise.all(
                        iterators.map(async ({ db }) => {
                            try {
                                await db.log.waitForReplicators({
                                    timeout: (options.remote as { warmup })
                                        .warmup,
                                    signal: closeControllerRef.current?.signal,
                                });
                            } catch (e) {
                                if (
                                    e instanceof AbortError ||
                                    e instanceof NoPeersError
                                )
                                    return;
                                console.warn("Remote replicators not ready", e);
                            }
                        })
                    );
                }
                markWaited();
            }

            /* pull items round-robin */
            const newlyFetched: Item[] = [];
            for (const ref of iterators) {
                if (ref.iterator.done()) continue;
                const batch = await ref.iterator.next(n); // pull up to <n> at once
                if (batch.length) {
                    ref.itemsConsumed += batch.length;
                    newlyFetched.push(...batch);
                }
            }

            if (!newlyFetched.length) {
                emptyResultsRef.current = iterators.every((i) =>
                    i.iterator.done()
                );
                return !emptyResultsRef.current;
            }

            /* optional transform */
            let processed = newlyFetched;
            if (options.transform) {
                processed = await Promise.all(processed.map(options.transform));
            }

            /* deduplicate & merge */
            const prev = allRef.current;
            const dedupHeads = new Set(
                prev.map((x) => (x as any).__context.head)
            );
            const unique = processed.filter(
                (x) => !dedupHeads.has((x as any).__context.head)
            );
            if (!unique.length)
                return !iterators.every((i) => i.iterator.done());

            const combined = reverseRef.current
                ? [...unique.reverse(), ...prev]
                : [...prev, ...unique];
            updateAll(combined);

            emptyResultsRef.current = iterators.every((i) => i.iterator.done());
            return !emptyResultsRef.current;
        } catch (e) {
            if (!(e instanceof ClosedError)) throw e;
            return false;
        } finally {
            setIsLoading(false);
        }
    };

    /* ────────────── live-merge listeners ────────────── */
    useEffect(() => {
        if (!options.onChange || options.onChange.merge === false) return;

        const listeners = iteratorRefs.current.map(({ db, id: itId }) => {
            const mergeFn =
                typeof options.onChange?.merge === "function"
                    ? options.onChange.merge
                    : (c: DocumentsChange<T, I>) => c;

            const handler = async (e: CustomEvent<DocumentsChange<T, I>>) => {
                log("Merge change", e.detail, "it", itId);
                const filtered = await mergeFn(e.detail);
                if (
                    !filtered ||
                    (!filtered.added.length && !filtered.removed.length)
                )
                    return;

                let merged: Item[];
                if (options.onChange?.update) {
                    merged = await options.onChange.update(
                        allRef.current,
                        filtered
                    );
                } else {
                    merged = await db.index.updateResults(
                        allRef.current as WithContext<RT>[],
                        filtered,
                        options.query || {},
                        options.resolve ?? true
                    );
                }
                updateAll(options.reverse ? merged.reverse() : merged);
            };
            db.events.addEventListener("change", handler);
            return { db, handler };
        });

        return () => {
            listeners.forEach(({ db, handler }) =>
                db.events.removeEventListener("change", handler)
            );
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        iteratorRefs.current.map((r) => r.db.address).join("|"),
        options.onChange,
    ]);

    /* ────────────── public API – unchanged from the caller's perspective ────────────── */
    return {
        items: all,
        loadMore,
        isLoading,
        empty: () => emptyResultsRef.current,
        id,
    };
};
