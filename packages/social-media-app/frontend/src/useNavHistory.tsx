import { useEffect } from "react";
import { useLocation } from "react-router";

/** We only need pathname+search to recognise an entry */
type Entry = { key: string; path: string };

const stack: Entry[] = [];

/**
 * Call this hook once near the top of your app (e.g. in <App /> or
 * inside the router provider).  It records each history entry as it lands.
 */
export function useRecordLocation() {
    const loc = useLocation();

    useEffect(() => {
        // Avoid duplicates if React re-mounts the same entry
        if (stack.length === 0 || stack[stack.length - 1].key !== loc.key) {
            stack.push({ key: loc.key, path: loc.pathname + loc.search });
        }
    }, [loc.key]);
}

/** Returns the path of the previous history entry, or null if none. */
export function peekPrevPath(): string | null {
    return stack.length > 1 ? stack[stack.length - 2].path : null;
}
