import React, { useContext } from "react";
import { Multiaddr } from "@multiformats/multiaddr";
import { Peerbit } from "peerbit";
import { DirectSub } from "@peerbit/pubsub";
import { yamux } from "@chainsafe/libp2p-yamux";
import {
    getFreeKeypair,
    getTabId,
    inIframe,
    cookiesWhereClearedJustNow,
} from "./utils.js";
import { noise } from "@chainsafe/libp2p-noise";
import { v4 as uuid } from "uuid";
import { Ed25519Keypair } from "@peerbit/crypto";
import { FastMutex } from "./lockstorage.js";
import sodium from "libsodium-wrappers";

import { useMount } from "./useMount.js";
import { createClient, createHost } from "@peerbit/proxy-window";
import { ProgramClient } from "@peerbit/program";
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

/** Discriminated union for PeerContext */
export type IPeerContext = ProxyPeerContext | NodePeerContext;

export interface ProxyPeerContext {
    type: "proxy";
    peer: ProgramClient | undefined;
    promise: Promise<void> | undefined;
    loading: boolean;
    status: ConnectionStatus;
    persisted: boolean | undefined;
    /** Present only in proxy (iframe) mode */
    targetOrigin: string;
}

export interface NodePeerContext {
    type: "node";
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

type TopOptions = NodeOptions & { inMemory?: boolean };
type TopAndIframeOptions = {
    iframe: IFrameOptions | NodeOptions;
    top: TopOptions;
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

    // Decide which options to use based on whether we're in an iframe.
    // If options.top is defined, assume we have separate settings for iframe vs. host.
    const nodeOptions: IFrameOptions | TopOptions = (
        options as TopAndIframeOptions
    ).top
        ? inIframe()
            ? (options as TopAndIframeOptions).iframe
            : (options as TopAndIframeOptions).top
        : (options as TopOptions);

    // If running as a proxy (iframe), expect a targetOrigin.
    const computedTargetOrigin =
        nodeOptions.type === "proxy"
            ? (nodeOptions as IFrameOptions).targetOrigin
            : undefined;

    const memo = React.useMemo<IPeerContext>(() => {
        if (nodeOptions.type === "proxy") {
            return {
                type: "proxy",
                peer,
                promise,
                loading,
                status: connectionState,
                persisted,
                targetOrigin: computedTargetOrigin as string,
            };
        } else {
            return {
                type: "node",
                peer,
                promise,
                loading,
                status: connectionState,
                persisted,
            };
        }
    }, [
        loading,
        promise,
        connectionState,
        peer,
        persisted,
        computedTargetOrigin,
    ]);

    useMount(() => {
        setLoading(true);
        const fn = async () => {
            await sodium.ready;
            let newPeer: ProgramClient;

            if (nodeOptions.type !== "proxy") {
                const releaseFirstLock = cookiesWhereClearedJustNow();
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
                            {
                                releaseFirstLock,
                                releaseLockIfSameId: true,
                            }
                        )
                    ).key;
                const peerId = nodeId.toPeerId();

                let directory: string | undefined = undefined;
                if (
                    !(nodeOptions as TopOptions).inMemory &&
                    !(await detectIncognito()).isPrivate
                ) {
                    const persisted = await navigator.storage.persist();
                    setPersisted(persisted);
                    if (!persisted) {
                        setPersisted(false);
                        console.error(
                            "Request persistence but permission was not granted by browser."
                        );
                    } else {
                        directory = `./repo/${peerId.toString()}/`;
                    }
                }

                console.log("Create client");
                newPeer = await Peerbit.create({
                    libp2p: {
                        addresses: { listen: ["/p2p-circuit"] },
                        connectionEncrypters: [noise()],
                        peerId,
                        connectionManager: { maxConnections: 100 },
                        connectionMonitor: { enabled: false },
                        streamMuxers: [yamux()],
                        ...(nodeOptions.network === "local"
                            ? {
                                  connectionGater: {
                                      denyDialMultiaddr: () => false,
                                  },
                                  transports: [
                                      webSockets({ filter: filters.all }),
                                      circuitRelayTransport(),
                                  ],
                              }
                            : {
                                  transports: [
                                      webSockets({ filter: filters.wss }),
                                      circuitRelayTransport(),
                                  ],
                              }),
                        services: {
                            pubsub: (c) =>
                                new DirectSub(c, { canRelayMessage: true }),
                            identify: identify(),
                        },
                    },
                    directory,
                });
                console.log("Client created", {
                    directory,
                    peerHash: newPeer?.identity.publicKey.hashcode(),
                    network:
                        nodeOptions.network === "local" ? "local" : "remote",
                });

                setConnectionState("connecting");

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
                        newPeer = await createHost(newPeer as Peerbit);
                    }
                };

                console.log("Bootstrap start...");
                const promise = connectFn();
                promise.then(() => {
                    console.log("Bootstrap done");
                });
                if (nodeOptions.waitForConnnected !== false) {
                    await promise;
                }
            } else {
                // When in proxy mode (iframe), use the provided targetOrigin.
                newPeer = await createClient(
                    (nodeOptions as IFrameOptions).targetOrigin
                );
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
