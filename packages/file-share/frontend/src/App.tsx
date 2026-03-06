import { PeerProvider, usePeer } from "@peerbit/react";
import { BaseRoutes } from "./routes";

import { HashRouter } from "react-router";
import { Footer } from "./Footer";
import { useEffect } from "react";
/* import { enable } from "@libp2p/logger";
enable("libp2p:*"); */
/* import { logger } from "@peerbit/logger";

const loggefr = logger({ module: "shared-log" })
loggefr.level = 'trace'
loggefr.trace("hello") */

const getBootstrapAddresses = (): string[] | undefined => {
    const params = new URLSearchParams(window.location.search);
    const hashQueryIndex = window.location.hash.indexOf("?");
    if (hashQueryIndex !== -1) {
        const hashParams = new URLSearchParams(
            window.location.hash.slice(hashQueryIndex + 1)
        );
        if (!params.has("bootstrap") && hashParams.has("bootstrap")) {
            params.set("bootstrap", hashParams.get("bootstrap") || "");
        }
    }

    const bootstrap = params.get("bootstrap");
    if (bootstrap == null) {
        return undefined;
    }

    const normalized = bootstrap.trim().toLowerCase();
    if (normalized === "" || normalized === "offline") {
        return [];
    }

    return bootstrap
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
};

document.documentElement.classList.add("dark");

const BootstrapOverride = ({ bootstrap }: { bootstrap?: string[] }) => {
    const { peer } = usePeer();

    useEffect(() => {
        if (!peer || bootstrap == null || bootstrap.length === 0) {
            return;
        }

        peer.bootstrap?.(bootstrap).catch((error) => {
            console.error("Failed to bootstrap:", error);
        });
    }, [peer, bootstrap?.join(",")]);

    return null;
};

export const App = () => {
    const bootstrap = getBootstrapAddresses();
    const network =
        bootstrap !== undefined
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
                    bootstrap !== undefined ||
                    import.meta.env.MODE === "development"
                        ? true
                        : "in-flight",
            }}
        >
            <div className="h-screen">
                <BootstrapOverride bootstrap={bootstrap} />
                <HashRouter basename="/">
                    <BaseRoutes />
                </HashRouter>
                <Footer />
            </div>
        </PeerProvider>
    );
};
