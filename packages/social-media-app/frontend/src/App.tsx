import { ClientBusyError, usePeer } from "@peerbit/react";
import { HashRouter } from "react-router";
import { AppProvider } from "./content/useApps";
import { ProfileProvider } from "./profile/useProfiles";
import { IdentitiesProvider } from "./identity/useIdentities";
import { ErrorProvider, useErrorDialog } from "./dialogs/useErrorDialog";
import { HostRegistryProvider } from "@giga-app/sdk";
import { useEffect } from "react";
import { ThemeProvider } from "./theme/useTheme";
import { ReplyProgressProvider } from "./canvas/main/useReplyProgress";
import { AIReplyProvider } from "./ai/AIReployContext";
import { HeaderVisibilityProvider } from "./HeaderVisibilitiyProvider";
import useRemoveFocusWhenNotTab from "./canvas/utils/outline";
import type { NetworkOption } from "@peerbit/react";
import { BlurOnOutsidePointerProvider } from "./canvas/feed/BlurOnScrollProvider";
import { FocusProvider } from "./FocusProvider";
import { EditModeProvider } from "./canvas/edit/EditModeProvider";
import { ToolbarVisibilityProvider } from "./canvas/edit/ToolbarVisibilityProvider";
import { ScopeRegistryProvider } from "./canvas/useScope";
import { DraftManagerProvider } from "./canvas/edit/draft/DraftManager";
import { setupPrettyConsole } from "./debug/debug";
import { DebugConfigProvider } from "./debug/DebugConfig";
import { DeveloperConfigProvider } from "./debug/DeveloperConfig";
import { StreamSettingsProvider } from "./canvas/feed/StreamSettingsContext";
import { BOOTSTRAP_ADDRS } from "@giga-app/network";
import { AuthProvider } from "./auth/useAuth";
import { IdentityNoticeProvider } from "./auth/IdentityNoticeDialog";
import { PeerWithAuth } from "./auth/PeerWithAuth";
import { AuthNextRedirect } from "./auth/AuthNextRedirect";
import { SupabaseIdentityBinder } from "./auth/SupabaseIdentityBinder";
import { enable } from "@peerbit/logger";
import {
    markStorageSnapshot,
    publishStartupPerfSnapshot,
    startupMark,
} from "./debug/perf";
import { LayeredContent } from "./LayeredContent";
enable("peerbit:react:usePeer:*");

export const Content = () => {
    const { error: peerError, peer, persisted, status, loading } = usePeer();
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

    useEffect(() => {
        if (status) startupMark(`peer:status:${status}`, { loading });
        if (loading === false) startupMark("peer:loading:false");
    }, [status, loading]);

    useEffect(() => {
        if (!peer) return;
        startupMark("peer:context:ready", {
            peerHash: peer.identity.publicKey.hashcode(),
            persisted,
            status,
        });
        markStorageSnapshot("afterPeerReady");
        publishStartupPerfSnapshot("peer:context:ready");
    }, [peer?.identity?.publicKey?.hashcode?.(), persisted, status]);

    useRemoveFocusWhenNotTab();

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
        } catch {}
    }, [peer?.identity?.publicKey?.hashcode?.(), persisted]);

    return (
        <StreamSettingsProvider>
            <DraftManagerProvider debug>
                <ToolbarVisibilityProvider>
                    <EditModeProvider>
                        <FocusProvider>
                            <LayeredContent />
                        </FocusProvider>
                    </EditModeProvider>
                </ToolbarVisibilityProvider>
            </DraftManagerProvider>
        </StreamSettingsProvider>
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
    const waitForConnnected = (() => {
        const raw =
            params.get("waitForConnected") ??
            params.get("waitForConnnected") ??
            null;
        if (raw == null) return true;
        const v = raw.trim().toLowerCase();
        if (v === "" || v === "1" || v === "true") return true;
        if (v === "0" || v === "false") return false;
        if (v === "in-flight" || v === "inflight" || v === "in_flight")
            return "in-flight" as const;
        return true;
    })();
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
        const w: any = window as any;
        w.__DBG_BOOTSTRAP = bootstrapAddrs; // aid tests/debug
        if (offline && !w.__offline_bootstrap_logged) {
            w.__offline_bootstrap_logged = true;
            try {
                // aid offline e2e smoke checks
                console.log("Offline bootstrap: skipping relay dialing");
            } catch {}
        }
    }

    // your original config stays the same, but now reuses that array
    const networkConfig: NetworkOption =
        import.meta.env.MODE === "development"
            ? {
                  type: "local",
              }
            : { bootstrap: BOOTSTRAP_ADDRS };

    useEffect(() => {
        startupMark("app:config", {
            inMemory,
            offline,
            bootstrapCount: bootstrapAddrs?.length ?? null,
            waitForConnnected,
        });
        publishStartupPerfSnapshot("app:config");
    }, [inMemory, offline, bootstrapAddrs?.join(","), waitForConnnected]);

    return (
        <HashRouter basename="/">
            <ErrorProvider>
                <ThemeProvider>
                    <DebugConfigProvider>
                        <DeveloperConfigProvider>
                            <AuthProvider>
                                <AuthNextRedirect />
                                <PeerWithAuth
                                    network={
                                        bootstrapAddrs !== undefined
                                            ? {
                                                  // Explicit override: if empty we stay offline
                                                  type: "explicit",
                                                  bootstrap: bootstrapAddrs,
                                              }
                                            : networkConfig
                                    }
                                    iframe={{
                                        type: "proxy",
                                        targetOrigin: "*",
                                    }}
                                    waitForConnnected={waitForConnnected}
                                    inMemory={inMemory}
                                    singleton
                                >
                                    <IdentityNoticeProvider>
                                        <SupabaseIdentityBinder />
                                        <IdentitiesProvider>
                                            <AppProvider>
                                                <HeaderVisibilityProvider>
                                                    <BlurOnOutsidePointerProvider>
                                                        <ScopeRegistryProvider>
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
                                                        </ScopeRegistryProvider>
                                                    </BlurOnOutsidePointerProvider>
                                                </HeaderVisibilityProvider>
                                            </AppProvider>
                                        </IdentitiesProvider>
                                    </IdentityNoticeProvider>
                                </PeerWithAuth>
                            </AuthProvider>
                        </DeveloperConfigProvider>
                    </DebugConfigProvider>
                </ThemeProvider>
            </ErrorProvider>
        </HashRouter>
    );
};
