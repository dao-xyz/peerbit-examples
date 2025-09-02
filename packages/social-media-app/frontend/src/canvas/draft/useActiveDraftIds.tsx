import { useEffect, useMemo, useState } from "react";
import { useDraftManager } from "../edit/draft/DraftManager";

export const useActiveDraftIds = () => {
    const mgr = useDraftManager();
    const [ver, setVer] = useState(0);

    useEffect(() => mgr.subscribe(() => setVer(v => v + 1)), [mgr]);

    // Derive a stable Set<string> of active ids
    return useMemo(() => {
        const ids = new Set<string>();
        for (const c of mgr.listActiveIds()) {
            if (c) ids.add(c);
        }
        return ids;
    }, [mgr, ver]);
};