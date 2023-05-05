import { usePeer } from "@dao-xyz/peerbit-react";
import { useNavigate } from "react-router-dom";
import { getStreamPath } from "./routes";
import { useEffect } from "react";
export const CreateStream = () => {
    const { peer } = usePeer();
    const navigate = useNavigate();
    useEffect(() => {
        if (!peer?.idKey?.publicKey) {
            return;
        }
        navigate(getStreamPath(peer.idKey.publicKey));
    }, [peer?.idKey?.publicKey.hashcode()]);
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