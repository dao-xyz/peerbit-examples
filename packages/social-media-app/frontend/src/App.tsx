import { releaseKey } from "@peerbit/react";
import { PeerProvider } from "@peerbit/react";
import { getRootKeypair } from "./keys";
import { HashRouter } from "react-router-dom";
import { Header } from "./Header";
import { BaseRoutes } from "./routes";
import { AppProvider } from "./content/useApps";
import { inIframe } from "@peerbit/react";
import { CanvasProvider } from "./canvas/useCanvas";
import { ProfileProvider } from "./profile/useProfiles";
import { IdentitiesProvider } from "./identity/useIdentities";
import { ErrorProvider } from "./dialogs/useErrorDialog";

/* import { logger, enable } from "@libp2p/logger";
enable("libp2p:*"); */

let { key: keypair, path: rootKeyPath } = await getRootKeypair();

window.onbeforeunload = function () {
    releaseKey(rootKeyPath);
};

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

export const App = () => {
    setTheme();
    return (
        <PeerProvider
            network={
                import.meta.env.MODE === "development" ? "local" : "remote"
            }
            keypair={keypair}
            top={{
                type: "node",
                network:
                    import.meta.env.MODE === "development" ? "local" : "remote",
                host: true,
            }}
            iframe={{ type: "proxy", targetOrigin: "*" }}
            waitForConnnected={false}
            inMemory={false}
        >
            <HashRouter basename="/">
                <ErrorProvider>
                    <IdentitiesProvider>
                        <AppProvider>
                            <CanvasProvider>
                                <ProfileProvider>
                                    <>
                                        <Header fullscreen={inIframe()}>
                                            <div
                                                /*     className={`flex-row h-[calc(100vh-${HEIGHT}px)] w-full`} */
                                                /*  */
                                                /*   */
                                                className="content-container w-full h-full"
                                            >
                                                <BaseRoutes />
                                            </div>
                                        </Header>
                                    </>
                                </ProfileProvider>
                            </CanvasProvider>
                        </AppProvider>
                    </IdentitiesProvider>
                </ErrorProvider>
            </HashRouter>
        </PeerProvider>
    );
};
