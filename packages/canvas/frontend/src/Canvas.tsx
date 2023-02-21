import { useState, useEffect, useRef, useCallback } from "react";
import createCache from "@emotion/cache";
import styled from "@emotion/styled";
import ReactDOM from "react-dom";
import { getStreamPath, getPathFromKey, getKeyFromPath } from "./routes.js";
import { CacheProvider } from "@emotion/react";
import {
    usePeer,
    submitKeypairChange,
    getFreeKeypair,
    getAllKeyPairs,
    getTabId,
} from "@dao-xyz/peerbit-react";
import { useParams } from "react-router-dom";
import { MyCanvas, Position, Rect, Size } from "./dbs/canvas";
import {
    toBase64,
    Ed25519Keypair,
    PublicSignKey,
} from "@dao-xyz/peerbit-crypto";
import { Box, Button, Grid, IconButton } from "@mui/material";
import iFrameResize from "iframe-resizer";
import { logger } from "@dao-xyz/peerbit";
import { Add } from "@mui/icons-material";
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

//"http://localhost:5801/"
const STREAMING_APP = ["development", "staging"].includes(import.meta.env.MODE)
    ? "https://stream.test.xyz:5801/#"
    : "https://stream.dao.xyz/#"; /*  "https://iframe.test.xyz:5801" */ // "https://stream.test.xyz:5801"; //   "https://stream.peerchecker.com" //
const keypairs = new Map<string, Ed25519Keypair>();
export const Canvas = () => {
    const { peer } = usePeer();
    const params = useParams();
    const myCanvas = useRef<Promise<MyCanvas>>(null);
    const [rects, setRects] = useState<Rect[]>([]);

    const [idArgs, setIdArgs] = useState<{
        node: PublicSignKey;
    }>();
    const [isOwner, setIsOwner] = useState<boolean | undefined>(undefined);

    useEffect(() => {}, [peer?.id, params?.node]);

    const addRect = async () => {
        const { key: keypair } = await getFreeKeypair("canvas");
        (await myCanvas.current).rects.put(
            new Rect({
                keypair,
                publicKey: keypair.publicKey,
                position: new Position({ x: 0, y: 0, z: 0 }),
                size: new Size({ height: 100, width: 100 }),
                src: STREAMING_APP + "/" + getStreamPath(keypair.publicKey),
            })
        );
    };

    useEffect(() => {
        if (!peer?.libp2p || !params.key || myCanvas.current) {
            return;
        }

        console.log(
            peer.identity.publicKey.hashcode(),
            peer.idKey.publicKey.hashcode(),
            peer.id.toString()
        );
        const node = getKeyFromPath(params.key);
        let isOwner = peer.idKey.publicKey.equals(node);
        setIsOwner(isOwner);
        setIdArgs({ node });

        console.log(
            "open!?",
            peer.idKey.publicKey.equals(peer.identity.publicKey)
        );

        myCanvas.current = peer
            .open(new MyCanvas({ rootTrust: node }), { sync: () => true })
            .then(async (canvas) => {
                canvas.rects.events.addEventListener(
                    "change",
                    async (change) => {
                        setRects(
                            (
                                await Promise.all(
                                    [...canvas.rects.index.index.values()].map(
                                        async (x) => {
                                            if (isOwner) {
                                                if (!x.value.keypair) {
                                                    // try to find it in memory
                                                    const keypairs =
                                                        await getAllKeyPairs(
                                                            "canvas"
                                                        );
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
                                                        await getFreeKeypair(
                                                            "canvas"
                                                        );
                                                    x.value.keypair = keypair;
                                                }
                                            }
                                            return x.value;
                                        }
                                    )
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
                    addRect();
                    /*     const { key: keypair2 } = await getFreeKeypair('canvas')
                    canvas.rects.put(new Rect({ keypair: keypair2, position: new Position({ x: 0, y: 0, z: 0 }), size: new Size({ height: 100, width: 100 }), src: STREAMING_APP + "/" + getStreamPath(keypair2.publicKey) })) */
                }
                return canvas;
                /*  else {
                 setInterval(async () => {
                     const results = await canvas.rects.index.query(new DocumentQueryRequest({ queries: [] }), { remote: { sync: true, amount: 2 } })
                     console.log(results)
                 }, 2000)
             } */
            });
    }, [peer?.id.toString()]);

    const onIframe = useCallback((node, rect: Rect) => {
        const resize = iFrameResize.iframeResize(
            { /* heightCalculationMethod: 'bodyOffset', */ log: false },
            node.target
        );
        let interval = setInterval(() => {
            resize[0]["iFrameResizer"].resize();
        }, 1000); // resize a few times in the beginning, height calculations seems to initialize incorrectly
        submitKeypairChange(node.target, rect.keypair, rect.src);
    }, []);

    return (
        <Box sx={{ flexDirection: "column", p: 4 }}>
            {rects.map((x, ix) => {
                console.log(x.src);
                return (
                    <Grid item key={ix} sx={{ maxWidth: "500px" }}>
                        <iframe
                            onLoad={(event) => onIframe(event, x)}
                            style={{ width: "100%", height: "100%", border: 0 }}
                            src={x.src}
                            allow="camera; microphone; display-capture; autoplay; clipboard-write;"
                        ></iframe>
                        {/*  <Box sx={{ backgroundColor: 'red', width: '100%', height: '100%' }}> RED</Box> */}
                    </Grid>
                );
            })}
            {isOwner && (
                <IconButton size="large" onClick={addRect}>
                    <Add />
                </IconButton>
            )}
        </Box>
    );
};
