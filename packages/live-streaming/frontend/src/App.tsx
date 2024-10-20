import { HashRouter } from "react-router-dom";
import { Content } from "./Content";
import { PeerProvider } from "@peerbit/react";
import "./index.css";
document.documentElement.classList.add("dark");

export const App = () => {
    return (
        <PeerProvider
            inMemory={true /* inIframe() */} // TODO mobile in memory? Weak devices in memory? https://github.com/dao-xyz/peerbit/issues/18
            waitForConnnected={true}
            network={
                import.meta.env.MODE === "development" ? "local" : "remote"
            }
        >
            {/*  <ThemeProvider theme={theme}>
                <CssBaseline /> */}
            <HashRouter basename="/">
                <Content />
            </HashRouter>
            {/*    </ThemeProvider> */}
        </PeerProvider>
    );
};
