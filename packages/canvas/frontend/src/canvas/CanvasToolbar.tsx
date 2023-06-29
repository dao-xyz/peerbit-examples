import { Grid, IconButton, Paper } from "@mui/material";
import DashboardIcon from "@mui/icons-material/Dashboard";
import ExploreIcon from "@mui/icons-material/Explore";
import { usePeer } from "@peerbit/react";
import { useEffect, useRef, useState } from "react";
import { Canvas, Spaces } from "./db";
import { useNavigate } from "react-router-dom";
import { SearchRequest } from "@peerbit/document";
import QueueIcon from "@mui/icons-material/Queue";

export const WIDTH = "35px";
export const CanvasToolbar = (props: { direction: "column" | "row" }) => {
    const { peer } = usePeer();
    let spaces = useRef<Promise<Spaces>>(null);
    const navigate = useNavigate();
    let [canvases, setCanvases] = useState<Canvas[]>([]);
    const [textInput, setTextInput] = useState("");
    const handleTextInputChange = (event) => {
        setTextInput(event.target.value);
    };

    useEffect(() => {
        if (spaces.current || !peer) {
            return;
        }
        console.log("open!");
        spaces.current = peer
            .open(new Spaces(), { args: { sync: () => true } })
            .then(async (result) => {
                result.canvases.events.addEventListener(
                    "change",
                    async (_change) => {
                        setCanvases(
                            await Promise.all(
                                [...result.canvases.index.index.values()].map(
                                    (x) => result.canvases.index.getDocument(x)
                                )
                            )
                        );
                    }
                );

                setInterval(async () => {
                    await result.canvases.index.search(
                        new SearchRequest({ query: [] }),
                        { remote: { sync: true } }
                    );
                }, 2000);
                return result;
            });
    }, [peer?.identity.toString()]);

    return (
        <Paper sx={{ height: "100%", width: WIDTH }}>
            <Grid container direction={props.direction} sx={{ height: "100%" }}>
                <Grid item>
                    <IconButton
                        size="small"
                        onClick={() => {
                            navigate("/new");
                        }}
                        sx={{ borderRadius: 0 }}
                    >
                        <QueueIcon />
                    </IconButton>
                </Grid>
                <Grid item>
                    <IconButton size="small" sx={{ borderRadius: 0 }}>
                        <DashboardIcon />
                    </IconButton>
                </Grid>
                <Grid item>
                    <IconButton size="small" sx={{ borderRadius: 0 }}>
                        <ExploreIcon />
                    </IconButton>
                </Grid>
            </Grid>
        </Paper>
    );
};
