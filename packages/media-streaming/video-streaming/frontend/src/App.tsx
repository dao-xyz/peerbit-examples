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
                          type: "remote",
                          bootstrap: [
                              "/dns4/bc97c21cb63f3360c9328ed9b3a0753cce7165f4.peerchecker.com/tcp/4003/wss/p2p/12D3KooWMWKqQejvpuKRFzYhDjYYkCgEMqnfAjbB5zHt9kMqzuro",
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
