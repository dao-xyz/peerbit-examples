import { useEffect } from "react";
import { PeerProvider } from "./Peer";
import { HashRouter } from "react-router-dom";
import {
    createTheme,
    responsiveFontSizes,
    ThemeProvider,
    CssBaseline,
} from "@mui/material";
import { ChatProvider } from "./ChatContext";
import { Content } from "./Context";
import * as x from "@dao-xyz/peerbit-example-browser-chat";
import * as y from "@dao-xyz/peerbit";
import * as z from "@dao-xyz/peerbit-crypto";

console.log(x, y, z);
let theme = createTheme({
    palette: {
        mode: "dark",
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
    useEffect(() => {
        console.log();
    }, []);
    return (
        <PeerProvider>
            <ChatProvider>
                <ThemeProvider theme={theme}>
                    <CssBaseline />
                    <HashRouter basename="/">
                        <Content />
                    </HashRouter>
                </ThemeProvider>
            </ChatProvider>
        </PeerProvider>
    );
};
