import { PeerProvider } from "@peerbit/react";
import { BaseRoutes } from "./routes";

import { HashRouter } from "react-router";
import { Footer } from "./Footer";
/* import { enable } from "@libp2p/logger";
enable("libp2p:*"); */
/* import { logger } from "@peerbit/logger";

const loggefr = logger({ module: "shared-log" })
loggefr.level = 'trace'
loggefr.trace("hello") */
document.documentElement.classList.add("dark");
export const App = () => {
    return (
        <PeerProvider
            config={{
                runtime: "node",
                network: import.meta.env.MODE === "development" ? "local" : "remote",
                waitForConnected: true,
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
