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
                waitForConnnected: true,
                bootstrap: [
                    "/dns4/8f7ec389599f3350e466dbcbd11acea60c3e3376.peerchecker.com/tcp/4003/wss/p2p/12D3KooWGERhPmCQ4GpxL1rX5y2uEJENcaShygapvUmnpfoddypy",
                ],
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
