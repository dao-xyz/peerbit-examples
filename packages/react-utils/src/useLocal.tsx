import { ClosedError, Documents, SearchRequest } from "@peerbit/document";
import { useEffect, useState } from "react";
export const useLocal = <T extends Record<string, any>>(
    db?: Documents<T, any>
) => {
    const [all, setAll] = useState<T[]>([]);
    useEffect(() => {
        if (!db || db.closed) {
            return;
        }

        const changeListener = async () => {
            try {
                setAll(
                    await db.index.search(new SearchRequest(), {
                        local: true,
                        remote: false,
                    })
                );
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
