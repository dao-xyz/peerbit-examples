import { BaseRoutes } from "./routes";
import {
    Avatar,
    Box,
    Button,
    Grid,
    IconButton,
    Typography,
} from "@mui/material";
import { usePeer } from "@dao-xyz/peerbit-react";
import { useEffect } from "react";
export const Content = () => {
    const { peer } = usePeer();
    useEffect(() => {
        if (!peer?.id) {
            return;
        }
    }, [peer?.id]);
    return (
        <Box>
            <Grid container sx={{ p: 4, height: "100vh" }}>
                <Grid item container direction="column" maxWidth="600px">
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
        </Box>
    );
};
