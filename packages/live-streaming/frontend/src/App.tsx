import { HashRouter } from "react-router";
import { Content } from "./Content";
import { PeerProvider } from "@peerbit/react";
import { AppProvider } from "@giga-app/sdk";

import "./index.css";
document.documentElement.classList.add("dark");

export const App = () => {
    return (
        <PeerProvider
            inMemory={true} // TODO mobile in memory? Weak devices in memory? https://github.com/dao-xyz/peerbit/issues/18
            waitForConnnected={true}
            network={
                import.meta.env.MODE === "development" ? "local" : "remote"
            }
        >
            <AppProvider navigation="emit-all">
                <HashRouter basename="/">
                    <Content />
                </HashRouter>
            </AppProvider>
        </PeerProvider>
    );
};
