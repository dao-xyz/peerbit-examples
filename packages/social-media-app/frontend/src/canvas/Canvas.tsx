import {
    Element,
    IFrameContent,
    ElementContent,
    StaticContent,
    StaticMarkdownText,
} from "@dao-xyz/social";
import { equals } from "uint8arrays";
import "./Canvas.css";
import { Frame } from "../content/Frame.js";
import { useCanvas } from "./CanvasWrapper";
import { ReactNode, useCallback, useMemo } from "react";

type SizeProps = {
    width?: number;
    height?: number;
    scaled?: boolean; // when true, use CSS transform scaling to fit without overflow
};

export const Canvas = (
    properties: SizeProps & {
        appearance?: "chat-view-images" | "chat-view-text";
        children?: ReactNode;
    } & ({ draft: true; onSave: () => void } | { draft?: false })
) => {
    const asThumbnail = !!properties.scaled;
    const {
        editMode,
        active,
        setActive,
        pendingRects,
        rects,
        removePending,
        canvas,
    } = useCanvas();

    // Inside your Canvas component:
    const filteredTextRectsCount = useMemo(() => {
        const filtered = [...rects, ...pendingRects].filter(
            (rect, i) =>
                rect.content instanceof StaticContent &&
                rect.content.content instanceof StaticMarkdownText
        );
        return filtered.length;
    }, [rects, pendingRects]);

    // rects and pendingRects purpose filtered for properties.appearance
    const filteredRects = useMemo(() => {
        return [...rects, ...pendingRects].filter((rect, i) =>
            properties.appearance === "chat-view-images"
                ? i > 0 ||
                  !(
                      rect.content instanceof StaticContent &&
                      rect.content.content instanceof StaticMarkdownText
                  )
                : properties.appearance === "chat-view-text"
                ? rect.content instanceof StaticContent &&
                  rect.content.content instanceof StaticMarkdownText
                : true
        );
    }, [rects, pendingRects, properties.appearance]);

    const renderRects = (rectsToRender: Element<ElementContent>[]) => {
        return rectsToRender.map((x, key) => {
            return (
                <div
                    key={key}
                    className={
                        properties.appearance === "chat-view-images"
                            ? "bg-white rounded-md w-20 h-20 max-w-20 max-h-20 border-[1px] border-neutral-800 overflow-hidden"
                            : ""
                    }
                >
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
                        editMode={
                            properties.appearance === "chat-view-images"
                                ? false
                                : editMode
                        }
                        showCanvasControls={
                            properties.appearance !== "chat-view-images" &&
                            editMode &&
                            filteredRects.length > 1
                        }
                        element={x}
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
                        coverParent={
                            properties.appearance === "chat-view-images"
                        }
                    />
                </div>
            );
        });
    };

    // Exclude the first rect if it is a text content form rendering in chat-view-images appearance mode

    return (
        <div
            className={
                properties.appearance === "chat-view-images"
                    ? "flex gap-4 p-4"
                    : `flex-grow w-full ${
                          properties.scaled
                              ? "overflow-hidden"
                              : "overflow-auto"
                      }`
            }
        >
            {renderRects(filteredRects)}
            {filteredRects.length > 0 ? properties.children : null}
        </div>
    );
};
