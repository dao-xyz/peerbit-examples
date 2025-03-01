import { usePeer } from "@peerbit/react";
import { useSpaces } from "../useSpaces.js";
import { useEffect } from "react";
import { Canvas as CanvasView } from "./Canvas.js";
import { Replies as RepliesView } from "./Replies.js";

import { CreateRoom } from "./CreateSpace.js";
import { Spinner } from "../utils/Spinner.js";

export const CanvasAndReplies = () => {
    const { peer } = usePeer();
    const { root, canvases: location, loading, path } = useSpaces();

    useEffect(() => {
        if (!peer || !root) {
            return;
        }
    }, [peer?.identity.publicKey.hashcode(), root]);

    return (
        <>
            {location.length === 0 && (
                <div className="w-full h-full flex flex-col justify-center">
                    <div className="flex flex-col content-center gap-4 items-center">
                        {loading && (
                            <div className="flex flex-row gap-2">
                                <>Looking for spaces</>
                                <Spinner />
                            </div>
                        )}
                        {!loading && (
                            <div className="flex flex-row gap-2">
                                Space not found
                            </div>
                        )}
                        <CreateRoom />
                    </div>
                </div>
            )}
            {location.length > 0 &&
                location.map((canvas, ix) => (
                    <div key={ix} className="flex flex-col">
                        <div className="p-5 rounded-md">
                            <CanvasView canvas={canvas}></CanvasView>
                        </div>
                        <RepliesView canvas={canvas}></RepliesView>
                    </div>
                ))}
        </>
    );
};
