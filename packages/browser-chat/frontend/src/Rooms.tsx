import { useEffect, useState } from 'react';
import { Box, Grid, Typography } from '@mui/material';
import { usePeer } from './Peer';
import { deserialize } from '@dao-xyz/borsh';
import { Rooms as RoomsDB } from '@dao-xyz/peerbit-example-browser-chat';
import { DocumentQueryRequest } from '@dao-xyz/peerbit-document';

const TOPIC = 'world';

// This is a serialized version of RoomsDB manifest.
// We could store this on IPFS and load it using a CID but this is "easier"

const ROOMS_PROGRAM = "AAABAAAAJAAAADIwZDJkZDk0LTUxZTUtNDE5Zi1hMjQzLTk2MDExMDI4ZmQyOQUAAAByb29tcwAAAQEAAAAAAAEJAAAAZG9jdW1lbnRzAAAAAAAAAAAAAAEBAgAAAAABDwAAAGRvY3VtZW50c19pbmRleAAAAQEEAAAAAAEDAAAAcnBjAgAAAGlkAAABAQMAAAAAAQgAAABsb2dpbmRleAAAAQEFAAAAAAEDAAAAcnBjAAABAQEAAAAAACQAAABkZjMyZDdlZS1hZTM2LTQ0M2QtYmM5OS02ZGUzYjVkYWJmNTMJAAAAcmVsYXRpb25zAAABAQYAAAAAAQkAAABkb2N1bWVudHMAAAABAAAAAAAAAQEHAAAAAAEPAAAAZG9jdW1lbnRzX2luZGV4AAABAQkAAAAAAQMAAABycGMCAAAAaWQAAAEBCAAAAAABCAAAAGxvZ2luZGV4AAABAQoAAAAAAQMAAABycGM=";

export const Rooms = () => {

    const { loading, peer } = usePeer();
    const [rooms, setRooms] = useState<RoomsDB>(undefined)
    useEffect(() => {
        if (!peer?.id) {
            return;
        }

        peer.open(deserialize(Buffer.from(ROOMS_PROGRAM, 'base64'), RoomsDB), { replicate: true, replicationTopic: TOPIC }).then(db => {
            setRooms(db);

            // Sync heads
            rooms.rooms.index.query(new DocumentQueryRequest({ queries: [] }), (response, from) => { }, { sync: true })
        })
    }, [peer?.id])

    useEffect(() => {
        console.log()
    }, [])

    return (
        <Box sx={{ backgroundColor: '#21242d', color: 'white', fontFamily: 'monospace' }}>
            <Grid container sx={{ p: 4, height: '100vh' }}>
                <Grid item container direction='column' maxWidth='400px' >
                    <Grid item container direction='row' alignItems='center' mb={2}>
                        <Grid item><Typography variant="h5" sx={{ fontFamily: 'fantasy' }}>Peerbit Chat</Typography></Grid>
                    </Grid>
                    <Grid item><Typography variant="overline">Id</Typography></Grid>
                    Yoo
                    {/*  <Grid item>{id}</Grid>
          <Grid item sx={{ pt: 2 }}><Typography variant="overline">Address</Typography></Grid>
          <Grid item>/dns4/{window.location.hostname}/tcp/4002/wss/p2p/{id}</Grid> */}
                </Grid>
            </Grid>
        </Box >
    );
}