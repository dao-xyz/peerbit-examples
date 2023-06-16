import {
    createTheme,
    responsiveFontSizes,
    ThemeProvider,
    CssBaseline,
} from "@mui/material";
import { releaseKey } from "@dao-xyz/peerbit-react";
import { PeerProvider } from "@dao-xyz/peerbit-react";
import { Body } from "./Body";
import { NameProvider } from "./names/useNames";
import { getRootKeypair } from "./keys";
import { SpaceProvider } from "./useSpaces";

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

theme = createTheme(
    {
        components: {
            MuiCssBaseline: {
                styleOverrides: {
                    body: {
                        // Add override for scroll bar
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

                        // Add override for canvas element placeholder (the rectangle that appears when you drag rects)
                        "& .react-grid-placeholder": {
                            color: "white",
                            backgroundColor:
                                theme.palette.primary.main + " !important",
                        },
                        "& .canvas-react-resizable-handle": {
                            borderColor:
                                theme.palette.primary.main + " !important",
                            backgroundColor: theme.palette.text.primary,
                        },
                        "& .react-grid-item": {
                            transition: "disabled !important",
                        },
                    },
                },
            },
        },
    },
    theme
);

theme = responsiveFontSizes(theme);

let { key: keypair, path: rootKeyPath } = await getRootKeypair();

window.onbeforeunload = function () {
    releaseKey(rootKeyPath);
};

console.log(keypair.publicKey.toString());
export const App = () => {
    return (
        <PeerProvider
            inMemory={false}
            network={
                import.meta.env.MODE === "development" ? "local" : "remote"
            }
            keypair={keypair}
        >
            <NameProvider>
                <SpaceProvider>
                    <ThemeProvider theme={theme}>
                        <CssBaseline />
                        <Body />
                    </ThemeProvider>
                </SpaceProvider>
            </NameProvider>
        </PeerProvider>
    );
};
