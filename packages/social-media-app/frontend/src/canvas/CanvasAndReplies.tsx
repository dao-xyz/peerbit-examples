import { usePeer, useProgram } from "@peerbit/react";
import { useCanvases } from "./useCanvas.js";
import { useState, useEffect } from "react";
import { Canvas as Canvas } from "./Canvas.js";
import { CanvasWrapper, useCanvas } from "./CanvasWrapper.js";
import { Canvas as CanvasDB, CanvasAddressReference } from "@dao-xyz/social";
import { Replies as RepliesView } from "./Replies.js";
import { CreateNew } from "./CreateNew.js";
import { Spinner } from "../utils/Spinner.js";
import { Header } from "./header/Header.js";
import { BsSend } from "react-icons/bs";
import { CanvasModifyToolbar } from "./ModifyToolbar.js";
import { ImageUploadTrigger } from "../content/native/image/ImageUploadToCanvas.js";
import { FaPlus } from "react-icons/fa";

const SaveButton = ({ onSavePending }: { onSavePending: () => void }) => {
    const { savePending } = useCanvas();
    return (
        <div className="flex-shrink-0">
            <button
                onClick={() => {
                    savePending();
                    onSavePending();
                }}
                className="btn-elevated btn-icon btn-icon-md btn-toggle"
                aria-label="Send"
            >
                <BsSend size={24} />
            </button>
        </div>
    );
};

const CanvasWithReplies = (props: { canvas?: CanvasDB }) => {
    const isRoot = props.canvas?.parent == null;
    const [showReplies, setShowReplies] = useState(isRoot);
    const { peer } = usePeer();

    return (
        <div className="p-5 flex flex-col">
            <Header publicKey={peer.identity.publicKey} />
            <div className="rounded-md">
                <CanvasWrapper canvas={props.canvas}>
                    <Canvas draft={false} />
                </CanvasWrapper>
            </div>
            {showReplies && (
                <div className="mt-[3px] p-2 rounded-md">
                    <RepliesView canvas={props.canvas} />
                </div>
            )}
        </div>
    );
};

export const CanvasAndReplies = () => {
    const { peer } = usePeer();
    const { root, path: canvases, loading } = useCanvases();
    const [lastCanvas, setLastCanvas] = useState<CanvasDB>(undefined);

    useEffect(() => {
        setLastCanvas(canvases[canvases.length - 1]);
    }, [canvases]);

    useEffect(() => {
        if (!peer || !root) {
            return;
        }
        // Additional logic if needed
    }, [peer?.identity.publicKey.hashcode(), root]);

    const [pendingCanvasState, setPendingCanvasState] = useState<
        CanvasDB | undefined
    >(undefined);

    useEffect(() => {
        if (peer && lastCanvas)
            setPendingCanvasState(
                new CanvasDB({
                    publicKey: peer.identity.publicKey,
                    parent: new CanvasAddressReference({ canvas: lastCanvas }), // simplified reference
                })
            );
    }, [lastCanvas?.idString, peer?.identity.publicKey.hashcode()]);

    const pendingCanvas = useProgram(pendingCanvasState, {
        id: pendingCanvasState?.idString,
        keepOpenOnUnmount: true,
        existing: "reuse",
    });

    const onSavePending = () => {
        setPendingCanvasState((prev) => {
            // add "comment"
            lastCanvas.replies.put(prev);
            // and initialize a new canvas for the next comment
            return new CanvasDB({
                publicKey: peer.identity.publicKey,
                parent: new CanvasAddressReference({ canvas: lastCanvas }), // simplified reference
            });
        });
    };

    if (canvases.length === 0) {
        return (
            <div className="h-full flex flex-col justify-center">
                <div className="flex flex-col gap-4 items-center">
                    {loading ? (
                        <div className="flex flex-row gap-2">
                            <>Looking for spaces</>
                            <Spinner />
                        </div>
                    ) : (
                        <div className="flex flex-row gap-2">
                            Space not found
                        </div>
                    )}
                    <CreateNew />
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            <div className="flex-grow">
                <CanvasWithReplies key={0} canvas={lastCanvas} />
            </div>
            <CanvasWrapper
                canvas={pendingCanvas.program}
                draft={true}
                multiCanvas
            >
                <div className="mt-4 flex flex-col sticky bottom-0 w-full left-0">
                    <Canvas appearance="chat-view-images">
                        <ImageUploadTrigger className="btn-elevated btn-icon btn-icon-md btn-toggle w-20 h-20 flex items-center justify-center bg-white">
                            <FaPlus />
                        </ImageUploadTrigger>
                    </Canvas>
                    <div className="flex bg-neutral-50 dark:bg-neutral-950 p-4">
                        <div className="max-w-[600px]">
                            <CanvasModifyToolbar direction="row" />
                        </div>
                        <Canvas
                            fitWidth
                            draft={true}
                            onSave={onSavePending}
                            appearance="chat-view-text"
                        />
                        <SaveButton onSavePending={onSavePending} />
                    </div>
                </div>
            </CanvasWrapper>
        </div>
    );
};
