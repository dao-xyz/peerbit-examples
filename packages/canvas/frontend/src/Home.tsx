import { usePeer } from "@dao-xyz/peerbit-react";
import { Button, Grid, Typography } from "@mui/material";
import { useNavigate } from "react-router-dom";
import { getPathFromKey } from "./routes";

export const Home = () => {
    const { peer } = usePeer();
    const navigate = useNavigate();
    return (
        <Grid
            container
            justifyContent="center"
            direction="column"
            padding={4}
            spacing={4}
        >
            <Grid item>
                <Typography variant="h4" gutterBottom>
                    My space
                </Typography>
                <Button
                    size="large"
                    disabled={!peer}
                    onClick={() => {
                        navigate(getPathFromKey(peer.idKey.publicKey));
                    }}
                >
                    Open
                </Button>
            </Grid>
            <Grid item>
                <Typography variant="h4" gutterBottom>
                    Explore
                </Typography>
                <> ...</>
            </Grid>
        </Grid>
    );
};
