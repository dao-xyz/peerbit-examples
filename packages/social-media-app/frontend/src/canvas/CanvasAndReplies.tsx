import { usePeer } from "@peerbit/react";
import { useSpaces } from "../useSpaces.js";
import { useState, useEffect } from "react";
import { Canvas as CanvasView } from "./Canvas.js";
import { Replies as RepliesView } from "./Replies.js";
import { CreateRoom } from "./CreateSpace.js";
import { Spinner } from "../utils/Spinner.js";
import { AiOutlineComment } from "react-icons/ai";

const CanvasRepliesItem = ({ canvas }) => {
    const [showReplies, setShowReplies] = useState(false);

    return (
        <div className="p-5 flex flex-col">
            <div className="rounded-md">
                <CanvasView canvas={canvas} />
            </div>
            <button
                className="btn btn-elevated btn-icon mt-2 flex items-center"
                onClick={() => setShowReplies(!showReplies)}
            >
                <AiOutlineComment size={20} />
                <span className="ml-2">
                    {showReplies ? "Hide Comments" : "Show Comments"}
                </span>
            </button>
            {showReplies && (
                <div className="mt-[3px] border border-gray-300 p-2 rounded-md">
                    <RepliesView canvas={canvas} />
                </div>
            )}
        </div>
    );
};

export const CanvasAndReplies = () => {
    const { peer } = usePeer();
    const { root, canvases, loading } = useSpaces();

    useEffect(() => {
        if (!peer || !root) {
            return;
        }
        // Additional logic if needed
    }, [peer?.identity.publicKey.hashcode(), root]);

    // When there are no canvases, ensure the container fills the screen
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
                    <CreateRoom />
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex flex-col">
            <div className="flex-grow">
                {canvases.map((canvas, ix) => (
                    <CanvasRepliesItem key={ix} canvas={canvas} />
                ))}
            </div>
            {/* This filler pushes the content to fill the screen if there is whitespace */}
        </div>
    );
};
