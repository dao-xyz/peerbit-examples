import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
    Box,
    CircularProgress,
    Grid,
    IconButton,
    TextField,
    Typography,
} from "@mui/material";
import { useParams } from "react-router";
import { SearchRequest } from "@peerbit/document";
import { Post, Room as RoomDB } from "@peerbit/example-many-chat-rooms";
import { usePeer } from "@peerbit/react";
import { Send } from "@mui/icons-material";
import { Ed25519PublicKey, X25519Keypair } from "@peerbit/crypto";
import { getRoomNameFromPath } from "./routes";
import { Peerbit } from "peerbit";

/***
 *  TODO
 *  This view should be written as multipple parts in multiple files/functions
 *  This is not a best practice way of doing a "room" chat experience
 *
 */

/* 
TODO add encryption feature

const MENU_ITEM_HEIGHT = 48;
const MENU_ITEM_PADDING_TOP = 8;
const MenuProps = {
    PaperProps: {
        style: {
            maxHeight: MENU_ITEM_HEIGHT * 4.5 + MENU_ITEM_PADDING_TOP,
            width: 250,
        },
    },
};

function getStyles(name: string, recievers: readonly string[], theme: Theme) {
    return {
        fontWeight:
            recievers.indexOf(name) === -1
                ? theme.typography.fontWeightRegular
                : theme.typography.fontWeightMedium,
    };
}
 */

const shortName = (name: string) => {
    return (
        name.substring(0, 14) +
        "..." +
        name.substring(name.length - 3, name.length)
    );
};

export const Room = () => {
    const { peer, loading: loadingPeer } = usePeer();
    const [loading, setLoading] = useState(false);
    const [identitiesInChatMap, setIdentitiesInChatMap] =
        useState<Map<string, Ed25519PublicKey>>();

    const room = useRef<RoomDB>();
    const [peerCounter, setPeerCounter] = useState<number>(1);
    const [text, setText] = useState("");
    const [receivers, setRecievers] = useState<string[]>([]);
    const posts = useRef<Post[]>([]);
    const params = useParams();
    const messagesEndRef = useRef(null);
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    };

    useEffect(() => {
        if (!room?.current?.id || room?.current?.closed) {
            return;
        }
        room?.current.messages.index.search(new SearchRequest({ query: [] }), {
            remote: { sync: true },
        });

        /* const identityMap = new Map<string, Ed25519PublicKey>();
       newPosts.forEach((post) => {
           const id = post.entry.signatures[0].publicKey;
           if (peer.identity.publicKey.equals(id)) {
               return; // ignore me
           }
           identityMap.set(id.toString(), id as Ed25519PublicKey); // bad assumption only Ed25519PublicKey in chat
       });
       setIdentitiesInChatMap(identityMap); */
    }, [room?.current?.id, room?.current?.closed, peerCounter]);

    useEffect(() => {
        if (room.current || !params.name || !peer) {
            return;
        }
        room.current = undefined;
        setLoading(true);
        const name = getRoomNameFromPath(params.name);
        peer.open(new RoomDB({ name }), {
            args: { sync: () => true },
            existing: "reuse",
        })
            .then(async (r) => {
                room.current = r;

                const sortPosts = async () => {
                    let wallTimes = new Map<string, bigint>();
                    await Promise.all(
                        posts.current.map(async (x) => {
                            return {
                                post: x,
                                entry: await room.current.messages.log.log.get(
                                    room.current.messages.index.index.get(x.id)
                                        .context.head
                                ),
                            };
                        })
                    ).then((entries) => {
                        entries.forEach(({ post, entry }) => {
                            wallTimes.set(
                                post.id,
                                entry.meta.clock.timestamp.wallTime
                            );
                        });
                    });
                    posts.current.sort((a, b) =>
                        Number(wallTimes.get(a.id) - wallTimes.get(b.id))
                    );
                };

                r.messages.events.addEventListener("change", async (e) => {
                    e.detail.added?.forEach((p) => {
                        const ix = posts.current.findIndex(
                            (x) => x.id === p.id
                        );
                        if (ix === -1) {
                            posts.current.push(p);
                        } else {
                            posts.current[ix] = p;
                        }
                    });
                    e.detail.removed?.forEach((p) => {
                        const ix = posts.current.findIndex(
                            (x) => x.id === p.id
                        );
                        if (ix !== -1) {
                            posts.current.splice(ix, 1);
                        }
                    });

                    // Sort by time
                    sortPosts();
                    forceUpdate();
                });

                // Handle missed events by manually retrieving all posts and setting current posts to the ones we find
                posts.current = await r.messages.index.search(
                    new SearchRequest()
                );
                sortPosts();
                forceUpdate();

                r.events.addEventListener("join", (e) => {
                    r.getReady().then((set) => setPeerCounter(set.size + 1));
                });

                r.events.addEventListener("leave", (e) => {
                    r.getReady().then((set) => setPeerCounter(set.size + 1));
                });

                r.getReady().then((set) => setPeerCounter(set.size + 1)); // To make sure even if join and leave events have been fired before the handlers have been registered, we do this
            })
            .catch((e) => {
                console.error("Failed top open room: " + e.message);
                alert("Failed top open room: " + e.message);

                throw e;
            })
            .finally(() => {
                setLoading(false);
            });
    }, [params.name, peer?.identity.publicKey.hashcode()]);

    useEffect(() => {
        scrollToBottom();
        // sync latest messages
    }, [posts.current?.length]);

    const createPost = useCallback(async () => {
        if (!room) {
            return;
        }
        room.current.messages
            .put(new Post({ message: text, from: peer.identity.publicKey }), {
                encryption: {
                    // TODO do once for performance
                    keypair: await X25519Keypair.from(
                        await peer.keychain.exportByKey(peer.identity.publicKey)
                    ),
                    receiver: {
                        payload: receivers.map((r) =>
                            identitiesInChatMap.get(r)
                        ),
                        meta: [],
                        signatures: [],
                    },
                },
            })
            .then(() => {
                setText("");
                forceUpdate();
            })
            .catch((e) => {
                console.error("Failed to create message: " + e.message);
                alert("Failed to create message: " + e.message);
                throw e;
            });
    }, [text, room, peer, receivers]);

    /* TODO add encryption feature
    
    const handleRecieverChange = (
        event: SelectChangeEvent<typeof receivers>
    ) => {
        const {
            target: { value },
        } = event;
        setRecievers(
            // On autofill we get a stringified value.
            typeof value === "string" ? value.split(",") : value
        );
    }; */

    return (
        <Box>
            <Grid container direction="column">
                {loading || loadingPeer ? (
                    <Grid item>
                        <CircularProgress size={20} />
                    </Grid>
                ) : (
                    <Grid item>
                        <Typography variant="h4">
                            {room.current?.name}
                        </Typography>
                    </Grid>
                )}

                <Grid
                    item
                    border="solid 1px"
                    height="60vh"
                    sx={{ overflowY: "scroll" }}
                    padding={2}
                    mt={2}
                    mb={2}
                >
                    {posts.current?.length > 0 ? (
                        <Grid container direction="column">
                            {posts.current.map((p, ix) => (
                                <Grid
                                    container
                                    item
                                    direction="column"
                                    key={ix}
                                    mb={1}
                                >
                                    <Grid
                                        item
                                        container
                                        direction="row"
                                        justifyItems="center"
                                        spacing={0.5}
                                        mb={-0.5}
                                    >
                                        <Grid item>
                                            <Typography
                                                fontStyle="italic"
                                                variant="caption"
                                                color={
                                                    p.from.equals(
                                                        peer.identity.publicKey
                                                    )
                                                        ? "primary"
                                                        : undefined
                                                }
                                            >
                                                {shortName(p.from.toString())}
                                            </Typography>
                                        </Grid>
                                        {/* {p.entry._payload instanceof
                                            EncryptedThing && (
                                                <Grid
                                                    item
                                                    display="flex"
                                                    alignItems="center"
                                                >
                                                    {" "}
                                                    <Tooltip
                                                        title={
                                                            <span
                                                                style={{
                                                                    whiteSpace:
                                                                        "pre-line",
                                                                }}
                                                            >
                                                                {(
                                                                    p.entry
                                                                        ._payload as EncryptedThing<any>
                                                                )._envelope._ks
                                                                    .map((k) =>
                                                                        shortName(
                                                                            k._recieverPublicKey.toString()
                                                                        )
                                                                    )
                                                                    .join("\n")}
                                                            </span>
                                                        }
                                                    >
                                                        <IconButton>
                                                            <LockIcon
                                                                color="success"
                                                                sx={{
                                                                    fontSize:
                                                                        "14px",
                                                                }}
                                                            />{" "}
                                                        </IconButton>
                                                    </Tooltip>{" "}
                                                </Grid>
                                            )} */}
                                    </Grid>
                                    <Grid item>
                                        <Typography> {p.message}</Typography>
                                    </Grid>
                                </Grid>
                            ))}
                        </Grid>
                    ) : (
                        <>No messages found!</>
                    )}
                    <div ref={messagesEndRef} />
                </Grid>

                <Grid
                    container
                    item
                    direction="row"
                    justifyContent="space-between"
                    spacing={1}
                >
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
                        <IconButton
                            disabled={!text || !room}
                            onClick={createPost}
                        >
                            <Send />
                        </IconButton>
                    </Grid>
                </Grid>
                {/* TODO add encryption feature
                
                <Grid
                    item
                    container
                    justifyContent="space-between"
                    alignItems="center"
                    spacing={1}
                    direction="row"
                    mt={2}
                    mb={2}
                >
                    <Grid item flex={1} pr={1}>
                        <FormControl sx={{ width: "100%" }}>
                            <InputLabel id="demo-multiple-chip-label">
                                Recievers
                            </InputLabel>
                            <Select
                                labelId="recieversl"
                                id="recievers"
                                multiple
                                value={receivers}
                                onChange={handleRecieverChange}
                                input={
                                    <OutlinedInput
                                        id="select-multiple-chip"
                                        label="Recievers"
                                    />
                                }
                                renderValue={(selected) => (
                                    <Box
                                        sx={{
                                            display: "flex",
                                            flexWrap: "wrap",
                                            gap: 0.5,
                                        }}
                                    >
                                        {selected.map((value) => (
                                            <Chip
                                                key={value}
                                                label={shortName(value)}
                                            />
                                        ))}
                                    </Box>
                                )}
                                MenuProps={MenuProps}
                            >
                                {identitiesInChatMap &&
                                    [...identitiesInChatMap.keys()]?.map(
                                        (id) => (
                                            <MenuItem
                                                key={id}
                                                value={id}
                                                style={getStyles(
                                                    id,
                                                    receivers,
                                                    theme
                                                )}
                                            >
                                                {shortName(id)}
                                            </MenuItem>
                                        )
                                    )}
                            </Select>
                        </FormControl>
                    </Grid>
                    <Grid item pr={1}>
                        <KeyIcon
                            color={
                                receivers?.length > 0 ? "success" : undefined
                            }
                        />
                    </Grid>
                </Grid> */}
            </Grid>
        </Box>
    );
};
