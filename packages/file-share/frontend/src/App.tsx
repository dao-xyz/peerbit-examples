import { PeerProvider, usePeer } from "@peerbit/react";
import { BaseRoutes } from "./routes";

import { HashRouter } from "react-router";
import { Footer } from "./Footer";
import { useCallback, useEffect, useRef, useState } from "react";
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

type AppDiagnostics = {
    mountedAt: number;
    peersProvided: boolean;
    peerAddressCount: number;
    peerAddresses: string[];
    connectionState: "pending" | "ready" | "failed";
    peerReadyAt: number | null;
    dialStartedAt: number | null;
    dialFinishedAt: number | null;
    dialError: string | null;
    dialResults: Array<{
        address: string;
        status: "pending" | "fulfilled" | "rejected";
        startedAt: number;
        finishedAt: number | null;
        error?: string;
    }>;
};

const createAppDiagnostics = (
    peers: string[] | undefined,
    connectionState: AppDiagnostics["connectionState"]
): AppDiagnostics => ({
    mountedAt: Date.now(),
    peersProvided: peers !== undefined,
    peerAddressCount: peers?.length ?? 0,
    peerAddresses: peers ?? [],
    connectionState,
    peerReadyAt: null,
    dialStartedAt: null,
    dialFinishedAt: null,
    dialError: null,
    dialResults: [],
});

const getErrorMessage = (error: unknown) => {
    if (error instanceof Error) {
        return error.message;
    }
    if (
        error &&
        typeof error === "object" &&
        "type" in error &&
        typeof error.type === "string"
    ) {
        return `Event:${error.type}`;
    }
    return String(error);
};

const PeerOverride = ({
    peers,
    onReady,
    onError,
    onDiagnostics,
}: {
    peers?: string[];
    onReady: () => void;
    onError: (error: unknown) => void;
    onDiagnostics: (diagnostics: Partial<AppDiagnostics>) => void;
}) => {
    const { peer } = usePeer();

    useEffect(() => {
        if (!peer || peers == null || peers.length === 0) {
            if (peer) {
                onDiagnostics({ peerReadyAt: Date.now() });
            }
            onReady();
            return;
        }

        let cancelled = false;
        const startedAt = Date.now();
        const dialResults: AppDiagnostics["dialResults"] = peers.map(
            (address) => ({
                address,
                status: "pending",
                startedAt,
                finishedAt: null,
            })
        );
        onDiagnostics({
            peerReadyAt: startedAt,
            dialStartedAt: startedAt,
            dialFinishedAt: null,
            dialError: null,
            dialResults,
        });
        Promise.all(
            peers.map((address, index) =>
                peer
                    .dial(address)
                    .then(() => {
                        dialResults[index] = {
                            ...dialResults[index],
                            status: "fulfilled",
                            finishedAt: Date.now(),
                        };
                        onDiagnostics({ dialResults: [...dialResults] });
                    })
                    .catch((error) => {
                        dialResults[index] = {
                            ...dialResults[index],
                            status: "rejected",
                            finishedAt: Date.now(),
                            error: getErrorMessage(error),
                        };
                        onDiagnostics({ dialResults: [...dialResults] });
                        throw error;
                    })
            )
        )
            .then(() => {
                if (!cancelled) {
                    onDiagnostics({ dialFinishedAt: Date.now() });
                    onReady();
                }
            })
            .catch((error) => {
                console.error("Failed to connect to peer:", error);
                if (!cancelled) {
                    onDiagnostics({
                        dialFinishedAt: Date.now(),
                        dialError: getErrorMessage(error),
                    });
                    onError(error);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [peer, peers?.join(","), onDiagnostics, onError, onReady]);

    return null;
};

export const App = () => {
    const peers = getPeerAddresses();
    const [connectionState, setConnectionState] = useState<
        "pending" | "ready" | "failed"
    >(
        peers !== undefined && peers.length > 0 ? "pending" : "ready"
    );
    const diagnosticsRef = useRef(
        createAppDiagnostics(peers, connectionState)
    );
    diagnosticsRef.current.connectionState = connectionState;
    const updateDiagnostics = useCallback(
        (diagnostics: Partial<AppDiagnostics>) => {
            diagnosticsRef.current = {
                ...diagnosticsRef.current,
                ...diagnostics,
            };
        },
        []
    );
    const handleReady = useCallback(() => setConnectionState("ready"), []);
    const handleError = useCallback(() => setConnectionState("failed"), []);
    useEffect(() => {
        const testWindow = window as Window & {
            __peerbitFileShareAppDiagnostics?: () => AppDiagnostics;
        };
        testWindow.__peerbitFileShareAppDiagnostics = () => ({
            ...diagnosticsRef.current,
            dialResults: diagnosticsRef.current.dialResults.map((result) => ({
                ...result,
            })),
        });
        return () => {
            delete testWindow.__peerbitFileShareAppDiagnostics;
        };
    }, []);
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
                    onReady={handleReady}
                    onError={handleError}
                    onDiagnostics={updateDiagnostics}
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
