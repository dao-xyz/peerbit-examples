import { BaseRoutes } from "./routes";
import { Box, Grid, IconButton, Tooltip, Typography } from "@mui/material";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import { usePeer } from "./Peer";

export const Content = () => {
    const { swarm } = usePeer();
    return (
        <Box>
            <Grid container sx={{ p: 4, height: "100vh" }}>
                <Grid item container direction="column" maxWidth="400px">
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
                        <Grid item ml={2}>
                            <Tooltip title={JSON.stringify(swarm)}>
                                <IconButton>
                                    <TravelExploreIcon />
                                </IconButton>
                            </Tooltip>
                        </Grid>
                    </Grid>
                    <BaseRoutes />
                </Grid>
            </Grid>
        </Box>
    );
};
