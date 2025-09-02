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
import {
    PrivateScope,
    PublicScope,
    ScopeRegistryProvider,
} from "./canvas/useScope";
import { DraftManagerProvider } from "./canvas/edit/draft/DraftManager";
import { StreamSettingsProvider } from "./canvas/feed/StreamSettingsContext";

const HEADER_EXPANDED_HEIGHT = 12;
const heightStyle: { [expanded: string]: string } = {
    true: `min-h-${HEADER_EXPANDED_HEIGHT}`,
    false: `min-h-${HEADER_EXPANDED_HEIGHT}`,
};

export const Content = () => {
    const { error: peerError } = usePeer();
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

const networkConfig: NetworkOption =
    import.meta.env.MODE === "development"
        ? {
            type: "local",
        }
        : {
            type: "remote",
            bootstrap: [
                "/dns4/d9f74f9f8dfcf3a5c912238b177d04ad45e936f3.peerchecker.com/tcp/4003/wss/p2p/12D3KooWNh5kj63a5rfKJCJL4PznDMmZKTJ2VQQQxE8161bgZ3nR",
            ],
        };

export const App = () => {
    return (
        <HashRouter basename="/">
            <ErrorProvider>
                <ThemeProvider>
                    <PeerProvider
                        network={networkConfig}
                        iframe={{ type: "proxy", targetOrigin: "*" }}
                        waitForConnnected={false}
                        inMemory={false}
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
                </ThemeProvider>
            </ErrorProvider>
        </HashRouter>
    );
};
