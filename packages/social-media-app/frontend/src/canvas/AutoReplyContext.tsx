import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    ReactNode,
    useRef,
} from "react";

import { Canvas, CanvasAddressReference } from "@giga-app/interface";
import { usePendingCanvas } from "./edit/PendingCanvasContext";
import { useCanvas } from "./CanvasWrapper";
import { useView } from "./view/ViewContext";
import { useFeed } from "./feed/FeedContext";

interface AutoReplyContextType {
    typedOnce: boolean;
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
    const { view, processedReplies, feedRoot } = useFeed();
    const [replyTo, _setReplyTo] = useState<Canvas | undefined>(feedRoot);
    const lastPendingCanvasId = useRef<string | undefined>(undefined);
    const enabled = useRef(true);

    const setReplyTo = async (canvas: Canvas | undefined) => {
        let canvasOrRoot = canvas || feedRoot;
        _setReplyTo(canvasOrRoot);
        await setReplyToCanvas(canvasOrRoot);
        lastPendingCanvasId.current = pendingCanvas?.idString;
    };

    useEffect(() => {
        setReplyTo(feedRoot);
    }, [feedRoot]); // reset replyTo when viewRoot changes

    /**
     * If the pending canvas has updated their path, we need to update all pending rects too
     */
    useEffect(() => {
        if (!pendingCanvas || pendingCanvas.closed) {
            return;
        }
        typedOnce.current = false; // reset typedOnce when pending canvas changes

        mutate((element) => {
            element.canvasId = pendingCanvas.id;
            return true;
        });
    }, [pendingCanvas?.closed === false ? pendingCanvas?.address : undefined]); // important is to observe address changes, not just path changes because address depends on the path

    /*  useEffect(() => { TODO when do we neeed this?
         // reset replyTo when pending canvas changes
         console.log(pendingCanvas?.idString)
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
  */
    const autoReplyFunctionality = () => {
        if (!processedReplies) {
            return;
        }
        let last = processedReplies[processedReplies.length - 1]?.reply;
        if (
            view?.id === "chat" &&
            last &&
            (replyTo == null ||
                (replyTo.idString === feedRoot.idString &&
                    last.idString !== feedRoot.idString))
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
        /*    
        if (typedOnce.current) {
            return;
        }
        */
        // auto reply to the last processed reply
        if (view?.id === "chat") {
            if (processedReplies?.length > 0) {
                let last = processedReplies[processedReplies.length - 1]?.reply;
                if (
                    view.id === "chat" &&
                    last &&
                    replyTo.address !== last.address
                ) {
                    setReplyTo(last);
                }
            }
        } else {
            setReplyTo(feedRoot); // clear replyTo when not in chat view
        }
    }, [view, processedReplies]);

    return (
        <AutoReplyContext.Provider
            value={{
                typedOnce: typedOnce.current,
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
