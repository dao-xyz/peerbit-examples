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
                <Box
                    sx={{
                        display: "flex",
                        justifyContent: "right",
                        width: "100%",
                        b: 0,
                        mt: "auto",
                    }}
                >
                    <Button
                        size="small"
                        href="https://github.com/dao-xyz/peerbit-examples/tree/master/packages/live-streaming"
                    >
                        Source code
                    </Button>
                    <IconButton size="small" href="https://github.com/dao-xyz">
                        <Avatar
                            variant="square"
                            src={
                                "https://avatars.githubusercontent.com/u/94802457?s=96&v=4"
                            }
                        />
                    </IconButton>
                </Box>
            </Grid>
        </Box>
    );
};
