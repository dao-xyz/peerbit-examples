import { PeerProvider } from "@peerbit/react";
import { HashRouter } from "react-router-dom";
import {
    createTheme,
    responsiveFontSizes,
    ThemeProvider,
    CssBaseline,
} from "@mui/material";
import { Content } from "./Context";

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
