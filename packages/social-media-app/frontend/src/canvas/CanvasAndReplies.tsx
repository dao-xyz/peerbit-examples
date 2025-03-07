import { usePeer, useProgram } from "@peerbit/react";
import { useCanvases } from "./useCanvas.js";
import { useState, useEffect } from "react";
import { Canvas as Canvas } from "./Canvas.js";
import { CanvasWrapper } from "./CanvasWrapper.js";
import { Canvas as CanvasDB, CanvasValueReference } from "@dao-xyz/social";

import { Replies as RepliesView } from "./Replies.js";
import { CreateNew } from "./CreateNew.js";
import { Spinner } from "../utils/Spinner.js";
import { AiOutlineComment } from "react-icons/ai";
import { Header } from "./header//Header.js";
import { FaPhotoVideo } from "react-icons/fa";
import { FaPlus } from "react-icons/fa6";
import { PendingAppsChatBar } from "./PendingApps.js";

const CanvasWithReplies = (props: { canvas?: CanvasDB }) => {
    const isRoot = props.canvas?.parent == null;
    const [showReplies, setShowReplies] = useState(isRoot);
    const { peer } = usePeer();

    return (
        <div className="p-5 flex flex-col">
            <Header publicKey={peer.identity.publicKey} />
            <div className="rounded-md">
                <CanvasWrapper canvas={props.canvas}>
                    <Canvas />
                </CanvasWrapper>
            </div>
            {/*  {!isRoot && (
                <button
                    className="btn btn-elevated btn-icon mt-2 flex items-center"
                    onClick={() => setShowReplies(!showReplies)}
                >
                    <AiOutlineComment size={20} />
                    <span className="ml-2">
                        {showReplies ? "Hide Comments" : "Show Comments"}
                    </span>
                </button>
            )} */}
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
                    parent: new CanvasValueReference({
                        canvas: lastCanvas,
                    }),
                })
            );
    }, [lastCanvas?.idString, peer?.identity.publicKey.hashcode()]);

    const pendingCanvas = useProgram(pendingCanvasState, {
        id: pendingCanvasState?.idString, // we do set the id here so the useProgram hooke will change on pendingCavnasState changes
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
                parent: new CanvasValueReference({
                    canvas: lastCanvas,
                }),
            });
        });
    };

    // When there is not a currently selected canvas, ensure the container fills the screen
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
            <CanvasWrapper canvas={pendingCanvas.program} draft={true}>
                <div className="flex-grow">
                    <CanvasWithReplies key={0} canvas={lastCanvas} />
                </div>
                {/* spacer div */}
                <div className="mt-4 flex flex-col sticky bottom-0 w-full left-0">
                    <PendingAppsChatBar>
                        <label className="btn-elevated btn-icon btn-icon-md btn-toggle w-20 flex items-center justify-center">
                            <input
                                type="file"
                                accept="image/*, video/*"
                                multiple
                                style={{ display: "none" }}
                                id="image-upload"
                            />
                            <FaPlus />
                        </label>
                    </PendingAppsChatBar>
                    <Canvas draft={true} onSave={onSavePending} />
                </div>
            </CanvasWrapper>
            {/* This filler pushes the content to fill the screen if there is whitespace */}
        </div>
    );
};
