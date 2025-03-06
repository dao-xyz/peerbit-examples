import React, {
    useState,
    useEffect,
    useRef,
    useCallback,
    useReducer,
    RefObject,
} from "react";
import { inIframe, useLocal, usePeer, useProgram } from "@peerbit/react";
import {
    Canvas as CanvasDB,
    Element,
    Layout,
    IFrameContent,
    ElementContent,
    StaticContent,
    StaticMarkdownText,
    AbstractStaticContent,
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
import { Frame } from "../content/Frame.js";
import { CanvasModifyToolbar } from "./ModifyToolbar.js";
import { sha256Sync } from "@peerbit/crypto";
import { BsSend } from "react-icons/bs";
import { SimpleWebManifest } from "@dao-xyz/app-service";
import { useApps } from "../content/useApps.js";

const ReactGridLayout = RGL;
// For scaled grid, we use one column.
const cols = { md: 1, xxs: 1 };
const rowHeight = 1; // 1 unit per row.
const margin: [number, number] = [0, 0];
const containerPadding: [number, number] = [0, 0];
const maxRows = Infinity;
const rectBorderWidth = 10;

type SizeProps = {
    width?: number;
    height?: number;
    scaled?: boolean; // when true, use CSS transform scaling to fit without overflow
};

const getLayouts = (
    rectGroups: Element[][],
    layoutOverrides: Map<number, Layout>
) => {
    let breakpointsToLayouts: Record<string, RGLayout> = {};
    let ix = 0;
    for (const rects of rectGroups) {
        for (const rect of rects) {
            for (const layout of rect.location) {
                let arr = breakpointsToLayouts[layout.breakpoint];
                if (!arr) {
                    arr = [];
                    breakpointsToLayouts[layout.breakpoint] = arr;
                }
                let tempOverride = layoutOverrides.get(ix);
                arr.push({
                    ...layout,
                    ...(tempOverride ? tempOverride : {}),
                    i: String(ix),
                });
                ix++;
            }
        }
    }
    return breakpointsToLayouts;
};

let updateRectsTimeout: ReturnType<typeof setTimeout> = undefined;

export const Canvas = (
    properties: { canvas: CanvasDB } & SizeProps &
        ({ draft: true; onSave: () => void } | { draft?: false })
) => {
    const asThumbnail = !!properties.scaled;
    const { peer } = usePeer();
    const { program: canvas } = useProgram(properties.canvas, {
        existing: "reuse",
        id: properties.canvas.idString,
        keepOpenOnUnmount: true,
    });
    const { getNativeApp } = useApps();
    const [editMode, setEditMode] = useState(properties.draft);
    const resizeSizes = useRef<Map<number, { width: number; height: number }>>(
        new Map()
    );
    const [layouts, setLayouts] = useState<Record<string, RGLayout>>({});
    const rects = useLocal(canvas?.elements);
    const [pendingRects, setPendingRects] = useState<Element[]>([]);
    const pendingCounter = useRef(0);
    const layoutOverrides = useRef(new Map<number, Layout>());

    useEffect(() => {
        setLayouts(getLayouts([rects, pendingRects], layoutOverrides.current));
    }, [rects, pendingRects]);

    const [isOwner, setIsOwner] = useState<boolean | undefined>(undefined);
    const { name, setName } = useNames();
    const [focused, setFocused] = useState<number>();
    const [active, setActive] = useState<Set<number>>(new Set());
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const dragging = useRef(false);
    const latestBreakpoint = useRef<"xxs" | "md">("md");

    // Get the measured natural width and a ref for the grid layout container.
    const { width: measuredWidth, ref: gridLayoutRef } = useWidth(0);
    // Use a state to capture the natural height of the grid layout container.
    const [naturalHeight, setNaturalHeight] = useState(300);
    useEffect(() => {
        if (!gridLayoutRef.current) return;
        const observer = new ResizeObserver((entries) => {
            for (let entry of entries) {
                setNaturalHeight(entry.contentRect.height);
            }
        });
        observer.observe(gridLayoutRef.current);
        return () => observer.disconnect();
    }, [gridLayoutRef]);

    const naturalWidth = measuredWidth || 800;
    const containerWidth =
        typeof properties.width === "number" ? properties.width : naturalWidth;
    const containerHeight =
        typeof properties.height === "number"
            ? properties.height
            : naturalHeight;

    // Calculate the scale factor so the natural dimensions fit within the container.
    const scaleFactor = Math.min(
        containerWidth / naturalWidth,
        containerHeight / naturalHeight
    );

    // We pass naturalWidth to the grid layout when scaled.
    const gridLayoutWidth = naturalWidth;

    const fitToSize = async (
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
            containerWidth: naturalWidth,
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
        let minDiffDelta = 5;
        console.log("MAYHBE SIZE DIFF?", {
            w,
            h,
            prevW: layout.w,
            prevH: layout.h,
        });
        if (
            Math.abs(w - layout.w) > minDiffDelta ||
            Math.abs(h - layout.h) > minDiffDelta
        ) {
            console.log("New size", {
                w,
                h,
                prevW: layout.w,
                prevH: layout.h,
            });
            layout.h = h;
            if (index < rects.length) {
                layoutOverrides.current.set(index, layout);
            } else {
                setPendingRects((prev) => {
                    const newPending = [...prev];
                    newPending[index - rects.length] = element;
                    return newPending;
                });
            }
        }
    };

    const addRect = async (
        content: ElementContent,
        options: { id?: Uint8Array; pending: boolean } = { pending: false }
    ) => {
        const allCurrentRects = await canvas.elements.index.search({});
        const allPending = pendingRects;
        let maxY = [...allCurrentRects, ...allPending]
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
                    w: 1,
                    h: 1,
                }),
            ],
            content,
        });
        if (options.pending) {
            setPendingRects((prev) => {
                const prevElement = prev.find((x) => equals(x.id, element.id));
                if (prevElement) {
                    if (
                        prevElement.content instanceof StaticContent &&
                        prevElement.content.content.isEmpty
                    ) {
                        prevElement.content = element.content;
                        return [...prev];
                    }
                    console.log("Already have a pending element");
                    return prev;
                }
                return [...prev, element];
            });
        } else {
            canvas.elements.put(element);
        }
    };

    const savePending = async () => {
        if (!pendingRects) return;
        const pendingToSave = pendingRects.filter(
            (x) =>
                x.content instanceof StaticContent === false ||
                x.content.content.isEmpty === false
        );
        if (pendingToSave.length === 0) return;
        setPendingRects([]);
        pendingCounter.current += pendingToSave.length;
        await Promise.all(pendingToSave.map((x) => canvas.elements.put(x)));
        if (properties.draft) {
            properties.onSave();
        }
        return pendingToSave;
    };

    const updateRects = async (newRects?: Element[], timeout = 500) => {
        if (!newRects) {
            if (!canvas.elements.index.index) {
                console.error(canvas.elements.index.closed);
                throw new Error(
                    "Room is not open, because index does not exist"
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 3000));
            newRects = (
                await canvas.elements.index.search(new SearchRequest())
            ).filter((x) => !!x);
        }
        updateRectsTimeout = setTimeout(() => {
            setLayouts(
                getLayouts([newRects, pendingRects], layoutOverrides.current)
            );
        }, timeout);
    };

    const reset = () => {
        setPendingRects([]);
        resizeSizes.current = new Map();
    };

    const insertDefault = (options?: {
        app?: SimpleWebManifest;
        increment?: boolean;
    }) => {
        if (options?.increment) {
            const last = pendingRects[pendingRects.length - 1];
            if (
                last &&
                last.content instanceof StaticContent &&
                last.content.content.isEmpty
            ) {
                // Do not increment
            } else {
                pendingCounter.current++;
            }
        }
        const defaultId = sha256Sync(
            concat([
                canvas.id,
                peer.identity.publicKey.bytes,
                new Uint8Array([pendingCounter.current]),
            ])
        );
        let appToAdd: AbstractStaticContent;
        if (options?.app) {
            const native = getNativeApp(options.app.url);
            if (!native) {
                throw new Error("Missing native app");
            }
            const defaultValue = native.default();
            appToAdd = defaultValue;
        } else {
            appToAdd = new StaticMarkdownText({ text: "" });
        }
        return addRect(
            new StaticContent({
                content: appToAdd,
            }),
            { id: defaultId, pending: true }
        );
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
        if (!peer || !canvas) return;
        reset();
        if (canvas?.closed) {
            throw new Error("Expecting canvas to be open");
        }
        const room = properties.canvas;
        let isOwner = peer.identity.publicKey.equals(room.publicKey);
        setIsOwner(isOwner);
        if (properties.draft) {
            insertDefault();
        }
    }, [
        peer?.identity.publicKey.hashcode(),
        !canvas || canvas?.closed ? undefined : canvas.address,
    ]);

    let renderRects = (
        rectsToRender: Element<ElementContent>[],
        offset: number
    ) => {
        return rectsToRender.map((x, _ix) => {
            const ix = offset + _ix;
            return (
                <div key={ix}>
                    <Frame
                        thumbnail={asThumbnail}
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
                            } else {
                                canvas?.elements.del(x.id);
                            }
                        }}
                        editMode={editMode}
                        showCanvasControls={
                            editMode && pendingRects.length + rects.length > 1
                        }
                        element={x}
                        index={ix}
                        replace={async (url) => {
                            let pendingElement = pendingRects.find((pending) =>
                                equals(pending.id, x.id)
                            );
                            let fromPending = !!pendingElement;
                            let element =
                                pendingElement ||
                                (await canvas.elements.index.get(x.id));
                            (element.content as IFrameContent).src = url;
                            if (!fromPending) {
                                await canvas.elements.put(element);
                            }
                        }}
                        onLoad={(event) =>
                            onIframe(event, x as Element<IFrameContent>, ix)
                        }
                        onStaticResize={(dims, idx) => {
                            fitToSize(idx, dims);
                        }}
                        onContentChange={(newContent, idx) => {
                            if (idx < rects.length) {
                                const element = rects[idx];
                                element.content = new StaticContent({
                                    content: newContent,
                                });
                                canvas.elements.put(element);
                            } else {
                                setPendingRects((prev) => {
                                    const newPending = [...prev];
                                    newPending[idx - rects.length].content =
                                        new StaticContent({
                                            content: newContent,
                                        });
                                    return newPending;
                                });
                            }
                        }}
                        pending={!!pendingRects.find((p) => equals(p.id, x.id))}
                    />
                </div>
            );
        });
    };

    return (
        <div
            className={`w-full h-full ${
                properties.height ? "" : "min-h-10"
            } flex flex-row items-center space-x-4`}
            /*  style={{
                 width: '100%',
                 height: '100%',
             }} */
            style={
                properties.scaled
                    ? {
                          width: containerWidth,
                          height: containerHeight,
                          overflow: "hidden",
                      }
                    : {}
            }
        >
            {/* Left toolbar */}
            {!inIframe() && properties.draft && (
                <div className="max-w-[600px]">
                    <CanvasModifyToolbar
                        onNew={(app) => insertDefault({ app, increment: true })}
                        unsavedCount={pendingRects.length}
                        onEditModeChange={setEditMode}
                        direction="row"
                    />
                </div>
            )}

            {/* Center grid layout */}
            <div
                className={`flex-grow w-full ${
                    properties.scaled ? "overflow-hidden" : "overflow-auto"
                } ${
                    rects.length + pendingRects.length > 1
                        ? "min-h-[300px]"
                        : ""
                }`}
                onClick={() => setFocused(undefined)}
            >
                <div
                    style={
                        properties.scaled
                            ? {
                                  transform: `scale(${scaleFactor})`,
                                  transformOrigin: "center",
                                  /*  width: naturalWidth,
                             height: naturalHeight, */
                              }
                            : {}
                    }
                >
                    <div ref={gridLayoutRef} className="w-full">
                        <ReactGridLayout
                            autoSize={true}
                            width={
                                properties.scaled ? naturalWidth : measuredWidth
                            }
                            className="layout max-h-[450px]"
                            cols={cols}
                            rowHeight={rowHeight}
                            margin={margin}
                            containerPadding={containerPadding}
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
                            isResizable={false} // TODO
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
                                        return canvas.elements.put(rect);
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

            {/* Right send button */}
            {properties.draft && (
                <div className="flex-shrink-0">
                    <button
                        onClick={() => {
                            savePending();
                        }}
                        className="btn-elevated btn-icon btn-icon-md btn-toggle"
                        aria-label="Send"
                    >
                        <BsSend size={24} />
                    </button>
                </div>
            )}
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
