import { BaseRoutes } from "./routes";
import { Box, Grid, Typography } from "@mui/material";
import { usePeer } from "@dao-xyz/peerbit-react";
import { useEffect } from "react";
import { delay } from '@dao-xyz/peerbit-time';
export const Content = () => {
    const { peer } = usePeer();

    useEffect(() => {
        if (!peer?.id) {
            return;
        }
        peer.libp2p.pubsub.subscribe("world")
        peer.libp2p.pubsub.addEventListener('message', async (evt) => {

            if (evt.detail.type === 'signed') {
                if (evt.detail.from.toString() === peer.libp2p.peerId.toString()) {
                    return;
                }
                console.log('got message!')


            }
        })
        /* const fn = async () => {
            while (true) {
                await delay(35);
                peer.libp2p.pubsub.publish("world", new Uint8Array([1, 2, 3]));
            }
        }
        fn() */

        setTimeout(() => { console.log(peer.libp2p.peerId, peer.libp2p.pubsub.getSubscribers("world"), peer.libp2p.pubsub.getSubscribers("world!")); peer.libp2p.pubsub.publish("world", new Uint8Array([1, 2, 3])); },
            5000)

    }, [peer?.id])
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
                                    >

                                    </Typography>
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
