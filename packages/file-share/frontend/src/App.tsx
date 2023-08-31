import { PeerProvider, usePeer } from "@peerbit/react";
import { BaseRoutes } from "./routes";
import { HashRouter } from "react-router-dom";

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
            <HashRouter basename="/">
                <BaseRoutes />
            </HashRouter>
        </PeerProvider>
    );
};
