import { DocumentQuery } from "@dao-xyz/peerbit-document";
import { Button, Grid, TextField, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Canvas } from "./canvas/db";
import { usePeer } from "@dao-xyz/peerbit-react";
import { userSpaces } from "./useSpaces";
import { CanvasPreview } from "./canvas/CanvasPreview";
import { Add } from "@mui/icons-material";
import { NEW_SPACE } from "./routes";

export const Home = () => {
    const { spaces } = userSpaces();
    const { peer } = usePeer();
    let [canvases, setCanvases] = useState<Canvas[]>([]);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const navigate = useNavigate();

    useEffect(() => {
        if (!spaces || !peer) {
            return;
        }
        const refresh = () => {
            spaces.canvases.index
                .query(new DocumentQuery({ queries: [] }), {
                    remote: {},
                })
                .then((results) => {
                    setCanvases(results);
                });
        };
        refresh();
        setInterval(async () => {
            refresh();
        }, 2000);
    }, [spaces]);

    return (
        <Grid container direction="column" padding={4} spacing={4}>
            <Grid item>
                <Typography variant="h4">My stuff</Typography>
            </Grid>
            <Grid item container direction="row" spacing={2}>
                {canvases.find((x) => x.key.equals(peer.idKey.publicKey)) && (
                    <Grid item container spacing={2}>
                        {canvases
                            .filter((x) => x.key.equals(peer.idKey.publicKey))
                            .map((canvas, ix) => {
                                return (
                                    <Grid item key={ix}>
                                        <CanvasPreview
                                            canvas={canvas}
                                            onDelete={() =>
                                                spaces.canvases.del(canvas.id)
                                            }
                                        />
                                    </Grid>
                                );
                            })}
                    </Grid>
                )}
                <Grid item>
                    <Button
                        variant="outlined"
                        size="large"
                        onClick={() => navigate(NEW_SPACE)}
                    >
                        <Add />
                    </Button>
                </Grid>
            </Grid>
            <Grid item>
                <Typography variant="h4">Explore</Typography>
            </Grid>
            <Grid item>
                <Grid container spacing={2}>
                    {canvases.map((canvas, ix) => {
                        return (
                            <Grid item key={ix}>
                                <CanvasPreview canvas={canvas} />
                            </Grid>
                        );
                    })}
                </Grid>
            </Grid>
        </Grid>
    );
};
