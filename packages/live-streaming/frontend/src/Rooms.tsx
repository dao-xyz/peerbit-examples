import { useEffect, useState } from "react";
import { Box, Button, CircularProgress, Grid, Typography } from "@mui/material";
import { NewRoomButtom } from "./NewRoom";
import { Room } from "@dao-xyz/peerbit-example-browser-chat";
import { useChat } from "./ChatContext";
import { useNavigate } from "react-router-dom";
import { getRoomPath } from "./routes";
import { usePeer } from "./Peer";

export const Rooms = () => {
    const { roomsUpdated, rooms, loading } = useChat();
    const { loading: loadingPeer } = usePeer();
    const [list, setList] = useState<Room[]>();
    const [open, setOpen] = useState(false);
    const navigate = useNavigate();

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
                <Grid item mb={2}>
                    <Typography variant="subtitle1">A P2P chat app</Typography>
                </Grid>
                <Grid
                    container
                    direction="row"
                    item
                    alignItems="left"
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
                {loading || loadingPeer ? (
                    <Grid item>
                        <CircularProgress size={20} />
                    </Grid>
                ) : (
                    <Grid item>
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
                )}
            </Grid>
        </Box>
    );
};
