import { useState, useEffect, useRef, useCallback } from "react";
import createCache from "@emotion/cache";
import styled from "@emotion/styled";
import ReactDOM from "react-dom";
import {
    getStreamPath,
    getPathFromKey,
    getKeyFromPath,
    CHAT_APP,
    STREAMING_APP,
    getNameFromPath,
    getChatPath,
} from "./routes.js";
import { CacheProvider } from "@emotion/react";
import {
    usePeer,
    submitKeypairChange,
    getFreeKeypair,
} from "@dao-xyz/peerbit-react";
import { useParams } from "react-router-dom";
import { Canvas as CanvasDB, Position, Rect, Size, Spaces } from "./dbs/canvas";
import { Ed25519Keypair, PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { Box, Grid, IconButton } from "@mui/material";
import iFrameResize from "iframe-resizer";
import { logger } from "@dao-xyz/peerbit";
import { Add, Clear } from "@mui/icons-material";
import { DocumentQueryRequest } from "@dao-xyz/peerbit-document";
import { useNames } from "./useNames.js";
import { getCanvasKeypair, getCanvasKeypairs } from "./keys.js";
import { Header } from "./Header.js";

logger.level = "trace";

const PreviewIframe = styled("iframe")(() => ({
    border: "none",
    height: "100%",
    width: "100%",
}));

const PreviewPortal = (props: any) => {
    const [contentRef, setContentRef] = useState<any>(null);
    const mountNode = contentRef?.contentWindow?.document?.body;
    const cache = createCache({
        key: "css",
        container: contentRef?.contentWindow?.document?.head,
        prepend: true,
    });
    return (
        <PreviewIframe ref={setContentRef}>
            {mountNode &&
                ReactDOM.createPortal(
                    <CacheProvider value={cache}>
                        {props.children}
                    </CacheProvider>,
                    mountNode
                )}
        </PreviewIframe>
    );
};

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
    const header = useRef<HTMLDivElement>();

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
                src: STREAMING_APP + "/" + getStreamPath(keypair.publicKey),
            })
        );
    };

    useEffect(() => {
        if (!peer?.libp2p || !params.key || myCanvas.current) {
            return;
        }

        const node = getKeyFromPath(params.key);
        const canvasName = getNameFromPath(params.name);

        let isOwner = peer.idKey.publicKey.equals(node);
        setIsOwner(isOwner);
        setIdArgs({ node });

        console.log(
            "open!?",
            peer.idKey.publicKey.equals(peer.identity.publicKey)
        );

        myCanvas.current = peer
            .open(new CanvasDB({ rootTrust: node, name: canvasName }), {
                sync: () => true,
            })
            .then(async (canvas) => {
                canvas.rects.events.addEventListener(
                    "change",
                    async (change) => {
                        setRects(
                            (
                                await Promise.all(
                                    [...canvas.rects.index.index.values()]
                                        .sort(
                                            (a, b) =>
                                                a.value.position.y -
                                                b.value.position.y
                                        )
                                        .map(async (x) => {
                                            if (isOwner) {
                                                if (!x.value.keypair) {
                                                    // try to find it in memory
                                                    const keypairs =
                                                        await getCanvasKeypairs();
                                                    for (const keypair of keypairs) {
                                                        if (
                                                            keypair.publicKey.equals(
                                                                x.value
                                                                    .publicKey
                                                            )
                                                        ) {
                                                            x.value.keypair =
                                                                keypair;
                                                            return x.value;
                                                        }
                                                    }
                                                    console.warn(
                                                        "Could not find keypair for rect"
                                                    );
                                                    return undefined; // We don't generate a new one, since its meaningless
                                                }
                                            } else {
                                                if (!x.value.keypair) {
                                                    const { key: keypair } =
                                                        await getCanvasKeypair();
                                                    /*  const keypair =
                                                         await Ed25519Keypair.create();
                                                     console.log(
                                                         "FREE KEYPAIR",
                                                         keypair.publicKey.hashcode()
                                                     ); */
                                                    x.value.keypair = keypair;
                                                }
                                            }
                                            return x.value;
                                        })
                                )
                            ).filter((x) => !!x)
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
                                    new DocumentQueryRequest({ queries: [] }),
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
        <>
            <Header ref={header}></Header>
            <Grid container direction="row">
                <Grid
                    item
                    sx={{
                        height: `calc(100vh - ${header.current?.scrollHeight})"`,
                        overflowY: "scroll",
                        width: "calc(100% - 275px)",
                    }}
                >
                    <Box sx={{ flexDirection: "column", p: 4 }}>
                        {rects.map((x, ix) => {
                            return (
                                <Grid
                                    item
                                    ref={(ref) => {
                                        ref?.querySelector<HTMLElement>(
                                            "#frame-" + ix
                                        )?.addEventListener(
                                            "mouseenter",
                                            () => {
                                                ref.querySelector<HTMLElement>(
                                                    "#header-" + ix
                                                ).style.opacity = "1";
                                            }
                                        );

                                        ref?.querySelector<HTMLElement>(
                                            "#frame-" + ix
                                        )?.addEventListener(
                                            "mouseleave",
                                            () => {
                                                ref.querySelector<HTMLElement>(
                                                    "#header-" + ix
                                                ).style.opacity = "0";
                                            }
                                        );
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
                                        {" "}
                                        <IconButton
                                            size="small"
                                            sx={{ ml: "auto" }}
                                            onClick={() => {
                                                console.log("delete!");
                                            }}
                                        >
                                            <Clear />
                                        </IconButton>
                                    </Grid>
                                    <Grid id={"frame-" + ix} item>
                                        <iframe
                                            onLoad={(event) =>
                                                onIframe(event, x)
                                            }
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
                                        CHAT_APP +
                                        "/" +
                                        getChatPath(idArgs.node);
                                } else {
                                    onIframe(event, {
                                        keypair: kp,
                                        src:
                                            CHAT_APP +
                                            "/" +
                                            getChatPath(idArgs.node),
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
        </>
    );
};
