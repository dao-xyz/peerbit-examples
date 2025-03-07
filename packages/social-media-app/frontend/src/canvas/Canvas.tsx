import { inIframe } from "@peerbit/react";
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
import { equals } from "uint8arrays";
import "./Canvas.css";
import { Frame } from "../content/Frame.js";
import { CanvasModifyToolbar } from "./ModifyToolbar.js";
import { BsSend } from "react-icons/bs";
import { useCanvas } from "./CanvasWrapper";

type SizeProps = {
    width?: number;
    height?: number;
    scaled?: boolean; // when true, use CSS transform scaling to fit without overflow
};

export const Canvas = (
    properties: SizeProps &
        ({ draft: true; onSave: () => void } | { draft?: false })
) => {
    const asThumbnail = !!properties.scaled;
    const {
        editMode,
        setEditMode,
        active,
        setActive,
        pendingRects,
        rects,
        insertDefault,
        removePending,
        savePending,
        canvas,
    } = useCanvas();

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
                        active={active.has(x.id)}
                        setActive={(v) => {
                            if (v) {
                                setActive(new Set(active.add(x.id)));
                            } else {
                                setActive(
                                    new Set(
                                        [...active].filter((el) => el !== x.id)
                                    )
                                );
                            }
                        }}
                        delete={() => {
                            removePending(x.id);
                            // TODO: make this logic smarter in the future.
                            // We don't always want to delete.
                            canvas?.elements.del(x.id);
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
                        onLoad={() => {}}
                        onStaticResize={() => {}}
                        onContentChange={(newContent, id) => {
                            const changedElement = rects.find(
                                (rect) => rect.id === id
                            );
                            // if contained in rects
                            if (changedElement) {
                                changedElement.content = new StaticContent({
                                    content: newContent,
                                });
                                canvas.elements.put(changedElement);
                            }
                            // if outside of rects -> pending!
                            else {
                                const newPending = [...pendingRects];
                                newPending.find((el) => el.id === id).content =
                                    new StaticContent({
                                        content: newContent,
                                    });
                                return newPending;
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
            } flex flex-row items-center space-x-4 ${
                !inIframe() && properties.draft
                    ? "bg-neutral-50 dark:bg-neutral-950 p-4"
                    : ""
            }`}
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
                            if (properties.onSave) {
                                properties.onSave();
                            }
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
