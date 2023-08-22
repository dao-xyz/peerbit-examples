import {
    useState,
    useEffect,
    useRef,
    useCallback,
    useReducer,
    RefObject,
} from "react";

import { TEXT_APP } from "../routes.js";
import { usePeer } from "@peerbit/react";
import {
    Room as RoomDB,
    Element,
    Layout,
    IFrameContent,
    ElementContent,
} from "@dao-xyz/social";
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
import useWidth from "./useWidth.js";
import { equals } from "uint8arrays";
import "./Canvas.css";
import { Frame } from "./Frame.js";

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
    return breakpointsToLayouts;
};

let updateRectsTimeout: ReturnType<typeof setTimeout> = undefined;

export const Room = (properties: { room: RoomDB; editMode: boolean }) => {
    const { peer } = usePeer();
    const myCanvas = useRef<Promise<RoomDB>>(null);
    const [rects, setRects] = useState<Element[]>([]);

    const pendingRef = useRef<Element[]>([]);

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
    const addRect = async (
        content: ElementContent,
        pending = false /* generator: ElementGenerator */
    ) => {
        // await setName(name); // Reinitialize names, so that all keypairs get associated with the name

        console.log("CANVAS REF?", myCanvas.current);

        const c = await myCanvas.current;

        let maxY = rectsRef.current
            .map((x) => x.location)
            .flat()
            .filter((x) => x.breakpoint === latestBreakpoint.current)
            .reduce(
                (prev, current, ix) => Math.max(current.y + current.h, prev),
                -1
            );
        let element = new Element({
            publicKey: peer.identity.publicKey,
            location: [
                new Layout({
                    breakpoint: latestBreakpoint.current,
                    x: 0,
                    y: maxY != null ? maxY + 1 : 0,
                    z: 0,
                    w: 20,
                    h: 500,
                }),
            ],
            content, //generator({ keypair: peer.identity }),
        });
        if (pending) {
            if (
                pendingRef.current &&
                pendingRef.current.find((x) => equals(x.id, element.id))
            ) {
                throw new Error("Already have an pending element");
            }
            if (pendingRef.current.length > 0) {
                throw new Error("Unpexted dangling rect");
            }
            pendingRef.current.push(element);
        } else {
            c.elements.put(element);
        }
    };

    const savePending = async () => {
        if (!pendingRef.current) {
            throw new Error("Missing pending element");
        }
        const c = await myCanvas.current;

        await pendingRef.current.map((x) => c.elements.put(x));
        pendingRef.current = undefined;
        return pendingRef.current;
    };

    const updateRects = async (newRects?: Element[], timeout = 500) => {
        if (!newRects) {
            newRects = (
                await Promise.all(
                    [...properties.room.elements.index.index.values()].map(
                        async (x) => {
                            let doc =
                                await properties.room.elements.index.getDocument(
                                    x
                                );
                            return doc;
                        }
                    )
                )
            ).filter((x) => !!x);
            if (pendingRef.current) {
                for (const pending of pendingRef.current) {
                    if (!newRects.find((x) => equals(x.id, pending.id))) {
                        console.log(
                            "COULD NOT FIND ",
                            pending.id,
                            "FROM",
                            newRects
                        );
                        newRects.push(pending);
                    }
                }
            }
        }
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

    const reset = () => {
        pendingRef.current = [];
        setRects([]);
        rectsRef.current = [];
        resizeSizes.current = new Map();
    };
    useEffect(() => {
        if (!peer || !properties.room /* || myCanvas.current */) {
            return;
        }
        reset();

        myCanvas.current = peer
            .open<RoomDB>(properties.room, {
                args: {
                    sync: () => true,
                },
                existing: "reuse",
            })
            .then(async (room) => {
                console.log("OPEN!", room);
                const node = room.key;

                let isOwner = peer.identity.publicKey.equals(node);

                setIsOwner(isOwner);
                room.elements.events.addEventListener(
                    "change",
                    async (change) => {
                        console.log(
                            "SET RECT AFTER CHANGE!",
                            change.detail.added.map((x) => x.location)
                        );
                        updateRects(undefined, 0);
                    }
                );

                if (room.elements.index.size > 0) {
                    return room;
                }

                if (isOwner) {
                    //addRect();
                    /*     const { key: keypair2 } = await getFreeKeypair('canvas')
                    canvas.elements.put(new Rect({ keypair: keypair2, position: new Position({ x: 0, y: 0, z: 0 }), size: new Size({ height: 100, width: 100 }), src: STREAMING_APP + "/" + getStreamPath(keypair2.publicKey) })) */
                } else {
                    setInterval(async () => {
                        console.log(
                            (
                                await room.elements.index.search(
                                    new SearchRequest({ query: [] }),
                                    { remote: { sync: true } }
                                )
                            ).length
                        );
                    }, 2000);
                }
                return room;
            });

        myCanvas.current.then(() => {
            console.log("ADD RECT", TEXT_APP);
            if (pendingRef.current.length === 0) {
                addRect(
                    new IFrameContent({ src: TEXT_APP, resizer: false }),
                    true
                ).then(() => {
                    updateRects();
                });
            }
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
            className="flex flex-row w-full p-2"
            onClick={() => {
                setFocused(undefined);
            }}
        >
            <div
                ref={gridLayoutRef}
                className="w-full h-screen"
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
                    isResizable={properties.editMode}
                    resizeHandles={["s", "w", "e", "n", "sw", "nw", "se", "ne"]}
                    draggableHandle=".drag-handle-element"
                    draggableCancel=".canvas-react-resizable-handle" // We need to cancel drag events, when we drag the resize handle, passing the class solves this
                    resizeHandle={(axis, ref) => (
                        <div
                            ref={ref as RefObject<HTMLDivElement>}
                            className={`canvas-react-resizable-handle canvas-react-resizable-handle-${axis}`}
                        ></div>
                    )}
                    onLayoutChange={({ breakpoint, layout: layouts }) => {
                        let toUpdate = new Map<string, Element>();
                        let change = false;
                        latestBreakpoint.current = breakpoint as "xxs" | "md";
                        //    console.log('layout change!')
                        for (const [i, l] of layouts.entries()) {
                            // Shrink to fit content (TODO optioanly)
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
                            console.log("LAYOUT CHANGE", layout);

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
                            <div key={ix}>
                                <Frame
                                    delete={() =>
                                        myCanvas.current.then((canvas) => {
                                            canvas.elements.del(x.id);
                                        })
                                    }
                                    editMode={properties.editMode}
                                    element={x}
                                    index={ix}
                                    replace={(url) => {
                                        myCanvas.current.then(
                                            async (canvas) => {
                                                let pendingElement =
                                                    pendingRef.current.find(
                                                        (pending) =>
                                                            equals(
                                                                pending.id,
                                                                x.id
                                                            )
                                                    );
                                                let fromPending =
                                                    !!pendingElement;
                                                let element =
                                                    pendingElement ||
                                                    (await canvas.elements.index.get(
                                                        x.id
                                                    ));
                                                (
                                                    element.content as IFrameContent
                                                ).src = url;
                                                console.log(
                                                    "UPDATED ELEMENT",
                                                    element
                                                );
                                                if (!fromPending) {
                                                    await canvas.elements.put(
                                                        element
                                                    );
                                                } else {
                                                    forceUpdate(); // because pendingrefs is a ref so we need to do change detection manually
                                                }
                                            }
                                        );
                                    }}
                                    onLoad={(event) => onIframe(event, x, ix)}
                                    pending={
                                        !!pendingRef.current.find((p) =>
                                            equals(p.id, x.id)
                                        )
                                    }
                                ></Frame>
                            </div>
                        );
                    })}
                </ReactGridLayout>

                {/*  {isOwner && (
        
                    <AddElement onContent={addRect} />
                )} */}
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
