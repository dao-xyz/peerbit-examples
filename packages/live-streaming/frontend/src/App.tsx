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
            waitForKeypairInIFrame={true}
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
