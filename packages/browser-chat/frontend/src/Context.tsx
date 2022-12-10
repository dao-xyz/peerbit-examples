import { BaseRoutes } from "./routes";
import { Box, Grid, IconButton, Tooltip, Typography } from "@mui/material";
import PublicIcon from "@mui/icons-material/Public";
import { usePeer } from "@dao-xyz/peerbit-react";
import { useEffect, useState } from "react";
import { PeerId } from "@libp2p/interface-peer-id";
import { delay } from "@dao-xyz/peerbit-time";
export const Content = () => {
    const { peer } = usePeer();
    const [peers, setPeers] = useState<PeerId[]>();
    useEffect(() => {
        // Pool peers TODO, dont do this?
        if (!peer) {
            return;
        }
        let stop = false;
        (async () => {
            while (!stop) {
                setPeers(peer.libp2p.pubsub.getPeers());
                await delay(500);
            }
        })();
        return () => {
            stop = true;
        };
    }, [peer?.id.toString()]);
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
                                        variant="h4"
                                        /*    sx={{
                                   fontFamily: "Indie Flower",
                               }} */
                                    >
                                        Peer Chat v.
                                        {process.env.REACT_APP_VERSION}
                                    </Typography>
                                </Grid>

                                <Grid item ml={1}>
                                    {peers?.length > 0 ? (
                                        <Tooltip
                                            color="success"
                                            title={JSON.stringify(
                                                peers.map((x) => x.toString())
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
