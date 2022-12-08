import React, { useContext, useEffect, useRef } from "react";
/* import { useWallet } from "@dao-xyz/wallet-adapter-react"; */
import { multiaddr } from "@multiformats/multiaddr";
import { Peerbit, logger } from "@dao-xyz/peerbit";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import { noise } from "@chainsafe/libp2p-noise";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { floodsub } from "@libp2p/floodsub";
import { mplex } from "@libp2p/mplex";
import { getKeypair, resolveSwarmAddress } from "./utils";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { Entry } from "@dao-xyz/ipfs-log";
import { PeerId } from "@libp2p/interface-peer-id";
import { delay } from "@dao-xyz/peerbit-time";

interface IPeerContext {
    peer: Peerbit;
    loading: boolean;
    pubsubPeers: PeerId[];
}

export const PeerContext = React.createContext<IPeerContext>({} as any);
export const usePeer = () => useContext(PeerContext);
export const PeerProvider = ({ children }: { children: JSX.Element }) => {
    const [peer, setPeer] = React.useState<Peerbit | undefined>(undefined);
    const [pubsubPeers, setPubsubPeers] = React.useState<PeerId[]>([]);
    const [loading, setLoading] = React.useState<boolean>(false);

    const memo = React.useMemo<IPeerContext>(
        () => ({
            peer,
            loading,
            pubsubPeers,
        }),
        [loading, pubsubPeers, peer?.identity?.publicKey.toString()]
    );
    const ref = useRef(null);

    useEffect(() => {
        if (loading || ref.current) {
            return;
        }
        setLoading(true);
        ref.current = getKeypair().then(async (keypair) => {
            console.log("Creating peer with id:", keypair.publicKey.toString());

            return createLibp2p({
                connectionManager: {
                    autoDial: false,
                },
                connectionEncryption: [noise()],
                pubsub: gossipsub({
                    floodPublish: true,
                    canRelayMessage: true,
                }),
                streamMuxers: [mplex()],
                ...(process.env.REACT_APP_NETWORK === "local"
                    ? {
                        transports: [
                            // Add websocket impl so we can connect to "unsafe" ws (production only allows wss)
                            webSockets({
                                filter: (addrs) => {
                                    return addrs.filter(
                                        (addr) =>
                                            addr.toString().indexOf("/ws/") !=
                                            -1 ||
                                            addr
                                                .toString()
                                                .indexOf("/wss/") != -1
                                    );
                                },
                            }),
                        ],
                    }
                    : { transports: [webSockets()] }),
            })
                .then(async (node) => {
                    await node.start();
                    if (process.env.REACT_APP_NETWORK === "local") {
                        const swarmAddress =
                            "/ip4/127.0.0.1/tcp/8002/ws/p2p/12D3KooWBycJFtocweGrU7AvArJbTgrvNxzKUiy8ey8rMLA1A1SG";
                        await node.dial(multiaddr(swarmAddress));
                    } else {
                        const axios = await import("axios");
                        // 1. You can insert the whole address
                        // or
                        // 2. Or just the domain here (only if you created the domain with the Peerbit CLI)
                        // ..
                        // default below is env file from the github repo
                        const swarmAddressees = [
                            (
                                await axios.default.get(
                                    "https://raw.githubusercontent.com/dao-xyz/peerbit-examples/master/demo-relay.env"
                                )
                            ).data
                        ];
                        try {
                            const swarmAddresseesResolved = await Promise.all(
                                swarmAddressees.map((s) =>
                                    resolveSwarmAddress(s)
                                )
                            );
                            await Promise.all(
                                swarmAddresseesResolved.map((swarm) =>
                                    node
                                        .dial(multiaddr(swarm))
                                        .then(async (c) => {
                                            console.log(
                                                "Successfully dialed remote",
                                                multiaddr(swarm).toString()
                                            );
                                        })
                                        .catch((error) => {
                                            console.error(
                                                "PEER CONNECT ERROR",
                                                error
                                            );
                                            alert(
                                                "Failed to connect to peers. Please try again later."
                                            );
                                            throw error;
                                        })
                                )
                            ).then(() => { });
                        } catch (error) {
                            console.log(
                                "Failed to resolve relay node. Please come back later or start the demo locally"
                            );
                        }
                    }


                    // We create a new directrory to make tab to tab communication go smoothly
                    const peer = await Peerbit.create(node, {
                        waitForKeysTimout: 0,
                        directory: "./repo",
                        identity: keypair,
                    });

                    // Cross tab sync when we write
                    const broadCastWrite = new BroadcastChannel(
                        keypair.publicKey.toString() + "/onWrite"
                    );
                    const onWriteDefault = peer.onWrite.bind(peer);
                    peer.onWrite = (program, store, entry, topic) => {
                        broadCastWrite.postMessage({
                            program: program.address.toString(),
                            store: store._storeIndex,
                            entry: serialize(entry),
                            topic,
                        });
                        return onWriteDefault(program, store, entry, topic);
                    };
                    broadCastWrite.onmessage = (message) => {
                        peer.programs
                            .get(message.data.topic)
                            ?.get(message.data.program)
                            ?.program?.allStoresMap.get(message.data.store)
                            .sync([deserialize(message.data.entry, Entry)], {
                                canAppend: () => true,
                                save: false,
                            });
                    };

                    // Cross tab sync when we get messages
                    const broadCastOnMessage = new BroadcastChannel(
                        keypair.publicKey.toString() + "/onMessage"
                    );
                    const onMessageDefault = peer._onMessage.bind(peer);
                    peer._onMessage = (message) => {
                        broadCastOnMessage.postMessage(message);
                        return onMessageDefault(message);
                    };
                    broadCastOnMessage.onmessage = (message) => {
                        onMessageDefault(message.data);
                    };

                    setPeer(peer);
                    const updatePeersFn = async () => {
                        while (true) {
                            setPubsubPeers(
                                node.pubsub.getPeers()
                            );
                            await delay(500)
                        }
                    }
                    updatePeersFn();
                    setLoading(false);
                    return peer;
                })
                .catch((e) => {
                    setLoading(false);
                    if (e.toString().startsWith("LockExistsError")) {
                        return; // this context has been remounted in dev mode and the same repo has been created twice
                    }
                    throw e;
                });
        });

        /* return () => {
            someImperativeThing.then((v) => {
                console.log('close', v)
                if (v instanceof Peerbit) { v.disconnect(); }
            })
        } */
    }, []);

    return <PeerContext.Provider value={memo}>{children}</PeerContext.Provider>;
};

/*  
 We cant do this kind of config yet
libp2p: ({ peerId }) => {
        console.log('here?', peerId)
        return createLibp2p({
            peerId: peerId,
            connectionManager: {
                autoDial: false
            },
            transports: [
                webSockets({
                    filter: (addrs) => {
                        console.log('here')
                        return addrs.filter(
                            (addr) =>
                                addr.toString().indexOf("/ws/") !=
                                -1 ||
                                addr
                                    .toString()
                                    .indexOf("/wss/") != -1
                        )
                    }
                })
            ],
            streamMuxers: [mplex()],
            connectionEncryption: [noise()],
            peerDiscovery: [],
            dht: kadDHT(),
            pubsub: () => (new GossipSub() as any),
            datastore: null
        }) 
},*/
