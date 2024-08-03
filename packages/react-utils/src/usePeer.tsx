import React, { useContext } from "react";
import { Multiaddr } from "@multiformats/multiaddr";
import { Peerbit } from "peerbit";
import { DirectSub } from "@peerbit/pubsub";
import { yamux } from "@chainsafe/libp2p-yamux";
import { getFreeKeypair, getTabId, inIframe } from "./utils.js";
import { noise } from "@dao-xyz/libp2p-noise";
import { v4 as uuid } from "uuid";
import { Ed25519Keypair } from "@peerbit/crypto";
import { FastMutex } from "./lockstorage.js";
import sodium from "libsodium-wrappers";

import { useMount } from "./useMount.js";
import { createClient, createHost } from "@peerbit/proxy-window";
import { ProgramClient } from "@peerbit/program";
import { webRTC } from "@libp2p/webrtc";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";

import * as filters from "@libp2p/websockets/filters";
import { detectIncognito } from "detectincognitojs";

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
    persisted: boolean | undefined;
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

    const [persisted, setPersisted] = React.useState<boolean | undefined>(
        undefined
    );

    const [loading, setLoading] = React.useState<boolean>(true);
    const [connectionState, setConnectionState] =
        React.useState<ConnectionStatus>("disconnected");
    const memo = React.useMemo<IPeerContext>(
        () => ({
            peer,
            promise,
            loading,
            connectionState,
            status: connectionState,
            persisted: persisted,
        }),
        [
            loading,
            !!promise,
            connectionState,
            peer?.identity?.publicKey?.hashcode(),
            persisted,
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
                const peerId = await nodeId.toPeerId();

                let directory: string | undefined = undefined;
                if (
                    !(nodeOptions as WithMemory).inMemory &&
                    !(await detectIncognito()).isPrivate
                ) {
                    const persisted = await navigator.storage.persist();
                    setPersisted(persisted);
                    if (!persisted) {
                        setPersisted(false);
                        if (window["chrome"]) {
                            console.error(
                                "Request persistance but was not given permission by browser. Adding this site to your bookmarks or enabling push notifications might allow your chrome browser to persist data"
                            );
                        } else {
                            console.error(
                                "Request persistance but was not given permission by browser."
                            );
                        }
                    } else {
                        directory = `./repo/${peerId.toString()}/`;
                    }
                }

                // We create a new directrory to make tab to tab communication go smoothly
                console.log("Create client");
                newPeer = await Peerbit.create({
                    libp2p: {
                        addresses: {
                            listen: [
                                /* "/webrtc" */
                            ], // TMP disable because flaky behaviour with libp2p 1.8.1
                        },
                        connectionEncryption: [noise()],
                        peerId, //, having the same peer accross broswers does not work, only one tab will be recognized by other peers
                        connectionManager: {
                            maxConnections: 100,
                            minConnections: 1,
                        },

                        streamMuxers: [yamux()],
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
                                      circuitRelayTransport({
                                          discoverRelays: 1,
                                      }),
                                      /*    webRTC(), */ // TMP disable because flaky behaviour with libp2p 1.8.1
                                  ],
                              }
                            : {
                                  transports: [
                                      webSockets({ filter: filters.wss }),
                                      circuitRelayTransport({
                                          discoverRelays: 1,
                                      }),
                                      /*   webRTC(), */ // TMP disable because flaky behaviour with libp2p 1.8.1
                                  ],
                              }),

                        services: {
                            pubsub: (c) =>
                                new DirectSub(c, {
                                    canRelayMessage: true,
                                    /*      connectionManager: {
                                            autoDial: false,
                                        }, */
                                }),
                            identify: identify(),
                        },
                    },
                    directory,
                });
                console.log("Create done");
                console.log(newPeer?.identity.publicKey.hashcode());

                setConnectionState("connecting");

                // Resolve bootstrap nodes async (we want to return before this is done)
                const connectFn = async () => {
                    try {
                        if (nodeOptions.network === "local") {
                            await newPeer.dial(
                                "/ip4/127.0.0.1/tcp/8002/ws/p2p/" +
                                    (await (
                                        await fetch(
                                            "http://localhost:8082/peer/id"
                                        )
                                    ).text())
                            );
                        } else {
                            // TODO fix types. When proxy client this will not be available
                            if (nodeOptions.bootstrap) {
                                for (const addr of nodeOptions.bootstrap) {
                                    await newPeer.dial(addr);
                                }
                            } else {
                                await newPeer["bootstrap"]?.();
                            }
                        }
                        setConnectionState("connected");
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

                console.log("Bootstrap start...");
                const promise = connectFn();
                promise.then(() => {
                    console.log("Bootstrap done");
                });
                // Make sure data flow as expected between tabs and windows locally (offline states)

                if (nodeOptions.waitForConnnected !== false) {
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
