import { useEffect } from "react";
import { useLocation, useNavigationType, NavigationType } from "react-router";

/** We only need pathname+search to recognise an entry */
type Entry = { key: string; path: string };

const stack: Entry[] = [];

/**
 * Call this hook once near the top of your app (e.g. in <App /> or
 * inside the router provider).  It records each history entry as it lands.
 * If navigation happened with { replace: true } we overwrite the
 * current entry instead of pushing a new one.
 */
export function useRecordLocation() {
    const loc = useLocation();
    const navType = useNavigationType(); // "PUSH" | "REPLACE" | "POP"

    useEffect(() => {
        const path = loc.pathname + loc.search;

        // If the stack is empty just push.
        if (stack.length === 0) {
            stack.push({ key: loc.key, path });
            return;
        }

        if (navType === "REPLACE") {
            // Overwrite the last entry
            stack[stack.length - 1] = { key: loc.key, path };
            console.log("REPLACE!", stack);
        } else if (navType === "PUSH") {
            // Avoid duplicates caused by React remounting the same entry
            if (stack[stack.length - 1].key !== loc.key) {
                stack.push({ key: loc.key, path });
                console.log("PUSH", stack);
            }
        }
        // "POP" doesn’t modify the stack because the browser
        // is moving among entries we already recorded.
    }, [loc.key, loc.pathname, loc.search, navType]);
}

/** Returns the path of the previous history entry, or null if none. */
export function peekPrevPaths(i: number): string | null {
    return i < stack.length ? stack[stack.length - 1 - i].path : null;
}

/** Remove the last `i` paths from the stack. */
export function consumePaths(i: number) {
    stack.splice(-i, i);
}
