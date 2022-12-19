import React, { useContext, useEffect, useRef } from "react";
import { multiaddr } from "@multiformats/multiaddr";
import { Peerbit } from "@dao-xyz/peerbit";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import { noise } from "@chainsafe/libp2p-noise";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { floodsub } from "@libp2p/floodsub";

import { mplex } from "@libp2p/mplex";
import { getKeypair } from "./utils.js";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { Entry } from "@dao-xyz/peerbit-log";
import { Libp2p } from "libp2p";
import { Multiaddr } from "@multiformats/multiaddr";

const keypair = await getKeypair();

interface IPeerContext {
    peer: Peerbit;
    loading: boolean;
}

export const connectTabs = (peer: Peerbit) => {
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
};
export const PeerContext = React.createContext<IPeerContext>({} as any);
export const usePeer = () => useContext(PeerContext);
export const PeerProvider = ({
    libp2p,
    bootstrap,
    children,
}: {
    libp2p?: Libp2p;
    bootstrap?: (Multiaddr | string)[];
    children: JSX.Element;
}) => {
    const [peer, setPeer] = React.useState<Peerbit | undefined>(undefined);
    const [loading, setLoading] = React.useState<boolean>(false);

    const memo = React.useMemo<IPeerContext>(
        () => ({
            peer,
            loading,
        }),
        [loading, peer?.identity?.publicKey.toString()]
    );
    const ref = useRef<Promise<Peerbit | void>>(null);

    useEffect(() => {
        if (ref.current) {
            return;
        }
        setLoading(true);
        ref.current = (
            libp2p
                ? Promise.resolve(libp2p)
                : createLibp2p({
                    connectionManager: {
                        autoDial: true,
                        maxData
                    },
                    connectionEncryption: [noise()],
                    /*                     pubsub: gossipsub({
                                            floodPublish: true,
                                            canRelayMessage: true,
                                        }), */
                    pubsub: floodsub(),
                    streamMuxers: [mplex()],
                    ...(process.env.REACT_APP_NETWORK === "local"
                        ? {
                            transports: [
                                // Add websocket impl so we can connect to "unsafe" ws (production only allows wss)
                                webSockets({
                                    filter: (addrs) => {
                                        return addrs.filter(
                                            (addr) =>
                                                addr
                                                    .toString()
                                                    .indexOf("/ws/") !=
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
        )
            .then(async (node) => {
                await node.start();

                if (bootstrap?.length > 0) {
                    try {
                        await Promise.all(
                            bootstrap
                                .map((a) =>
                                    typeof a === "string" ? multiaddr(a) : a
                                )
                                .map((a) => node.dial(a))
                        );
                    } catch (error) {
                        console.error(
                            "Failed to resolve relay node. Please come back later or start the demo locally"
                        );
                        throw error;
                    }
                }

                // We create a new directrory to make tab to tab communication go smoothly
                const peer = await Peerbit.create(node, {
                    waitForKeysTimout: 0,
                    directory: "./repo",
                    identity: keypair,
                });

                // Make sure data flow as expected between tabs and windows locally (offline states)
                connectTabs(peer);
                setPeer(peer);

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
    }, []);

    return <PeerContext.Provider value={memo}>{children}</PeerContext.Provider>;
};
