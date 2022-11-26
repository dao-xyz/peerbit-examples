import { useEffect, useState } from "react";
import { Box, Button, Grid, Typography } from "@mui/material";
import { NewRoomButtom } from "./NewRoom";
import { Room } from "@dao-xyz/peerbit-example-browser-chat";
import { useChat } from "./ChatContext";
import { useNavigate } from "react-router-dom";
import { getRoomPath } from "./routes";

// This is a serialized version of RoomsDB manifest.
// We could store this on IPFS and load it using a CID but this is "easier"
// For info how to generate this, see https://github.com/dao-xyz/peerbit-examples/blob/63d6923d82d5c496632824e0c0f162b199f1cd37/packages/browser-chat/library/src/__tests__/index.integration.test.ts#L92

export const Rooms = () => {
    const { roomsUpdated, rooms } = useChat();
    const [list, setList] = useState<Room[]>();
    const [open, setOpen] = useState(false);
    const navigate = useNavigate();

    const handleClickOpen = () => {
        setOpen(true);
    };

    const goToRoom = (room: Room) => {
        navigate(getRoomPath(room));
    };

    useEffect(() => {
        if (!rooms?.initialized) {
            return;
        }
        setList([...rooms.rooms.index._index.values()].map((x) => x.value)); // show all rooms
    }, [roomsUpdated]);

    return (
        <Box>
            <Grid container>
                <Grid
                    container
                    direction="row"
                    item
                    alignItems="center"
                    spacing={2}
                    mb={2}
                >
                    <Grid item>
                        <Typography variant="h4">Rooms</Typography>
                    </Grid>
                    <Grid item>
                        <NewRoomButtom />
                    </Grid>
                </Grid>
                <Grid>
                    {list?.length > 0 ? (
                        <Box>
                            {list.map((room, ix) => (
                                <Typography key={ix} variant="h5">
                                    <Button
                                        variant="text"
                                        onClick={() => goToRoom(room)}
                                    >
                                        {" "}
                                        {room.name}
                                    </Button>
                                </Typography>
                            ))}
                        </Box>
                    ) : (
                        <Typography>No rooms found</Typography>
                    )}
                </Grid>
            </Grid>
        </Box>
    );
};
