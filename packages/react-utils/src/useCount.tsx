import { ClosedError, Documents, WithContext } from "@peerbit/document";
import { useEffect, useRef, useState } from "react";
import * as indexerTypes from "@peerbit/indexer-interface";
import { debounceLeadingTrailing } from "./utils";

type QueryOptons = {
    query: indexerTypes.Query[] | indexerTypes.QueryLike;
    id: string;
};
export const useCount = <T extends Record<string, any>>(
    db?: Documents<T, any, any>,
    options?: {
        debounce?: number;
        debug?: boolean; // add debug option here
    } & QueryOptons
) => {
    const [count, setCount] = useState<number>(0);
    const countRef = useRef<number>(0);

    useEffect(() => {
        if (!db || db.closed) {
            return;
        }

        const _l = async (args?: any) => {
            try {
                const count = await db.count({
                    query: options?.query,
                    approximate: true,
                });
                countRef.current = count;
                setCount(count);
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
            debounced();
            /* TODO change count frequency when we have low counts
             if (countRef.current === 0) {
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
            } */
        };

        debounced();
        db.events.addEventListener("change", handleChange);

        return () => {
            db.events.removeEventListener("change", handleChange);
            debounced.cancel();
        };
    }, [db?.closed ? undefined : db?.rootAddress, options?.id]);

    return count;
};
