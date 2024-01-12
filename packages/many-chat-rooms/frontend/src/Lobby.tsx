import { useEffect, useReducer, useRef, useState } from "react";
import { Box, Button, CircularProgress, Grid, Typography } from "@mui/material";
import { NewRoomButtom } from "./NewRoom";
import { useNavigate } from "react-router-dom";
import { getRoomPath } from "./routes";
import { usePeer, useProgram } from "@peerbit/react";
import { Lobby as LobbyDB, Room } from "@peerbit/example-many-chat-rooms";
import { SearchRequest } from "@peerbit/document";

const lobbyConfig = new LobbyDB({
    id: new Uint8Array(32), // 0,0,....0 choose this dynamically instead? Now it is static, => same lobby for all
});
export const Lobby = () => {
    const { loading: loadingPeer, peer } = usePeer();
    const navigate = useNavigate();
    const lobby = useProgram(lobbyConfig, {
        args: {
            role: {
                type: "replicator",
                factor: 1,
            },
        },
        existing: "reuse",
    });
    const rooms = useRef<Room[]>([]);
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);

    console.log(lobby.program?.rooms?.log["_roleOptions"]);
    useEffect(() => {
        if (lobby.program && !lobby.program.closed) {
            const addToLobby = (toAdd: Room[], reset?: Boolean) => {
                if (reset) {
                    rooms.current = [];
                }
                for (const room of toAdd) {
                    const ix = rooms.current.findIndex((x) => x.id === room.id);
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

            console.log("HERE!", lobby.program.rooms.log.log.length);
            setTimeout(() => {
                console.log("HERE!", lobby.program.rooms.log.log.length);
            }, 3000);

            const changeListener = async (e) => {
                // additions
                console.log("CHANGE");
                e.detail.added && addToLobby(e.detail.added);

                // removals
                e.detail.removed?.forEach((p) => {
                    const ix = rooms.current.findIndex((x) => x.id === p.id);
                    if (ix !== -1) {
                        rooms.current.splice(ix, 1);
                    }
                });
                e.detail.removed && forceUpdate();
            };

            lobby.program.rooms.events.addEventListener(
                "change",
                changeListener
            );

            lobby.program.rooms.index
                .search(new SearchRequest(), { remote: { sync: true } })
                .then((results) => {
                    addToLobby(results, true);
                });

            return () =>
                lobby.program.rooms.events.removeEventListener(
                    "change",
                    changeListener
                );
        }
    }, [lobby.session, lobby.program?.closed]);

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
                        <NewRoomButtom lobby={lobby.program} />
                    </Grid>
                    <Grid
                        item
                        sx={{
                            display: "flex",
                            textAlign: "center",
                            alignItems: "center",
                        }}
                    >
                        <Typography>
                            Peers in lobby: {lobby.peerCounter}
                        </Typography>
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
