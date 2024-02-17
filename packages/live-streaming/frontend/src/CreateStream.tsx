import { usePeer, useProgram } from "@peerbit/react";
import { useNavigate } from "react-router-dom";
import { getStreamPath } from "./routes";
import { useEffect } from "react";
import { MediaStreamDB } from "./media/database";
export const CreateStream = () => {
    const { peer } = usePeer();
    const mediaStream = useProgram<MediaStreamDB>(
        peer && new MediaStreamDB(peer.identity.publicKey),
        { args: { role: { type: "replicator", factor: 1 } }, existing: "reuse" }
    );
    const navigate = useNavigate();
    useEffect(() => {
        if (!peer?.identity.publicKey) {
            return;
        }
        if (!mediaStream.program?.address) {
            return;
        }
        navigate(getStreamPath(mediaStream.program));
    }, [peer?.identity?.publicKey.hashcode(), mediaStream.program?.address]);
    return (
        /*  <Grid container spacing={2}>
             <Grid item>
                 <Button onClick={() => navigate(getStreamPath(peer.identity.publicKey, peer.identity.publicKey))} endIcon={<VideoCameraFrontIcon />}>
                     Start stream
                 </Button>
             </Grid>
         </Grid> */
        <></>
    );
};
