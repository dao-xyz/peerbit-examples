import { BaseRoutes } from "./routes";
import {
    Avatar,
    Box,
    Button,
    Grid,
    IconButton,
    Typography,
} from "@mui/material";
import { usePeer, inIframe } from "@dao-xyz/peerbit-react";
import { useEffect } from "react";
export const Content = () => {
    const { peer } = usePeer();
    useEffect(() => {
        if (!peer?.id) {
            return;
        }
    }, [peer?.id]);
    return (
        <Grid container sx={{ p: inIframe() ? 0 : 0, height: "100%" }}>
            <Grid item container direction="column">
                <Grid item container>
                    <Grid item container direction="column">
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
