import { useEffect } from "react";
import { PeerProvider } from "./Peer";
import { BaseRoutes } from "./routes";
import { HashRouter } from "react-router-dom";
import {
    Box,
    createTheme,
    responsiveFontSizes,
    Grid,
    ThemeProvider,
    Typography,
    CssBaseline,
} from "@mui/material";
import { ChatProvider } from "./ChatContext";

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
                        <Box>
                            <Grid container sx={{ p: 4, height: "100vh" }}>
                                <Grid
                                    item
                                    container
                                    direction="column"
                                    maxWidth="400px"
                                >
                                    <Grid
                                        item
                                        container
                                        direction="row"
                                        alignItems="center"
                                        mb={2}
                                    >
                                        <Grid item>
                                            <Typography
                                                variant="h3"
                                                sx={{
                                                    fontFamily: "Indie Flower",
                                                }}
                                            >
                                                Peerbit Chat
                                            </Typography>
                                        </Grid>
                                    </Grid>
                                    <BaseRoutes />
                                </Grid>
                            </Grid>
                        </Box>
                    </HashRouter>
                </ThemeProvider>
            </ChatProvider>
        </PeerProvider>
    );
};
