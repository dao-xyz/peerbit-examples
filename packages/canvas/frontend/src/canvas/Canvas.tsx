import {
    useState,
    useEffect,
    useRef,
    useCallback,
    useReducer,
    RefObject,
} from "react";

import {
    getStreamPath,
    CHAT_APP,
    STREAMING_APP,
    getChatPath,
    getAdressFromKey,
} from "../routes.js";
import { usePeer, submitKeypairChange } from "@peerbit/react";
import { useParams } from "react-router-dom";
import {
    Canvas as CanvasDB,
    Rect,
    Layout,
    RectContent,
    IFrameContent,
} from "./db";
import { Ed25519Keypair, PublicSignKey } from "@peerbit/crypto";
import { Box, Grid, IconButton, useTheme } from "@mui/material";
import iFrameResize from "iframe-resizer";
import { Add, Clear } from "@mui/icons-material";
import { SearchRequest } from "@peerbit/document";
import { useNames } from "../names/useNames.js";
import { getCanvasKeypair, getCanvasKeypairs } from "../keys.js";
import { HEIGHT } from "../Header.js";
import "react-grid-layout-next/css/styles.css";
import "react-resizable/css/styles.css";
import {
    ResponsiveGridLayout as RGL,
    Layout as RGLayout,
    WidthProvider,
    calcGridColWidth,
    PositionParams,
    resolveRowHeight,
} from "react-grid-layout-next";
import { AddElement, ElementGenerator } from "./AddElement.js";
import useWidth from "./useWidth.js";
import { OpenWith } from "@mui/icons-material";
import "./Canvas.css";
const ReactGridLayout = /* WidthProvider */ RGL;

const cols = { md: 10, xxs: 10 };
const rowHeight = (w) => w / 100;
const margin: [number, number] = [0, 0];
const containerPadding: [number, number] = [0, 0];
const maxRows = Infinity;
const rectBorderWidth = 10;
const getLayouts = (rects: Rect[]) => {
    let breakpointsToLayouts: Record<string, RGLayout> = {};
    for (const [ix, rect] of rects.entries()) {
        for (const layout of rect.layout) {
            let arr = breakpointsToLayouts[layout.breakpoint];
            if (!arr) {
                arr = [];
                breakpointsToLayouts[layout.breakpoint] = arr;
            }
            arr.push({ ...layout, i: String(ix) });
        }
    }
    console.log("getLayouts", breakpointsToLayouts);
    return breakpointsToLayouts;
};

let updateRectsTimeout: ReturnType<typeof setTimeout> = undefined;

export const Canvas = () => {
    const { peer } = usePeer();
    const params = useParams();
    const myCanvas = useRef<Promise<CanvasDB>>(null);
    const [rects, setRects] = useState<Rect[]>([]);
    const rectsRef = useRef<Rect[]>(rects);

    const resizeSizes = useRef<Map<number, { width: number; height: number }>>(
        new Map()
    );
    const [layouts, setLayouts] = useState<Record<string, RGLayout>>({});
    const [idArgs, setIdArgs] = useState<{
        node: PublicSignKey;
    }>();
    const [isOwner, setIsOwner] = useState<boolean | undefined>(undefined);
    const chatKeypairRef = useRef<Ed25519Keypair>(null);
    const { name, setName } = useNames();
    const [focused, setFocused] = useState<number>();
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const theme = useTheme();
    const dragging = useRef(false);
    const latestBreakpoint = useRef<"xxs" | "md">("md"); // needs to be the highest breakpoint to work correctl with width resize into lower breakpoints where layout does not exist

    const { width: gridLayoutWidth, ref: gridLayoutRef } = useWidth(0); // we choose 0 so that the initial layout will be optimized for 0 width (xxs)

    const addRect = async (generator: ElementGenerator) => {
        const { key: keypair } = await getCanvasKeypair();
        await setName(name); // Reinitialize names, so that all keypairs get associated with the name
        const c = await myCanvas.current;
        console.log("new rect");
        let maxY = rectsRef.current
            .map((x) => x.layout)
            .flat()
            .filter((x) => x.breakpoint === latestBreakpoint.current)
            .reduce(
                (prev, current, ix) => Math.max(current.y + current.h, prev),
                -1
            );
        c.rects.put(
            new Rect({
                keypair,
                publicKey: keypair.publicKey,
                layout: [
                    new Layout({
                        breakpoint: latestBreakpoint.current,
                        x: 0,
                        y: maxY + 1,
                        z: 0,
                        w: 20,
                        h: 500,
                    }),
                ],
                content: generator({ keypair }),
            })
        );
    };

    const updateRects = (newRects: Rect[], timeout = 500) => {
        clearTimeout(updateRectsTimeout);
        updateRectsTimeout = setTimeout(() => {
            console.log("redraw rects");
            rectsRef.current = newRects;
            setRects(newRects);
            setLayouts(getLayouts(newRects));
        }, timeout);
    };

    useEffect(() => {
        const unfocusListener = () => {
            setFocused(undefined);
        };

        window.addEventListener("focus", unfocusListener);
        return () => {
            window.removeEventListener("focus", unfocusListener);
        };
    }, []);

    useEffect(() => {
        if (!peer?.libp2p || !params.key || myCanvas.current) {
            return;
        }

        const canvasAddress = getAdressFromKey(params.key);

        console.log(
            "open canvas address",
            canvasAddress.toString(),
            peer.services.blocks.publicKey.toString(),
            peer.identity.publicKey.toString()
        );
        setTimeout(() => {
            console.log(peer.services.blocks.peers.size);
        }, 5000);
        myCanvas.current = peer
            .open<CanvasDB>(canvasAddress, {
                args: {
                    sync: () => true,
                },
            })
            .then(async (canvas) => {
                console.log("OPEN!", canvas);
                const node = canvas.key;
                let isOwner = peer.identity.publicKey.equals(node);
                console.log("is owner?", isOwner);
                setIsOwner(isOwner);
                setIdArgs({ node });
                canvas.rects.events.addEventListener(
                    "change",
                    async (change) => {
                        console.log(
                            "SET RECT AFTER CHANGE!",
                            change.detail.added.map((x) => x.layout)
                        );
                        updateRects(
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
                            ).filter((x) => !!x),
                            0
                        );
                    }
                );

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
                                await canvas.rects.index.search(
                                    new SearchRequest({ query: [] }),
                                    { remote: { sync: true } }
                                )
                            ).length
                        );
                    }, 2000);
                }
                return canvas;
            });
    }, [peer?.identity.publicKey.hashcode()]);

    const onIframe = useCallback(
        (
            node,
            rect: { keypair: Ed25519Keypair; content: IFrameContent },
            i?: number
        ) => {
            console.log(
                "on load frame!",
                rect.content.src,
                rect.content.resizer
            );
            if (rect.content.resizer) {
                const resize = iFrameResize.iframeResize(
                    {
                        heightCalculationMethod: "taggedElement",
                        tolerance: 5,
                        log: false,
                        onResized: (e: { width: number; height: number }) => {
                            if (i != null) {
                                let rzw = Number(e.width);
                                let rzh = Number(e.height);
                                console.log("RESIZE EVENT", rzw, rzh);
                                resizeSizes.current.set(i, {
                                    height: rzh,
                                    width: rzw,
                                });
                            }
                            if (!dragging.current) {
                                //    console.log('resizeevent', e)
                                let rzw = Number(e.width);
                                let rzh = Number(e.height);
                                if (i != null) {
                                    let change = false;
                                    rectsRef.current[i].layout?.forEach(
                                        (l, lx) => {
                                            let c = cols[l.breakpoint];

                                            const positionParams = {
                                                cols: c,
                                                containerPadding,
                                                containerWidth: gridLayoutWidth,
                                                margin,
                                                maxRows,
                                                rowHeight,
                                            };
                                            const { /*  w, */ h } = calcWH(
                                                positionParams,
                                                rzw,
                                                rzh + rectBorderWidth * 2,
                                                l.x,
                                                l.y
                                            );
                                            console.log(
                                                "new w,h",
                                                h,
                                                lx,
                                                rzh + rectBorderWidth * 2
                                            );
                                            if (/* w !== l.w || */ h !== l.h) {
                                                // l.w = w;

                                                l.h = h;
                                                change = true;
                                            }
                                        }
                                    );
                                    if (change) {
                                        console.log(
                                            "SET RECTS RESIZE DIFF",
                                            i,
                                            rectsRef.current
                                        );
                                        updateRects(rectsRef.current);
                                        forceUpdate();
                                    }
                                }
                            }
                        },
                    },
                    node.target
                );
                setInterval(() => {
                    resize[0]?.["iFrameResizer"]?.resize();
                }, 1000); // resize a few times in the beginning, height calculations seems to initialize incorrectly
            }

            submitKeypairChange(node.target, rect.keypair, rect.content.src);
        },
        [rects]
    );
    return (
        <Grid
            container
            direction="row"
            sx={{ width: "100%" }}
            onClick={() => {
                setFocused(undefined);
            }}
        >
            <Grid
                ref={gridLayoutRef}
                item
                sx={{
                    overflowY: "scroll",
                    height: `calc(100vh - ${HEIGHT})`,
                    width: "100%", //`calc(100% - 275px)`,
                }}
            >
                <ReactGridLayout
                    width={gridLayoutWidth}
                    className="layout"
                    cols={cols}
                    rowHeight={rowHeight}
                    margin={margin}
                    containerPadding={containerPadding}
                    allowOverlap
                    breakpoints={{ md: 768, xxs: 0 }}
                    onResizeStart={(e) => {
                        console.log("FOCUSING", e.layout);
                        setFocused(Number(e.item.i));
                        dragging.current = true;
                    }}
                    onResizeStop={() => {
                        dragging.current = false;
                    }}
                    onDragStart={(e) => {
                        setFocused(Number(e.item.i));
                        dragging.current = true;
                    }}
                    onDragStop={() => {
                        dragging.current = false;
                    }}
                    layouts={layouts}
                    useCSSTransforms={true}
                    onBreakpointChange={(b, c) => {
                        clearTimeout(updateRectsTimeout);
                    }}
                    resizeHandles={["s", "w", "e", "n", "sw", "nw", "se", "ne"]}
                    draggableHandle=".drag-handle-element"
                    draggableCancel=".canvas-react-resizable-handle" // We need to cancel drag events, when we drag the resize handle, passing the class solves this
                    resizeHandle={(axis, ref) => (
                        <div
                            ref={ref as RefObject<HTMLDivElement>}
                            className={` canvas-react-resizable-handle canvas-react-resizable-handle-${axis}`}
                        ></div>
                    )}
                    onLayoutChange={({ breakpoint, layout: layouts }) => {
                        console.log(
                            "layout change",
                            breakpoint,
                            layouts.map((x) => x.x)
                        );
                        let toUpdate = new Map<string, Rect>();
                        let change = false;
                        latestBreakpoint.current = breakpoint as "xxs" | "md";
                        //    console.log('layout change!')
                        for (const [i, l] of layouts.entries()) {
                            // Shrink to fit content (TODO optioanly)
                            console.log("shinkt!?", i, resizeSizes);
                            let rz = resizeSizes.current.get(i);
                            if (rz) {
                                let c = cols[breakpoint];
                                const positionParams = {
                                    cols: c,
                                    containerPadding,
                                    containerWidth: gridLayoutWidth,
                                    margin,
                                    maxRows,
                                    rowHeight,
                                };
                                const { w, h } = calcWH(
                                    positionParams,
                                    rz.width,
                                    rz.height + rectBorderWidth * 2,
                                    l.x,
                                    l.y
                                );
                                console.log(
                                    "new w,h",
                                    w,
                                    h,
                                    "FROM HEGIHT: " +
                                        (rz.height + rectBorderWidth * 2)
                                );
                                if (/* w !== l.w || */ h !== l.h) {
                                    // l.w = w;

                                    l.h = h;
                                    change = true;
                                }
                            }
                        }
                        /* 
                                                if (change) {
                                                    console.log('update!')
                                                    updateRects(rects)
                                                    forceUpdate()
                                                    // return;
                                                }
                         */

                        for (const [i, layout] of layouts.entries()) {
                            const rect =
                                toUpdate.get(layout.i) ||
                                rects[Number(layout.i)];
                            let layoutIndex = rect.layout.findIndex(
                                (l) => l.breakpoint === breakpoint
                            );
                            let newLayout = new Layout({
                                breakpoint,
                                z: 0,
                                ...layout,
                            });
                            if (layoutIndex === -1) {
                                rect.layout.push(newLayout);
                            } else {
                                rect.layout[layoutIndex] = newLayout;
                            }
                            toUpdate.set(layout.i, rect);
                        }

                        Promise.all(
                            [...toUpdate.values()].map((rect) =>
                                myCanvas.current.then((c) => c.rects.put(rect))
                            )
                        )
                            .then(() => {
                                // console.log('layout change saved', breakpoint, layouts);
                            })
                            .catch((e) => {
                                console.error("Failed to update layout", e);
                            });
                    }}
                >
                    {rects.map((x, ix) => {
                        return (
                            <Grid
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
                                onClick={(e) => {
                                    console.log("set focued", ix);
                                    setFocused(ix);
                                    e.stopPropagation();
                                }}
                                container
                                direction="column"
                                key={ix}
                                className={
                                    "drag-handle-element " +
                                    (ix !== focused
                                        ? "react-resizable-hide"
                                        : "")
                                }
                                sx={{
                                    cursor: "pointer",
                                    position: "relative",
                                    width: "100%",
                                    maxWidth: "100%",
                                    /*      boxSizing: 'border-box', */
                                    border:
                                        `${rectBorderWidth}px ` +
                                        (focused === ix
                                            ? `${theme.palette.action.disabled} solid`
                                            : `${theme.palette.divider} solid`),
                                }}
                            >
                                {focused === ix && (
                                    <Grid
                                        id={"header-" + ix}
                                        item
                                        container
                                        alignItems="right"
                                        width="100%"
                                        display="flex"
                                        justifyContent="right"
                                        position="absolute"
                                        sx={{ top: "0px", opacity: 1 }}
                                    >
                                        <Grid item>
                                            <IconButton
                                                size="small"
                                                onClick={() => {
                                                    myCanvas.current.then(
                                                        (canvas) => {
                                                            canvas.rects.del(
                                                                x.id
                                                            );
                                                        }
                                                    );
                                                }}
                                            >
                                                <Clear />
                                            </IconButton>
                                        </Grid>
                                        <Grid item>
                                            <IconButton
                                                size="small"
                                                className="drag-handle-element"
                                            >
                                                <OpenWith />
                                            </IconButton>
                                        </Grid>
                                    </Grid>
                                )}
                                <Grid
                                    id={"frame-" + ix}
                                    sx={{ width: "100%", height: "100%" }}
                                    item
                                >
                                    {x.content instanceof IFrameContent ? (
                                        <iframe
                                            onLoad={(event) =>
                                                onIframe(event, x, ix)
                                            }
                                            onBlur={() => {
                                                console.log(
                                                    "blured iframe",
                                                    ix
                                                );
                                            }}
                                            style={{
                                                width: "100%",
                                                height: "100%",
                                                border: 0,
                                            }}
                                            src={x.content.src}
                                            allow="camera; microphone; allowtransparency; display-capture; fullscreen; autoplay; clipboard-write;"
                                        ></iframe>
                                    ) : (
                                        <>UNSUPPORTED</>
                                    )}
                                </Grid>
                            </Grid>
                        );
                    })}
                </ReactGridLayout>

                {isOwner && (
                    /*  <IconButton size="large" onClick={addRect}>
                         <Add />
                     </IconButton> */
                    <AddElement onContent={addRect} />
                )}
            </Grid>
            {/*  <Grid
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
                                    content: new IFrameContent({ src: CHAT_APP + getChatPath(idArgs.node), resizer: true }),
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
            </Grid> */}
        </Grid>
    );
};

export function calcWH(
    positionParams: PositionParams,
    width: number,
    height: number,
    x: number,
    y: number
): { w: number; h: number } {
    const { margin, maxRows, cols, rowHeight } = positionParams;
    const colWidth = calcGridColWidth(positionParams);
    const rowHeightNumber = resolveRowHeight(rowHeight, colWidth);

    // width = colWidth * w - (margin * (w - 1))
    // ...
    // w = (width + margin) / (colWidth + margin)
    let w = Math.ceil((width + margin[0]) / (colWidth + margin[0]));
    let h = Math.ceil((height + margin[1]) / (rowHeightNumber + margin[1]));

    // Capping
    w = clamp(w, 0, cols - x);
    h = clamp(h, 0, maxRows - y);
    console.log(h, rowHeightNumber, colWidth, maxRows, height);
    return { w, h };
}

// Similar to _.clamp
export function clamp(
    num: number,
    lowerBound: number,
    upperBound: number
): number {
    return Math.max(Math.min(num, upperBound), lowerBound);
}
