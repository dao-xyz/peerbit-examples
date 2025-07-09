// Content.tsx
import { ClientBusyError, usePeer } from "@peerbit/react";
import { PeerProvider } from "@peerbit/react";
import { HashRouter } from "react-router";
import { Header } from "./Header";
import { BaseRoutes } from "./routes";
import { AppProvider } from "./content/useApps";
import { inIframe } from "@peerbit/react";
import { CanvasProvider } from "./canvas/useCanvas";
import { ProfileProvider } from "./profile/useProfiles";
import { IdentitiesProvider } from "./identity/useIdentities";
import { ErrorProvider, useErrorDialog } from "./dialogs/useErrorDialog";
import { HostRegistryProvider } from "@giga-app/sdk";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ThemeProvider } from "./theme/useTheme";
import { ReplyProgressProvider } from "./canvas/main/useReplyProgress";
import { AIReplyProvider } from "./ai/AIReployContext";
import { ViewProvider } from "./canvas/view/ViewContext";
import {
    HeaderVisibilityProvider,
    useHeaderVisibilityContext,
} from "./HeaderVisibilitiyProvider";
import useRemoveFocusWhenNotTab from "./canvas/utils/outline";
import type { NetworkOption } from "@peerbit/react";
import { BlurOnOutsidePointerProvider } from "./canvas/feed/BlurOnScrollProvider";
import { CustomizedBackground } from "./canvas/custom/applyVisualization";
import { CustomizationProvider } from "./canvas/custom/CustomizationProvider";
import { FeedProvider } from "./canvas/feed/FeedContext";
import clsx from "clsx";
import { FocusProvider } from "./FocusProvider";

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
        <ViewProvider>
            <FeedProvider>
                <CustomizationProvider>
                    <CustomizedBackground className=" h-full">
                        <FocusProvider>
                            {/* Main header with transform animation */}
                            <div
                                ref={headerRef}
                                className={clsx(
                                    "sticky top-0 inset-x-0  z-30",
                                    heightStyle[String(headerVisible)]
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
                    </CustomizedBackground>
                </CustomizationProvider>
            </FeedProvider>
        </ViewProvider>
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
                  "/dns4/a5c173e3e5dc4a3a7a07cf805da8d1643cbb6d22.peerchecker.com/tcp/4003/wss/p2p/12D3KooWQ6iCbymYAy6YbBU3VJrXZf2p7974uwHq45SRguEb5mzE",
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
                        waitForConnnected={true}
                        inMemory={false}
                        singleton
                    >
                        <IdentitiesProvider>
                            <AppProvider>
                                <HeaderVisibilityProvider>
                                    <BlurOnOutsidePointerProvider>
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
