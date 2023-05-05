import { usePeer } from "@dao-xyz/peerbit-react";
import {
    Button,
    Card,
    CardContent,
    Menu,
    MenuItem,
    Typography,
} from "@mui/material";
import { useNavigate } from "react-router-dom";
import { Canvas } from "./db";
import { getCanvasPath } from "./../routes";
import { useState } from "react";

export const CanvasPreview = (props: {
    canvas: Canvas;
    onDelete?: () => void;
}) => {
    const navigate = useNavigate();
    const { peer } = usePeer();
    const [contextMenu, setContextMenu] = useState<{
        mouseX: number;
        mouseY: number;
    } | null>(null);

    const handleContextMenu = (event: React.MouseEvent) => {
        console.log("here!");
        event.preventDefault();
        setContextMenu(
            contextMenu === null
                ? {
                      mouseX: event.clientX + 2,
                      mouseY: event.clientY - 6,
                  }
                : // repeated contextmenu when it is already open closes it with Chrome 84 on Ubuntu
                  // Other native context menus might behave different.
                  // With this behavior we prevent contextmenu from the backdrop to re-locale existing context menus.
                  null
        );
    };

    const handleClose = () => {
        setContextMenu(null);
    };

    const handleDelete = () => {
        props.onDelete();
        return handleClose();
    };

    return (
        <>
            <Card onContextMenu={handleContextMenu}>
                <Button
                    sx={{ minWidth: "100px", minHeight: "100px" }}
                    onClick={async () => {
                        const db = await peer.open(props.canvas);
                        navigate(getCanvasPath(db));
                    }}
                >
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

            <Menu
                open={contextMenu !== null}
                onClose={handleClose}
                anchorReference="anchorPosition"
                anchorPosition={
                    contextMenu !== null
                        ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
                        : undefined
                }
            >
                {props.onDelete && (
                    <MenuItem onClick={handleDelete}>Delete</MenuItem>
                )}
            </Menu>
        </>
    );
};
