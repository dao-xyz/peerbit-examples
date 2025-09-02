// AutoSaveBridge.tsx
import React, { useEffect, useMemo } from "react";
import debounce from "lodash/debounce";
import { useCanvas } from "../../CanvasWrapper";
import { PrivateScope } from "../../useScope";
import { useDraftSession } from "./DraftSession";

export const AutoSaveBridge: React.FC<{ enabled?: boolean }> = ({
    enabled,
}) => {
    const { savePending, pendingRects, subscribeContentChange } = useCanvas();
    const privateScope = PrivateScope.useScope();
    const session = useDraftSession();

    const flush = useMemo(
        () =>
            debounce(async () => {
                if (!enabled || !privateScope) return;
                // 1) persist pending rects to the draft’s private scope
                await savePending(privateScope).catch(() => void 0);
                // 2) kick the DraftManager’s debounced save too (metadata etc.)
                session.saveDebounced();
            }, 200),
        [enabled, privateScope, savePending, session]
    );

    // call on each content mutation event
    useEffect(() => {
        const unsub = subscribeContentChange(() => flush());
        return () => {
            unsub();
            flush.cancel();
        };
    }, [flush, subscribeContentChange]);

    // also react to presence of non-empty pending rects (e.g. programmatic inserts)
    useEffect(() => {
        if (!enabled) return;
        if (pendingRects.some((p) => !p.content.isEmpty)) flush();
    }, [enabled, pendingRects, flush]);

    // safety: flush on unmount if something is pending
    /* useEffect(() => {
        return () => {
            if (!enabled || !privateScope) return;
            // fire-and-forget
            savePending(privateScope).catch(() => void 0);
        };
    }, [enabled, privateScope, savePending]); */

    return null;
};
