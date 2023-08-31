import { PeerProvider, usePeer } from "@peerbit/react";
import { BaseRoutes } from "./routes";
import { HashRouter } from "react-router-dom";
import { Footer } from "./Footer";

document.documentElement.classList.add("dark");
export const App = () => {
    return (
        <PeerProvider
            iframe={{ type: "proxy", targetOrigin: "*" }}
            top={{
                type: "node",
                network:
                    import.meta.env.MODE === "development" ? "local" : "remote",
                host: true,
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
