import { HashRouter } from "react-router-dom";
import {
    createTheme,
    responsiveFontSizes,
    ThemeProvider,
    CssBaseline,
} from "@mui/material";
import { Content } from "./Content";
import { PeerProvider } from "@peerbit/react";
import blue from "@mui/material/colors/amber";
import { inIframe } from "@peerbit/react";

/* import { logger, enable } from "@libp2p/logger";
enable("libp2p:*"); */

let theme = createTheme({
    palette: {
        mode: "dark",
        primary: blue,
        background: inIframe()
            ? {
                  default: "transparent",
              }
            : {},
    },
    typography: {
        fontFamily: [
            "-apple-system",
            "BlinkMacSystemFont",
            '"Segoe UI"',
            "Roboto",
            '"Helvetica Neue"',
            "Arial",
            "sans-serif",
            '"Apple Color Emoji"',
            '"Segoe UI Emoji"',
            '"Segoe UI Symbol"',
        ].join(","),
    },
});
theme = responsiveFontSizes(theme);

export const App = () => {
    return (
        <PeerProvider
            inMemory={true /* inIframe() */} // TODO mobile in memory? Weak devices in memory? https://github.com/dao-xyz/peerbit/issues/18
            waitForConnnected={true}
            bootstrap={[
                "/dns4/36b631592994756b7365801a28b9ecafca843171.peerchecker.com/tcp/4003/wss/p2p/12D3KooWHEXi7VtdBFANXXVvWXVDSQaWTHZUjZq2MsVUxQ1ZF4SX",
            ]}
            network={
                import.meta.env.MODE === "development" ? "local" : "remote"
            }
        >
            <ThemeProvider theme={theme}>
                <CssBaseline />
                <HashRouter basename="/">
                    <Content />
                </HashRouter>
            </ThemeProvider>
        </PeerProvider>
    );
};
