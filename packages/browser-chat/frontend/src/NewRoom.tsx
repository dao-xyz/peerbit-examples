import * as React from "react";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import { useChat } from "./ChatContext";
import { Room } from "@dao-xyz/peerbit-example-browser-chat";

export const NewRoomButtom = () => {
    const [open, setOpen] = React.useState(false);
    const [name, setName] = React.useState("");
    const { lobby: rooms } = useChat();
    const handleClickOpen = () => {
        setOpen(true);
    };

    const handleClose = () => {
        setOpen(false);
    };

    const handleNewRoom = () => {
        const nameTrimmed = name.trim();
        if (nameTrimmed.length === 0) {
            alert("No name was given!");
        } else {
            console.log("create room with name: " + nameTrimmed);
            rooms.rooms
                .put(new Room({ name: nameTrimmed }))
                .then(() => {
                    setName("");
                })
                .catch((error) => {
                    console.error(error);
                    alert("Failed to create room: " + error.message);
                })
                .finally(() => {
                    setOpen(false);
                });
        }
    };
    return (
        <div>
            <Button variant="outlined" onClick={handleClickOpen}>
                New room
            </Button>
            <Dialog open={open} onClose={handleClose}>
                <DialogTitle>Create new room</DialogTitle>
                <DialogContent>
                    <TextField
                        autoFocus
                        margin="dense"
                        id="name"
                        label="Room name"
                        type="text"
                        fullWidth
                        variant="standard"
                        onChange={(e) => setName(e.target.value)}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleClose}>Cancel</Button>
                    <Button onClick={handleNewRoom}>Create</Button>
                </DialogActions>
            </Dialog>
        </div>
    );
};
