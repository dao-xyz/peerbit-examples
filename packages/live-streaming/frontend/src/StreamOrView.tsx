import { usePeer } from "@peerbit/react";
import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { getKeyFromStreamKey } from "./routes";
import { Stream } from "./media/streamer/Stream";
import { View } from "./media/viewer/View";
import { PublicSignKey } from "@peerbit/crypto";

export const StreamOrView = () => {
    const { peer } = usePeer();
    const params = useParams();
    const [idArgs, setIdArgs] = useState<{
        node: PublicSignKey;
    }>();
    const [isStreamer, setIsStreamer] = useState<boolean | undefined>(
        undefined
    );

    // TODO
    useEffect(() => {
        if (!peer?.libp2p || !params.node || !params.node) {
            return;
        }

        const node = getKeyFromStreamKey(params.node);
        setIsStreamer(peer.identity.publicKey.equals(node));
        setIdArgs({ node });
    }, [peer?.identity.publicKey.hashcode(), params?.node]);

    return (
        <>
            {isStreamer !== undefined && (
                <>
                    {isStreamer ? (
                        <Stream node={idArgs.node}></Stream>
                    ) : (
                        /*       <Box sx={{ backgroundColor: 'red', width: '100%', height: '100%' }}> RED</Box> */
                        <View node={idArgs.node}></View>
                    )}
                </>
            )}
        </>
    );
};
