import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    ReactNode,
    useRef,
} from "react";
import { usePeer, useProgram } from "@peerbit/react";
import { Canvas, ChildVisualization, Layout } from "@giga-app/interface";
import pDefer from "p-defer";
import { PrivateCanvasScope } from "../useCanvas";

interface PendingCanvasContextType {
    pendingCanvas: Canvas | undefined;
    publish: () => Promise<void>;
    saveDraft: () => Promise<void>;
    setReplyTo: (canvas: Canvas | undefined) => Promise<void>;
    isSaving: boolean;
}

const PendingCanvasContext = createContext<
    PendingCanvasContextType | undefined
>(undefined);

export const PendingCanvasProvider: React.FC<{
    parent: Canvas;
    children: ReactNode;
    pendingCanvas?: Canvas;
    experience?: ChildVisualization;
    layout?: Layout;
}> = ({
    parent,
    children,
    pendingCanvas: fromPendingCanvas,
    experience: type,
    layout,
}) => {
        const { peer } = usePeer();
        const [pendingCanvasState, setPendingCanvasState] = useState<
            Canvas | undefined
        >(undefined);

        const privateCanvases = PrivateCanvasScope.useCanvases();

        const isSaving = useRef(false);

        const pendingCanvas = useProgram<Canvas>(pendingCanvasState, {
            id: pendingCanvasState?.idString,
            keepOpenOnUnmount: true,
            existing: "reuse",
        });

        const [replyTo, _setReplyTo] = useState<Canvas | undefined>(undefined);

        useEffect(() => {
            if (peer) {
                let pendingCanvas: Canvas | undefined;
                if (fromPendingCanvas) {
                    setPendingCanvasState(fromPendingCanvas);
                    pendingCanvas = fromPendingCanvas;
                } else if (parent) {
                    const newPendingCanvas = new Canvas({
                        publicKey: peer.identity.publicKey,
                        parent: replyTo || parent,
                    });
                    setPendingCanvasState(newPendingCanvas);
                    pendingCanvas = newPendingCanvas;
                }
                else {
                    return;
                }


            }
        }, [peer, parent, fromPendingCanvas]);


        const setReplyTo = async (replyTo) => {
            _setReplyTo(replyTo);
            if (isSaving.current) {
                console.log("setReplyTo while saving, ignoring");
                return;
            }
            if (pendingCanvas?.program && (replyTo || parent)) {
                await pendingCanvas.program.load();
                await pendingCanvas.program.setParent(replyTo || parent);

                /*  console.log(
                     "SET REPLY FROM ",
                     pendingCanvas.program,
                     " TO ",
                     replyTo || parent
                 ); */

                setPendingCanvasState(pendingCanvas.program);
            }

            /*  console.log("UPDATE REPLY TO", { replyTo: replyTo?.idString, viewRoot: viewRoot?.idString, idString: pendingCanvas.program?.idString, address: pendingCanvas.program?.address }); */
        };

        const saveDraft = async () => {
            privateCanvases.root?.replies.index.get(pendingCanvasState.id).then(async (existing) => {
                if (!existing) {
                    await privateCanvases.root.replies.put(pendingCanvasState)
                    return;
                }
            })
        }

        const savePending = async () => {
            const savePromise = pDefer<void>();
            isSaving.current = true;
            console.log("SAVE", {
                parent: parent?.idString,
                pendingCanvas: pendingCanvas?.program?.idString,
            });
            if (parent) {
                await parent
                    .createReply(pendingCanvasState, {
                        type,
                    })
                    .then(async () => {
                        if (layout) {
                            await parent.link(pendingCanvasState.id, { layout });
                        }

                        if (type) {
                            await pendingCanvasState.setExperience(type);
                        }

                        /*   // create "comment" sectio by creating a post with "Comments" content
                          const commentsCanvasId = randomBytes(32);
      
                          // create post type before Comment section, this ensures that receivers can load the comments post according to the type immediately
                          await pendingCanvasState.setMode("page");
                          await pendingCanvasState.getCreateCanvasByPath(
                              ["Comments"],
                              {
                                  id: commentsCanvasId,
                              }
                          ); */
                    })
                    .then(() => savePromise.resolve())
                    .catch(savePromise.reject);

                const newCanvas = new Canvas({
                    publicKey: peer.identity.publicKey,
                    parent,
                });
                console.log("CREATE NEW PENDING CANVAS", newCanvas.idString);
                setPendingCanvasState(newCanvas);
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
                    saveDraft,
                    pendingCanvas: pendingCanvas?.program,
                    publish: savePending,
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
