import { usePeer, useProgram } from "@peerbit/react";
import { useState, useEffect } from "react";
import { useParams } from "react-router";
import { MediaStreamDB } from "@peerbit/media-streaming";
import { Upload } from "./upload/Upload";
import { Play } from "./play/Play";

export const UploadOrPlay = () => {
    const { peer } = usePeer();

    const params = useParams();

    const [isStreamer, setIsStreamer] = useState<boolean | undefined>(
        undefined
    );

    const mediaStream = useProgram<MediaStreamDB>(peer, params.address, {
        existing: "reuse",
        args: { replicate: "owned" },
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
                        <Upload source={mediaStream.program}></Upload>
                    ) : (
                        /*       <Box sx={{ backgroundColor: 'red', width: '100%', height: '100%' }}> RED</Box> */
                        <Play source={mediaStream.program}></Play>
                    )}
                </>
            )}
        </>
    );
};
