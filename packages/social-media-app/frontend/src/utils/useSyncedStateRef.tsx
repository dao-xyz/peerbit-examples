import { useCallback, useRef, useState } from "react";

export function useSyncedStateRef<T>(initial: T) {
    const [state, _setState] = useState<T>(initial);
    const ref = useRef<T>(state);

    const set = useCallback((next: React.SetStateAction<T>) => {
        _setState(prev => {
            const v = typeof next === "function" ? (next as any)(prev) : next;
            ref.current = v;
            return v;
        });
    }, []);

    return { state, set, ref }; // ref.current is always in lockstep
}