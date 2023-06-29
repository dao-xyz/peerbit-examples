import { BaseRoutes } from "./routes";
import { Alert, AlertTitle, Grid, Snackbar, Typography } from "@mui/material";
import { usePeer, inIframe } from "@peerbit/react";
import { useEffect } from "react";
export const Content = () => {
    const { peer, status } = usePeer();
    useEffect(() => {
        if (!peer?.identity.publicKey.hashcode()) {
            return;
        }
    }, [peer?.identity.publicKey.hashcode()]);
    return (
        <Grid container sx={{ p: inIframe() ? 0 : 0, height: "100%" }}>
            <Grid item container direction="column">
                <Grid item container>
                    <Grid item container direction="column">
                        {status === "failed" && (
                            <Snackbar
                                open={true}
                                anchorOrigin={{
                                    vertical: "top",
                                    horizontal: "center",
                                }}
                            >
                                <Alert severity="error">
                                    <AlertTitle>Error</AlertTitle>
                                    Failed to connect to the network
                                </Alert>
                            </Snackbar>
                        )}

                        <Grid
                            item
                            container
                            direction="row"
                            alignItems="center"
                        >
                            <Grid itemID="">
                                <Typography variant="h3"></Typography>
                            </Grid>
                        </Grid>
                    </Grid>
                </Grid>
                <BaseRoutes />
            </Grid>
        </Grid>
    );
};
