import { usePeer, useProgram } from "@peerbit/react";
import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { getMediaStreamAddress } from "./routes";
import { Stream } from "./media/streamer/Stream";
import { View } from "./media/viewer/View";
import { MediaStreamDB } from "./media/database";

export const StreamOrView = () => {
    const { peer } = usePeer();
    const params = useParams();
    const [isStreamer, setIsStreamer] = useState<boolean | undefined>(
        undefined
    );
    const mediaStream = useProgram<MediaStreamDB>(params.address, {
        args: { role: { type: "replicator", factor: 1 } },
        existing: "reuse",
    });
    // TODO
    useEffect(() => {
        if (!peer || !mediaStream?.program) {
            return;
        }

        console.log(
            "???",
            peer.identity.publicKey.equals(mediaStream.program.owner)
        );
        setIsStreamer(
            peer.identity.publicKey.equals(mediaStream.program.owner)
        );
    }, [mediaStream?.program?.address]);
    console.log(mediaStream?.program?.address);
    return (
        <>
            {isStreamer !== undefined && (
                <>
                    {isStreamer ? (
                        <Stream stream={mediaStream.program}></Stream>
                    ) : (
                        /*       <Box sx={{ backgroundColor: 'red', width: '100%', height: '100%' }}> RED</Box> */
                        <View stream={mediaStream.program}></View>
                    )}
                </>
            )}
        </>
    );
};
