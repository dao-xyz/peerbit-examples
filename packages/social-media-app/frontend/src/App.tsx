import { releaseKey } from "@peerbit/react";
import { PeerProvider } from "@peerbit/react";
import { getRootKeypair } from "./keys";
import { HashRouter } from "react-router-dom";
import { Header } from "./Header";
import { BaseRoutes } from "./routes";
import { AppProvider } from "./content/useApps";
/* import { logger, enable } from "@libp2p/logger";
enable("libp2p:*"); */
/*
 "&::-webkit-scrollbar, & *::-webkit-scrollbar": {
    backgroundColor: "#2b2b2b",
},
"&::-webkit-scrollbar-thumb, & *::-webkit-scrollbar-thumb":
{
    borderRadius: 8,
    backgroundColor: "#6b6b6b",
    minHeight: 24,
    border: "3px solid #2b2b2b",
},
"&::-webkit-scrollbar-thumb:focus, & *::-webkit-scrollbar-thumb:focus":
{
    backgroundColor: "#959595",
},
"&::-webkit-scrollbar-thumb:active, & *::-webkit-scrollbar-thumb:active":
{
    backgroundColor: "#959595",
},
"&::-webkit-scrollbar-thumb:hover, & *::-webkit-scrollbar-thumb:hover":
{
    backgroundColor: "#959595",
},
"&::-webkit-scrollbar-corner, & *::-webkit-scrollbar-corner":
{
    backgroundColor: "#2b2b2b",
},

// Add override for canvas element placeholder (the rectangle that appears when you drag rects)
"& .react-grid-placeholder": {
    color: "white",
    backgroundColor:
        theme.palette.primary.main + " !important",
},
"& .canvas-react-resizable-handle": {
    borderColor:
        theme.palette.primary.main + " !important",
    backgroundColor: theme.palette.text.primary,
},
"& .react-grid-item": {
    transition: "disabled !important",
}, */

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
    /*
      // Whenever the user explicitly chooses light mode
      localStorage.theme = 'light'

      // Whenever the user explicitly chooses dark mode
      localStorage.theme = 'dark'

      // Whenever the user explicitly chooses to respect the OS preference
      localStorage.removeItem('theme') */

    /* document.documentElement.classList.remove('dark') */
};

import { inIframe } from "@peerbit/react";
import { CanvasProvider } from "./canvas/useCanvas";
import { ProfileProvider } from "./profile/useProfiles";
import { IdentitiesProvider } from "./identity/useIdentities";
import { ErrorProvider } from "./dialogs/useErrorDialog";

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
                                        {!inIframe() && <Header></Header>}
                                        <div
                                            /*     className={`flex-row h-[calc(100vh-${HEIGHT}px)] w-full`} */
                                            /*  */
                                            /*   */
                                            className="content-container flex-1 h-full overflow-hidden"
                                        >
                                            <BaseRoutes />
                                        </div>
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
