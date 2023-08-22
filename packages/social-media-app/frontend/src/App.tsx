import { releaseKey } from "@peerbit/react";
import { PeerProvider } from "@peerbit/react";
import { NameProvider } from "./names/useNames";
import { getRootKeypair } from "./keys";
import { RoomProvider } from "./useRooms";
import { HashRouter } from "react-router-dom";
import { Header } from "./Header";
import { BaseRoutes } from "./routes";
import { AppProvider } from "./useApps";

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

console.log(keypair.publicKey.toString());
export const App = () => {
    return (
        <PeerProvider
            network={
                import.meta.env.MODE === "development" ? "local" : "remote"
            }
            keypair={keypair}
            host={true}
        >
            <NameProvider>
                <HashRouter basename="/">
                    <AppProvider>
                        <RoomProvider>
                            <div className="text-slate-900 dark:text-white; bg-netrual-50 dark:bg-neutral-950">
                                <Header></Header>

                                <div
                                    /* className={`flex-row h-[calc(100vh - ${HEIGHT}] w-full`} */
                                    className="content-container"
                                >
                                    <div className="w-full">
                                        <BaseRoutes />
                                    </div>
                                </div>
                            </div>
                        </RoomProvider>
                    </AppProvider>
                </HashRouter>
            </NameProvider>
        </PeerProvider>
    );
};
