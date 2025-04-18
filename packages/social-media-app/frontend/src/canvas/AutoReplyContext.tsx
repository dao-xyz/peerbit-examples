import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    ReactNode,
    useRef,
} from "react";

import { Canvas, CanvasAddressReference } from "@giga-app/interface";
import { usePendingCanvas } from "./PendingCanvasContext";
import { useCanvas } from "./CanvasWrapper";
import { useView } from "../view/ViewContex";

interface AutoReplyContextType {
    replyTo?: Canvas | undefined;
    setReplyTo: (canvas: Canvas | undefined) => void;
    disable: () => void;
}

const AutoReplyContext = createContext<AutoReplyContextType | undefined>(
    undefined
);

export const AutoReplyProvider: React.FC<{
    children: ReactNode;
}> = ({ children }) => {
    const { setReplyTo: setReplyToCanvas, pendingCanvas } = usePendingCanvas();
    const { subscribeContentChange, mutate, pendingRects } = useCanvas();
    const typedOnce = useRef(false);
    const { view, processedReplies, viewRoot } = useView();
    const [replyTo, _setReplyTo] = useState<Canvas | undefined>(viewRoot);
    const lastPendingCanvasId = useRef<string | undefined>(undefined);
    const enabled = useRef(true);

    const setReplyTo = async (canvas: Canvas | undefined) => {
        let canvasOrRoot = canvas || viewRoot;
        _setReplyTo(canvasOrRoot);
        await setReplyToCanvas(canvasOrRoot);
    };

    useEffect(() => {
        setReplyTo(viewRoot);
    }, [viewRoot]); // reset replyTo when viewRoot changes

    /**
     * If the pending canvas has updated their path, we need to update all pending rects too
     */
    useEffect(() => {
        if (!pendingCanvas || pendingCanvas.closed) {
            return;
        }
        typedOnce.current = false; // reset typedOnce when pending canvas changes
        const newPath = [
            ...pendingCanvas.path,
            new CanvasAddressReference({ canvas: pendingCanvas }),
        ];
        mutate((element) => {
            element.path = newPath;
            return true;
        });
    }, [pendingCanvas?.closed === false ? pendingCanvas?.address : undefined]); // important is to observe address changes, not just path changes because address depends on the path

    useEffect(() => {
        // reset replyTo when pending canvas changes
        if (
            pendingCanvas &&
            pendingCanvas.idString !== lastPendingCanvasId.current
        ) {
            lastPendingCanvasId.current = pendingCanvas?.idString;
            console.log("SET REPLY TO VIEWROOT", viewRoot);
            setReplyTo(replyTo ?? viewRoot);

            enabled.current = true; // we can enable auto reply again, because we are going into a new canvas draft
        }
    }, [pendingCanvas?.idString]);

    const autoReplyFunctionality = () => {
        let last = processedReplies[processedReplies.length - 1]?.reply;
        if (
            view === "chat" &&
            last &&
            (replyTo == null ||
                (replyTo.idString === viewRoot.idString &&
                    last.idString !== viewRoot.idString))
        ) {
            console.log("AUTO REPLY TO", last);
            setReplyTo(last);
        }
    };

    const contentChangeCallback = (_elements) => {
        if (!enabled.current) {
            console.log("Auto reply disabled");
            return;
        }

        typedOnce.current = true;

        for (const element of pendingRects) {
            if (!element.content.isEmpty) {
                autoReplyFunctionality();
                return;
            }
        }
        setReplyTo(null); // clear replyTo when content changes to null
    };

    useEffect(() => {
        const unsubscribe = subscribeContentChange(contentChangeCallback);
        return () => {
            unsubscribe();
        };
    }, [subscribeContentChange, contentChangeCallback, pendingCanvas]);

    useEffect(() => {
        // this behaviour we only want if we have not typed anything
        /*    if (typedOnce.current) {
               return;
           }
    */
        // auto reply to the last processed reply
        if (view === "chat") {
            if (processedReplies.length > 0) {
                let last = processedReplies[processedReplies.length - 1]?.reply;
                if (
                    view === "chat" &&
                    last &&
                    replyTo.address !== last.address
                ) {
                    console.log("AUTO REPLY TO", last, processedReplies.length);
                    setReplyTo(last);
                }
            }
        } else {
            setReplyTo(viewRoot); // clear replyTo when not in chat view
        }
    }, [processedReplies]);

    return (
        <AutoReplyContext.Provider
            value={{
                replyTo,
                setReplyTo,
                disable: () => {
                    enabled.current = false;
                    setReplyTo(null);
                },
            }}
        >
            {children}
        </AutoReplyContext.Provider>
    );
};

export const useAutoReply = (): AutoReplyContextType => {
    const context = useContext(AutoReplyContext);
    if (!context) {
        throw new Error("useAutoReply must be used within a AutoReplyProvider");
    }
    return context;
};
