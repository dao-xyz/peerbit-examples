import { PeerProvider, usePeer } from "@peerbit/react";
import { BaseRoutes } from "./routes";
import { HashRouter } from "react-router-dom";
import { Footer } from "./Footer";
/* import { enable } from "@libp2p/logger";
enable("libp2p:*"); */
document.documentElement.classList.add("dark");

export const App = () => {
    return (
        <PeerProvider
            /*    inMemory={true} */
            iframe={{ type: "proxy", targetOrigin: "*" }}
            top={{
                /* inMemory: true, */
                type: "node",
                network:
                    import.meta.env.MODE === "development" ? "local" : "remote",
                host: true,
                waitForConnnected: true,
            }}
        >
            <div className="h-screen">
                <HashRouter basename="/">
                    <BaseRoutes />
                </HashRouter>
                <Footer />
            </div>
        </PeerProvider>
    );
};
