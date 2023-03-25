import { useState, useEffect, useRef, useCallback } from "react";

import {
    getStreamPath,
    CHAT_APP,
    STREAMING_APP,
    getChatPath,
    getAdressFromKey,
} from "./routes.js";
import { usePeer, submitKeypairChange } from "@dao-xyz/peerbit-react";
import { useParams } from "react-router-dom";
import { Canvas as CanvasDB, Position, Rect, Size } from "./dbs/canvas";
import { Ed25519Keypair, PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { Box, Grid, IconButton } from "@mui/material";
import iFrameResize from "iframe-resizer";
import { Add, Clear } from "@mui/icons-material";
import { DocumentQuery } from "@dao-xyz/peerbit-document";
import { useNames } from "./useNames.js";
import { getCanvasKeypair, getCanvasKeypairs } from "./keys.js";
import { HEIGHT } from "./Header.js";

export const Canvas = () => {
    const { peer } = usePeer();
    const params = useParams();
    const myCanvas = useRef<Promise<CanvasDB>>(null);
    const [rects, setRects] = useState<Rect[]>([]);
    const [idArgs, setIdArgs] = useState<{
        node: PublicSignKey;
    }>();
    const [isOwner, setIsOwner] = useState<boolean | undefined>(undefined);
    const chatKeypairRef = useRef<Ed25519Keypair>(null);
    const { name, setName } = useNames();

    const addRect = async () => {
        const { key: keypair } = await getCanvasKeypair();
        await setName(name); // Reinitialize names, so that all keypairs get associated with the name
        const c = await myCanvas.current;
        c.rects.put(
            new Rect({
                keypair,
                publicKey: keypair.publicKey,
                position: new Position({ x: 0, y: c.rects.index.size, z: 0 }),
                size: new Size({ height: 100, width: 100 }),
                src: STREAMING_APP + getStreamPath(keypair.publicKey),
            })
        );
    };

    useEffect(() => {
        if (!peer?.libp2p || !params.key || myCanvas.current) {
            return;
        }

        const canvasAddress = getAdressFromKey(params.key);

        myCanvas.current = peer
            .open<CanvasDB>(canvasAddress, {
                sync: () => true,
            })
            .then(async (canvas) => {
                console.log("OPEN!", canvas);
                const node = canvas.key;
                let isOwner = peer.idKey.publicKey.equals(node);
                console.log("is owner?", isOwner);
                setIsOwner(isOwner);
                setIdArgs({ node });
                canvas.rects.events.addEventListener(
                    "change",
                    async (change) => {
                        setRects(
                            (
                                await Promise.all(
                                    [...canvas.rects.index.index.values()].map(
                                        async (x) => {
                                            let doc =
                                                await canvas.rects.index.getDocument(
                                                    x
                                                );
                                            if (isOwner) {
                                                if (!doc.keypair) {
                                                    console.log(
                                                        "reset keypair for rect!"
                                                    );
                                                    // try to find it in memory
                                                    const keypairs =
                                                        await getCanvasKeypairs();
                                                    for (const keypair of keypairs) {
                                                        if (
                                                            keypair.publicKey.equals(
                                                                doc.publicKey
                                                            )
                                                        ) {
                                                            doc.keypair =
                                                                keypair;
                                                            return doc;
                                                        }
                                                    }
                                                    console.warn(
                                                        "Could not find keypair for rect"
                                                    );
                                                    return undefined; // We don't generate a new one, since its meaningless
                                                }
                                            } else {
                                                console.log(
                                                    "reset keypair for rect!"
                                                );
                                                if (!doc.keypair) {
                                                    const { key: keypair } =
                                                        await getCanvasKeypair();
                                                    /*  const keypair =
                                                         await Ed25519Keypair.create();
                                                     console.log(
                                                         "FREE KEYPAIR",
                                                         keypair.publicKey.hashcode()
                                                     ); */
                                                    doc.keypair = keypair;
                                                }
                                            }
                                            return doc;
                                        }
                                    )
                                )
                            )
                                .sort((a, b) => a.position.y - b.position.y)
                                .filter((x) => !!x)
                        );
                    }
                );
                await canvas.load();

                if (canvas.rects.index.size > 0) {
                    return canvas;
                }

                if (isOwner) {
                    //addRect();
                    /*     const { key: keypair2 } = await getFreeKeypair('canvas')
                    canvas.rects.put(new Rect({ keypair: keypair2, position: new Position({ x: 0, y: 0, z: 0 }), size: new Size({ height: 100, width: 100 }), src: STREAMING_APP + "/" + getStreamPath(keypair2.publicKey) })) */
                } else {
                    setInterval(async () => {
                        console.log(
                            (
                                await canvas.rects.index.query(
                                    new DocumentQuery({ queries: [] }),
                                    { remote: { sync: true } }
                                )
                            ).length
                        );
                    }, 2000);
                }
                return canvas;
                /*  else {
                
             } */
            });
    }, [peer?.id.toString()]);

    const onIframe = useCallback(
        (
            node,
            rect: { keypair: Ed25519Keypair; src: string },
            autoResize: boolean = true
        ) => {
            console.log("LOAD IFRAME");
            if (autoResize) {
                const resize = iFrameResize.iframeResize(
                    { /* heightCalculationMethod: 'bodyOffset', */ log: false },
                    node.target
                );
                setInterval(() => {
                    resize[0]?.["iFrameResizer"]?.resize();
                }, 1000); // resize a few times in the beginning, height calculations seems to initialize incorrectly
            }
            submitKeypairChange(node.target, rect.keypair, rect.src);
        },
        []
    );

    return (
        <Grid container direction="row" sx={{ width: "100%" }}>
            <Grid
                item
                sx={{
                    overflowY: "scroll",
                    height: `calc(100vh - ${HEIGHT})`,
                    width: `calc(100% - 275px)`,
                }}
            >
                <Box sx={{ flexDirection: "column" }}>
                    {rects.map((x, ix) => {
                        return (
                            <Grid
                                item
                                ref={(ref) => {
                                    ref?.querySelector<HTMLElement>(
                                        "#frame-" + ix
                                    )?.addEventListener("mouseenter", () => {
                                        ref.querySelector<HTMLElement>(
                                            "#header-" + ix
                                        ).style.opacity = "1";
                                    });

                                    ref?.querySelector<HTMLElement>(
                                        "#frame-" + ix
                                    )?.addEventListener("mouseleave", () => {
                                        ref.querySelector<HTMLElement>(
                                            "#header-" + ix
                                        ).style.opacity = "0";
                                    });
                                }}
                                container
                                direction="column"
                                key={ix}
                                sx={{
                                    position: "relative",
                                    width: "100%",
                                    maxWidth: "100%",
                                }}
                            >
                                <Grid
                                    id={"header-" + ix}
                                    item
                                    alignItems="right"
                                    width="100%"
                                    display="flex"
                                    position="absolute"
                                    sx={{ top: "0px", opacity: 0 }}
                                >
                                    {isOwner && (
                                        <IconButton
                                            size="small"
                                            sx={{ ml: "auto" }}
                                            onClick={() => {
                                                myCanvas.current.then(
                                                    (canvas) => {
                                                        canvas.rects.del(x.id);
                                                    }
                                                );
                                            }}
                                        >
                                            <Clear />
                                        </IconButton>
                                    )}
                                </Grid>
                                <Grid id={"frame-" + ix} item>
                                    <iframe
                                        onLoad={(event) => onIframe(event, x)}
                                        style={{
                                            width: "100%",
                                            height: "500px",
                                            border: 0,
                                        }}
                                        src={x.src}
                                        allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write;"
                                    ></iframe>
                                </Grid>
                            </Grid>
                        );
                    })}
                    {isOwner && (
                        <IconButton size="large" onClick={addRect}>
                            <Add />
                        </IconButton>
                    )}
                </Box>
            </Grid>
            <Grid
                item
                sx={{
                    width: "250px",
                    position: "fixed",
                    bottom: "10px",
                    right: "10px",
                }}
            >
                {idArgs?.node && (
                    <iframe
                        onLoad={async (event) => {
                            if (!chatKeypairRef.current) {
                                chatKeypairRef.current = (
                                    await getCanvasKeypair()
                                ).key;

                                setName(name);
                            }
                            const kp = chatKeypairRef.current;
                            if (
                                (event.target as HTMLIFrameElement).src ==
                                CHAT_APP
                            ) {
                                (event.target as HTMLIFrameElement).src =
                                    CHAT_APP + getChatPath(idArgs.node);
                            } else {
                                onIframe(event, {
                                    keypair: kp,
                                    src: CHAT_APP + getChatPath(idArgs.node),
                                });
                            }
                        }}
                        style={{
                            display: "block",
                            width: "100%",
                            height: "calc(100vh - 50px)",
                            border: 0,
                            overflow: "hidden",
                        }}
                        src={CHAT_APP}
                        allow="camera; microphone; display-capture; autoplay; clipboard-write;"
                    ></iframe>
                )}
            </Grid>
        </Grid>
    );
};
