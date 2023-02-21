import { usePeer } from "@dao-xyz/peerbit-react";
import { Button, Grid } from "@mui/material";
import { useNavigate } from "react-router-dom";
import { getPathFromKey } from "./routes";

export const Home = () => {
    const { peer } = usePeer();
    const navigate = useNavigate();

    return (
        <Grid container justifyContent="center">
            <Grid item>
                <Button
                    disabled={!peer}
                    onClick={() => {
                        navigate(getPathFromKey(peer.idKey.publicKey));
                    }}
                >
                    My canvas
                </Button>
            </Grid>
        </Grid>
    );
};
