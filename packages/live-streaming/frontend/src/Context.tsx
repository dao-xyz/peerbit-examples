import { BaseRoutes } from "./routes";
import { Box, Grid, IconButton, Tooltip, Typography } from "@mui/material";
import PublicIcon from "@mui/icons-material/Public";
import { usePeer } from "./Peer";
import { TOPIC } from "./ChatContext";

export const Content = () => {
    const { peer, pubsubPeers } = usePeer();
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
                                    {pubsubPeers.length > 0 ? (
                                        <Tooltip
                                            color="success"
                                            title={JSON.stringify(
                                                pubsubPeers.map((x) =>
                                                    x.toString()
                                                )
                                            )}
                                        >
                                            <IconButton>
                                                <PublicIcon />
                                            </IconButton>
                                        </Tooltip>
                                    ) : (
                                        <Tooltip title="Offline">
                                            <IconButton sx={{ opacity: 0.5 }}>
                                                <PublicIcon />
                                            </IconButton>
                                        </Tooltip>
                                    )}
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
