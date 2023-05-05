import {
    createTheme,
    responsiveFontSizes,
    ThemeProvider,
    CssBaseline,
} from "@mui/material";
import { Content } from "./Content";
import { PeerProvider } from "@dao-xyz/peerbit-react";

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
            inMemory={true}
            network={
                import.meta.env.MODE === "development" ? "local" : "remote"
            }
        >
            <ThemeProvider theme={theme}>
                <CssBaseline />
                <Content />
            </ThemeProvider>
        </PeerProvider>
    );
};
