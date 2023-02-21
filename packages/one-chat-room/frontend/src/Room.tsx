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
import {
    DocumentQueryRequest,
    StringMatchQuery,
    IndexedValue,
} from "@dao-xyz/peerbit-document";
import { Post, Room as RoomDB } from "./database.js";
import { usePeer } from "@dao-xyz/peerbit-react";
import { Send } from "@mui/icons-material";
import { getKeyFromPath } from "./routes";
import { useNavigate } from "react-router-dom";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import FormControl from "@mui/material/FormControl";
import Select, { SelectChangeEvent } from "@mui/material/Select";
import Chip from "@mui/material/Chip";
import { Theme, useTheme } from "@mui/material/styles";
import { Ed25519PublicKey, EncryptedThing } from "@dao-xyz/peerbit-crypto";
import KeyIcon from "@mui/icons-material/Key";
import LockIcon from "@mui/icons-material/Lock";
import { ReplicatorType } from "@dao-xyz/peerbit-program";

/***
 *  TODO
 *  This view should be written as multipple parts in multiple files/functions
 *  This is not a best practice way of doing a "room" chat experience
 *
 */

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

const shortName = (name: string) => {
    return (
        name.substring(0, 14) +
        "..." +
        name.substring(name.length - 3, name.length)
    );
};

export const Room = () => {
    const theme = useTheme();
    const { peer, loading: loadingPeer } = usePeer();
    const [room, setRoom] = useState<RoomDB>();
    const [loading, setLoading] = useState(false);
    const [identitiesInChatMap, setIdentitiesInChatMap] =
        useState<Map<string, Ed25519PublicKey>>();

    const [text, setText] = useState("");
    const [receivers, setRecievers] = useState<string[]>([]);
    const [lastUpdated, setLastUpdate] = useState(0);
    const [posts, setPosts] = useState<IndexedValue<Post>[]>();
    const params = useParams();
    const navigate = useNavigate();
    const messagesEndRef = useRef(null);
    const inputArea = useRef<HTMLDivElement>(null);

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
        peer.open(new RoomDB({ creator: getKeyFromPath(params.key) }))
            .then((r) => {
                r.messages.events.addEventListener("change", () => {
                    refresh();
                });
                setRoom(r);
            })
            .catch((e) => {
                console.error("Failed top open room: " + e.message);
                alert("Failed top open room: " + e.message);

                throw e;
            })
            .finally(() => {
                setLoading(false);
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
    };

    return (
        <Grid container direction="column" sx={{ height: "100vh" }}>
            {(loading || loadingPeer) && (
                <Grid item>
                    <CircularProgress size={20} />
                </Grid>
            )}
            <Grid
                item
                height={`calc(100vh - ${
                    (inputArea.current?.scrollHeight || 0) + "px"
                } - 8px)`}
                sx={{ overflowY: "auto" }}
                padding={2}
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
                                        <Typography
                                            fontStyle="italic"
                                            variant="caption"
                                            color={
                                                p.entry.signatures[0].publicKey.equals(
                                                    peer.identity.publicKey
                                                )
                                                    ? "primary"
                                                    : undefined
                                            }
                                        >
                                            {shortName(
                                                p.entry.signatures[0].publicKey.toString()
                                            )}
                                        </Typography>
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
