import { usePeer } from "@dao-xyz/peerbit-react"
import { Button, Grid } from "@mui/material"
import { useNavigate } from "react-router-dom";
import { getStreamPath } from "./routes";

export const CreateStream = () => {
    const { peer } = usePeer();
    const navigate = useNavigate();

    return <Grid container spacing={2}>
        <Grid item>
            <Button onClick={() => navigate(getStreamPath(peer.identity.publicKey))}>Create stream</Button>
        </Grid>
    </Grid>
}