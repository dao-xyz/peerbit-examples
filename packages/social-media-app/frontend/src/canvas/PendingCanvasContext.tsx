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
    savePending: () => Promise<void>;
    setReplyTo: (canvas: Canvas | undefined) => Promise<void>;
    isSaving: boolean;
}

const PendingCanvasContext = createContext<
    PendingCanvasContextType | undefined
>(undefined);

export const PendingCanvasProvider: React.FC<{
    viewRoot: Canvas;
    children: ReactNode;
    pendingCanvas?: Canvas;
}> = ({ viewRoot, children, pendingCanvas: fromPendingCanvas }) => {
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
            if (!pendingCanvasState) {
                const newPendingCanvas =
                    fromPendingCanvas ||
                    new Canvas({
                        publicKey: peer.identity.publicKey,
                        parent: replyTo || viewRoot,
                    });
                setPendingCanvasState(newPendingCanvas);
            } else {
                // set reply to ? we already have auto reply which also does this...
            }
        }
    }, [peer, viewRoot, fromPendingCanvas]);

    useEffect(() => {
        if (
            pendingCanvas.program &&
            pendingCanvas?.program !== pendingCanvasState
        ) {
            setPendingCanvasState(pendingCanvas.program);
        }
    }, [pendingCanvas?.program]);

    const setReplyTo = async (replyTo) => {
        _setReplyTo(replyTo);
        if (isSaving.current) {
            console.log("setReplyTo while saving, ignoring");
            return;
        }
        if (pendingCanvas?.program) {
            await pendingCanvas.program.load();
            await pendingCanvas.program.setParent(replyTo || viewRoot);

            setPendingCanvasState(pendingCanvas.program);
        }

        /*  console.log("UPDATE REPLY TO", { replyTo: replyTo?.idString, viewRoot: viewRoot?.idString, idString: pendingCanvas.program?.idString, address: pendingCanvas.program?.address }); */
    };

    const savePending = async () => {
        const savePromise = pDefer<void>();
        isSaving.current = true;
        if (viewRoot) {
            setPendingCanvasState((prev) => {
                viewRoot
                    .createReply(prev)
                    .then(() => savePromise.resolve())
                    .catch(savePromise.reject);
                /*  .finally(() => {
                     console.log(
                         "SAVED PREV " +
                         prev.address.toString() +
                         "/" +
                         prev.idString +
                         " and creating a new one"
                     );
                 }); */
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
                savePending,
                setReplyTo,
                isSaving: isSaving.current,
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
