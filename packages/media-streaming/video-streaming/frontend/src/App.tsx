import { HashRouter } from "react-router";
import { Content } from "./Content";
import { PeerProvider } from "@peerbit/react";

import "./index.css";
document.documentElement.classList.add("dark");

export const App = () => {
    return (
        <PeerProvider
            config={{
                runtime: "node",
                inMemory: true, // TODO mobile in memory? Weak devices in memory? https://github.com/dao-xyz/peerbit/issues/18
                waitForConnected: true,
                network:
                    import.meta.env.MODE === "development" ? "local" : "remote",
            }}
        >
            <HashRouter basename="/">
                <Content />
            </HashRouter>
        </PeerProvider>
    );
};
