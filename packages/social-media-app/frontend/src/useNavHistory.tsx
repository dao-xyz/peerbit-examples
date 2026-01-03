import { useEffect } from "react";
import { useLocation, useNavigationType, NavigationType } from "react-router";

/** We only need pathname+search to recognise an entry */
type Entry = { key: string; path: string };

const stack: Entry[] = [];
let currentIdx: number | undefined;

const historyIdx = () => {
    try {
        const idx = (window.history.state as any)?.idx;
        return typeof idx === "number" ? idx : undefined;
    } catch {
        return undefined;
    }
};

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
        const idx = historyIdx();

        if (typeof idx === "number") {
            // When a user goes "back" and then navigates forward via PUSH,
            // the browser discards forward history. Mirror that in our stack.
            if (navType === NavigationType.Push) {
                stack.length = idx + 1;
            } else if (stack.length <= idx) {
                stack.length = idx + 1;
            }

            stack[idx] = { key: loc.key, path };
            currentIdx = idx;
            return;
        }

        // Fallback: no history idx (non-browser environments). Keep best-effort stack order.
        if (stack.length === 0) {
            stack.push({ key: loc.key, path });
            currentIdx = 0;
            return;
        }

        if (navType === NavigationType.Replace) {
            stack[stack.length - 1] = { key: loc.key, path };
            currentIdx = stack.length - 1;
        } else if (navType === NavigationType.Push) {
            if (stack[stack.length - 1].key !== loc.key) {
                stack.push({ key: loc.key, path });
            }
            currentIdx = stack.length - 1;
        } else if (navType === NavigationType.Pop) {
            currentIdx = stack.length - 1;
        }
    }, [loc.key, loc.pathname, loc.search, navType]);
}

/** Returns the path of the previous history entry, or null if none. */
export function peekPrevPaths(i: number): string | null {
    const idx = (currentIdx ?? stack.length - 1) - i;
    if (idx < 0) return null;
    return stack[idx]?.path ?? null;
}

/** Best-effort: drop forward history from the current index. */
export function consumePaths() {
    const idx = currentIdx ?? stack.length - 1;
    if (idx >= 0) stack.length = idx + 1;
}
