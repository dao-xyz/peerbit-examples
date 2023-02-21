import { PeerProvider } from "@dao-xyz/peerbit-react";
import { HashRouter } from "react-router-dom";
import {
    createTheme,
    responsiveFontSizes,
    ThemeProvider,
    CssBaseline,
} from "@mui/material";
import { Content } from "./Content";
import { resolveSwarmAddress, inIframe } from "@dao-xyz/peerbit-react";
import axios from "axios";

// Bootstrap addresses for network
let bootstrapAddresses: string[];
if (import.meta.env.MODE === "development") {
    bootstrapAddresses = [
        "/ip4/127.0.0.1/tcp/8002/ws/p2p/12D3KooWBycJFtocweGrU7AvArJbTgrvNxzKUiy8ey8rMLA1A1SG",
    ];
} else {
    const swarmAddressees = [
        "c134ffe07eeae36ec95917e88b942232324f672f.peerchecker.com",
    ];
    try {
        bootstrapAddresses = await Promise.all(
            swarmAddressees.map((s) => resolveSwarmAddress(s))
        );
    } catch (error: any) {
        console.log(
            "Failed to resolve relay node. Please come back later or start the demo locally: " +
                error?.message
        );
    }
}

// Theme
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
// import.meta.env.DEV
export const App = () => {
    return (
        <PeerProvider
            bootstrap={bootstrapAddresses}
            dev={import.meta.env.MODE === "development"}
            waitForKeypairInIFrame={inIframe()}
            inMemory={inIframe()}
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
