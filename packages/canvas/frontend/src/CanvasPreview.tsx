import { usePeer } from "@dao-xyz/peerbit-react";
import { Button, Card, CardContent, Typography } from "@mui/material";
import { useNavigate } from "react-router-dom";
import { Canvas } from "./dbs/canvas";
import { getCanvasPath } from "./routes";

export const CanvasPreview = (props: { canvas: Canvas }) => {
    const navigate = useNavigate()
    const { peer } = usePeer();
    return (
        <Card>
            <Button sx={{ minWidth: "100px", minHeight: "100px" }} onClick={async () => {
                const db = await peer.open(props.canvas)
                navigate(getCanvasPath(db))
            }}>

                <CardContent>
                    <Typography gutterBottom variant="h5" component="div">
                        {props.canvas.info.name}
                    </Typography>
                    <Typography variant="body2">
                        {props.canvas.info.description}
                    </Typography>
                </CardContent>
            </Button>
        </Card>
    );
};
