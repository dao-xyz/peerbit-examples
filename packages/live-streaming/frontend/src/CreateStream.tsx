import { usePeer } from "@dao-xyz/peerbit-react";
import { Button, Grid } from "@mui/material";
import { useNavigate } from "react-router-dom";
import { getStreamPath } from "./routes";
import VideoCameraFrontIcon from "@mui/icons-material/VideoCameraFront";
import { useEffect } from "react";
export const CreateStream = () => {
    const { peer } = usePeer();
    const navigate = useNavigate();
    useEffect(() => {
        if (!peer?.identity?.publicKey) {
            return;
        }
        navigate(getStreamPath(peer.identity.publicKey, peer.idKey.publicKey));
    }, [
        peer?.identity?.publicKey.hashcode(),
        peer?.idKey?.publicKey.hashcode(),
    ]);
    return (
        /*  <Grid container spacing={2}>
             <Grid item>
                 <Button onClick={() => navigate(getStreamPath(peer.identity.publicKey, peer.idKey.publicKey))} endIcon={<VideoCameraFrontIcon />}>
                     Start stream
                 </Button>
             </Grid>
         </Grid> */
        <></>
    );
};
