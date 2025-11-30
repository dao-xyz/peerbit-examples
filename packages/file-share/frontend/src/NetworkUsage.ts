import { usePeer } from "@peerbit/react";
import { useEffect, useState } from "react";
import { PeerbitProxyHost } from "@peerbit/proxy";
import { Peerbit } from "peerbit";
import { BandwidthTracker } from "@peerbit/stream";
import { ProgramClient } from "@peerbit/program";

export const useNetworkUsage = () => {
    const { peer } = usePeer();
    const [up, setUp] = useState(0);
    const [down, setDown] = useState(0);

    useEffect(() => {
        if (!peer) {
            return;
        }

        let client = peer;
        if (peer instanceof PeerbitProxyHost) {
            client = peer.hostClient as ProgramClient; // TODO why do we need this cast?
        }
        if (client instanceof Peerbit === false) {
            throw new Error(
                "Network stats can not be collected with a proxy client"
            );
        }

        const processRpc = (client as Peerbit).services.pubsub.processRpc.bind(
            (client as Peerbit).services.pubsub
        );

        const downloadTracker = new BandwidthTracker();
        downloadTracker.start();

        (client as Peerbit).services.pubsub.processRpc = (
            from,
            peerStreams,
            message
        ) => {
            downloadTracker.add(message.length);
            return processRpc(from, peerStreams, message);
        };
        const i2 = setInterval(() => {
            downloadTracker.add(0);
        }, 1000);

        const collectInterval = setInterval(() => {
            let sum = 0;
            for (const peer of (client as Peerbit).services.pubsub.peers) {
                sum += peer[1].usedBandwidth;
            }
            setUp(Math.round(sum * 1e-3) * 8);
            setDown(Math.round(downloadTracker.value * 1e-3) * 8);
        }, 100);

        return () => {
            downloadTracker.stop();
            clearInterval(i2);
            clearInterval(collectInterval);
            (client as Peerbit).services.pubsub.processRpc = processRpc;
        };
    }, [peer?.identity.publicKey.hashcode()]);
    return { up, down };
};
