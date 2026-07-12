import { PeerProvider, usePeer } from "@peerbit/react";
import { BaseRoutes } from "./routes";

import { HashRouter } from "react-router";
import { Footer } from "./Footer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "./Spinner";
import {
    getPeerAddressConfiguration,
    getPeerDialOutcome,
    getPeerOverrideAction,
    type PeerHintSource,
} from "./app-connection";
/* import { enable } from "@libp2p/logger";
enable("libp2p:*"); */
/* import { logger } from "@peerbit/logger";

const loggefr = logger({ module: "shared-log" })
loggefr.level = 'trace'
loggefr.trace("hello") */

document.documentElement.classList.add("dark");

type AppDiagnostics = {
    mountedAt: number;
    peersProvided: boolean;
    peerHintSource: PeerHintSource;
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
    peerHintSource: PeerHintSource,
    connectionState: AppDiagnostics["connectionState"]
): AppDiagnostics => ({
    mountedAt: Date.now(),
    peersProvided: peers !== undefined,
    peerHintSource,
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
        const action = getPeerOverrideAction(Boolean(peer), peers);
        if (action === "wait-for-peer") {
            return;
        }
        if (action === "ready-without-explicit-dial") {
            onDiagnostics({ peerReadyAt: Date.now() });
            onReady();
            return;
        }
        if (!peer || !peers) {
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
        const dialPromises = peers.map((address, index) =>
            Promise.resolve()
                .then(() => peer.dial(address))
                .then(() => {
                    dialResults[index] = {
                        ...dialResults[index],
                        status: "fulfilled",
                        finishedAt: Date.now(),
                    };
                    if (!cancelled) {
                        onDiagnostics({ dialResults: [...dialResults] });
                    }
                })
                .catch((error) => {
                    dialResults[index] = {
                        ...dialResults[index],
                        status: "rejected",
                        finishedAt: Date.now(),
                        error: getErrorMessage(error),
                    };
                    if (!cancelled) {
                        onDiagnostics({ dialResults: [...dialResults] });
                    }
                    throw error;
                })
        );
        Promise.allSettled(dialPromises).then(() => {
            if (cancelled) {
                return;
            }
            const dialFinishedAt = Date.now();
            const outcome = getPeerDialOutcome(dialResults);
            if (outcome === "ready") {
                onDiagnostics({
                    dialFinishedAt,
                    dialError: null,
                    dialResults: [...dialResults],
                });
                onReady();
                return;
            }
            const rejected = dialResults
                .filter((result) => result.status === "rejected")
                .map(
                    (result) =>
                        `${result.address}: ${result.error ?? "unknown error"}`
                );
            const error = new Error(
                `Failed to connect to all supplied peers: ${rejected.join("; ")}`
            );
            console.error("Failed to connect to supplied peers:", error);
            onDiagnostics({
                dialFinishedAt,
                dialError: error.message,
                dialResults: [...dialResults],
            });
            onError(error);
        });
        return () => {
            cancelled = true;
        };
    }, [peer, peers?.join(","), onDiagnostics, onError, onReady]);

    return null;
};

export const App = () => {
    const peerConfiguration = useMemo(
        () => getPeerAddressConfiguration(window.location.href),
        []
    );
    const peers = peerConfiguration.peers;
    const [connectionState, setConnectionState] = useState<
        "pending" | "ready" | "failed"
    >(peers !== undefined && peers.length > 0 ? "pending" : "ready");
    const diagnosticsRef = useRef(
        createAppDiagnostics(peers, peerConfiguration.source, connectionState)
    );
    diagnosticsRef.current.connectionState = connectionState;
    diagnosticsRef.current.peersProvided = peers !== undefined;
    diagnosticsRef.current.peerHintSource = peerConfiguration.source;
    diagnosticsRef.current.peerAddressCount = peers?.length ?? 0;
    diagnosticsRef.current.peerAddresses = peers ?? [];
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
    const peerProviderConfig = useMemo(
        () => ({
            runtime: "node" as const,
            network:
                peers !== undefined
                    ? { bootstrap: [] }
                    : import.meta.env.MODE === "development"
                      ? ("local" as const)
                      : ("remote" as const),
            waitForConnected:
                peers !== undefined || import.meta.env.MODE === "development"
                    ? true
                    : ("in-flight" as const),
        }),
        [peers]
    );

    return (
        <PeerProvider config={peerProviderConfig}>
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
