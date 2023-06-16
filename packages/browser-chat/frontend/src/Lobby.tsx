import { useEffect, useReducer, useRef, useState } from "react";
import { Box, Button, CircularProgress, Grid, Typography } from "@mui/material";
import { NewRoomButtom } from "./NewRoom";
import { useNavigate } from "react-router-dom";
import { getRoomPath } from "./routes";
import { usePeer } from "@dao-xyz/peerbit-react";
import { Lobby as LobbyDB, Room } from "@dao-xyz/peerbit-example-browser-chat";
import { Documents } from "@dao-xyz/peerbit-document";

export const Lobby = () => {
    const { loading: loadingPeer } = usePeer();
    const navigate = useNavigate();
    const { peer } = usePeer();
    const [lobby, setLobby] = useState<LobbyDB>();
    const loadingLobby = useRef<Promise<any>>();
    const rooms = useRef<Room[]>([]);
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);

    const [peerCount, setPeerCount] = useState(0);

    useEffect(() => {
        if (!peer?.identityHash && !loadingLobby.current) {
            return;
        }

        loadingLobby.current = peer
            .open(
                new LobbyDB({
                    id: new Uint8Array(32), // 0,0,....0 choose this dynamically instead? Now it is static, => same lobby for all
                    rooms: new Documents<Room>(),
                }),
                { sync: () => true }
            )
            .then(async (lobby) => {
                console.log("OPEN LOBBY", lobby.address.toString());
                setLobby(lobby);

                lobby.rooms.events.addEventListener("change", async (e) => {
                    e.detail.added?.forEach((p) => {
                        const ix = rooms.current.findIndex(
                            (x) => x.id === p.id
                        );
                        if (ix === -1) {
                            rooms.current.push(p);
                        } else {
                            rooms.current[ix] = p;
                        }
                    });
                    e.detail.removed?.forEach((p) => {
                        const ix = rooms.current.findIndex(
                            (x) => x.id === p.id
                        );
                        if (ix !== -1) {
                            rooms.current.splice(ix, 1);
                        }
                    });
                    console.log(rooms.current);
                    forceUpdate();
                });

                peer.libp2p.services.pubsub.addEventListener(
                    "subscribe",
                    (e) => {
                        console.log("SYBSCRIBE", e.detail);

                        setPeerCount(
                            peer.libp2p.services.pubsub.topics.get(
                                lobby.rooms.log.idString
                            ).size + 1
                        );
                    }
                );
                await lobby.load();
            });
    }, [peer?.identityHash]);

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
