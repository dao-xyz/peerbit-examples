import { usePeer } from "@peerbit/react";
import { useCanvases } from "./useCanvas.js";
import { useState, useEffect } from "react";
import { Canvas as Canvas } from "./Canvas.js";
import { Canvas as CanvasDB } from "@dao-xyz/social";

import { Replies as RepliesView } from "./Replies.js";
import { CreateNew } from "./CreateNew.js";
import { Spinner } from "../utils/Spinner.js";
import { AiOutlineComment } from "react-icons/ai";
import { Header } from "./header//Header.js";

const CanvasWithReplies = (props: { canvas?: CanvasDB }) => {
    const isRoot = props.canvas?.parent == null;
    const [showReplies, setShowReplies] = useState(isRoot);
    const { peer } = usePeer();

    return (
        <div className="p-5 flex flex-col">
            <Header publicKey={peer.identity.publicKey} />
            <div className="rounded-md">
                <Canvas canvas={props.canvas} />
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

    useEffect(() => {
        if (!peer || !root) {
            return;
        }
        // Additional logic if needed
    }, [peer?.identity.publicKey.hashcode(), root]);

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
        <div className="flex flex-col">
            <div className="flex-grow">
                <CanvasWithReplies
                    key={0}
                    canvas={canvases[canvases.length - 1]}
                />
            </div>
            {/* This filler pushes the content to fill the screen if there is whitespace */}
        </div>
    );
};
