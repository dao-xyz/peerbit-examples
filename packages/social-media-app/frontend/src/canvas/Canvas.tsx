import { useState, useEffect, useRef, useReducer } from "react";
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
import { SearchRequest } from "@peerbit/document";
import { useNames } from "../names/useNames.js";
import { concat, equals } from "uint8arrays";
import "./Canvas.css";
import { Frame } from "../content/Frame.js";
import { CanvasModifyToolbar } from "./ModifyToolbar.js";
import { sha256Sync } from "@peerbit/crypto";
import { BsSend } from "react-icons/bs";
import { SimpleWebManifest } from "@dao-xyz/app-service";
import { useApps } from "../content/useApps.js";

type SizeProps = {
    width?: number;
    height?: number;
    scaled?: boolean; // when true, use CSS transform scaling to fit without overflow
};

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
    console.log(canvas);
    const { getNativeApp } = useApps();
    const [editMode, setEditMode] = useState(properties.draft);
    const resizeSizes = useRef<Map<number, { width: number; height: number }>>(
        new Map()
    );
    const rects = useLocal(canvas?.elements);
    const [pendingRects, setPendingRects] = useState<Element[]>([]);
    const pendingCounter = useRef(0);
    const [active, setActive] = useState<Set<number>>(new Set());
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const latestBreakpoint = useRef<"xxs" | "md">("md");

    const addRect = async (
        content: ElementContent,
        options: { id?: Uint8Array; pending: boolean } = { pending: false }
    ) => {
        const allCurrentRects = await canvas.elements.index.search({});
        const allPending = pendingRects;
        const maxY = [...allCurrentRects, ...allPending]
            .map((x) => x.location)
            .flat()
            .filter((x) => x.breakpoint === latestBreakpoint.current)
            .reduce(
                (prev, current) => Math.max(current.y + current.h, prev),
                -1
            );
        const element = new Element({
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
        if (!peer || !canvas) return;
        reset();
        if (canvas?.closed) {
            throw new Error("Expecting canvas to be open");
        }
        if (properties.draft) {
            insertDefault();
        }
    }, [
        peer?.identity.publicKey.hashcode(),
        !canvas || canvas?.closed ? undefined : canvas.address,
    ]);

    const renderRects = (
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
                            const pendingElement = pendingRects.find(
                                (pending) => equals(pending.id, x.id)
                            );
                            const fromPending = !!pendingElement;
                            const element =
                                pendingElement ||
                                (await canvas.elements.index.get(x.id));
                            (element.content as IFrameContent).src = url;
                            if (!fromPending) {
                                await canvas.elements.put(element);
                            }
                        }}
                        onLoad={(event) => {}}
                        onStaticResize={(dims, idx) => {}}
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
            >
                <div>
                    <div className="w-full">
                        {renderRects(rects, 0)}
                        {renderRects(pendingRects, rects.length)}
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
