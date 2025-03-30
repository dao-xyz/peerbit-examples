import { ClosedError, Documents, WithContext } from "@peerbit/document";
import { useEffect, useRef, useState } from "react";
import * as indexerTypes from "@peerbit/indexer-interface";
import { debounceLeadingTrailing } from "./utils";

type QueryLike = {
    query?: indexerTypes.Query[] | indexerTypes.QueryLike;
    sort?: indexerTypes.Sort[] | indexerTypes.Sort | indexerTypes.SortLike;
};
type QueryOptons = {
    query: QueryLike;
    id: string;
};

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

        let ts = setTimeout(() => {
            _l();
        }, 3000);

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

        debounced();
        db.events.addEventListener("change", handleChange);

        return () => {
            db.events.removeEventListener("change", handleChange);
            debounced.cancel();
            clearTimeout(ts);
        };
    }, [
        db?.closed ? undefined : db?.rootAddress,
        options?.id,
        options?.resolve,
        options?.onChanges,
    ]);

    return all;
};
