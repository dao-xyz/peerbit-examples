import { useCallback, useEffect, useRef, useState } from "react";
import {
    Box,
    CircularProgress,
    Grid,
    IconButton,
    OutlinedInput,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material";
import { useParams } from "react-router";
import { DocumentQueryRequest, IndexedValue } from "@dao-xyz/peerbit-document";
import { Post, Room as RoomDB } from "./database.js";
import { usePeer } from "@dao-xyz/peerbit-react";
import { Send } from "@mui/icons-material";
import { getKeyFromPath } from "./routes";
import { Ed25519PublicKey, EncryptedThing } from "@dao-xyz/peerbit-crypto";
import LockIcon from "@mui/icons-material/Lock";
import PeopleIcon from "@mui/icons-material/People";
import { Names } from "@dao-xyz/peer-names";

/***
 *  TODO
 *  This view should be written as multipple parts in multiple files/functions
 *  This is not a best practice way of doing a "room" chat experience
 *
 */

const shortName = (name: string) => {
    return (
        name.substring(0, 14) +
        "..." +
        name.substring(name.length - 3, name.length)
    );
};
let namesCache = new Map();
export const Room = () => {
    const { peer, loading: loadingPeer } = usePeer();
    const names = useRef<Names>();
    const [room, setRoom] = useState<RoomDB>();
    const [peerCounter, setPeerCounter] = useState<number>(1);
    const [loading, setLoading] = useState(false);
    const [identitiesInChatMap, setIdentitiesInChatMap] =
        useState<Map<string, Ed25519PublicKey>>();
    const [text, setText] = useState("");
    const [receivers, setRecievers] = useState<string[]>([]);
    const [lastUpdated, setLastUpdate] = useState(0);
    const [posts, setPosts] = useState<IndexedValue<Post>[]>();
    const params = useParams();
    const messagesEndRef = useRef(null);
    const inputArea = useRef<HTMLDivElement>(null);
    const header = useRef<HTMLDivElement>(null);
    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    };
    const refresh = useCallback(() => {
        setLastUpdate(+new Date());
    }, [lastUpdated]);

    useEffect(() => {
        if (!room?.id || !room?.initialized) {
            return;
        }
        room.load();

        room.messages.index.query(new DocumentQueryRequest({ queries: [] }), {
            remote: { sync: true },
            onResponse: () => {
                setLastUpdate(+new Date());
            },
        });
    }, [room?.id, room?.initialized]);

    useEffect(() => {
        if (!room?.initialized) {
            return;
        }

        const newPosts = [...room.messages.index.index.values()].sort((a, b) =>
            Number(
                a.entry.metadata.clock.timestamp.wallTime -
                    b.entry.metadata.clock.timestamp.wallTime
            )
        );
        const identityMap = new Map<string, Ed25519PublicKey>();
        newPosts.forEach((post) => {
            const id = post.entry.signatures[0].publicKey;
            if (peer.identity.publicKey.equals(id)) {
                return; // ignore me
            }
            identityMap.set(id.toString(), id as Ed25519PublicKey); // bad assumption only Ed25519PublicKey in chat
        });
        setIdentitiesInChatMap(identityMap);
        setPosts(newPosts); // TODO make more performant and add sort
    }, [room?.id, lastUpdated]);

    useEffect(() => {
        if (room || loading || !params.key || !peer) {
            //('return', rooms, loadedRoomsLocally)
            return;
        }
        setRoom(undefined);
        setLoading(true);
        const key = getKeyFromPath(params.key);
        peer.open(new Names(), { sync: () => true }).then(async (namesDB) => {
            await namesDB.load();
            names.current = namesDB;

            await peer
                .open(new RoomDB({ creator: key }))
                .then((r) => {
                    const updateNames = async (p: Post) => {
                        const pk = r.messages.index.index.get(p.id).entry
                            .signatures[0].publicKey;
                        namesDB.getName(pk).then((name) => {
                            namesCache.set(pk.hashcode(), name);
                        });
                    };
                    r.messages.events.addEventListener("change", (e) => {
                        e.detail.added?.forEach((p) => {
                            updateNames(p);
                        });
                        e.detail.removed?.forEach((p) => {
                            updateNames(p);
                        });
                        refresh();
                    });

                    setRoom(r);

                    peer.libp2p.directsub.addEventListener("subscribe", () => {
                        setPeerCounter(
                            peer.libp2p.directsub.getSubscribers(
                                r.address.toString()
                            ).size + 1
                        );
                    });
                    peer.libp2p.directsub.addEventListener(
                        "unsubscribe",
                        () => {
                            setPeerCounter(
                                peer.libp2p.directsub.getSubscribers(
                                    r.address.toString()
                                ).size + 1
                            );
                        }
                    );
                })
                .catch((e) => {
                    console.error("Failed top open room: " + e.message);
                    alert("Failed top open room: " + e.message);

                    throw e;
                })
                .finally(() => {
                    setLoading(false);
                });
        });
    }, [params.name, lastUpdated, peer?.id.toString()]);
    useEffect(() => {
        scrollToBottom();
        // sync latest messages
    }, [posts]);

    const createPost = useCallback(async () => {
        if (!room) {
            return;
        }
        room.messages
            .put(new Post({ message: text }), {
                reciever: {
                    payload: receivers.map((r) => identitiesInChatMap.get(r)),
                    metadata: [],
                    next: [],
                    signatures: [],
                },
            })
            .then(() => {
                setText("");
                setLastUpdate(+(+new Date()));
            })
            .catch((e) => {
                console.error("Failed to create message: " + e.message);
                alert("Failed to create message: " + e.message);
                throw e;
            });
    }, [text, room, peer, receivers]);

    /* const handleRecieverChange = (
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

    const getDisplayName = (p: IndexedValue<Post>) => {
        const name = namesCache.get(p.entry.signatures[0].publicKey.hashcode());
        if (name) {
            return name;
        }
        return shortName(p.entry.signatures[0].publicKey.toString());
    };
    const hasDisplayName = (p: IndexedValue<Post>) =>
        namesCache.has(p.entry.signatures[0].publicKey.hashcode());

    return loading || loadingPeer ? (
        <Box
            sx={{
                height: "100vh",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
            }}
        >
            <CircularProgress size={20} />
        </Box>
    ) : (
        <Grid container direction="column" sx={{ height: "100vh" }}>
            <Grid item container ref={header} pl={1} pt={1} pb={1} spacing={1}>
                <Grid item>
                    <PeopleIcon />
                </Grid>
                <Grid item>{peerCounter}</Grid>
            </Grid>
            <Grid
                item
                height={`calc(100vh - ${
                    (header.current?.offsetHeight || 0) + "px"
                }  - ${(inputArea.current?.offsetHeight || 0) + "px"} - 8px)`}
                sx={{ overflowY: "auto" }}
                padding={1}
                mb="8px"
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
                                <Grid
                                    item
                                    container
                                    direction="row"
                                    justifyItems="center"
                                    spacing={0.5}
                                    mb={-0.5}
                                >
                                    <Grid item>
                                        <Tooltip
                                            title={p.entry.signatures[0].publicKey.toString()}
                                        >
                                            <Typography
                                                fontStyle={
                                                    !hasDisplayName(p) &&
                                                    "italic"
                                                }
                                                variant="caption"
                                                color={
                                                    p.entry.signatures[0].publicKey.equals(
                                                        peer.identity.publicKey
                                                    )
                                                        ? "primary"
                                                        : undefined
                                                }
                                            >
                                                {getDisplayName(p)}
                                            </Typography>
                                        </Tooltip>
                                    </Grid>
                                    {p.entry._payload instanceof
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
                                                            fontSize: "14px",
                                                        }}
                                                    />{" "}
                                                </IconButton>
                                            </Tooltip>{" "}
                                        </Grid>
                                    )}
                                </Grid>
                                <Grid item>
                                    <Typography> {p.value.message}</Typography>
                                </Grid>
                            </Grid>
                        ))}
                    </Grid>
                ) : (
                    <>{/* No messages found! */}</>
                )}
                <div ref={messagesEndRef} />
            </Grid>

            <Grid
                ref={inputArea}
                container
                item
                direction="row"
                justifyContent="space-between"
                spacing={1}
                marginTop="auto"
            >
                <Grid item flex={1}>
                    <TextField
                        size="small"
                        id="outlined-multiline-flexible"
                        label="Send message"
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
                                if (text.length > 0) {
                                    createPost();
                                }
                            }
                        }}
                        value={text}
                    />
                </Grid>

                <Grid item>
                    <IconButton disabled={!text || !room} onClick={createPost}>
                        <Send />
                    </IconButton>
                </Grid>
            </Grid>
            {/* <Grid
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
    );
};
