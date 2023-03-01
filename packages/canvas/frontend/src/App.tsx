import {
    createTheme,
    responsiveFontSizes,
    ThemeProvider,
    CssBaseline,
} from "@mui/material";
import { releaseKey, resolveSwarmAddress } from "@dao-xyz/peerbit-react";
import { PeerProvider } from "@dao-xyz/peerbit-react";
import { Body } from "./Body";
import { NameProvider } from "./useNames";
import { getRootKeypair } from "./keys";

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
    components: {
        MuiCssBaseline: {
            styleOverrides: {
                body: {
                    scrollbarColor: "#6b6b6b #2b2b2b",
                    "&::-webkit-scrollbar, & *::-webkit-scrollbar": {
                        backgroundColor: "#2b2b2b",
                    },
                    "&::-webkit-scrollbar-thumb, & *::-webkit-scrollbar-thumb":
                        {
                            borderRadius: 8,
                            backgroundColor: "#6b6b6b",
                            minHeight: 24,
                            border: "3px solid #2b2b2b",
                        },
                    "&::-webkit-scrollbar-thumb:focus, & *::-webkit-scrollbar-thumb:focus":
                        {
                            backgroundColor: "#959595",
                        },
                    "&::-webkit-scrollbar-thumb:active, & *::-webkit-scrollbar-thumb:active":
                        {
                            backgroundColor: "#959595",
                        },
                    "&::-webkit-scrollbar-thumb:hover, & *::-webkit-scrollbar-thumb:hover":
                        {
                            backgroundColor: "#959595",
                        },
                    "&::-webkit-scrollbar-corner, & *::-webkit-scrollbar-corner":
                        {
                            backgroundColor: "#2b2b2b",
                        },
                },
            },
        },
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
let { key: keypair, path: rootKeyPath } = await getRootKeypair();

window.onbeforeunload = function () {
    releaseKey(rootKeyPath);
};

export const App = () => {
    return (
        <PeerProvider
            bootstrap={bootstrapAddresses}
            inMemory={false}
            dev={import.meta.env.MODE === "development"}
            keypair={keypair}
            identity={keypair}
        >
            <NameProvider>
                <ThemeProvider theme={theme}>
                    <CssBaseline />
                    <Body />
                </ThemeProvider>
            </NameProvider>
        </PeerProvider>
    );
};
