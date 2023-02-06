import React, { useContext, useEffect, useRef } from "react";
import { multiaddr } from "@multiformats/multiaddr";
import { Peerbit } from "@dao-xyz/peerbit";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import { supportedKeys } from "@libp2p/crypto/keys";
import { mplex } from "@libp2p/mplex";
import { getKeypair } from "./utils.js";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { Entry } from "@dao-xyz/peerbit-log";
import { Libp2p } from "libp2p";
import { noise } from "@dao-xyz/libp2p-noise";
import { peerIdFromKeys } from "@libp2p/peer-id";
import { createLibp2pExtended } from "@dao-xyz/peerbit-libp2p";
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
    peer.onWrite = (program, store, entry) => {
        broadCastWrite.postMessage({
            program: program.address.toString(),
            store: store._storeIndex,
            entry: serialize(entry),
        });
        return onWriteDefault(program, store, entry);
    };
    broadCastWrite.onmessage = (message) => {
        peer.programs
            .get(message.data.program)
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
    dev,
    bootstrap,
    children,
    inMemory,
}: {
    libp2p?: Libp2p;
    dev?: boolean;
    inMemory?: boolean;
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

        const peerId = peerIdFromKeys(
            new supportedKeys["ed25519"].Ed25519PublicKey(
                keypair.publicKey.publicKey
            ).bytes,
            new supportedKeys["ed25519"].Ed25519PrivateKey(
                keypair.privateKey.privateKey,
                keypair.publicKey.publicKey
            ).bytes
        );
        ref.current = (
            libp2p
                ? Promise.resolve(libp2p)
                : peerId.then(async (peerId) => {
                      return createLibp2pExtended({
                          blocks: {
                              directory: !inMemory ? "./blocks" : undefined,
                          },
                          libp2p: await createLibp2p({
                              connectionManager: {
                                  autoDial: true,
                              },
                              connectionEncryption: [noise()],
                              peerId, //, having the same peer accross broswers does not work, only one tab will be recognized by other peers

                              streamMuxers: [mplex()],
                              ...(dev
                                  ? {
                                        transports: [
                                            // Add websocket impl so we can connect to "unsafe" ws (production only allows wss)
                                            webSockets({
                                                filter: (addrs) => {
                                                    return addrs.filter(
                                                        (addr) =>
                                                            addr
                                                                .toString()
                                                                .indexOf(
                                                                    "/ws/"
                                                                ) != -1 ||
                                                            addr
                                                                .toString()
                                                                .indexOf(
                                                                    "/wss/"
                                                                ) != -1
                                                    );
                                                },
                                            }),
                                        ],
                                    }
                                  : { transports: [webSockets()] }),
                          }).then((r) => {
                              console.log("creating libp2p done!");
                              return r;
                          }),
                      });
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
                console.log("create peerbit");
                const peer = await Peerbit.create({
                    libp2p: node,
                    directory: !inMemory ? "./repo" : undefined,
                    identity: keypair,
                    limitSigning: true,
                });
                console.log("create peerbit done!");

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
