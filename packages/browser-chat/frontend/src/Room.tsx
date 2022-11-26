import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Grid, IconButton, TextField, Typography } from "@mui/material";
import { useParams } from "react-router";
import { useChat } from "./ChatContext";
import {
    DocumentQueryRequest,
    FieldStringMatchQuery,
    IndexedValue,
} from "@dao-xyz/peerbit-document";
import { Post, Room as RoomDB } from "@dao-xyz/peerbit-example-browser-chat";
import { usePeer } from "./Peer";
import { Send } from "@mui/icons-material";

const TOPIC = "world";
const shortName = (name: string) => {
    return (
        name.substring(0, 14) +
        "..." +
        name.substring(name.length - 3, name.length)
    );
};

export const Room = () => {
    /* const [client, setClient] = useState<Awaited<ReturnType<typeof api>> | undefined>();
    const [password, setPassword] = useState<string>();
    const [id, setId] = useState<string>(); */
    const { peer } = usePeer();
    const { rooms, roomsUpdated } = useChat();
    const [room, setRoom] = useState<RoomDB>();
    const [text, setText] = useState("");
    const [lastUpdated, setLastUpdate] = useState(0);
    const [posts, setPosts] = useState<IndexedValue<Post>[]>();
    const params = useParams();

    const messagesEndRef = useRef(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    };
    const refresh = useCallback(() => {
        setLastUpdate(+new Date());
    }, [lastUpdated]);

    useEffect(() => {
        if (!room?.initialized) {
            return;
        }
        if (room.messages.index._index.size === 0) {
            room.messages.index.query(
                new DocumentQueryRequest({ queries: [] }),
                () => {
                    setLastUpdate(+new Date());
                },
                { sync: true }
            );
        } else {
            setPosts(
                [...room.messages.index._index.values()].sort((a, b) =>
                    Number(
                        a.entry.metadata.clock.timestamp.wallTime -
                            b.entry.metadata.clock.timestamp.wallTime
                    )
                )
            ); // TODO make more performant and add sort
        }
    }, [room?.id, room?.messages?.store.oplog._hlc.last.wallTime, lastUpdated]);

    useEffect(() => {
        if (!rooms || room || !params.name) {
            return;
        }
        setRoom(undefined);
        let gotRoom = false;
        rooms.rooms.index
            .query(
                new DocumentQueryRequest({
                    queries: [
                        new FieldStringMatchQuery({
                            key: "name",
                            value: params.name,
                        }),
                    ],
                }),
                (response) => {
                    if (response.results.length > 0) {
                        const roomToOpen = response.results[0].value;
                        peer.open(roomToOpen, {
                            replicate: true,
                            topic: TOPIC,
                            onUpdate: () => {
                                refresh();
                            },
                        })
                            .then((r) => {
                                if (gotRoom) {
                                    return;
                                }
                                gotRoom = true;
                                setRoom(r);
                            })
                            .catch((e) => {
                                console.error(
                                    "Failed top open room: " + e.message
                                );
                                alert("Failed top open room: " + e.message);

                                throw e;
                            });
                    }
                },
                { sync: true, waitForAmount: 1 }
            )
            .then(() => {
                if (!room) {
                    // Create the room or na? (TODO)
                    /*    const newRoom = new RoomDB({ name: params.name });
                   rooms.rooms
                       .put(newRoom).then(() => {
                           peer.open(newRoom, {
                               topic: TOPIC, replicate: true
                           }).then((openRoom) => {
   
                               setRoom(openRoom);
                               console.log('Set room to ', openRoom)
   
                           })
                       }) */
                }
            });
    }, [roomsUpdated, !!rooms?.id, params.name, refresh]);
    useEffect(() => {
        scrollToBottom();
        // sync latest messages
    }, [posts]);

    const createPost = useCallback(async () => {
        if (!room) {
            return;
        }

        room.messages
            .put(new Post({ message: text }))
            .then(() => {
                setText("");
            })
            .catch((e) => {
                console.error("Failed to create message: " + e.message);
                alert("Failed to create message: " + e.message);
                throw e;
            });
    }, [text, room, peer]);
    return (
        <Box>
            <Grid container direction="column">
                <Grid item>
                    <Typography variant="h4">{room?.name}</Typography>
                    <Typography variant="caption">{room?.id}</Typography>
                </Grid>

                <Grid
                    item
                    border="solid 1px"
                    height="60vh"
                    sx={{ overflowY: "scroll" }}
                    padding={2}
                    mt={2}
                    mb={2}
                >
                    {posts?.length > 0 ? (
                        <Grid container direction="column">
                            {posts.map((p, ix) => (
                                <Grid
                                    container
                                    item
                                    direction="column"
                                    key={ix}
                                    mb={1}
                                >
                                    <Grid item mb={-0.5}>
                                        <Typography
                                            fontStyle="italic"
                                            variant="caption"
                                        >
                                            {shortName(
                                                p.entry.signatures[0].publicKey.toString()
                                            )}
                                        </Typography>
                                    </Grid>
                                    <Grid item>
                                        <Typography>
                                            {" "}
                                            {p.value.message}
                                        </Typography>
                                    </Grid>
                                </Grid>
                            ))}
                        </Grid>
                    ) : (
                        <>No messages found!</>
                    )}
                    <div ref={messagesEndRef} />
                </Grid>

                <Grid container item justifyContent="space-between" spacing={1}>
                    <Grid item flex={1}>
                        <TextField
                            size="small"
                            id="outlined-multiline-flexible"
                            label="Create post"
                            multiline
                            maxRows={4}
                            sx={{ width: "100%" }}
                            onChange={(event) => {
                                setText(event.target.value);
                            }}
                            onKeyPress={(ev) => {
                                if (ev.key === "Enter" && !ev.shiftKey) {
                                    ev.preventDefault();

                                    // Send
                                    createPost();
                                }
                            }}
                            value={text}
                        />
                    </Grid>

                    <Grid item>
                        <IconButton disabled={!text} onClick={createPost}>
                            <Send />
                        </IconButton>
                    </Grid>
                </Grid>
            </Grid>
        </Box>
    );
};
