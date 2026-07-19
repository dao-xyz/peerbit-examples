import { PeerProvider, usePeer } from "@peerbit/react";
import { BaseRoutes } from "./routes";

import { HashRouter } from "react-router";
import { Footer } from "./Footer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "./Spinner";
import {
    dialPeerWithTimeout,
    getLocalShareFallbackOutcome,
    getPeerAddressConfiguration,
    getPeerDialOutcome,
    getPeerOverrideAction,
    getShareAddressFromHref,
    type PeerDial,
    type PeerHintSource,
} from "./app-connection";
import {
    getFileShareBenchmarkStorageMode,
    type FileShareBenchmarkStorageMode,
} from "./benchmark-storage";
/* import { enable } from "@libp2p/logger";
enable("libp2p:*"); */
/* import { logger } from "@peerbit/logger";

const loggefr = logger({ module: "shared-log" })
loggefr.level = 'trace'
loggefr.trace("hello") */

document.documentElement.classList.add("dark");

const EXPLICIT_PEER_DIAL_TIMEOUT_MS = 15_000;

type AppConnectionState = "pending" | "ready" | "ready-local" | "failed";

type AppDiagnostics = {
    mountedAt: number;
    benchmarkStorageMode: FileShareBenchmarkStorageMode | null;
    peersProvided: boolean;
    peerHintSource: PeerHintSource;
    peerAddressCount: number;
    peerAddresses: string[];
    connectionState: AppConnectionState;
    peerReadyAt: number | null;
    dialStartedAt: number | null;
    dialFinishedAt: number | null;
    dialError: string | null;
    localFallbackState:
        | "not-attempted"
        | "checking"
        | "ready"
        | "missing"
        | "error";
    localFallbackAddress: string | null;
    localFallbackStartedAt: number | null;
    localFallbackFinishedAt: number | null;
    localFallbackError: string | null;
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
    connectionState: AppDiagnostics["connectionState"],
    benchmarkStorageMode: FileShareBenchmarkStorageMode | null
): AppDiagnostics => ({
    mountedAt: Date.now(),
    benchmarkStorageMode,
    peersProvided: peers !== undefined,
    peerHintSource,
    peerAddressCount: peers?.length ?? 0,
    peerAddresses: peers ?? [],
    connectionState,
    peerReadyAt: null,
    dialStartedAt: null,
    dialFinishedAt: null,
    dialError: null,
    localFallbackState: "not-attempted",
    localFallbackAddress: null,
    localFallbackStartedAt: null,
    localFallbackFinishedAt: null,
    localFallbackError: null,
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
    peerHintSource,
    shareAddress,
    onReady,
    onLocalReady,
    onError,
    onDiagnostics,
}: {
    peers?: string[];
    peerHintSource: PeerHintSource;
    shareAddress: string | undefined;
    onReady: () => void;
    onLocalReady: () => void;
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
        const dialController = new AbortController();
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
        const dial: PeerDial = (address, options) =>
            (peer.dial as unknown as PeerDial).call(peer, address, options);
        const dialPromises = peers.map((address, index) =>
            Promise.resolve()
                .then(() =>
                    dialPeerWithTimeout(
                        dial,
                        address,
                        EXPLICIT_PEER_DIAL_TIMEOUT_MS,
                        dialController.signal
                    )
                )
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
        void Promise.allSettled(dialPromises).then(async () => {
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
            onDiagnostics({
                dialFinishedAt,
                dialError: error.message,
                dialResults: [...dialResults],
            });

            if (peerHintSource === "peer" && shareAddress) {
                const localFallbackStartedAt = Date.now();
                onDiagnostics({
                    localFallbackState: "checking",
                    localFallbackAddress: shareAddress,
                    localFallbackStartedAt,
                    localFallbackFinishedAt: null,
                    localFallbackError: null,
                });
                try {
                    const blocks = (
                        peer as unknown as {
                            services?: {
                                blocks?: {
                                    has?: (
                                        address: string
                                    ) => boolean | Promise<boolean>;
                                };
                            };
                        }
                    ).services?.blocks;
                    if (typeof blocks?.has !== "function") {
                        throw new Error(
                            "The local program block store is unavailable"
                        );
                    }
                    const localProgramAvailable =
                        await blocks.has(shareAddress);
                    if (cancelled) {
                        return;
                    }
                    const localFallbackFinishedAt = Date.now();
                    const fallbackOutcome = getLocalShareFallbackOutcome({
                        source: peerHintSource,
                        shareAddress,
                        localProgramAvailable,
                    });
                    if (fallbackOutcome === "ready-local") {
                        console.warn(
                            "Supplied peer hints were unavailable; opening the saved local share"
                        );
                        onDiagnostics({
                            localFallbackState: "ready",
                            localFallbackFinishedAt,
                        });
                        onLocalReady();
                        return;
                    }
                    onDiagnostics({
                        localFallbackState: "missing",
                        localFallbackFinishedAt,
                    });
                } catch (fallbackError) {
                    if (cancelled) {
                        return;
                    }
                    onDiagnostics({
                        localFallbackState: "error",
                        localFallbackFinishedAt: Date.now(),
                        localFallbackError: getErrorMessage(fallbackError),
                    });
                }
            }
            console.error("Failed to connect to supplied peers:", error);
            onError(error);
        });
        return () => {
            cancelled = true;
            dialController.abort(
                new DOMException("Peer override unmounted", "AbortError")
            );
        };
    }, [
        peer,
        peers?.join(","),
        peerHintSource,
        shareAddress,
        onDiagnostics,
        onError,
        onLocalReady,
        onReady,
    ]);

    return null;
};

export const App = () => {
    const benchmarkStorageMode = useMemo(
        () => getFileShareBenchmarkStorageMode(),
        []
    );
    const peerConfiguration = useMemo(
        () => getPeerAddressConfiguration(window.location.href),
        []
    );
    const shareAddress = useMemo(
        () => getShareAddressFromHref(window.location.href),
        []
    );
    const peers = peerConfiguration.peers;
    const [connectionState, setConnectionState] = useState<AppConnectionState>(
        peers !== undefined && peers.length > 0 ? "pending" : "ready"
    );
    const diagnosticsRef = useRef(
        createAppDiagnostics(
            peers,
            peerConfiguration.source,
            connectionState,
            benchmarkStorageMode
        )
    );
    diagnosticsRef.current.benchmarkStorageMode = benchmarkStorageMode;
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
    const handleLocalReady = useCallback(
        () => setConnectionState("ready-local"),
        []
    );
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
            ...(benchmarkStorageMode == null
                ? {}
                : { inMemory: benchmarkStorageMode === "memory" }),
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
        [benchmarkStorageMode, peers]
    );

    return (
        <PeerProvider config={peerProviderConfig}>
            <div className="h-screen">
                <PeerOverride
                    peers={peers}
                    peerHintSource={peerConfiguration.source}
                    shareAddress={shareAddress}
                    onReady={handleReady}
                    onLocalReady={handleLocalReady}
                    onError={handleError}
                    onDiagnostics={updateDiagnostics}
                />
                {connectionState === "ready" ||
                connectionState === "ready-local" ? (
                    <>
                        {connectionState === "ready-local" ? (
                            <div
                                className="fixed top-0 left-0 right-0 z-50 bg-amber-200 text-amber-950 text-center text-sm p-2"
                                data-testid="saved-copy-warning"
                                role="status"
                            >
                                Peer unavailable. Showing data saved on this
                                device; recent changes may be missing.
                            </div>
                        ) : null}
                        <HashRouter basename="/">
                            <BaseRoutes />
                        </HashRouter>
                    </>
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
