import React, { useContext, useEffect } from "react";
/* import { useWallet } from "@dao-xyz/wallet-adapter-react"; */
import * as IPFS from "ipfs-core";
import { multiaddr } from "@multiformats/multiaddr";
import { Peerbit, logger } from "@dao-xyz/peerbit";
import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { mplex } from "@libp2p/mplex";
import { noise } from "@chainsafe/libp2p-noise";
import { kadDHT } from "@libp2p/kad-dht";
import { GossipSub } from "@chainsafe/libp2p-gossipsub";

logger.level = "trace";
interface IPeerContext {
    peer: Peerbit;
    loading: boolean;
}

export const PeerContext = React.createContext<IPeerContext>({} as any);
export const usePeer = () => useContext(PeerContext);
export const PeerProvider = ({ children }: { children: JSX.Element }) => {
    const [peer, setPeer] = React.useState<Peerbit | undefined>(undefined);

    /* const [rootIdentity, setRootIdentity] = React.useState<Identity>(undefined); */
    const [loading, setLoading] = React.useState<boolean>(false);
    /* const wallet = useWallet() */
    const memo = React.useMemo<IPeerContext>(
        () => ({
            peer,
            /*    rootIdentity, */
            loading,
        }),
        [loading, peer?.identity?.publicKey.toString()]
    );

    useEffect(() => {
        /*   if (!wallet.publicKey)
              return; */
        if (loading) {
            return;
        }
        setLoading(true);
        console.log("load peer: " + loading);

        IPFS.create({
            /*   start: true,
              relay: { enabled: false, hop: { enabled: false, active: false } }, */
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
            repo: "abcx", // repo name uncertainty: When failing to get remote block
            libp2p: {
                connectionManager: {
                    autoDial: false,
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
            /*  libp2p: ({ peerId }) => {
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
        })
            .then(async (node) => {
                console.log(process.env.REACT_APP_NETWORK);

                if (process.env.REACT_APP_NETWORK === "local") {
                    console.log("swarm connect?");
                    await node.swarm
                        .connect(
                            multiaddr(
                                "/ip4/127.0.0.1/tcp/8081/ws/p2p/12D3KooWSaRg8Sghk3rtzVGmPboAo9yr7F5hdbf9UZXJ3CZFLKWs"
                            )
                        )
                        .then(() => {
                            node.pubsub.subscribe("xyz", (e) =>
                                console.log("GOT EMSSAGE", e)
                            );

                            setTimeout(() => {
                                console.log("pub messages");

                                node.pubsub.publish(
                                    "xyz",
                                    new Uint8Array([1, 2, 3])
                                );
                            }, 5000);
                        });
                } else {
                    const bootstrapConfig: { bootstrap: string[] } = {
                        bootstrap: [
                            "/ip4/172.17.0.2/tcp/8081/ws/p2p/12D3KooWQFTgNjuekJfuXHf3xqoa6YVP4QKd14CUH2fhMvkoFs2E", // "/dns4/8c8d6a3b36037714d198d9622d4e934222872dc5.peerchecker.com/tcp/4002/wss/p2p/12D3KooWFXg89AFm6RpLFqmK7LiBaY8U49YL2vfMyNre2bHZz3BW",
                        ],
                    };
                    await Promise.all(
                        bootstrapConfig.bootstrap.map((bootstrap) =>
                            node.swarm
                                .connect(multiaddr(bootstrap)) /* .then(() => {
                                    node.pubsub.publish("xyz", new Uint8Array([1, 2, 3]));
                                    setTimeout(() => {
                                        console.log('pub messages')

                                        node.pubsub.subscribe("xyz", (e) => console.log("GOT EMSSAGE", e))
                                    }, 5000)
                                }) */
                                .catch((error) => {
                                    console.error("PEER CONNECT ERROR", error);
                                    alert(
                                        "Failed to connect to peers. Please try again later."
                                    );
                                    throw error;
                                })
                        )
                    );
                }

                console.log("Connected to swarm!");
                // TODO fix types
                /*     console.log('got wallet', wallet)
                const walletIdentity: Identity = {
                    publicKey: (wallet.publicKey as (Ed25519PublicKey | Secp256k1PublicKey)) as any,
                    sign: (data) => (wallet.signMessage(data))
                };
                setRootIdentity(walletIdentity);
     */
                Peerbit.create(node).then(async (peer) => {
                    console.log(
                        "Created peer",
                        peer.identity.publicKey.toString()
                    );
                    setPeer(peer);
                });
            })
            .catch((e) => {
                if (e.toString().startsWith("LockExistsError")) {
                    return; // this context has been remounted in dev mode and the same repo has been created twice
                }
                throw e;
            })
            .finally(() => {
                setLoading(false);
            });
    }, ["xyz" /* wallet?.publicKey?.toString() */]);

    return <PeerContext.Provider value={memo}>{children}</PeerContext.Provider>;
};
