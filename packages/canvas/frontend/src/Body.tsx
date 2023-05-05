import { Box, Grid } from "@mui/material";
import { useRef } from "react";
import { HashRouter } from "react-router-dom";
import { Header, HEIGHT } from "./Header";
import { CanvasToolbar } from "./canvas/CanvasToolbar";
import { BaseRoutes } from "./routes";

export const Body = () => {
    return (
        <>
            <HashRouter basename="/">
                <Header></Header>
                <Grid
                    container
                    direction="row"
                    flexWrap="nowrap"
                    sx={{ height: `calc(100vh - ${HEIGHT})`, width: "100%" }}
                >
                    <Grid item sx={{ height: "100%" }}>
                        <CanvasToolbar direction="column" />
                    </Grid>
                    <Grid item sx={{ width: "100%" }}>
                        <BaseRoutes />
                    </Grid>
                </Grid>
            </HashRouter>
        </>
    );
};
