// PendingCanvasContext.tsx
import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    ReactNode,
    useRef,
} from "react";
import { usePeer, useProgram } from "@peerbit/react";
import { Canvas } from "@giga-app/interface";
import pDefer from "p-defer";

interface PendingCanvasContextType {
    pendingCanvas: Canvas | undefined;
    onSavePending: () => Promise<void>;
    setReplyTo: (canvas: Canvas | undefined) => Promise<void>;
}

const PendingCanvasContext = createContext<
    PendingCanvasContextType | undefined
>(undefined);

export const PendingCanvasProvider: React.FC<{
    viewRoot: Canvas;
    children: ReactNode;
}> = ({ viewRoot, children }) => {
    const { peer } = usePeer();
    const [pendingCanvasState, setPendingCanvasState] = useState<
        Canvas | undefined
    >(undefined);
    const isSaving = useRef(false);

    const pendingCanvas = useProgram<Canvas>(pendingCanvasState, {
        id: pendingCanvasState?.idString,
        keepOpenOnUnmount: true,
        existing: "reuse",
    });

    const [replyTo, _setReplyTo] = useState<Canvas | undefined>(undefined);

    useEffect(() => {
        if (peer && viewRoot) {
            setPendingCanvasState(
                new Canvas({
                    publicKey: peer.identity.publicKey,
                    parent: replyTo || viewRoot,
                })
            );
        }
    }, [peer, viewRoot]);

    const setReplyTo = async (replyTo) => {
        _setReplyTo(replyTo);
        if (isSaving.current) {
            console.log("setReplyTo while saving, ignoring");
            return;
        }
        if (pendingCanvasState) {
            await pendingCanvasState.setParent(replyTo || viewRoot);
            console.log(
                "update parent of pending canvas: " +
                    pendingCanvasState.address.toString(),
                pendingCanvasState.path.length
            );
        }

        setPendingCanvasState(pendingCanvasState);
    };

    const onSavePending = async () => {
        const savePromise = pDefer<void>();
        isSaving.current = true;
        if (viewRoot) {
            setPendingCanvasState((prev) => {
                viewRoot.replies
                    .put(prev)
                    .then(() => savePromise.resolve())
                    .catch(savePromise.reject)
                    .finally(() => {
                        console.log(
                            "SAVED PREV " +
                                prev.address.toString() +
                                "/" +
                                prev.idString +
                                " and creating a new one"
                        );
                        viewRoot.replies.index
                            .iterate({})
                            .all()
                            .then((all) => {
                                console.log("ALL AFTER SAVE REPLIES", all);
                            });
                    });
                //  setReplyTo(null);

                return new Canvas({
                    publicKey: peer.identity.publicKey,
                    parent: viewRoot,
                });
            });
        } else {
            console.error("No viewRoot found");
            savePromise.reject(new Error("No viewRoot found"));
        }
        return savePromise.promise.finally(() => {
            isSaving.current = false;
        });
    };

    return (
        <PendingCanvasContext.Provider
            value={{
                pendingCanvas: pendingCanvas?.program,
                onSavePending,
                setReplyTo,
            }}
        >
            {children}
        </PendingCanvasContext.Provider>
    );
};

export const usePendingCanvas = (): PendingCanvasContextType => {
    const context = useContext(PendingCanvasContext);
    if (!context) {
        throw new Error(
            "usePendingCanvas must be used within a PendingCanvasProvider"
        );
    }
    return context;
};
