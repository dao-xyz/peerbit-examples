import { BaseRoutes } from "./routes";
import { Box, Grid, IconButton, Tooltip, Typography } from "@mui/material";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import { usePeer } from "./Peer";

export const Content = () => {
    const { swarm } = usePeer();
    return (
        <Box>
            <Grid container sx={{ p: 4, height: "100vh", }}>
                <Grid item container direction="column" maxWidth="600px">
                    <Grid
                        item
                        container
                        mb={2}

                    >
                        <Grid item container direction="column">
                            <Grid item container direction="row" alignItems="center">
                                <Grid itemID="">
                                    <Typography
                                        variant="h3"
                                        sx={{
                                            fontFamily: "Indie Flower",
                                        }}
                                    >
                                        Peerbit Chat
                                    </Typography>

                                </Grid>
                                <Grid item ml={1}>
                                    <Tooltip title={JSON.stringify(swarm)}>
                                        <IconButton>
                                            <TravelExploreIcon />
                                        </IconButton>
                                    </Tooltip>
                                </Grid>
                            </Grid>

                            <Grid item>
                                <Typography
                                    variant="caption"

                                >
                                    This app stores all data on the Browser participants. If you are the only particant left and you close your tab, the data is gone!
                                </Typography>
                            </Grid>
                        </Grid>
                    </Grid>
                    <BaseRoutes />
                </Grid>
            </Grid>
        </Box>
    );
};
