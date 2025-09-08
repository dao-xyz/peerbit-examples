import { HashRouter } from "react-router";
import { Content } from "./Content";
import { PeerProvider } from "@peerbit/react";

import "./index.css";
import { LibrariesProvider } from "./libraries/LibrariesContext";
import { NamesProvider } from "./NamesProvider";
import { PlayStatsProvider } from "./play/PlayStatsContext";
import { ErrorProvider } from "./dialogs/useErrorDialog";

document.documentElement.classList.add("dark");

export const App = () => {
    return (
        <ErrorProvider>
            <PeerProvider
                inMemory={false} // TODO mobile in memory? Weak devices in memory? https://github.com/dao-xyz/peerbit/issues/18
                waitForConnnected={true}
                singleton={true}
                network={
                    import.meta.env.MODE === "development"
                        ? "local"
                        : {
                              bootstrap: [
                                  "/dns4/72e2dee3b6cc99167ecfb6114874cd9bf02f49e3.peerchecker.com/tcp/4003/wss/p2p/12D3KooWHVop5CpMVrBDtRtRnX4Z5ytVS2764DALemTbuZDzV11V",
                              ],
                          }
                }
            >
                <NamesProvider>
                    <LibrariesProvider>
                        <PlayStatsProvider>
                            <HashRouter basename="/">
                                <Content />
                            </HashRouter>
                        </PlayStatsProvider>
                    </LibrariesProvider>
                </NamesProvider>
            </PeerProvider>
        </ErrorProvider>
    );
};
