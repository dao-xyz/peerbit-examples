import { useEffect, useState } from "react";
import { Box, Grid, Typography } from "@mui/material";
import { usePeer } from "./Peer";
import { deserialize } from "@dao-xyz/borsh";
import { fromBase64 } from "@dao-xyz/peerbit-crypto";

import { Rooms as RoomsDB } from "@dao-xyz/peerbit-example-browser-chat";
import { DocumentQueryRequest } from "@dao-xyz/peerbit-document";

const TOPIC = "world";

// This is a serialized version of RoomsDB manifest.
// We could store this on IPFS and load it using a CID but this is "easier"

const ROOMS_PROGRAM =
    "AAAAACQAAAAwY2ZiMTExMy03ZTM3LTQ4NTctYmNlYy1iMTY1MWU2NWU4YmQFAAAAcm9vbXMAAQAAAAAAAQkAAABkb2N1bWVudHMAAAAAAAAAAQIAAAAAAQ8AAABkb2N1bWVudHNfaW5kZXgAAQQAAAAAAQMAAABycGMCAAAAaWQAAQMAAAAAAQgAAABsb2dpbmRleAABBQAAAAABAwAAAHJwYwABAQAAAAAAJAAAADQ3YmRkNzU0LWEzNGQtNDY2Yy05YTE2LWMyMjAyYTZhMzkyNgkAAAByZWxhdGlvbnMAAQYAAAAAAQkAAABkb2N1bWVudHMAAQAAAAAAAQcAAAAAAQ8AAABkb2N1bWVudHNfaW5kZXgAAQkAAAAAAQMAAABycGMCAAAAaWQAAQgAAAAAAQgAAABsb2dpbmRleAABCgAAAAABAwAAAHJwYw==";

export const Rooms = () => {
    const { loading, peer } = usePeer();
    const [rooms, setRooms] = useState<RoomsDB>(undefined);
    useEffect(() => {
        if (!peer?.id) {
            return;
        }

        peer.open(deserialize(fromBase64(ROOMS_PROGRAM), RoomsDB), {
            replicate: true,
            replicationTopic: TOPIC,
        }).then((db) => {
            setRooms(db);

            // Sync heads
            db.rooms.index.query(
                new DocumentQueryRequest({ queries: [] }),
                (response, from) => {},
                { sync: true }
            );
        });
    }, [peer?.id]);

    useEffect(() => {
        console.log();
    }, []);

    return (
        <Box
            sx={{
                backgroundColor: "#21242d",
                color: "white",
                fontFamily: "monospace",
            }}
        >
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
                                variant="h5"
                                sx={{ fontFamily: "fantasy" }}
                            >
                                Peerbit Chat
                            </Typography>
                        </Grid>
                    </Grid>
                    <Grid item>
                        <Typography variant="overline">Id</Typography>
                    </Grid>
                    Yoo
                    {/*  <Grid item>{id}</Grid>
          <Grid item sx={{ pt: 2 }}><Typography variant="overline">Address</Typography></Grid>
          <Grid item>/dns4/{window.location.hostname}/tcp/4002/wss/p2p/{id}</Grid> */}
                </Grid>
            </Grid>
        </Box>
    );
};
