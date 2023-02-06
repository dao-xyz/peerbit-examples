import { usePeer } from "@dao-xyz/peerbit-react";
import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { getKeyFromStreamKey } from "./routes";
import { Stream } from "./Stream";
import { View } from "./View";

export const StreamOrView = () => {
    const { peer } = usePeer();
    const params = useParams();
    const [isStreamer, setIsStreamer] = useState<boolean | undefined>(
        undefined
    );

    // TODO
    useEffect(() => {
        if (!peer?.libp2p || !params.key) {
            return;
        }
        const streamKey = getKeyFromStreamKey(params.key);
        setIsStreamer(peer.identity.publicKey.equals(streamKey));
    }, [peer?.id, params?.key]);

    return (
        <>
            {isStreamer !== undefined && (
                <>{isStreamer ? <Stream></Stream> : <View></View>}</>
            )}
        </>
    );
};
