// draft/DraftEditor.tsx
import React, { useEffect, useMemo } from "react";
import debounce from "lodash/debounce";
import { CanvasWrapper, useCanvas } from "../../CanvasWrapper";
import { AutoReplyProvider } from "../../AutoReplyContext";
import { useDraftSession } from "./DraftSession";
import { PrivateScope } from "../../useScope";

const AutoSaveBridge: React.FC<{ enabled?: boolean }> = ({ enabled }) => {
    const session = useDraftSession(); // for DraftManager.saveDebounced()
    const privateScope = PrivateScope.useScope();
    const { subscribeContentChange, savePending, pendingRects } = useCanvas();

    const flush = useMemo(
        () =>
            debounce(async () => {
                if (!enabled || !privateScope) return;
                try {
                    console.log("AutoSaveBridge: flush");
                    // 1) persist pending rects into PRIVATE scope
                    await savePending(privateScope);
                    // 2) trigger DraftManager debounced save (so publish rotation has data)
                    session.saveDebounced();
                } catch (e) {
                    console.error("Failed to save pending changes", e);
                }
            }, 200),
        [enabled, privateScope, session]
    );

    useEffect(() => () => flush.cancel(), [flush]);

    useEffect(() => {
        // subscribe to *element-level* changes coming from CanvasWrapper
        return subscribeContentChange((el) => {
            if (!enabled) return;
            if (!el.content.isEmpty) flush();
        });
    }, [enabled, subscribeContentChange, flush]);

    // Flush on unmount (e.g., reload) if there are pending changes
    useEffect(() => {
        return () => {
            if (!enabled || !privateScope) return;
            savePending(privateScope).catch(() => void 0);
        };
    }, [enabled, privateScope, savePending]);

    // Ensure we don't miss the initial save if privateScope becomes ready after first edits
    useEffect(() => {
        if (!enabled || !privateScope) return;
        const hasNonEmptyPendings = pendingRects?.some(
            (p) => !p.content.isEmpty
        );
        if (hasNonEmptyPendings) {
            (async () => {
                try {
                    await savePending(privateScope);
                    session.saveDebounced();
                } catch (e) {
                    console.error("AutoSaveBridge: initial flush failed", e);
                }
            })();
        }
        // re-check when scope changes or pendings length changes
    }, [enabled, privateScope?.address, pendingRects?.length]);

    return null;
};

export const DraftEditor: React.FC<{
    children: React.ReactNode;
    autoSave?: boolean;
    autoReply?: boolean;
    placeholder?: string;
    classNameContent?: string;
    debug?: boolean;
}> = ({
    children,
    autoSave,
    autoReply,
    placeholder,
    classNameContent,
    debug,
}) => {
    const session = useDraftSession();

    return (
        <CanvasWrapper
            canvas={session.draft}
            draft
            multiCanvas
            placeholder={placeholder}
            classNameContent={classNameContent}
            debug={debug}
        >
            {/* Lives INSIDE CanvasWrapper so it can use useCanvas() */}
            <AutoSaveBridge enabled={!!autoSave} />
            <AutoReplyProvider disabled={!autoReply}>
                {children}
            </AutoReplyProvider>
        </CanvasWrapper>
    );
};
