import { BaseRoutes } from "./routes";
import { Box, Grid, Typography } from "@mui/material";
const logChannel = new BroadcastChannel("/log");

export const Content = () => {

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
                                    <Typography variant="h3"></Typography>
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

/** 
 <Box
                    sx={{
                        display: "flex",
                        justifyContent: "right",
                        width: "100%",
                        b: 0,
                        mt: "auto",
                    }}
                >
                    <Button
                        size="small"
                        href="https://github.com/dao-xyz/peerbit-examples/tree/master/packages/live-streaming"
                    >
                        Source code
                    </Button>
                    <IconButton size="small" href="https://github.com/dao-xyz">
                        <Avatar
                            variant="square"
                            src={
                                "https://avatars.githubusercontent.com/u/94802457?s=96&v=4"
                            }
                        />
                    </IconButton>
                </Box>
 */
