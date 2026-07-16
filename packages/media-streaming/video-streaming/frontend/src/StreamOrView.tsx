import { View } from "./media/viewer/View";
import { Editor } from "./media/streamer/Stream";
import { usePeer } from "@peerbit/react";
import { useOwnedStreamProgram } from "./StreamProgramOwner";

export const StreamOrView = () => {
    const { peer } = usePeer();

    const mediaStream = useOwnedStreamProgram();
    const isStreamer =
        peer && mediaStream
            ? peer.identity.publicKey.equals(mediaStream.owner)
            : undefined;
    return (
        <>
            {isStreamer !== undefined && (
                <>
                    {isStreamer ? (
                        <Editor stream={mediaStream}></Editor>
                    ) : (
                        /*       <Box sx={{ backgroundColor: 'red', width: '100%', height: '100%' }}> RED</Box> */
                        <View stream={mediaStream}></View>
                    )}
                </>
            )}
        </>
    );
};
