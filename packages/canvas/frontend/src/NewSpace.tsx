import { DocumentQuery } from "@dao-xyz/peerbit-document";
import { Button, Grid, TextField, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Canvas, TitleAndDescription } from "./dbs/canvas";
import { usePeer } from "@dao-xyz/peerbit-react";
import { userSpaces } from "./useSpaces";
import { getCanvasPath } from "./routes";

export const NewSpace = () => {
    const { spaces } = userSpaces();
    const { peer } = usePeer();
    const navigate = useNavigate();
    let [canvases, setCanvases] = useState<Canvas[]>([]);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");

    const create = async () => {
        let canvas = new Canvas({
            rootTrust: peer.idKey.publicKey,
            info: new TitleAndDescription(name, description),
        });
        canvas = await peer.open(canvas);
        return spaces.canvases.put(canvas).then(() => {
            navigate(getCanvasPath(canvas));
        });
    };

    return (
        <>
            <Grid container direction="column" padding={4} spacing={4}>
                <Grid container item direction="column" spacing={2}>
                    <Grid item>
                        <Typography variant="h5" gutterBottom>
                            Create space
                        </Typography>
                    </Grid>

                    <Grid item>
                        <TextField
                            size="small"
                            label="Name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            id="name"
                            variant="outlined"
                        />
                    </Grid>

                    <Grid item>
                        <TextField
                            size="small"
                            label="Description"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            id="description"
                            variant="outlined"
                        />
                    </Grid>
                    <Grid item>
                        <Button
                            disabled={!spaces || !name || name.length == 0}
                            onClick={() => create()}
                            sx={{ ml: 1 }}
                        >
                            Create
                        </Button>
                    </Grid>
                </Grid>
            </Grid>
        </>
    );
};
