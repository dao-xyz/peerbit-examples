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
                              "/dns4/b9981764b064f1af2e9b0e3ef63e612c33418081.peerchecker.com/tcp/4003/wss/p2p/12D3KooWM7N2DZxfpFaWrhtZ3BY54gqeTFBTN3no55yNNHSjuu4y",
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
