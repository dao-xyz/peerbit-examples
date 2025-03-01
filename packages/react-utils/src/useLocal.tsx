import { ClosedError, Documents, SearchRequest } from "@peerbit/document";
import { useEffect, useState } from "react";
export const useLocal = <T extends Record<string, any>>(
    db?: Documents<T, any>,
    options?: {
        onChanges?: (all: T[]) => void;
    }
) => {
    const [all, setAll] = useState<T[]>([]);
    useEffect(() => {
        if (!db || db.closed) {
            return;
        }

        const changeListener = async () => {
            try {
                const all = await db.index.search(new SearchRequest(), {
                    local: true,
                    remote: false,
                });
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
    }, [db?.address, db?.closed]);
    return all;
};
