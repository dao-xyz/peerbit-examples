import { ClientBusyError, usePeer } from "@peerbit/react";
import { PeerProvider } from "@peerbit/react";
import { HashRouter } from "react-router";
import { Header } from "./Header";
import { BaseRoutes } from "./routes";
import { AppProvider } from "./content/useApps";
import { inIframe } from "@peerbit/react";
import { ProfileProvider } from "./profile/useProfiles";
import { IdentitiesProvider } from "./identity/useIdentities";
import { ErrorProvider, useErrorDialog } from "./dialogs/useErrorDialog";
import { HostRegistryProvider } from "@giga-app/sdk";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ThemeProvider } from "./theme/useTheme";
import { ReplyProgressProvider } from "./canvas/main/useReplyProgress";
import { AIReplyProvider } from "./ai/AIReployContext";
import {
    HeaderVisibilityProvider,
    useHeaderVisibilityContext,
} from "./HeaderVisibilitiyProvider";
import useRemoveFocusWhenNotTab from "./canvas/utils/outline";
import type { NetworkOption } from "@peerbit/react";
import { BlurOnOutsidePointerProvider } from "./canvas/feed/BlurOnScrollProvider";
import { CustomizedBackground } from "./canvas/custom/applyVisualization";
import { CustomizationProvider } from "./canvas/custom/CustomizationProvider";
import clsx from "clsx";
import { FocusProvider } from "./FocusProvider";
import { CanvasProvider } from "./canvas/useCanvas";
import { StreamProvider } from "./canvas/feed/StreamContext";
import { EditModeProvider } from "./canvas/edit/EditModeProvider";
import { ToolbarVisibilityProvider } from "./canvas/edit/ToolbarVisibilityProvider";
import { ScopeRegistryProvider } from "./canvas/useScope";
import { DraftManagerProvider } from "./canvas/edit/draft/DraftManager";
import { setupPrettyConsole } from "./debug/debug";
import { DebugConfigProvider } from "./debug/DebugConfig";
import { DeveloperConfigProvider } from "./debug/DeveloperConfig";
import { StreamSettingsProvider } from "./canvas/feed/StreamSettingsContext";
import { BOOTSTRAP_ADDRS } from "./bootstrap.js";

const HEADER_EXPANDED_HEIGHT = 12;
const heightStyle: { [expanded: string]: string } = {
    true: `min-h-${HEADER_EXPANDED_HEIGHT}`,
    false: `min-h-${HEADER_EXPANDED_HEIGHT}`,
};

export const Content = () => {
    const { error: peerError, peer, persisted } = usePeer();
    const { showError } = useErrorDialog();

    useEffect(() => {
        if (peerError) {
            if (peerError instanceof ClientBusyError) {
                showError({
                    title: "Session already open",
                    message:
                        "You already have a session open in another tab. Please close this tab and use the other one.",
                    deadend: true,
                    severity: "info",
                });
            } else {
                console.error("Unexpected error", typeof peerError);
                showError({
                    message:
                        typeof peerError === "string"
                            ? peerError
                            : peerError?.message,
                    error: peerError,
                    severity: "error",
                });
            }
        }
    }, [peerError, showError]);

    // Use our new hook to control header visibility.
    const { visible: headerVisible } = useHeaderVisibilityContext();

    const [headerHeight, setHeaderHeight] = useState(0);
    const headerRef = useRef<HTMLDivElement>(null);

    useRemoveFocusWhenNotTab();

    useLayoutEffect(() => {
        if (headerRef.current) {
            setHeaderHeight(headerRef.current.offsetHeight);
        }
    }, []);

    // Expose peer identity & persistence info for tests/debugging across reloads
    useEffect(() => {
        try {
            const peerHash = peer?.identity?.publicKey?.hashcode?.();
            if (!peerHash) return;
            (window as any).__peerInfo = { peerHash, persisted };
            window.dispatchEvent(
                new CustomEvent("peer:ready", {
                    detail: (window as any).__peerInfo,
                })
            );
        } catch { }
    }, [peer?.identity?.publicKey?.hashcode?.(), persisted]);

    return (
        <CustomizationProvider>
            <CustomizedBackground className=" h-full">
                <StreamSettingsProvider>
                    <StreamProvider>
                        <DraftManagerProvider debug>
                            <ToolbarVisibilityProvider>
                                <EditModeProvider>
                                    {" "}
                                    {/* influences whether canvases are editable or not */}
                                    <FocusProvider>
                                        {/* Main header with transform animation */}
                                        <div
                                            ref={headerRef}
                                            className={clsx(
                                                "sticky top-0 inset-x-0  z-30",
                                                heightStyle[
                                                String(headerVisible)
                                                ]
                                            )} /* transition-transform duration-800 ease-in-out */
                                            style={
                                                {
                                                    /*  transform: headerVisible
                                                     ? "translateY(0)"
                                                     : `translateY(-${headerHeight}px)`, */
                                                    /* transition: "max-height 0.3s ease-in-out", */
                                                    /*     transform: "translateY(0)",
                                                    backfaceVisibility: "hidden", */
                                                }
                                            }
                                        >
                                            <Header fullscreen={inIframe()} />
                                        </div>

                                        {/* Add padding so content isn’t hidden by the fixed header */}
                                        <BaseRoutes />
                                    </FocusProvider>
                                </EditModeProvider>
                            </ToolbarVisibilityProvider>
                        </DraftManagerProvider>
                        {/* This is the main content area, which will be scrolled */}
                    </StreamProvider>
                </StreamSettingsProvider>
            </CustomizedBackground>
        </CustomizationProvider>
    );
};

export const App = () => {
    // Initialize debug console once per app load
    setupPrettyConsole();
    // Parse query params from both traditional search (?foo=bar) and hash segment (/#/path?foo=bar)
    const params = (() => {
        const merged = new URLSearchParams(window.location.search);
        const hash = window.location.hash || ""; // e.g. #/path?bootstrap=offline&v=feed
        const qIndex = hash.indexOf("?");
        if (qIndex !== -1) {
            const hashQuery = hash.substring(qIndex + 1); // after the ? to end (before potential # but hash won't contain another # normally)
            // Remove potential fragment-only routing prefixes like #/ or #//
            const clean = hashQuery.replace(/^\/?/, "");
            const hashParams = new URLSearchParams(clean);
            hashParams.forEach((v, k) => {
                if (!merged.has(k)) {
                    merged.set(k, v);
                }
            });
        }
        return merged;
    })();
    const flagTrue = (val: string | null) =>
        val == null || val === "" ? undefined : val === "true" || val === "1";
    // Single canonical flag for non-persistent mode
    // Default behavior: persistent (inMemory=false). Override with ?ephemeral=true when desired.
    const eph = flagTrue(params.get("ephemeral"));
    const inMemory = eph === undefined ? false : eph;
    const bootstrapParam = params.get("bootstrap");
    // Support an "offline" mode (or empty ?bootstrap=) for tests/e2e to avoid dialing any relays
    // If bootstrap is explicitly provided (even if empty or 'offline'), we pass an explicit network option
    const offline =
        bootstrapParam !== null &&
        bootstrapParam.trim().toLowerCase() === "offline";
    const bootstrapAddrs =
        bootstrapParam !== null
            ? offline
                ? [] // explicit offline sentinel
                : bootstrapParam
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
            : undefined; // not provided at all => use default network config
    if (typeof window !== "undefined") {
        (window as any).__DBG_BOOTSTRAP = bootstrapAddrs; // aid tests/debug
    }

    // your original config stays the same, but now reuses that array
    const networkConfig: NetworkOption =
        import.meta.env.MODE === "development"
            ? {
                /* type: "local" */
                bootstrap: ["/ip4/127.0.0.1/tcp/59322/ws/p2p/12D3KooWKyXvBLwPAmuPAi485z2hNB9B7tCNmvk2tWhMwa9AZdmu"]
            }
            : { bootstrap: BOOTSTRAP_ADDRS };

    return (
        <HashRouter basename="/">
            <ErrorProvider>
                <ThemeProvider>
                    <DebugConfigProvider>
                        <DeveloperConfigProvider>
                            <PeerProvider
                                network={
                                    bootstrapAddrs !== undefined
                                        ? {
                                            // Explicit override: if empty we stay offline
                                            type: "explicit",
                                            bootstrap: bootstrapAddrs,
                                        }
                                        : networkConfig
                                }
                                iframe={{ type: "proxy", targetOrigin: "*" }}
                                waitForConnnected={true}
                                inMemory={inMemory}
                                singleton
                            >
                                <IdentitiesProvider>
                                    <AppProvider>
                                        <HeaderVisibilityProvider>
                                            <BlurOnOutsidePointerProvider>
                                                <ScopeRegistryProvider>
                                                    <CanvasProvider>
                                                        <ReplyProgressProvider>
                                                            <ProfileProvider>
                                                                <AIReplyProvider>
                                                                    <HostRegistryProvider>
                                                                        <Content />
                                                                        {/* <DebugOverlay /> */}
                                                                    </HostRegistryProvider>
                                                                </AIReplyProvider>
                                                            </ProfileProvider>
                                                        </ReplyProgressProvider>
                                                    </CanvasProvider>
                                                </ScopeRegistryProvider>
                                            </BlurOnOutsidePointerProvider>
                                        </HeaderVisibilityProvider>
                                    </AppProvider>
                                </IdentitiesProvider>
                            </PeerProvider>
                        </DeveloperConfigProvider>
                    </DebugConfigProvider>
                </ThemeProvider>
            </ErrorProvider>
        </HashRouter>
    );
};
