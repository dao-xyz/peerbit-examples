import {
    ClosedError,
    Documents,
    Query,
    SearchRequest,
    Sort,
} from "@peerbit/document";
import { useEffect, useState } from "react";

type ValueTypeFromRequest<
    Resolve extends boolean | undefined,
    T,
    I
> = Resolve extends false ? I : T;

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
    const [all, setAll] = useState<RT[]>([]);
    useEffect(() => {
        if (!db || db.closed) {
            return;
        }

        const changeListener = async () => {
            try {
                const all: RT[] = (await db.index.search(
                    new SearchRequest(options?.query),
                    {
                        local: true,
                        remote: false,
                        resolve: options?.resolve as any,
                    }
                )) as any; // TODO types
                setAll((_prev) => {
                    options?.onChanges?.(all);
                    return all;
                });
            } catch (error) {
                if (error instanceof ClosedError) {
                    // ignore
                    return;
                }
                throw error;
            }
        };

        changeListener();
        db.events.addEventListener("change", changeListener);

        return () => db.events.addEventListener("change", changeListener);
    }, [db?.closed ? undefined : db?.address]);
    return all;
};
