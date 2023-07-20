import React, { useContext } from "react";
import { multiaddr, Multiaddr } from "@multiformats/multiaddr";
import { Peerbit } from "peerbit";
import { webSockets } from "@libp2p/websockets";
import { DirectSub } from "@peerbit/pubsub";
import { mplex } from "@libp2p/mplex";
import { getFreeKeypair, getTabId, inIframe } from "./utils.js";
import { resolveBootstrapAddresses } from "@peerbit/network-utils";
import { noise } from "@dao-xyz/libp2p-noise";
import { v4 as uuid } from "uuid";
import { Ed25519Keypair } from "@peerbit/crypto";
import { FastMutex } from "./lockstorage.js";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { waitFor } from "@peerbit/time";
import sodium from "libsodium-wrappers";
import * as filters from "@libp2p/websockets/filters";
import { useMount } from "./useMount.js";
import { createClient, createHost } from "@peerbit/proxy-window";
import { ProgramClient } from "@peerbit/program";

export type ConnectionStatus =
    | "disconnected"
    | "connected"
    | "connecting"
    | "failed";
interface IPeerContext {
    peer: ProgramClient | undefined;
    promise: Promise<void> | undefined;
    loading: boolean;
    status: ConnectionStatus;
}

if (!window.name) {
    window.name = uuid();
}

export const PeerContext = React.createContext<IPeerContext>({} as any);
export const usePeer = () => useContext(PeerContext);

type IFrameOptions = {
    type: "proxy";
    targetOrigin: string;
};

type NodeOptions = {
    type?: "node";
    network: "local" | "remote";
    waitForConnnected?: boolean;
    keypair?: Ed25519Keypair;
    bootstrap?: (Multiaddr | string)[];
    host?: boolean;
};
type TopOptions = NodeOptions & WithMemory;
type TopAndIframeOptions = {
    iframe: IFrameOptions | NodeOptions;
    top: TopOptions;
};
type WithMemory = {
    inMemory?: boolean;
};
type WithChildren = {
    children: JSX.Element;
};
type PeerOptions = (TopAndIframeOptions | TopOptions) & WithChildren;

export const PeerProvider = (options: PeerOptions) => {
    const [peer, setPeer] = React.useState<ProgramClient | undefined>(
        undefined
    );
    const [promise, setPromise] = React.useState<Promise<void> | undefined>(
        undefined
    );

    const [loading, setLoading] = React.useState<boolean>(false);
    const [connectionState, setConnectionState] =
        React.useState<ConnectionStatus>("disconnected");
    const memo = React.useMemo<IPeerContext>(
        () => ({
            peer,
            promise,
            loading,
            connectionState,
            status: connectionState,
        }),
        [
            loading,
            !!promise,
            connectionState,
            peer?.identity?.publicKey.toString(),
        ]
    );

    useMount(() => {
        setLoading(true);
        const fn = async () => {
            await sodium.ready;
            if (peer) {
                await peer.stop();
                setPeer(undefined);
            }

            let newPeer: ProgramClient;
            const nodeOptions = (options as TopAndIframeOptions).top
                ? inIframe()
                    ? (options as TopAndIframeOptions).iframe
                    : (options as TopAndIframeOptions).top
                : (options as TopOptions);
            if (nodeOptions.type !== "proxy") {
                const nodeId =
                    nodeOptions.keypair ||
                    (
                        await getFreeKeypair(
                            "",
                            new FastMutex({
                                clientId: getTabId(),
                                timeout: 1000,
                            }),
                            undefined,
                            true // reuse keypairs from same tab, (force release)
                        )
                    ).key;

                // We create a new directrory to make tab to tab communication go smoothly
                newPeer = await Peerbit.create({
                    libp2p: {
                        addresses: {
                            listen: [
                                /*    '/webrtc' */
                            ],
                        },
                        connectionEncryption: [noise()],
                        peerId: await nodeId.toPeerId(), //, having the same peer accross broswers does not work, only one tab will be recognized by other peers
                        connectionManager: {
                            maxConnections: 100,
                            minConnections: 0,
                        },
                        streamMuxers: [mplex()],
                        ...(nodeOptions.network === "local"
                            ? {
                                  connectionGater: {
                                      denyDialMultiaddr: () => {
                                          // by default we refuse to dial local addresses from the browser since they
                                          // are usually sent by remote peers broadcasting undialable multiaddrs but
                                          // here we are explicitly connecting to a local node so do not deny dialing
                                          // any discovered address
                                          return false;
                                      },
                                  },
                                  transports: [
                                      // Add websocket impl so we can connect to "unsafe" ws (production only allows wss)
                                      webSockets({
                                          filter: filters.all,
                                      }),
                                      /*            circuitRelayTransport({ discoverRelays: 1 }),
               webRTC(), */
                                  ],
                              }
                            : {
                                  transports: [
                                      webSockets({ filter: filters.wss }),
                                      /*             circuitRelayTransport({ discoverRelays: 1 }),
                webRTC(), */
                                  ],
                              }),

                        services: {
                            pubsub: (c) =>
                                new DirectSub(c, {
                                    canRelayMessage: true,
                                    emitSelf: true,
                                }),
                        },
                    },
                    directory: !(nodeOptions as WithMemory).inMemory
                        ? "./repo"
                        : undefined,
                    limitSigning: true,
                });

                setConnectionState("connecting");

                // Resolve bootstrap nodes async (we want to return before this is done)
                const connectFn = async () => {
                    try {
                        const addresses = await (nodeOptions.bootstrap
                            ? Promise.resolve(nodeOptions.bootstrap)
                            : resolveBootstrapAddresses(nodeOptions.network));
                        if (addresses && addresses?.length > 0) {
                            try {
                                await Promise.all(
                                    addresses
                                        .map((a) =>
                                            typeof a === "string"
                                                ? multiaddr(a)
                                                : a
                                        )
                                        .map((a) => newPeer.dial(a))
                                );
                                setConnectionState("connected");
                            } catch (error) {
                                console.error(
                                    "Failed to resolve relay node. Please come back later or start the demo locally"
                                );
                                setConnectionState("failed");
                                throw error;
                            }
                        } else {
                            console.error("No addresses to connect to");
                            setConnectionState("failed");
                        }
                    } catch (err: any) {
                        console.error(
                            "Failed to resolve relay addresses. " + err?.message
                        );
                        setConnectionState("failed");
                    }

                    if (nodeOptions.host) {
                        newPeer = await createHost(newPeer);
                    }
                };

                const promise = connectFn();

                // Make sure data flow as expected between tabs and windows locally (offline states)

                if (nodeOptions.waitForConnnected) {
                    await promise;
                }
            } else {
                newPeer = await createClient(nodeOptions.targetOrigin);
            }
            setPeer(newPeer);
            setLoading(false);
        };
        setPromise(fn());
    });

    return (
        <PeerContext.Provider value={memo}>
            {options.children}
        </PeerContext.Provider>
    );
};
