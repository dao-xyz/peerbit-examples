import { PeerProvider, usePeer } from "@peerbit/react";
import { BaseRoutes } from "./routes";

import { HashRouter } from "react-router";
import { Footer } from "./Footer";
import { useEffect, useState } from "react";
import { Spinner } from "./Spinner";
/* import { enable } from "@libp2p/logger";
enable("libp2p:*"); */
/* import { logger } from "@peerbit/logger";

const loggefr = logger({ module: "shared-log" })
loggefr.level = 'trace'
loggefr.trace("hello") */

const getPeerAddresses = (): string[] | undefined => {
    const params = new URLSearchParams(window.location.search);
    const hashQueryIndex = window.location.hash.indexOf("?");
    const hashParams =
        hashQueryIndex !== -1
            ? new URLSearchParams(window.location.hash.slice(hashQueryIndex + 1))
            : undefined;

    const peer = params.get("peer") ??
        hashParams?.get("peer") ??
        params.get("bootstrap") ??
        hashParams?.get("bootstrap");
    if (peer == null) {
        return undefined;
    }

    const normalized = peer.trim().toLowerCase();
    if (normalized === "" || normalized === "offline") {
        return [];
    }

    return peer
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
};

document.documentElement.classList.add("dark");

const PeerOverride = ({
    peers,
    onReady,
    onError,
}: {
    peers?: string[];
    onReady: () => void;
    onError: (error: unknown) => void;
}) => {
    const { peer } = usePeer();

    useEffect(() => {
        if (!peer || peers == null || peers.length === 0) {
            onReady();
            return;
        }

        let cancelled = false;
        Promise.all(peers.map((address) => peer.dial(address)))
            .then(() => {
                if (!cancelled) {
                    onReady();
                }
            })
            .catch((error) => {
                console.error("Failed to connect to peer:", error);
                if (!cancelled) {
                    onError(error);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [peer, peers?.join(","), onError, onReady]);

    return null;
};

export const App = () => {
    const peers = getPeerAddresses();
    const [connectionState, setConnectionState] = useState<
        "pending" | "ready" | "failed"
    >(
        peers !== undefined && peers.length > 0 ? "pending" : "ready"
    );
    const network =
        peers !== undefined
            ? { bootstrap: [] }
            : import.meta.env.MODE === "development"
              ? "local"
              : "remote";

    return (
        <PeerProvider
            config={{
                runtime: "node",
                network,
                waitForConnected:
                    peers !== undefined ||
                    import.meta.env.MODE === "development"
                        ? true
                        : "in-flight",
            }}
        >
            <div className="h-screen">
                <PeerOverride
                    peers={peers}
                    onReady={() => setConnectionState("ready")}
                    onError={() => setConnectionState("failed")}
                />
                {connectionState === "ready" ? (
                    <HashRouter basename="/">
                        <BaseRoutes />
                    </HashRouter>
                ) : connectionState === "failed" ? (
                    <div className="w-screen h-screen bg-neutral-200 dark:bg-black flex justify-center items-center transition-all">
                        <span>Failed to connect to peer</span>
                    </div>
                ) : (
                    <div className="w-screen h-screen bg-neutral-200 dark:bg-black flex justify-center items-center transition-all">
                        <Spinner />
                    </div>
                )}
                <Footer />
            </div>
        </PeerProvider>
    );
};
