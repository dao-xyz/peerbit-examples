import { ClientBusyError, releaseKey, usePeer } from "@peerbit/react";
import { PeerProvider } from "@peerbit/react";
import { HashRouter } from "react-router-dom";
import { Header } from "./Header";
import { BaseRoutes } from "./routes";
import { AppProvider } from "./content/useApps";
import { inIframe } from "@peerbit/react";
import { CanvasProvider } from "./canvas/useCanvas";
import { ProfileProvider } from "./profile/useProfiles";
import { IdentitiesProvider } from "./identity/useIdentities";
import { ErrorProvider, useErrorDialog } from "./dialogs/useErrorDialog";
import { HostRegistryProvider } from "@giga-app/sdk";
import { useEffect } from "react";
import { ThemeProvider } from "./theme/useTheme";

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
    }, [peerError]);
    return (
        <>
            <Header fullscreen={inIframe()}>
                <BaseRoutes />
            </Header>
        </>
    );
};
export const App = () => {
    return (
        <HashRouter basename="/">
            <ErrorProvider>
                <ThemeProvider>
                    <PeerProvider
                        network={
                            import.meta.env.MODE === "development"
                                ? "local"
                                : "remote"
                        }
                        top={{
                            type: "node",
                            network:
                                import.meta.env.MODE === "development"
                                    ? "local"
                                    : "remote",
                            host: true,
                        }}
                        iframe={{ type: "proxy", targetOrigin: "*" }}
                        waitForConnnected={false}
                        inMemory={false}
                        singleton
                    >
                        <IdentitiesProvider>
                            <AppProvider>
                                <CanvasProvider>
                                    <ProfileProvider>
                                        <HostRegistryProvider>
                                            <Content />
                                        </HostRegistryProvider>
                                    </ProfileProvider>
                                </CanvasProvider>
                            </AppProvider>
                        </IdentitiesProvider>
                    </PeerProvider>
                </ThemeProvider>
            </ErrorProvider>
        </HashRouter>
    );
};
