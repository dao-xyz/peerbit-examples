import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { ChildVisualization } from "@giga-app/interface";
import { useCanvas } from "./CanvasWrapper";
import { useStream } from "./feed/StreamContext";
import { useVisualizationContext } from "./custom/CustomizationProvider";
import { useDraftSession } from "./edit/draft/DraftSession";

interface AutoReplyContextType {
    typedOnce: boolean;
    replyTo?: any;
    setReplyTo: (c: any | undefined) => void;
    disable: () => void;
}

const AutoReplyContext = createContext<AutoReplyContextType | undefined>(undefined);

export const AutoReplyProvider: React.FC<{ children: React.ReactNode; disabled?: boolean; }> = ({ children, disabled }) => {
    const { subscribeContentChange, pendingRects, } = useCanvas();
    const { processedReplies, feedRoot } = useStream();
    const { visualization } = useVisualizationContext();
    const session = useDraftSession();

    const [replyTo, _setReplyTo] = useState(feedRoot);
    const typedOnce = useRef(false);
    const enabled = useRef(disabled !== undefined ? !disabled : true);

    useEffect(() => { enabled.current = disabled !== undefined ? !disabled : true; }, [disabled]);

    const isChat = visualization?.view === ChildVisualization.CHAT;

    const setReplyTo = async (canvas?: any) => {
        if (!enabled.current) return;
        const target = canvas ?? feedRoot;
        _setReplyTo(target);
        session.setReplyTarget(target);
    };

    useEffect(() => { setReplyTo(feedRoot); /* reset when root changes */ }, [feedRoot?.idString]); // eslint-disable-line

    const autoPickReplyTarget = () => {
        if (!processedReplies?.length) return;
        const last = processedReplies[processedReplies.length - 1]?.reply;
        const current = session.getReplyTarget();
        if (isChat && last && (!current || (current.idString === feedRoot?.idString && last.idString !== feedRoot?.idString))) {
            setReplyTo(last);
        }
    };

    useEffect(() => {
        const cb = () => {
            if (!enabled.current) return;
            typedOnce.current = true;
            for (const el of pendingRects) {
                if (!el.content.isEmpty) { autoPickReplyTarget(); return; }
            }
            setReplyTo(undefined);
        };
        const unsubscribe = subscribeContentChange(cb);
        return () => unsubscribe();
    }, [subscribeContentChange, pendingRects, isChat, processedReplies]); // eslint-disable-line

    useEffect(() => {
        if (isChat) {
            const last = processedReplies?.[processedReplies.length - 1]?.reply;
            if (last && replyTo?.idString !== last.idString) setReplyTo(last);
        } else {
            setReplyTo(feedRoot);
        }
    }, [isChat, processedReplies]); // eslint-disable-line

    return (
        <AutoReplyContext.Provider value={{
            typedOnce: typedOnce.current,
            replyTo,
            setReplyTo,
            disable: () => { enabled.current = false; setReplyTo(undefined); },
        }}>
            {children}
        </AutoReplyContext.Provider>
    );
};

export const useAutoReply = (): AutoReplyContextType => {
    const ctx = useContext(AutoReplyContext);
    if (!ctx) throw new Error("useAutoReply must be used within a AutoReplyProvider");
    return ctx;
};