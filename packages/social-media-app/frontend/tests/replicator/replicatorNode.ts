import { Peerbit } from "peerbit";
import { createRootScope, Scope } from "@giga-app/interface";
import { webSockets } from "@libp2p/websockets";
import * as filters from "@libp2p/websockets/filters";
import { noise } from "@chainsafe/libp2p-noise";

export async function startReplicator() {
    const client = await Peerbit.create({
        libp2p: {
            connectionEncrypters: [noise()],
            addresses: {
                listen: ["/ip4/127.0.0.1/tcp/0/ws"],
            },
            transports: [webSockets({ filter: filters.all })],
            connectionManager: { maxConnections: 100 },
            connectionMonitor: { enabled: false },
        },
    });

    // Open public root scope and set to replicate all
    const scope: Scope = await client.open(createRootScope(), {
        args: { replicate: { factor: 1 } },
        existing: "reuse",
    });

    const addrs = client.getMultiaddrs();
    return { client, addrs, scope };
}
