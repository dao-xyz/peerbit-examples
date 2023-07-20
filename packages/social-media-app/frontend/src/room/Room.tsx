import {
    useState,
    useEffect,
    useRef,
    useCallback,
    useReducer,
    RefObject,
} from "react";

import { getAdressFromKey } from "../routes.js";
import { usePeer } from "@peerbit/react";
import { useLocation, useParams } from "react-router-dom";
import {
    Room as RoomDB,
    Element,
    Layout,
    IFrameContent,
} from "@dao-xyz/social";
import { Ed25519Keypair, PublicSignKey } from "@peerbit/crypto";
import iFrameResize from "iframe-resizer";
import { SearchRequest } from "@peerbit/document";
import { useNames } from "../names/useNames.js";
import "react-grid-layout-next/css/styles.css";
import "react-resizable/css/styles.css";
import {
    ResponsiveGridLayout as RGL,
    Layout as RGLayout,
    calcGridColWidth,
    PositionParams,
    resolveRowHeight,
} from "react-grid-layout-next";
import { AddElement, ElementGenerator } from "./AddElement.js";
import useWidth from "./useWidth.js";
import { MdAdd, MdClear, MdOpenWith } from "react-icons/md";
import "./Canvas.css";
import { useRooms } from "../useRooms.js";
const ReactGridLayout = /* WidthProvider */ RGL;

const cols = { md: 10, xxs: 10 };
const rowHeight = (w) => w / 100;
const margin: [number, number] = [0, 0];
const containerPadding: [number, number] = [0, 0];
const maxRows = Infinity;
const rectBorderWidth = 10;
const getLayouts = (rects: Element[]) => {
    let breakpointsToLayouts: Record<string, RGLayout> = {};
    for (const [ix, rect] of rects.entries()) {
        for (const layout of rect.location) {
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

export const Room = (properties: { room: RoomDB }) => {
    const { peer } = usePeer();
    const myCanvas = useRef<Promise<RoomDB>>(null);
    const [rects, setRects] = useState<Element[]>([]);
    const rectsRef = useRef<Element[]>(rects);

    const resizeSizes = useRef<Map<number, { width: number; height: number }>>(
        new Map()
    );
    const [layouts, setLayouts] = useState<Record<string, RGLayout>>({});
    const [isOwner, setIsOwner] = useState<boolean | undefined>(undefined);
    const { name, setName } = useNames();
    const [focused, setFocused] = useState<number>();
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const dragging = useRef(false);
    const latestBreakpoint = useRef<"xxs" | "md">("md"); // needs to be the highest breakpoint to work correctl with width resize into lower breakpoints where layout does not exist

    const { width: gridLayoutWidth, ref: gridLayoutRef } = useWidth(0); // we choose 0 so that the initial layout will be optimized for 0 width (xxs)

    const addRect = async (generator: ElementGenerator) => {
        await setName(name); // Reinitialize names, so that all keypairs get associated with the name
        const c = await myCanvas.current;
        let maxY = rectsRef.current
            .map((x) => x.location)
            .flat()
            .filter((x) => x.breakpoint === latestBreakpoint.current)
            .reduce(
                (prev, current, ix) => Math.max(current.y + current.h, prev),
                -1
            );
        c.elements.put(
            new Element({
                publicKey: peer.identity.publicKey,
                location: [
                    new Layout({
                        breakpoint: latestBreakpoint.current,
                        x: 0,
                        y: maxY + 1,
                        z: 0,
                        w: 20,
                        h: 500,
                    }),
                ],
                content: generator({ keypair: peer.identity }),
            })
        );
    };

    const updateRects = (newRects: Element[], timeout = 500) => {
        clearTimeout(updateRectsTimeout);
        updateRectsTimeout = setTimeout(() => {
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
        if (!peer || !properties.room || myCanvas.current) {
            return;
        }
        myCanvas.current = peer
            .open<RoomDB>(properties.room, {
                args: {
                    sync: () => true,
                },
                existing: "reuse",
            })
            .then(async (canvas) => {
                console.log("OPEN!", canvas);
                const node = canvas.key;
                let isOwner = peer.identity.publicKey.equals(node);
                console.log("is owner?", isOwner);
                setIsOwner(isOwner);
                canvas.elements.events.addEventListener(
                    "change",
                    async (change) => {
                        console.log(
                            "SET RECT AFTER CHANGE!",
                            change.detail.added.map((x) => x.location)
                        );
                        updateRects(
                            (
                                await Promise.all(
                                    [
                                        ...canvas.elements.index.index.values(),
                                    ].map(async (x) => {
                                        let doc =
                                            await canvas.elements.index.getDocument(
                                                x
                                            );
                                        if (isOwner) {
                                            /*  if (!doc.keypair) {
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
                                                 } */
                                        } else {
                                            /*  console.log(
                                                     "reset keypair for rect!"
                                                 );
                                                 if (!doc.keypair) {
                                                     const { key: keypair } =
                                                         await getCanvasKeypair();
                                                   
                                                     doc.keypair = keypair;
                                                 } */
                                        }
                                        return doc;
                                    })
                                )
                            ).filter((x) => !!x),
                            0
                        );
                    }
                );

                if (canvas.elements.index.size > 0) {
                    return canvas;
                }

                if (isOwner) {
                    //addRect();
                    /*     const { key: keypair2 } = await getFreeKeypair('canvas')
                    canvas.elements.put(new Rect({ keypair: keypair2, position: new Position({ x: 0, y: 0, z: 0 }), size: new Size({ height: 100, width: 100 }), src: STREAMING_APP + "/" + getStreamPath(keypair2.publicKey) })) */
                } else {
                    setInterval(async () => {
                        console.log(
                            (
                                await canvas.elements.index.search(
                                    new SearchRequest({ query: [] }),
                                    { remote: { sync: true } }
                                )
                            ).length
                        );
                    }, 2000);
                }
                return canvas;
            });
    }, [peer?.identity.publicKey.hashcode(), properties?.room?.address]);

    const onIframe = useCallback(
        (node, rect: { content: IFrameContent }, i?: number) => {
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
                                    rectsRef.current[i].location?.forEach(
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

            //submitKeypairChange(node.target, rect.keypair, rect.content.src);
        },
        [rects]
    );
    return (
        <div
            className="flex flex-row w-full"
            onClick={() => {
                setFocused(undefined);
            }}
        >
            <div
                ref={gridLayoutRef}
                /*  item
         sx={{
             overflowY: "scroll",
             height: `calc(100vh - ${HEIGHT})`,
             width: "100%", //`calc(100% - 275px)`,
         }} */
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
                        let toUpdate = new Map<string, Element>();
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
                            let layoutIndex = rect.location.findIndex(
                                (l) => l.breakpoint === breakpoint
                            );
                            let newLayout = new Layout({
                                breakpoint,
                                z: 0,
                                ...layout,
                            });
                            if (layoutIndex === -1) {
                                rect.location.push(newLayout);
                            } else {
                                rect.location[layoutIndex] = newLayout;
                            }
                            toUpdate.set(layout.i, rect);
                        }

                        Promise.all(
                            [...toUpdate.values()].map((rect) =>
                                myCanvas.current.then((c) =>
                                    c.elements.put(rect)
                                )
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
                            <div
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
                                key={ix}
                                className={
                                    "flex flex-col cursor-pointer relative w-full wm-full drag-handle-element " +
                                    (ix !== focused
                                        ? "react-resizable-hide"
                                        : "")
                                }
                                /*   sx={{
                              cursor: "pointer",
                              position: "relative",
                              width: "100%",
                              maxWidth: "100%",
                              border:
                                  `${rectBorderWidth}px ` +
                                  (focused === ix
                                      ? `${theme.palette.action.disabled} solid`
                                      : `${theme.palette.divider} solid`),
                          }} */
                            >
                                {focused === ix && (
                                    <div
                                        id={"header-" + ix}
                                        className="flex w-full justify-end absolute top-0 opacity-100"
                                        /*  item
                                 container
                                 alignItems="right"
                                 width="100%"
                                 display="flex"
                                 justifyContent="right"
                                 position="absolute"
                                 sx={{ top: "0px", opacity: 1 }} */
                                    >
                                        <div>
                                            <button
                                                onClick={() => {
                                                    myCanvas.current.then(
                                                        (canvas) => {
                                                            canvas.elements.del(
                                                                x.id
                                                            );
                                                        }
                                                    );
                                                }}
                                            >
                                                <MdClear className="h-4 w-4" />
                                            </button>
                                        </div>
                                        <div>
                                            <button className="drag-handle-element">
                                                <MdOpenWith className="h-4 w-4" />
                                            </button>
                                        </div>
                                    </div>
                                )}
                                <div
                                    id={"frame-" + ix}
                                    className="w-full h-full"
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
                                </div>
                            </div>
                        );
                    })}
                </ReactGridLayout>

                {isOwner && (
                    /*  <IconButton size="large" onClick={addRect}>
                         <Add />
                     </IconButton> */
                    <AddElement onContent={addRect} />
                )}
            </div>
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
        </div>
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
