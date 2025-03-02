import React, {
    useState,
    useEffect,
    useRef,
    useCallback,
    useReducer,
    RefObject,
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

const ReactGridLayout = RGL;
const cols = { md: 10, xxs: 10 };
const rowHeight = (w: number) => w / 100;
const margin: [number, number] = [0, 0];
const containerPadding: [number, number] = [0, 0];
const maxRows = Infinity;
const rectBorderWidth = 10;

const getLayouts = (rectGroups: Element[][]) => {
    let breakpointsToLayouts: Record<string, RGLayout> = {};
    let ix = 0;
    for (const rects of rectGroups) {
        for (const rect of rects.values()) {
            for (const layout of rect.location) {
                let arr = breakpointsToLayouts[layout.breakpoint];
                if (!arr) {
                    arr = [];
                    breakpointsToLayouts[layout.breakpoint] = arr;
                }
                arr.push({ ...layout, i: String(ix) });
            }
            ix++;
        }
    }
    return breakpointsToLayouts;
};

let updateRectsTimeout: ReturnType<typeof setTimeout> = undefined;

export const Canvas = (properties: { canvas: CanvasDB; draft?: boolean }) => {
    const { peer } = usePeer();
    const [editMode, setEditMode] = useState(false);
    const resizeSizes = useRef<Map<number, { width: number; height: number }>>(
        new Map()
    );
    const [layouts, setLayouts] = useState<Record<string, RGLayout>>({});
    const rects = useLocal(properties?.canvas.elements);
    const [pendingRects, setPendingRects] = useState<Element[]>([]);

    useEffect(() => {
        setLayouts(getLayouts([rects, pendingRects]));
    }, [rects, pendingRects]);

    const [isOwner, setIsOwner] = useState<boolean | undefined>(undefined);
    const { name, setName } = useNames();
    const [focused, setFocused] = useState<number>();
    const [active, setActive] = useState<Set<number>>(new Set());
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const dragging = useRef(false);
    const latestBreakpoint = useRef<"xxs" | "md">("md");

    const { width: gridLayoutWidth, ref: gridLayoutRef } = useWidth(0);

    // Updated shrinkToFit: It only updates the element's layout if it changes.
    // For pending elements, it updates the local pendingRects state.
    const shrinkToFit = (
        index: number,
        dims: { width: number; height: number }
    ) => {
        let element: Element;
        if (index < rects.length) {
            element = rects[index];
        } else {
            element = pendingRects[index - rects.length];
        }
        const breakpoint = latestBreakpoint.current;
        const layout = element.location.find(
            (l) => l.breakpoint === breakpoint
        );
        if (!layout) return;
        const c = cols[breakpoint];
        const positionParams: PositionParams = {
            cols: c,
            containerPadding,
            containerWidth: gridLayoutWidth,
            margin,
            maxRows,
            rowHeight,
        };
        const { w, h } = calcWH(
            positionParams,
            dims.width,
            dims.height + rectBorderWidth * 2,
            layout.x,
            layout.y
        );
        if (h !== layout.h || w !== layout.w) {
            layout.h = h;
            // Optionally update layout.w if needed.
            if (index < rects.length) {
                // For stored elements, update in the canvas.
                properties.canvas.elements.put(element);
            } else {
                // For pending elements, update local state.
                setPendingRects((prev) => {
                    const newPending = [...prev];
                    newPending[index - rects.length] = element;
                    return newPending;
                });
            }
            // Let the useEffect (on rects or pendingRects change) update layouts.
        }
    };

    const addRect = async (
        content: ElementContent,
        options: { id?: Uint8Array; pending: boolean } = { pending: false }
    ) => {
        let maxY = rects
            .map((x) => x.location)
            .flat()
            .filter((x) => x.breakpoint === latestBreakpoint.current)
            .reduce(
                (prev, current) => Math.max(current.y + current.h, prev),
                -1
            );
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
            content,
        });

        if (options.pending) {
            if (
                pendingRects &&
                pendingRects.find((x) => equals(x.id, element.id))
            ) {
                console.log("Already have an pending element");
                return;
            }
            setPendingRects((prev) => [...prev, element]);
        } else {
            properties.canvas.elements.put(element);
        }
    };

    const savePending = async () => {
        if (!pendingRects) {
            throw new Error("Missing pending element");
        }
        await Promise.all(
            pendingRects.map((x) => properties.canvas.elements.put(x))
        );
        setPendingRects([]);
        return pendingRects;
    };

    const updateRects = async (newRects?: Element[], timeout = 500) => {
        if (!newRects) {
            if (!properties.canvas.elements.index.index) {
                console.error(properties.canvas.elements.index.closed);
                throw new Error(
                    "Room is not open, because index does not exist"
                );
            }
            await delay(3000);
            newRects = (
                await properties.canvas.elements.index.search(
                    new SearchRequest()
                )
            ).filter((x) => !!x);
        }
        updateRectsTimeout = setTimeout(() => {
            setLayouts(getLayouts([newRects, pendingRects]));
        }, timeout);
    };

    const reset = () => {
        setPendingRects([]);
        resizeSizes.current = new Map();
    };

    const insertDefault = () => {
        const defaultId = sha256Sync(
            concat([
                properties.canvas.id,
                peer.identity.publicKey.bytes,
                new Uint8Array([0]),
            ])
        );
        return addRect(
            new StaticContent({
                content: new StaticMarkdownText({ text: "Some text" }),
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
        setPendingRects((prev) => prev.filter((_, i) => i !== ix));
    };

    const onIframe = useCallback(
        (
            event: React.SyntheticEvent<HTMLElement, Event>,
            rect: { content: IFrameContent },
            i?: number
        ) => {
            if (rect.content.resizer) {
                const resize = iFrameResizer(
                    {
                        license: "GPLv3",
                        tolerance: 5,
                        log: false,
                        onResized: (e: { width: number; height: number }) => {
                            if (i != null) {
                                let rzw = Number(e.width);
                                let rzh = Number(e.height);
                                resizeSizes.current.set(i, {
                                    height: rzh,
                                    width: rzw,
                                });
                            }
                            if (!dragging.current && i != null) {
                                let rzw = Number(e.width);
                                let rzh = Number(e.height);
                                let change = false;
                                rects[i].location?.forEach((l) => {
                                    let c = cols[l.breakpoint];
                                    const positionParams: PositionParams = {
                                        cols: c,
                                        containerPadding,
                                        containerWidth: gridLayoutWidth,
                                        margin,
                                        maxRows,
                                        rowHeight,
                                    };
                                    const { h } = calcWH(
                                        positionParams,
                                        rzw,
                                        rzh + rectBorderWidth * 2,
                                        l.x,
                                        l.y
                                    );
                                    if (h !== l.h) {
                                        l.h = h;
                                        change = true;
                                    }
                                });
                                if (change) {
                                    updateRects(rects);
                                }
                            }
                        },
                    },
                    event.target as HTMLIFrameElement
                );
                setInterval(() => {
                    resize[0]?.["iFrameResizer"]?.resize();
                }, 1000);
            }
        },
        [rects, gridLayoutWidth]
    );

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            setActive(new Set());
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    useEffect(() => {
        const unfocusListener = () => setFocused(undefined);
        window.addEventListener("focus", unfocusListener);
        return () => {
            window.removeEventListener("focus", unfocusListener);
        };
    }, []);

    useEffect(() => {
        if (!peer || !properties.canvas) return;
        reset();
        if (properties.canvas.closed) {
            throw new Error("Expecting canvas to be open");
        }
        const room = properties.canvas;
        let isOwner = peer.identity.publicKey.equals(room.publicKey);
        setIsOwner(isOwner);
        room.elements.events.addEventListener("change", async () => {
            updateRects(undefined, 0);
        });
        if (properties.draft) {
            insertDefault();
        }
    }, [
        peer?.identity.publicKey.hashcode(),
        properties?.canvas.closed,
        properties?.canvas?.address,
    ]);

    let renderRects = (rects: Element<ElementContent>[], offset: number) => {
        return rects.map((x, _ix) => {
            const ix = offset + _ix;
            return (
                <div key={ix}>
                    <Frame
                        hideHeader={properties.draft}
                        active={active.has(ix)}
                        setActive={(v) => {
                            if (v) {
                                setActive((prev) => new Set(prev.add(ix)));
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
                            if (pendingIndex !== -1) {
                                removePending(ix);
                                updateRects();
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
                            if (!fromPending) {
                                await properties.canvas.elements.put(element);
                            }
                        }}
                        onLoad={(event) =>
                            onIframe(event, x as Element<IFrameContent>, ix)
                        }
                        onStaticResize={(dims, idx) => {
                            // When static content is resized, update the layout via shrinkToFit.
                            shrinkToFit(idx, dims);
                        }}
                        pending={!!pendingRects.find((p) => equals(p.id, x.id))}
                    />
                </div>
            );
        });
    };

    return (
        <div className="w-full h-full min-h-10 flex flex-row">
            <div className="flex flex-row justify-center mt-auto">
                {!inIframe() && properties.draft && (
                    <div className="max-w-[600px] w-full">
                        <Create
                            onSave={savePending}
                            onNew={insertDefault}
                            unsavedCount={pendingRects.length}
                            onEditModeChange={setEditMode}
                            direction="col"
                        />
                    </div>
                )}
            </div>
            <div className="overflow-auto h-full h-min-10 w-full mt-auto">
                <div
                    className="flex flex-row w-full"
                    onClick={() => setFocused(undefined)}
                >
                    <div ref={gridLayoutRef} className="w-full">
                        <ReactGridLayout
                            autoSize={true}
                            width={gridLayoutWidth}
                            className="layout max-h-[450px]"
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
                            draggableCancel=".canvas-react-resizable-handle"
                            resizeHandle={(axis, ref) => (
                                <div
                                    ref={ref as RefObject<HTMLDivElement>}
                                    className={`canvas-react-resizable-handle canvas-react-resizable-handle-${axis}`}
                                ></div>
                            )}
                            onLayoutChange={({
                                breakpoint,
                                layout: layoutsArray,
                            }) => {
                                let toUpdate = new Map<string, Element>();
                                let change = false;
                                latestBreakpoint.current = breakpoint as
                                    | "xxs"
                                    | "md";
                                for (const [i, l] of layoutsArray.entries()) {
                                    let rSize = resizeSizes.current.get(i);
                                    if (rSize) {
                                        let c = cols[breakpoint];
                                        const positionParams: PositionParams = {
                                            cols: c,
                                            containerPadding,
                                            containerWidth: gridLayoutWidth,
                                            margin,
                                            maxRows,
                                            rowHeight,
                                        };
                                        const { w, h } = calcWH(
                                            positionParams,
                                            rSize.width,
                                            rSize.height + rectBorderWidth * 2,
                                            l.x,
                                            l.y
                                        );
                                        if (h !== l.h) {
                                            l.h = h;
                                            change = true;
                                        }
                                    }
                                }
                                for (const [
                                    i,
                                    layout,
                                ] of layoutsArray.entries()) {
                                    let rectIndex = Number(layout.i);
                                    const rect =
                                        rectIndex >= rects.length
                                            ? pendingRects[
                                                  rectIndex - rects.length
                                              ]
                                            : rects[rectIndex];
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
                                        if (pendingRects.includes(rect)) return;
                                        return properties.canvas.elements.put(
                                            rect
                                        );
                                    })
                                ).catch((e) => {
                                    console.error("Failed to update layout", e);
                                });
                            }}
                        >
                            {renderRects(rects, 0)}
                            {renderRects(pendingRects, rects.length)}
                        </ReactGridLayout>
                    </div>
                </div>
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
    let w = Math.ceil((width + margin[0]) / (colWidth + margin[0]));
    let h = Math.ceil((height + margin[1]) / (rowHeightNumber + margin[1]));
    w = clamp(w, 0, cols - x);
    h = clamp(h, 0, maxRows - y);
    return { w, h };
}

export function clamp(
    num: number,
    lowerBound: number,
    upperBound: number
): number {
    return Math.max(Math.min(num, upperBound), lowerBound);
}
