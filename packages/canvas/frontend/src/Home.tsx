import { DocumentQueryRequest } from "@dao-xyz/peerbit-document";
import { usePeer } from "@dao-xyz/peerbit-react";
import { Button, Grid, TextField, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Canvas, Spaces } from "./dbs/canvas";
import { getPathFromKey } from "./routes";

export const Home = () => {
    const { peer } = usePeer();
    const navigate = useNavigate();
    let spaces = useRef<Promise<Spaces>>(null);
    let [canvases, setCanvases] = useState<Canvas[]>([]);

    const [textInput, setTextInput] = useState("");
    const handleTextInputChange = (event) => {
        setTextInput(event.target.value);
    };

    useEffect(() => {
        if (spaces.current || !peer) {
            return;
        }
        spaces.current = peer
            .open(new Spaces(), { sync: () => true })
            .then(async (result) => {
                result.canvases.events.addEventListener(
                    "change",
                    async (_change) => {
                        setCanvases(
                            [...result.canvases.index.index.values()].map(
                                (x) => x.value
                            )
                        );
                    }
                );

                await result.load();
                setInterval(async () => {
                    await result.canvases.index.query(
                        new DocumentQueryRequest({ queries: [] }),
                        { remote: { sync: true, amount: 2 } }
                    );
                }, 2000);
                return result;
            });
    }, [peer?.identity.toString()]);

    return (
        <Grid
            container
            justifyContent="center"
            direction="column"
            padding={4}
            spacing={4}
        >
            {canvases.find((x) => x.key.equals(peer.idKey.publicKey)) ? (
                <Grid item>
                    <Typography variant="h4" gutterBottom>
                        My space
                    </Typography>
                    <Typography variant="h5">
                        {
                            canvases.find((x) =>
                                x.key.equals(peer.idKey.publicKey)
                            ).name
                        }
                    </Typography>
                    <Button
                        onClick={() => {
                            navigate(
                                getPathFromKey(
                                    peer.idKey.publicKey,
                                    canvases.find((x) =>
                                        x.key.equals(peer.idKey.publicKey)
                                    ).name
                                )
                            );
                        }}
                    >
                        Open
                    </Button>
                </Grid>
            ) : (
                <Grid item>
                    <Typography variant="h4" gutterBottom>
                        Create space
                    </Typography>
                    <TextField
                        size="small"
                        value={textInput}
                        onChange={handleTextInputChange}
                        id="outlined-basic"
                        variant="outlined"
                    />
                    <Button
                        disabled={
                            !spaces || !textInput || textInput.length == 0
                        }
                        onClick={() => {
                            spaces.current.then((db) => {
                                console.log(
                                    "create canvas with name",
                                    textInput
                                );
                                db.canvases.put(
                                    new Canvas({
                                        rootTrust: peer.idKey.publicKey,
                                        name: textInput,
                                    })
                                );
                            });
                        }}
                        sx={{ ml: 1 }}
                    >
                        Create
                    </Button>
                </Grid>
            )}

            <Grid item>
                <Typography variant="h4" gutterBottom>
                    Explore
                </Typography>
                <Grid container direction="column">
                    {canvases.map((canvas, ix) => {
                        console.log(canvas);
                        return (
                            <Grid item key={ix}>
                                <Button
                                    size="large"
                                    disabled={!peer}
                                    onClick={() => {
                                        navigate(
                                            getPathFromKey(
                                                canvas.key,
                                                canvas.name
                                            )
                                        );
                                    }}
                                >
                                    {canvas.name}
                                </Button>
                            </Grid>
                        );
                    })}
                </Grid>
            </Grid>
        </Grid>
    );
};
