import { usePeer } from "@peerbit/react";
import { useEffect, useState } from "react";
import { Peerbit } from "peerbit";
import { BandwidthTracker } from "@peerbit/stream";

export const useNetworkUsage = () => {
    const { peer } = usePeer();
    const [up, setUp] = useState(0);
    const [down, setDown] = useState(0);

    useEffect(() => {
        if (!peer) {
            return;
        }

        // Some Peerbit/react setups may provide a proxy client with a reference to the
        // underlying host client. Network stats require access to the real Peerbit instance.
        let client: unknown = peer;
        const hostClient = (peer as any)?.hostClient as unknown;
        if (hostClient) client = hostClient;
        if (!(client instanceof Peerbit)) {
            throw new Error(
                "Network stats can not be collected with a proxy client"
            );
        }

        const processRpc = client.services.pubsub.processRpc.bind(
            client.services.pubsub
        );

        const downloadTracker = new BandwidthTracker();
        downloadTracker.start();

        client.services.pubsub.processRpc = (
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
            for (const peer of client.services.pubsub.peers) {
                sum += peer[1].usedBandwidth;
            }
            setUp(Math.round(sum * 1e-3) * 8);
            setDown(Math.round(downloadTracker.value * 1e-3) * 8);
        }, 100);

        return () => {
            downloadTracker.stop();
            clearInterval(i2);
            clearInterval(collectInterval);
            client.services.pubsub.processRpc = processRpc;
        };
    }, [peer?.identity.publicKey.hashcode()]);
    return { up, down };
};
