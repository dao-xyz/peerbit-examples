import { usePeer } from "@dao-xyz/peerbit-react";
import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { getKeyFromStreamKey } from "./routes";
import { Stream } from "./Stream";
import { View } from "./View";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";

export const StreamOrView = () => {
    const { peer } = usePeer();
    const params = useParams();
    const [idArgs, setIdArgs] = useState<{
        identity: PublicSignKey;
        node: PublicSignKey;
    }>();
    const [isStreamer, setIsStreamer] = useState<boolean | undefined>(
        undefined
    );

    // TODO
    useEffect(() => {
        if (!peer?.libp2p || !params.node || !params.identity) {
            return;
        }

        const node = getKeyFromStreamKey(params.node);
        setIsStreamer(peer.idKey.publicKey.equals(node));
        setIdArgs({ identity: getKeyFromStreamKey(params.identity), node });
    }, [peer?.id, params?.node]);

    return (
        <>
            {isStreamer !== undefined && (
                <>
                    {isStreamer ? (
                        <Stream
                            node={idArgs.node}
                            identity={idArgs.identity}
                        ></Stream>
                    ) : (
                        <View
                            node={idArgs.node}
                            identity={idArgs.identity}
                        ></View>
                    )}
                </>
            )}
        </>
    );
};
