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
import { SearchRequest } from "@peerbit/document";
import { Post, Room as RoomDB } from "./database.js";
import { usePeer } from "@peerbit/react";
import { Names } from "@peerbit/peer-names";
import { Send } from "@mui/icons-material";
import { getKeyFromPath } from "./routes";
import { Ed25519PublicKey, X25519Keypair } from "@peerbit/crypto";
import PeopleIcon from "@mui/icons-material/People";
import { useProgram } from "@peerbit/react";

const shortName = (name: string) => {
    return (
        name.substring(0, 14) +
        "..." +
        name.substring(name.length - 3, name.length)
    );
};
let namesCache = new Map();

function debounce(func, delay) {
    var timer = 0;
    return function debouncedFn(args: any) {
        if (Date.now() - timer > delay) {
            func(args);
        }
        timer = Date.now();
    };
}

export const Room = () => {
    // Manage names and identities
    const identitiesInChatMap =
        useRef<Map<string, Ed25519PublicKey>>(undefined);

    // This fields is meant for when one uses encryption (not used as of now)
    const [receivers, setRecievers] = useState<string[]>([]);

    // list of current posts in view
    const postsRef = useRef<Post[]>([]);

    // force updates
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);

    // input field
    const [text, setText] = useState("");

    // url
    const params = useParams();

    // db stuff

    /// client
    const { peer, loading: loadingPeer } = usePeer();

    /// aliases
    const names = useProgram(new Names(), {
        args: {
            replicate: {
                factor: 1,
            },
        },
        existing: "reuse",
    });

    /// messages
    const room = useProgram(
        params.key && new RoomDB({ creator: getKeyFromPath(params.key) }),
        {
            args: {
                replicate: {
                    factor: 1,
                },
            },
            existing: "reuse",
        }
    );

    const messagesEndRef = useRef(null);

    const [headerHeight, setHeaderHeight] = useState(0);
    const [inputHeight, setInputHeight] = useState(0);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    };

    useEffect(() => {
        console.log(peer?.identity.publicKey.hashcode());
        if (!room.program?.id || room.program?.closed) {
            return;
        }

        const updateNames = async (p: Post) => {
            const pk = (
                await room.program.messages.log.log.get(
                    (
                        await room.program.messages.index.getDetailed(p.id)
                    )[0]?.results[0].context.head
                )
            ).signatures[0].publicKey;
            names.program?.getName(pk).then((name) => {
                namesCache.set(pk.hashcode(), name);
            });
        };

        let updateTimeout: ReturnType<typeof setTimeout> | undefined;

        const updateWallTimes = () => {
            let wallTimes = new Map<string, bigint>();
            clearTimeout(updateTimeout);
            updateTimeout = setTimeout(async () => {
                const entries = await Promise.all(
                    postsRef.current.map(async (x) => {
                        return {
                            post: x,
                            entry: await room.program.messages.log.log.get(
                                (
                                    await room.program.messages.index.getDetailed(
                                        x.id
                                    )
                                )[0]?.results[0].context.head
                            ),
                        };
                    })
                );
                entries.forEach(({ post, entry }) => {
                    wallTimes.set(post.id, entry.meta.clock.timestamp.wallTime);
                });

                postsRef.current.sort((a, b) => {
                    return Number(
                        (wallTimes.get(a.id) || 0n) -
                            (wallTimes.get(b.id) || 0n)
                    );
                });
                forceUpdate();
            }, 5);
        };

        const addPostToView = (p: Post) => {
            const ix = postsRef.current.findIndex((x) => x.id === p.id);
            if (ix === -1) {
                postsRef.current.push(p);
            } else {
                postsRef.current[ix] = p;
            }
            updateNames(p);
        };
        const removePostFromView = (p: Post) => {
            const ix = postsRef.current.findIndex((x) => x.id === p.id);
            if (ix !== -1) {
                postsRef.current.splice(ix, 1);
            }
        };
        const changeListener = (e) => {
            e.detail.added?.forEach(addPostToView);
            e.detail.removed?.forEach(removePostFromView);
            updateWallTimes();
        };
        room.program.messages.events.addEventListener("change", changeListener);

        room.program.messages.index
            .search(new SearchRequest({ query: [], fetch: 0xffffffff }), {
                remote: { replicate: true },
            })
            .then((results) => {
                results.forEach(addPostToView);
                updateWallTimes();
            });

        return () =>
            room.program.messages.events.removeEventListener(
                "change",
                changeListener
            );
    }, [room.program?.address]);

    useEffect(() => {
        scrollToBottom();
        // sync latest messages
    }, [postsRef.current?.length]);

    const createPost = useCallback(async () => {
        if (!room) {
            return;
        }
        room.program.messages
            .put(new Post({ message: text, from: peer.identity.publicKey }), {
                encryption: {
                    // TODO do once for performance
                    keypair: await X25519Keypair.from(
                        await peer.services.keychain.exportByKey(
                            peer.identity.publicKey
                        )
                    ),

                    // Set reciever of message parts
                    receiver: {
                        payload: receivers.map((r) =>
                            identitiesInChatMap.current.get(r)
                        ),
                        meta: [],
                        signatures: [],
                    },
                },
            })
            .then(() => {
                setText("");
            })
            .catch((e) => {
                console.error("Failed to create message: " + e.message);
                if (!e.message) {
                    console.error(e);
                }
                alert("Failed to create message: " + e.message);
                throw e;
            });
    }, [text, room.program?.id, peer, receivers]);

    const getDisplayName = (p: Post) => {
        const name = namesCache.get(p.from.hashcode());
        if (name) {
            return name;
        }
        return shortName(p.from.toString());
    };
    const hasDisplayName = (p: Post) => namesCache.has(p.from.hashcode());

    return names.loading || room.loading || loadingPeer ? (
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
                <Grid item>{room.peers.length}</Grid>
            </Grid>
            <Grid
                item
                height={`calc(100vh - ${(headerHeight || 0) + "px"}  - ${
                    (inputHeight || 0) + "px"
                } - 8px)`}
                sx={{ overflowY: "scroll" }}
                padding={1}
                mb="8px"
                onWheel={debounce(async (e) => {
                    if (
                        e.currentTarget.scrollHeight ===
                        e.currentTarget.clientHeight
                    ) {
                        // No scrollbar visible, but we want to "scroll"
                        let scrollingTop = e.deltaY < 0;
                        scrollingTop
                            ? room.program.loadEarlier()
                            : room.program.loadLater();
                    }
                }, 30)}
                onScroll={async (e) => {
                    if (e.currentTarget.scrollTop === 0) {
                        room.program.loadEarlier();
                    } else if (
                        Math.abs(
                            e.currentTarget.scrollHeight -
                                e.currentTarget.scrollTop -
                                e.currentTarget.clientHeight
                        ) < 1
                    ) {
                        room.program.loadLater();
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
