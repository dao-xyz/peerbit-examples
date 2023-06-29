import { PeerProvider } from "@peerbit/react";
import { HashRouter } from "react-router-dom";
import {
    createTheme,
    responsiveFontSizes,
    ThemeProvider,
    CssBaseline,
} from "@mui/material";
import { Content } from "./Content";
import { inIframe } from "@peerbit/react";

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

console.log(import.meta.env.MODE);
theme = responsiveFontSizes(theme);

export const App = () => {
    return (
        <PeerProvider
            network={
                import.meta.env.MODE === "development" ? "local" : "remote"
            }
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
