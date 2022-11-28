import React, { useContext, useEffect } from "react";
/* import { useWallet } from "@dao-xyz/wallet-adapter-react"; */
import * as IPFS from "ipfs-core";
import { multiaddr } from "@multiformats/multiaddr";
import { Peerbit } from "@dao-xyz/peerbit";
import { webSockets } from "@libp2p/websockets";
import { resolveSwarmAddress } from "./utils";

interface IPeerContext {
    peer: Peerbit;
    loading: boolean;
    swarm: string[];
}

export const PeerContext = React.createContext<IPeerContext>({} as any);
export const usePeer = () => useContext(PeerContext);
export const PeerProvider = ({ children }: { children: JSX.Element }) => {
    const [peer, setPeer] = React.useState<Peerbit | undefined>(undefined);
    const [swarm, setSwarm] = React.useState<string[]>([]);
    const [loading, setLoading] = React.useState<boolean>(false);
    const memo = React.useMemo<IPeerContext>(
        () => ({
            peer,
            swarm,
            loading,
        }),
        [loading, peer?.identity?.publicKey.toString()]
    );

    useEffect(() => {
        if (loading) {
            return;
        }
        setLoading(true);
        console.log("load peer: " + loading);

        IPFS.create({
            preload: { enabled: false },
            EXPERIMENTAL: { ipnsPubsub: false, pubsub: true } as any,
            offline: false,
            config: {
                Bootstrap: [],
                Addresses: {
                    Swarm: [],
                    Delegates: [],
                },
                Discovery: {
                    MDNS: { Enabled: false },
                    webRTCStar: { Enabled: false },
                },
            },
            repo: "abcx" + +new Date(), // If we do same repo, then tab to tab communication does not work (because we filter pubsub messages that go to ourselves)
            libp2p: {
                connectionManager: {
                    autoDial: true,
                },
                ...(process.env.REACT_APP_NETWORK === "local"
                    ? {
                          transports: [
                              // Add websocket impl so we can connect to "unsafe" ws (production only allows wss)
                              webSockets({
                                  filter: (addrs) =>
                                      addrs.filter(
                                          (addr) =>
                                              addr.toString().indexOf("/ws/") !=
                                                  -1 ||
                                              addr
                                                  .toString()
                                                  .indexOf("/wss/") != -1
                                      ),
                              }),
                          ],
                      }
                    : {}),
            },
        })
            .then(async (node) => {
                console.log(process.env.REACT_APP_NETWORK);
                if (process.env.REACT_APP_NETWORK === "local") {
                    console.log("LOCAL NETWORK");
                    const swarmAddress =
                        "/ip4/127.0.0.1/tcp/8081/ws/p2p/12D3KooWS85oHFnS64rCmr8UbNny4x5c3YqsgQrow5sm9w7M1PA9";
                    await node.swarm
                        .connect(multiaddr(swarmAddress))
                        .then(() => {
                            setSwarm([swarmAddress]);
                        });
                } else {
                    const axios = await import("axios");
                    console.log("REMOTE ENETWORK");
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
                        ).data,
                    ];
                    try {
                        const swarmAddresseesResolved = await Promise.all(
                            swarmAddressees.map((s) => resolveSwarmAddress(s))
                        );
                        await Promise.all(
                            swarmAddresseesResolved.map((swarm) =>
                                node.swarm
                                    .connect(multiaddr(swarm))
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
                        ).then(() => {
                            setSwarm(swarmAddressees);
                        });
                    } catch (error) {
                        alert(
                            "Failed to resolve relay node. Please come back later or start the demo locally"
                        );
                    }
                }

                console.log("Connected to swarm!");
                // We create a new directrory to make tab to tab communication go smoothly
                const peer = await Peerbit.create(node, {
                    waitForKeysTimout: 0,
                    directory: "dir" + +new Date(),
                });
                console.log("Created peer", peer.identity.publicKey.toString());
                setPeer(peer);
                setLoading(false);
            })
            .catch((e) => {
                setLoading(false);
                if (e.toString().startsWith("LockExistsError")) {
                    return; // this context has been remounted in dev mode and the same repo has been created twice
                }
                throw e;
            });
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
