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
                import.meta.env.MODE === "development"
                    ? "local"
                    : {
                          bootstrap: [
                              "/dns4/9b97941c59a57bfe1cb9326c0adec2a1348e6940.peerchecker.com/tcp/4003/wss/p2p/12D3KooWLeSKmApwQ12CWQsumiy6Ge4u6hQR4KpEKMg9gHrNQwzf",
                          ],
                      }
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
