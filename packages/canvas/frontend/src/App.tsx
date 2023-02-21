import { HashRouter } from "react-router-dom";
import {
    createTheme,
    responsiveFontSizes,
    ThemeProvider,
    CssBaseline,
} from "@mui/material";
import { resolveSwarmAddress } from "@dao-xyz/peerbit-react";
import { PeerProvider } from "@dao-xyz/peerbit-react";
import { BaseRoutes } from "./routes";

// Bootstrap addresses for network
let bootstrapAddresses: string[];
if (import.meta.env.MODE === "development") {
    bootstrapAddresses = [
        "/ip4/127.0.0.1/tcp/8002/ws/p2p/12D3KooWBycJFtocweGrU7AvArJbTgrvNxzKUiy8ey8rMLA1A1SG",
    ];
} else {
    console.log("get!");

    const swarmAddressees = [
        "c134ffe07eeae36ec95917e88b942232324f672f.peerchecker.com",
    ];
    try {
        bootstrapAddresses = await Promise.allSettled(
            swarmAddressees.map((s) => resolveSwarmAddress(s, 500))
        ).then((x) =>
            x.map((y) => y.status === "fulfilled" && y.value).filter((x) => !!x)
        );
    } catch (error: any) {
        console.log(
            "Failed to resolve relay node. Please come back later or start the demo locally: " +
                error?.message
        );
    }
}

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
    return (
        <PeerProvider
            bootstrap={bootstrapAddresses}
            inMemory={false}
            dev={import.meta.env.MODE === "development"}
        >
            <ThemeProvider theme={theme}>
                <CssBaseline />
                <HashRouter basename="/">
                    <BaseRoutes />
                </HashRouter>
            </ThemeProvider>
        </PeerProvider>
    );
};
