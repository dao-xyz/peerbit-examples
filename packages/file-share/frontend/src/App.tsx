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

const BootstrapOverride = ({
    bootstrap,
    onReady,
    onError,
}: {
    bootstrap?: string[];
    onReady: () => void;
    onError: (error: unknown) => void;
}) => {
    const { peer } = usePeer();

    useEffect(() => {
        if (!peer || bootstrap == null || bootstrap.length === 0) {
            onReady();
            return;
        }

        let cancelled = false;
        peer.bootstrap?.(bootstrap)
            .then(() => {
                if (!cancelled) {
                    onReady();
                }
            })
            .catch((error) => {
                console.error("Failed to bootstrap:", error);
                if (!cancelled) {
                    onError(error);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [peer, bootstrap?.join(","), onError, onReady]);

    return null;
};

export const App = () => {
    const bootstrap = getBootstrapAddresses();
    const [bootstrapState, setBootstrapState] = useState<
        "pending" | "ready" | "failed"
    >(
        bootstrap !== undefined && bootstrap.length > 0 ? "pending" : "ready"
    );
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
                <BootstrapOverride
                    bootstrap={bootstrap}
                    onReady={() => setBootstrapState("ready")}
                    onError={() => setBootstrapState("failed")}
                />
                {bootstrapState === "ready" ? (
                    <HashRouter basename="/">
                        <BaseRoutes />
                    </HashRouter>
                ) : bootstrapState === "failed" ? (
                    <div className="w-screen h-screen bg-neutral-200 dark:bg-black flex justify-center items-center transition-all">
                        <span>Failed to bootstrap</span>
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
