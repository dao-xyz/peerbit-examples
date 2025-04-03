// PendingCanvasContext.tsx
import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    ReactNode,
} from "react";
import { usePeer, useProgram } from "@peerbit/react";
import { Canvas } from "@giga-app/interface";
import pDefer from "p-defer";

interface PendingCanvasContextType {
    pendingCanvas: Canvas | undefined;
    onSavePending: () => Promise<void>;
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

    useEffect(() => {
        if (peer && viewRoot) {
            setPendingCanvasState(
                new Canvas({
                    publicKey: peer.identity.publicKey,
                    parent: viewRoot,
                })
            );
        }
    }, [peer, viewRoot]);

    const pendingCanvas = useProgram<Canvas>(pendingCanvasState, {
        id: pendingCanvasState?.idString,
        keepOpenOnUnmount: true,
        existing: "reuse",
    });

    const onSavePending = async () => {
        const savePromise = pDefer();
        if (viewRoot) {
            setPendingCanvasState((prev) => {
                viewRoot.replies
                    .put(prev)
                    .then(savePromise.resolve)
                    .catch(savePromise.reject);
                return new Canvas({
                    publicKey: peer.identity.publicKey,
                    parent: viewRoot,
                });
            });
            await savePromise.promise;
        }
    };

    return (
        <PendingCanvasContext.Provider
            value={{ pendingCanvas: pendingCanvas?.program, onSavePending }}
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
