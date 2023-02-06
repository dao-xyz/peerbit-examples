import { BaseRoutes } from "./routes";
import { Box, Grid, Typography } from "@mui/material";

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
                                    <Typography
                                        variant="h4"
                                        /*    sx={{
                               fontFamily: "Indie Flower",
                           }} */
                                    >
                                        Peer Chat v.
                                        {import.meta.env.APP_VERSION}
                                    </Typography>
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
