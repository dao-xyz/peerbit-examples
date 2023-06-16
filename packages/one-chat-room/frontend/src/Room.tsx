import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
    Box,
    CircularProgress,
    Grid,
    IconButton,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material";
import { useParams } from "react-router";
import { SearchRequest } from "@dao-xyz/peerbit-document";
import { Post, Room as RoomDB } from "./database.js";
import { usePeer } from "@dao-xyz/peerbit-react";
import { Names } from "@dao-xyz/peer-names";
import { Send } from "@mui/icons-material";
import { getKeyFromPath } from "./routes";
import { Ed25519PublicKey } from "@dao-xyz/peerbit-crypto";
import PeopleIcon from "@mui/icons-material/People";

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
    const room = useRef<RoomDB>();
    const [peerCounter, setPeerCounter] = useState<number>(1);
    const [loading, setLoading] = useState(false);
    const identitiesInChatMap = useRef<Map<string, Ed25519PublicKey>>();
    const [text, setText] = useState("");
    const [receivers, setRecievers] = useState<string[]>([]);
    const postsRef = useRef<Post[]>([]);
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const params = useParams();
    const messagesEndRef = useRef(null);

    const [headerHeight, setHeaderHeight] = useState(0);
    const [inputHeight, setInputHeight] = useState(0);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    };

    useEffect(() => {
        if (!room?.current?.id || !room?.current?.initialized) {
            return;
        }
        room?.current.messages.index.search(new SearchRequest({ query: [] }), {
            remote: { sync: true },
        });
    }, [room?.current?.id, room?.current?.initialized, peerCounter]);

    useEffect(() => {
        if (room.current || loading || !params.key || !peer) {
            //('return', rooms, loadedRoomsLocally)
            return;
        }
        room.current = undefined;
        setLoading(true);
        const key = getKeyFromPath(params.key);
        peer.open(new Names(), { sync: () => true }).then(async (namesDB) => {
            await namesDB.load();
            names.current = namesDB;

            await peer
                .open(new RoomDB({ creator: key }), { sync: () => true })
                .then(async (r) => {
                    room.current = r;

                    const updateNames = async (p: Post) => {
                        const pk = (
                            await r.messages.log.get(
                                r.messages.index.index.get(p.id).context.head
                            )
                        ).signatures[0].publicKey;
                        namesDB.getName(pk).then((name) => {
                            namesCache.set(pk.hashcode(), name);
                        });
                    };

                    let updateTimeout:
                        | ReturnType<typeof setTimeout>
                        | undefined;
                    r.messages.events.addEventListener("change", (e) => {
                        e.detail.added?.forEach((p) => {
                            const ix = postsRef.current.findIndex(
                                (x) => x.id === p.id
                            );
                            if (ix === -1) {
                                postsRef.current.push(p);
                            } else {
                                postsRef.current[ix] = p;
                            }
                            updateNames(p);
                        });
                        e.detail.removed?.forEach((p) => {
                            const ix = postsRef.current.findIndex(
                                (x) => x.id === p.id
                            );
                            if (ix !== -1) {
                                postsRef.current.splice(ix, 1);
                            }
                        });

                        let wallTimes = new Map<string, bigint>();

                        clearTimeout(updateTimeout);
                        updateTimeout = setTimeout(async () => {
                            const entries = await Promise.all(
                                postsRef.current.map(async (x) => {
                                    return {
                                        post: x,
                                        entry: await room.current.messages.log.get(
                                            room.current.messages.index.index.get(
                                                x.id
                                            ).context.head
                                        ),
                                    };
                                })
                            );
                            entries.forEach(({ post, entry }) => {
                                wallTimes.set(
                                    post.id,
                                    entry.metadata.clock.timestamp.wallTime
                                );
                            });

                            postsRef.current.sort((a, b) =>
                                Number(
                                    wallTimes.get(a.id) - wallTimes.get(b.id)
                                )
                            );
                            forceUpdate();
                        }, 5);
                    });

                    peer.libp2p.services.pubsub.addEventListener(
                        "peer:reachable",
                        (e) => {
                            console.log(
                                "REACHABLE!",
                                peer.identityHash,
                                e.detail.hashcode()
                            );
                        }
                    );
                    peer.libp2p.services.pubsub.addEventListener(
                        "subscribe",
                        () => {
                            console.log("SUBSCRIBE!");
                            setPeerCounter(
                                peer.libp2p.services.pubsub.getSubscribers(
                                    r.allLogs[0].idString
                                ).size + 1
                            );
                        }
                    );

                    peer.libp2p.services.pubsub.addEventListener(
                        "unsubscribe",
                        () => {
                            setPeerCounter(
                                peer.libp2p.services.pubsub.getSubscribers(
                                    r.allLogs[0].idString
                                ).size + 1
                            );
                        }
                    );

                    await r.load();
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
    }, [params.name, peer?.identityHash]);
    useEffect(() => {
        scrollToBottom();
        // sync latest messages
    }, [postsRef.current?.length]);

    const createPost = useCallback(async () => {
        if (!room) {
            return;
        }
        console.log(peer.libp2p.services.pubsub.peers);
        room.current.messages
            .put(new Post({ message: text, from: peer.identity.publicKey }), {
                reciever: {
                    payload: receivers.map((r) =>
                        identitiesInChatMap.current.get(r)
                    ),
                    metadata: [],
                    next: [],
                    signatures: [],
                },
            })
            .then(() => {
                setText("");
            })
            .catch((e) => {
                console.error("Failed to create message: " + e.message);
                alert("Failed to create message: " + e.message);
                throw e;
            });
    }, [text, room.current?.id, peer, receivers]);

    const getDisplayName = (p: Post) => {
        const name = namesCache.get(p.from.hashcode());
        if (name) {
            return name;
        }
        return shortName(p.from.toString());
    };
    const hasDisplayName = (p: Post) => namesCache.has(p.from.hashcode());

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
            <Grid
                item
                container
                ref={(node) => node && setHeaderHeight(node.offsetHeight)}
                pl={1}
                pt={1}
                pb={1}
                spacing={1}
            >
                <Grid item>
                    <PeopleIcon />
                </Grid>
                <Grid item>{peerCounter}</Grid>
            </Grid>
            <Grid
                item
                height={`calc(100vh - ${(headerHeight || 0) + "px"}  - ${
                    (inputHeight || 0) + "px"
                } - 8px)`}
                sx={{ overflowY: "scroll" }}
                padding={1}
                mb="8px"
                onScroll={async (e) => {
                    if (e.currentTarget.scrollTop === 0) {
                        // load more elements
                    }
                }}
            >
                {postsRef.current?.length > 0 ? (
                    <Grid container direction="column">
                        {postsRef.current.map((p, ix) => (
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
                                        <Tooltip title={p.from.toString()}>
                                            <Typography
                                                fontStyle={
                                                    !hasDisplayName(p) &&
                                                    "italic"
                                                }
                                                variant="caption"
                                                color={
                                                    p.from.equals(
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
                                </Grid>
                                <Grid item>
                                    <Typography> {p.message}</Typography>
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
                ref={(node) => node && setInputHeight(node.offsetHeight)}
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
        </Grid>
    );
};
