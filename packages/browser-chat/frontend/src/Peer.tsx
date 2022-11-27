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

    /* const [rootIdentity, setRootIdentity] = React.useState<Identity>(undefined); */
    const [loading, setLoading] = React.useState<boolean>(false);
    /* const wallet = useWallet() */
    const memo = React.useMemo<IPeerContext>(
        () => ({
            peer,
            swarm,
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
            /*   start: true,*/
            // relay: { enabled: false, hop: { enabled: false, active: false } },
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
                    await node.swarm.connect(
                        multiaddr(
                            "/ip4/127.0.0.1/tcp/8081/ws/p2p/12D3KooWS85oHFnS64rCmr8UbNny4x5c3YqsgQrow5sm9w7M1PA9"
                        )
                    );
                } else {
                    console.log("REMOT ENETWORK");
                    const swarmAddressees = [
                        "48f3cbfae3b5ffe415c4f1c0987ac0af718700a6.peerchecker.com",
                    ];
                    const swarmAddresseesResolved = await Promise.all(
                        swarmAddressees.map((s) => resolveSwarmAddress(s))
                    );
                    await Promise.all(
                        swarmAddresseesResolved.map((swarm) =>
                            node.swarm
                                .connect(multiaddr(swarm))
                                .catch((error) => {
                                    console.error("PEER CONNECT ERROR", error);
                                    alert(
                                        "Failed to connect to peers. Please try again later."
                                    );
                                    throw error;
                                })
                        )
                    ).then(() => {
                        setSwarm(swarmAddressees);
                    });
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
                Peerbit.create(node, { waitForKeysTimout: 0 }).then(
                    async (peer) => {
                        console.log(
                            "Created peer",
                            peer.identity.publicKey.toString()
                        );
                        setPeer(peer);
                    }
                );
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
