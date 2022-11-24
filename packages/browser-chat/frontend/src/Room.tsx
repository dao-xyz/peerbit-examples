import { useEffect } from "react";
import { Box, Grid, Typography } from "@mui/material";
import { usePeer } from "./Peer";
import { useLocation } from "react-router";

const TOPIC = "world";
export const Room = () => {
    /* const [client, setClient] = useState<Awaited<ReturnType<typeof api>> | undefined>();
    const [password, setPassword] = useState<string>();
    const [id, setId] = useState<string>(); */
    //const { loading, peer } = usePeer();
    const location = useLocation();
    console.log(location);
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
                    <>ROOM</>
                </Grid>
            </Grid>
        </Box>
    );
};
