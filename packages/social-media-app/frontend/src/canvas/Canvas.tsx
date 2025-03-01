import {
    useState,
    useEffect,
    useRef,
    useCallback,
    useReducer,
    RefObject,
    forwardRef,
} from "react";

import { inIframe, useLocal, usePeer } from "@peerbit/react";
import {
    Canvas as CanvasDB,
    Element,
    Layout,
    IFrameContent,
    ElementContent,
    StaticContent,
    StaticMarkdownText,
} from "@dao-xyz/social";
import iFrameResizer from "@iframe-resizer/parent";
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
import { concat, equals } from "uint8arrays";
import "./Canvas.css";
import { Frame } from "./Frame.js";
import { Create } from "./Create.js";
import { delay } from "@peerbit/time";
import { sha256Sync } from "@peerbit/crypto";

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

export const Canvas = (properties: { canvas: CanvasDB; draft?: boolean }) => {
    const { peer } = usePeer();
    const [editMode, setEditMode] = useState(false);
    /*     const pendingRef = useRef<Element[]>([]); */

    /*     const rectsRef = useRef<Element[]>(rects); */
    const resizeSizes = useRef<Map<number, { width: number; height: number }>>(
        new Map()
    );

    const [layouts, setLayouts] = useState<Record<string, RGLayout>>({});

    const rects = useLocal(properties?.canvas.elements, {
        onChanges(all) {
            setLayouts(getLayouts(all));
        },
    });

    const [pendingRects, setPendingRects] = useState<Element[]>([]);

    const [isOwner, setIsOwner] = useState<boolean | undefined>(undefined);
    const { name, setName } = useNames();
    const [focused, setFocused] = useState<number>();
    const [active, setActive] = useState<Set<number>>(new Set());

    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const dragging = useRef(false);
    const latestBreakpoint = useRef<"xxs" | "md">("md"); // needs to be the highest breakpoint to work correctl with width resize into lower breakpoints where layout does not exist

    /* useEffect(() => {

    let mult = properties.editMode ? 1 : -1
    for (const rect of rects) {
        for (const l of rect.location) {
            console.log("???", l.x, l.y)
            l.y = l.y + 5 * mult;
            l.h = l.h - 10 * mult;
            l.x = l.x + 5 * mult;
            l.w = l.w - 10 * mult;
        }
    }
    updateRects(rects, 0)
    forceUpdate()
}, [properties.editMode]) */

    /* useEffect(() => {
        clearTimeout(updateRectsTimeout);
        updateRectsTimeout = setTimeout(() => {
            console.log("UPDATE LAYOUTS", rects,)
            setLayouts(getLayouts(rects));

        }, 500);
    }, rects) */

    const { width: gridLayoutWidth, ref: gridLayoutRef } = useWidth(0); // we choose 0 so that the initial layout will be optimized for 0 width (xxs)
    const addRect = async (
        content: ElementContent,
        options: {
            id?: Uint8Array;
            pending: boolean;
        } = { pending: false }
    ) => {
        // await setName(name); // Reinitialize names, so that all keypairs get associated with the name

        let maxY = rects /* rectsRef.current */
            .map((x) => x.location)
            .flat()
            .filter((x) => x.breakpoint === latestBreakpoint.current)
            .reduce(
                (prev, current, ix) => Math.max(current.y + current.h, prev),
                -1
            );
        /*    console.log(
               "CALCUCATE MAX Y",
               maxY,
               rects /// rectsRef.current.length
           ); */
        let element = new Element({
            publicKey: peer.identity.publicKey,
            id: options.id,
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

        if (options.pending) {
            if (
                /*  pendingRef.current &&
                 pendingRef.current.find((x) => equals(x.id, element.id)) */

                pendingRects &&
                pendingRects.find((x) => equals(x.id, element.id))
            ) {
                // throw new Error("Already have an pending element");
                return;
            }
            /*  if (pendingRef.current.length > 0) {
                throw new Error("Unpexted dangling rect");
            } */
            pendingRects.push(element);
            // console.log("PUSH PENDING", pendingRef.current.length);
        } else {
            properties.canvas.elements.put(element);
        }
    };

    const savePending = async () => {
        /*  if (!pendingRef.current) {
             throw new Error("Missing pending element");
         }
 
         await Promise.all(
             pendingRef.current.map((x) => properties.canvas.elements.put(x))
         );
         forceUpdate();
         pendingRef.current = [];
         return pendingRef.current; */

        if (!pendingRects) {
            throw new Error("Missing pending element");
        }

        await Promise.all(
            pendingRects.map((x) => properties.canvas.elements.put(x))
        );
        forceUpdate();
        setPendingRects([]);
        return pendingRects;
    };

    const updateRects = async (newRects?: Element[], timeout = 500) => {
        if (true) {
            return;
        }

        if (!newRects) {
            if (!properties.canvas.elements.index.index) {
                console.error(properties.canvas.elements.index.closed);
                throw new Error(
                    "Room is not open, because index does not exit"
                );
            }
            await delay(3000);
            newRects = (
                await properties.canvas.elements.index.search(
                    new SearchRequest()
                )
            ).filter((x) => !!x);
            /* console.log(
                "RECTS FROM REQUEST",
                properties.canvas.address,
                newRects.length,
                pendingRef.current?.length
            ); */
            /*   if (pendingRef.current) {
                  for (const pending of pendingRef.current) {
                      if (!newRects.find((x) => equals(x.id, pending.id))) {
  
                          newRects.push(pending);
                      } else {
                          console.log("ALREADY HAVE RECT", pending);
                      }
                  }
              } */
        }
        //clearTimeout(updateRectsTimeout);
        /* rectsRef.current = newRects; */
        /*         
                setRects(newRects);
                setLayouts(getLayouts(newRects)); */
        console.log("SET RECTS BEFRE TIMEOUT", newRects);
        if (true as any) {
            return;
        }
        updateRectsTimeout = setTimeout(() => {
            /*     rectsRef.current = newRects; */
            console.log("SET RECTS", newRects);
            /*  setRects([...newRects]); */
            setLayouts(getLayouts(newRects));
        }, timeout);
    };

    const reset = () => {
        setPendingRects([]);
        /* pendingRef.current = []; */
        /*    setRects([]); */
        /*   rectsRef.current = []; */
        resizeSizes.current = new Map();
    };

    const insertDefault = () => {
        // make determinsitic so we dont insert many defaults
        const defaultId = sha256Sync(
            concat([
                properties.canvas.id,
                peer.identity.publicKey.bytes,
                new Uint8Array([0]),
            ])
        );
        return addRect(
            new StaticContent({
                content: new StaticMarkdownText({ text: "" }),
            }),
            {
                id: defaultId,
                pending: true,
            }
        ).then(() => {
            updateRects();
        });
    };

    const removePending = (ix: number) => {
        /*   const spliced = pendingRef.current.splice(ix, 1);
          if (spliced.length > 0) {
               rectsRef.current.splice(
                  rectsRef.current.findIndex((x) => x === spliced[0]),
                  1
              ); 
          } */

        setPendingRects((prev) => {
            return [...prev.filter((x, i) => i != ix)];
        });
    };

    const onIframe = useCallback(
        (node, rect: { content: IFrameContent }, i?: number) => {
            console.log(
                "on load frame!",
                rect.content.src,
                rect.content.resizer
            );
            if (rect.content.resizer) {
                const resize = iFrameResizer(
                    {
                        /*  heightCalculationMethod: "taggedElement", */
                        license: "GPLv3",
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

                                    /* rectsRef.current */ rects[
                                        i
                                    ].location?.forEach((l, lx) => {
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
                                    });
                                    if (change) {
                                        console.log(
                                            "SET RECTS RESIZE DIFF",
                                            i
                                            /* rectsRef.current */
                                        );
                                        updateRects(
                                            rects /* rectsRef.current */
                                        );
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

    useEffect(() => {
        function handleClickOutside(event) {
            setActive(new Set());
        }
        // Bind the event listener
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            // Unbind the event listener on clean up
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

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
        if (!peer || !properties.canvas) {
            return;
        }
        reset();

        if (properties.canvas.closed) {
            throw new Error("Expecting canvas to be open");
        }

        const room = properties.canvas;
        const node = room.publicKey;

        let isOwner = peer.identity.publicKey.equals(node);

        setIsOwner(isOwner);
        room.elements.events.addEventListener("change", async (change) => {
            /* console.log(
                "SET RECT AFTER CHANGE!",
                change.detail.added.map((x) => x.location)
            ); */
            updateRects(undefined, 0);
        });

        /*  if (room.elements.index.size > 0) {
             return room;
         } */

        /*   updateRects().then(() => {
              if (isOwner) {
                  //addRect();
                  // const { key: keypair2 } = await getFreeKeypair('canvas')
                  // canvas.elements.put(new Rect({ keypair: keypair2, position: new Position({ x: 0, y: 0, z: 0 }), size: new Size({ height: 100, width: 100 }), src: STREAMING_APP + "/" + getStreamPath(keypair2.publicKey) }))
              } else {
                  setTimeout(async () => {
                      console.log({
                          remote: (
                              await room.elements.index.search(
                                  new SearchRequest({ query: [] }),
                                  { remote: { replicate: true } }
                              )
                          ).length,
                          local: (
                              await room.elements.index.search(
                                  new SearchRequest({ query: [] }),
                                  { local: true, remote: false }
                              )
                          ).length,
                      });
                  }, 2000);
              }
          }); */

        if (properties.draft) {
            insertDefault();
        }
    }, [
        peer?.identity.publicKey.hashcode(),
        properties?.canvas.closed || properties?.canvas?.address,
    ]);

    let renderRects = (rects: Element<ElementContent>[]) => {
        return rects.map((x, ix) => {
            return (
                <div key={ix}>
                    <Frame
                        hideHeader={properties.draft}
                        active={active.has(ix)}
                        setActive={(v) => {
                            if (v) {
                                setActive(
                                    (previousState) =>
                                        new Set(previousState.add(ix))
                                );
                            } else {
                                setActive(
                                    (prev) =>
                                        new Set(
                                            [...prev].filter((x) => x !== ix)
                                        )
                                );
                            }
                        }}
                        delete={() => {
                            const pendingIndex = pendingRects.indexOf(x);
                            if (pendingIndex != -1) {
                                removePending(ix);
                                if (pendingRects.length === 0) {
                                    // insertDefault()
                                    updateRects();
                                } else {
                                    updateRects();
                                }
                            } else {
                                properties.canvas.elements
                                    .del(x.id)
                                    .then(() => {
                                        updateRects();
                                    });
                            }
                        }}
                        editMode={editMode}
                        element={x}
                        index={ix}
                        replace={async (url) => {
                            let pendingElement = pendingRects.find((pending) =>
                                equals(pending.id, x.id)
                            );
                            let fromPending = !!pendingElement;
                            let element =
                                pendingElement ||
                                (await properties.canvas.elements.index.get(
                                    x.id
                                ));
                            (element.content as IFrameContent).src = url;
                            console.log("UPDATED ELEMENT", element);
                            if (!fromPending) {
                                await properties.canvas.elements.put(element);
                            } else {
                                forceUpdate(); // because pendingrefs is a ref so we need to do change detection manually
                            }
                        }}
                        onLoad={(event) =>
                            onIframe(event, x as Element<IFrameContent>, ix)
                        }
                        pending={!!pendingRects.find((p) => equals(p.id, x.id))}
                    ></Frame>
                </div>
            );
        });
    };

    return (
        <div className="w-[100%] h-full min-h-10 ">
            <div className="overflow-auto h-[100%]">
                {/*    <div className="sticky top-0">
                    <Header
                        title={
                            properties.room.parentId ? properties.room.name ? properties.room.name : "Unnamed" : ''
                        }
                        subtitle={sha256Base64Sync(properties.room.id)}
                    />
                </div> */}
                <div
                    className={`flex flex-row w-full`}
                    onClick={() => {
                        setFocused(undefined);
                    }}
                >
                    <div
                        ref={gridLayoutRef}
                        className="w-full"
                        /*  item
sx={{
overflowY: "scroll",
height: `calc(100vh - ${HEIGHT})`,
width: "100%", //`calc(100% - 275px)`,
}} */
                        // ${properties.editMode ? 'p-3' : 'p-0'}`
                    >
                        <ReactGridLayout
                            width={gridLayoutWidth}
                            className={`layout`}
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
                            isResizable={editMode}
                            resizeHandles={[
                                "s",
                                "w",
                                "e",
                                "n",
                                "sw",
                                "nw",
                                "se",
                                "ne",
                            ]}
                            draggableHandle=".drag-handle-element"
                            draggableCancel=".canvas-react-resizable-handle" // We need to cancel drag events, when we drag the resize handle, passing the class solves this
                            resizeHandle={(axis, ref) => (
                                <div
                                    ref={ref as RefObject<HTMLDivElement>}
                                    className={`canvas-react-resizable-handle canvas-react-resizable-handle-${axis}`}
                                ></div>
                            )}
                            onLayoutChange={({
                                breakpoint,
                                layout: layouts,
                            }) => {
                                let toUpdate = new Map<string, Element>();
                                let change = false;
                                latestBreakpoint.current = breakpoint as
                                    | "xxs"
                                    | "md";
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
                                                (rz.height +
                                                    rectBorderWidth * 2)
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

                                    if (layoutIndex === -1) {
                                        rect.location.push(newLayout);
                                    } else {
                                        rect.location[layoutIndex] = newLayout;
                                    }
                                    toUpdate.set(layout.i, rect);
                                }

                                Promise.all(
                                    [...toUpdate.values()].map((rect) => {
                                        if (
                                            /* pendingRef.current */ pendingRects.includes(
                                                rect
                                            )
                                        ) {
                                            return;
                                        }
                                        return properties.canvas.elements.put(
                                            rect
                                        );
                                    })
                                )
                                    .then(() => {
                                        // console.log('layout change saved', breakpoint, layouts);
                                    })
                                    .catch((e) => {
                                        console.error(
                                            "Failed to update layout",
                                            e
                                        );
                                    });
                            }}
                        >
                            {renderRects(rects)}
                            {renderRects(pendingRects)}
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
            </div>
            <div className="ml-auto">
                {!inIframe() && properties.draft && (
                    <div>
                        <Create
                            onSave={() => {
                                savePending();
                            }}
                            onNew={() => {
                                insertDefault();
                            }}
                            unsavedCount={pendingRects.length}
                            onEditModeChange={(edit) => {
                                setEditMode(edit);
                            }}
                        />
                    </div>
                )}
            </div>
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
