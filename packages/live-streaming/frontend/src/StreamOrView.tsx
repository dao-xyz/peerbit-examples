import { usePeer, useProgram } from "@peerbit/react";
import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { View } from "./media/viewer/View";
import { MediaStreamDB } from "@peerbit/video-lib";
import { Editor } from "./media/streamer/Stream";

export const StreamOrView = () => {
    const { peer } = usePeer();

    const params = useParams();

    const [isStreamer, setIsStreamer] = useState<boolean | undefined>(
        undefined
    );

    const mediaStream = useProgram<MediaStreamDB>(params.address, {
        existing: "reuse",
    });

    // TODO
    useEffect(() => {
        if (!peer || !mediaStream?.program) {
            return;
        }
        setIsStreamer(
            peer.identity.publicKey.equals(mediaStream.program.owner)
        );
    }, [mediaStream?.program?.address]);
    return (
        <>
            {isStreamer !== undefined && (
                <>
                    {isStreamer ? (
                        <Editor stream={mediaStream.program}></Editor>
                    ) : (
                        /*       <Box sx={{ backgroundColor: 'red', width: '100%', height: '100%' }}> RED</Box> */
                        <View stream={mediaStream.program}></View>
                    )}
                </>
            )}
        </>
    );
};
