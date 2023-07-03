import { useEffect, useReducer, useRef, useState } from "react";
import { Box, Button, CircularProgress, Grid, Typography } from "@mui/material";
import { NewRoomButtom } from "./NewRoom";
import { useNavigate } from "react-router-dom";
import { getRoomPath } from "./routes";
import { usePeer } from "@peerbit/react";
import { Lobby as LobbyDB, Room } from "@peerbit/example-many-chat-rooms";
import { SearchRequest } from "@peerbit/document";

export const Lobby = () => {
    const { loading: loadingPeer } = usePeer();
    const navigate = useNavigate();
    const { peer } = usePeer();
    const [lobby, setLobby] = useState<LobbyDB>();
    const rooms = useRef<Room[]>([]);
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);

    const [peerCount, setPeerCount] = useState(1);

    useEffect(() => {
        console.log("???", peer?.identity.publicKey.hashcode());

        if (!peer?.identity.publicKey.hashcode()) {
            return;
        }

        peer.open(
            new LobbyDB({
                id: new Uint8Array(32), // 0,0,....0 choose this dynamically instead? Now it is static, => same lobby for all
            }),
            { args: { sync: () => true }, existing: "reuse" }
        )
            .then(async (lobby) => {
                console.log("OPEN LOBBY", lobby);
                setLobby(lobby);
                const addToLobby = (toAdd: Room[], reset?: Boolean) => {
                    if (reset) {
                        rooms.current = [];
                    }
                    for (const room of toAdd) {
                        const ix = rooms.current.findIndex(
                            (x) => x.id === room.id
                        );
                        if (ix === -1) {
                            rooms.current.push(room);
                        } else {
                            rooms.current[ix] = room;
                        }
                    }
                    if (toAdd.length > 0) {
                        forceUpdate();
                    }
                };

                lobby.rooms.index
                    .search(new SearchRequest(), {})
                    .then((results) => {
                        addToLobby(results, true);
                    });

                lobby.rooms.events.addEventListener("change", async (e) => {
                    // additions
                    e.detail.added && addToLobby(e.detail.added);

                    // removals
                    e.detail.removed?.forEach((p) => {
                        const ix = rooms.current.findIndex(
                            (x) => x.id === p.id
                        );
                        if (ix !== -1) {
                            rooms.current.splice(ix, 1);
                        }
                    });
                    e.detail.removed && forceUpdate();
                });

                lobby.rooms.events.addEventListener("join", () => {
                    lobby.rooms
                        .getReady()
                        .then((set) => setPeerCount(set.size + 1));
                });

                lobby.rooms.events.addEventListener("leave", () => {
                    lobby.rooms
                        .getReady()
                        .then((set) => setPeerCount(set.size + 1));
                });
            })
            .catch((e) => {
                console.error(e);
            });
    }, [peer?.identity.publicKey.hashcode()]);

    const goToRoom = (room: Room) => {
        navigate(getRoomPath(room));
    };

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
                        <NewRoomButtom lobby={lobby} />
                    </Grid>
                    <Grid
                        item
                        sx={{
                            display: "flex",
                            textAlign: "center",
                            alignItems: "center",
                        }}
                    >
                        <Typography>Peers in lobby: {peerCount}</Typography>
                    </Grid>
                </Grid>

                {loadingPeer ? (
                    <Grid item>
                        <></> <CircularProgress size={20} />
                    </Grid>
                ) : (
                    <Grid item>
                        {rooms.current?.length > 0 ? (
                            <Box>
                                {rooms.current.map((room, ix) => (
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
