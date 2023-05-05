import React, { useContext, useEffect, useRef } from "react";
import { multiaddr, Multiaddr } from "@multiformats/multiaddr";
import { Identity, Peerbit } from "@dao-xyz/peerbit";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import { supportedKeys } from "@libp2p/crypto/keys";
import { mplex } from "@libp2p/mplex";
import {
    getFreeKeypair,
    getTabId,
    inIframe,
    resolveSwarmAddress,
} from "./utils.js";
import { noise } from "@dao-xyz/libp2p-noise";
import { peerIdFromKeys } from "@libp2p/peer-id";
import { createLibp2pExtended } from "@dao-xyz/peerbit-libp2p";
import { v4 as uuid } from "uuid";
import { Ed25519Keypair } from "@dao-xyz/peerbit-crypto";
import { FastMutex } from "./lockstorage.js";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { waitFor } from "@dao-xyz/peerbit-time";
import sodium from "libsodium-wrappers";
import { circuitRelayTransport } from "libp2p/circuit-relay";
import { webRTC } from "@dao-xyz/libp2p-webrtc";
import * as filters from "@libp2p/websockets/filters";
import axios from "axios";

interface IPeerContext {
    peer: Peerbit | undefined;
    loading: boolean;
}

type NetworkType = "local" | "remote";
const resolveBootstrapAddresses = async (network: NetworkType) => {
    // Bootstrap addresses for network
    try {
        let bootstrapAddresses: string[] = [];
        if (network === "local") {
            bootstrapAddresses = [
                await resolveSwarmAddress("http://localhost"),
            ];
        } else {
            const swarmAddressees = (
                await axios.get(
                    "https://raw.githubusercontent.com/dao-xyz/peerbit-bootstrap/master/bootstrap.env"
                )
            ).data
                .split(/\r?\n/)
                .filter((x) => x.length > 0);
            bootstrapAddresses = await Promise.all(
                swarmAddressees.map((s) => resolveSwarmAddress(s))
            );
        }
        return bootstrapAddresses;
    } catch (error: any) {
        console.error(
            "Failed to resolve relay node. Please come back later or start the demo locally: " +
                error?.message
        );
    }
};

export const connectTabs = (peer: Peerbit) => {
    // Cross tab sync when we write
    /* 
    const broadCastDirectSub = new BroadcastChannel(
        keypair.publicKey.toString() + "/directSub"
    );

    const processMessageDefault = peer.libp2p.directsub.processMessage.bind(peer.libp2p.directsub);
    peer.libp2p.directsub.processMessage = (peerId, stream, arr) => {
        console.log("Send data from tab", peerId.toString(), arr.length);
        broadCastDirectSub.postMessage({
            peerId: peerId.toString(),
            data: arr.subarray(),
        });
        return processMessageDefault(peerId, stream, arr);
    };
    broadCastDirectSub.onmessage = (message) => {
        const data = message.data.data;
        const peerId = peerIdFromString(message.data.peerId);
        const stream = peer.libp2p.directsub.peers.get(
            getPublicKeyFromPeerId(peerId).hashcode()
        );
        console.log("Got data from tab", peerId.toString(), data.length);
        processMessageDefault(peerId, stream, new Uint8ArrayList(data));
    };
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
       }; */
    // Cross tab sync when we get messages
    /* const broadCastOnMessage = new BroadcastChannel(
        keypair.publicKey.toString() + "/onMessage"
    );
    const onMessageDefault = peer._onMessage.bind(peer);
    peer._onMessage = (message) => {
        broadCastOnMessage.postMessage(message);
        return onMessageDefault(message);
    };
    broadCastOnMessage.onmessage = (message) => {
        onMessageDefault(message.data);
    }; */
};

if (!window.name) {
    window.name = uuid();
}

interface KeypairMessage {
    type: "keypair";
    bytes: Uint8Array;
}
export const subscribeToKeypairChange = (
    onChange: (keypair: Ed25519Keypair) => any
) => {
    window.onmessage = (c: MessageEvent) => {
        if ((c.data as KeypairMessage).type == "keypair") {
            onChange(
                deserialize((c.data as KeypairMessage).bytes, Ed25519Keypair)
            );
        }
    };
};

export const submitKeypairChange = (
    element: HTMLIFrameElement,
    keypair: Ed25519Keypair,
    origin: string
) => {
    element.contentWindow!.postMessage(
        { type: "keypair", bytes: serialize(keypair) } as KeypairMessage,
        origin
    );
};

let keypairMessages: Ed25519Keypair[] = [];
subscribeToKeypairChange((keypair) => {
    console.log("got keypair!", keypair);
    keypairMessages.push(keypair);
});

export const PeerContext = React.createContext<IPeerContext>({} as any);
export const usePeer = () => useContext(PeerContext);
export const PeerProvider = ({
    network,
    bootstrap,
    children,
    inMemory,
    keypair,
    identity,
    waitForKeypairInIFrame,
}: {
    network: "local" | "remote";
    inMemory?: boolean;
    keypair?: Ed25519Keypair;
    identity?: Identity;
    waitForKeypairInIFrame?: boolean;
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
    const ref = useRef<Promise<Peerbit | void> | null>(null);

    useEffect(() => {
        if (ref.current) {
            return;
        }
        setLoading(true);

        const fn = async (
            keypair: Ed25519Keypair = keypairMessages[
                keypairMessages.length - 1
            ]
        ) => {
            await sodium.ready;

            if (!keypair && waitForKeypairInIFrame && inIframe()) {
                await waitFor(
                    () =>
                        (keypair = keypairMessages[keypairMessages.length - 1])
                );
            }

            if (
                keypair &&
                keypairMessages[keypairMessages.length - 1] &&
                keypairMessages[keypairMessages.length - 1].equals(keypair)
            ) {
                console.log(
                    "Creating client from identity sent from parent window: " +
                        keypair.publicKey.hashcode()
                );
            } else {
                if (!keypair) {
                    console.log("Generating new keypair for client");
                } else {
                    console.log(
                        "Keypair missmatch with latest keypair message",
                        keypairMessages.map((x) => x.publicKey.hashcode()),
                        keypair.publicKey.hashcode()
                    );
                }
            }

            if (peer) {
                await peer.stop();
                setPeer(undefined);
            }

            const nodeId =
                keypair ||
                (
                    await getFreeKeypair(
                        "",
                        new FastMutex({ clientId: getTabId(), timeout: 1000 }),
                        undefined,
                        true // reuse keypairs from same tab, (force release)
                    )
                ).key;

            const peerId = await peerIdFromKeys(
                new supportedKeys["ed25519"].Ed25519PublicKey(
                    nodeId.publicKey.publicKey
                ).bytes,
                new supportedKeys["ed25519"].Ed25519PrivateKey(
                    nodeId.privateKey.privateKey,
                    nodeId.publicKey.publicKey
                ).bytes
            );

            identity = identity || nodeId;

            let node = await createLibp2pExtended({
                blocks: {
                    directory:
                        !inMemory && !inIframe() ? "./blocks" : undefined,
                },
                libp2p: await createLibp2p({
                    connectionEncryption: [noise()],
                    peerId, //, having the same peer accross broswers does not work, only one tab will be recognized by other peers
                    connectionManager: {
                        maxConnections: 100,
                        minConnections: 0,
                    },
                    streamMuxers: [mplex()],
                    ...(network === "local"
                        ? {
                              transports: [
                                  // Add websocket impl so we can connect to "unsafe" ws (production only allows wss)
                                  webSockets({
                                      filter: filters.all,
                                  }) /* ,
                                circuitRelayTransport({ discoverRelays: 1 }),
                                webRTC({ maxMsgSize: 256 * 1024 }), */,
                              ],
                          }
                        : {
                              transports: [
                                  webSockets({ filter: filters.all }) /* ,
                                circuitRelayTransport({ discoverRelays: 1 }),
                                webRTC({ maxMsgSize: 256 * 1024 }), */,
                              ],
                          }),
                }).then((r) => {
                    console.log(r);
                    return r;
                }),
            });
            await node.start();

            // We create a new directrory to make tab to tab communication go smoothly
            const newPeer = await Peerbit.create({
                libp2p: node,
                directory: !inMemory ? "./repo" : undefined,
                identity,
                limitSigning: true,
            });

            // Resolve bootstrap nodes async (we want to return before this is done)
            (bootstrap
                ? Promise.resolve(bootstrap)
                : resolveBootstrapAddresses(network)
            )
                .then(async (bootstrap) => {
                    if (bootstrap && bootstrap?.length > 0) {
                        try {
                            await Promise.all(
                                bootstrap
                                    .map((a) =>
                                        typeof a === "string" ? multiaddr(a) : a
                                    )
                                    .map((a) => newPeer.dial(a))
                            );
                        } catch (error) {
                            console.error(
                                "Failed to resolve relay node. Please come back later or start the demo locally"
                            );
                            throw error;
                        }
                    }
                })
                .catch((err: any) => {
                    console.error(
                        "Failed to resolve relay addresses. " + err?.message
                    );
                });

            // Make sure data flow as expected between tabs and windows locally (offline states)
            connectTabs(newPeer);
            setPeer(newPeer);
            setLoading(false);
            return peer;
        };
        ref.current = fn(keypair);
    }, []);

    return <PeerContext.Provider value={memo}>{children}</PeerContext.Provider>;
};
