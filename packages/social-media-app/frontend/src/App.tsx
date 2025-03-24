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
import { useEffect } from "react";

const setTheme = () => {
    // On page load or when changing themes, best to add inline in `head` to avoid FOUC
    if (
        localStorage.theme === "dark" ||
        (!("theme" in localStorage) &&
            window.matchMedia("(prefers-color-scheme: dark)").matches)
    ) {
        localStorage.setItem("theme", "dark");
        document.documentElement.classList.add("dark");
    } else {
        document.documentElement.classList.remove("dark");
    }
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
                showError({
                    message: peerError.message,
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
    setTheme();
    return (
        <HashRouter basename="/">
            <ErrorProvider>
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
                                    <Content />
                                </ProfileProvider>
                            </CanvasProvider>
                        </AppProvider>
                    </IdentitiesProvider>
                </PeerProvider>
            </ErrorProvider>
        </HashRouter>
    );
};
