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
import { rectIsStaticMarkdownText } from "./utils/rect";

type SizeProps = {
    width?: number;
    height?: number;
    scaled?: boolean; // when true, use CSS transform scaling to fit without overflow
    fitHeight?: boolean;
    fitWidth?: boolean;
};

export const Canvas = (
    properties: SizeProps & {
        appearance?: "chat-view-images" | "chat-view-text";
        children?: ReactNode;
        bgBlur?: boolean;
    } & ({ draft: true } | { draft?: false })
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
        savePending,
        onContentChange: onContentChangeContextTrigger,
    } = useCanvas();

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
        return rectsToRender.map((rect, key) => {
            return (
                <div
                    key={key}
                    className={`${
                        properties.appearance === "chat-view-images"
                            ? "bg-white rounded-md w-20 h-20 max-w-20 max-h-20 border-[1px] border-neutral-800 overflow-hidden"
                            : ""
                    } ${properties.fitHeight ? "h-full" : ""} ${
                        properties.fitWidth ? "w-full" : ""
                    }`}
                >
                    <div
                        className={`relative flex flex-col overflow-hidden rounded-md ${
                            rectIsStaticMarkdownText(rect)
                                ? ""
                                : "max-h-[60vh] h-full"
                        }`}
                    >
                        <Frame
                            thumbnail={asThumbnail}
                            active={active.has(rect.id)}
                            setActive={(v) => {
                                if (v) {
                                    setActive(new Set(active.add(rect.id)));
                                } else {
                                    setActive(
                                        new Set(
                                            [...active].filter(
                                                (el) => el !== rect.id
                                            )
                                        )
                                    );
                                }
                            }}
                            delete={() => {
                                removePending(rect.id);
                                // TODO: make this logic smarter in the future.
                                // We don't always want to delete.
                                canvas?.elements.del(rect.id);
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
                            element={rect}
                            replace={async (url) => {
                                const pendingElement = pendingRects.find(
                                    (pending) => equals(pending.id, rect.id)
                                );
                                const fromPending = !!pendingElement;
                                const element =
                                    pendingElement ||
                                    (await canvas.elements.index.get(rect.id));
                                (element.content as IFrameContent).src = url;
                                if (!fromPending) {
                                    await canvas.elements.put(element);
                                }
                            }}
                            onLoad={() => {}}
                            onContentChange={(change, options) => {
                                const changedElement = rects.find(
                                    (rect) => rect.id === change.id
                                );
                                // if contained in rects
                                if (changedElement) {
                                    changedElement.content = new StaticContent({
                                        content: change.content,
                                    });
                                    canvas.elements.put(changedElement);

                                    onContentChangeContextTrigger(
                                        changedElement
                                    );
                                }
                                // if outside of rects -> pending!
                                else {
                                    const newPending = [...pendingRects];
                                    const existingPending = newPending.find(
                                        (el) => el.id === change.id
                                    );
                                    existingPending.content = new StaticContent(
                                        {
                                            content: change.content,
                                        }
                                    );

                                    onContentChangeContextTrigger(
                                        existingPending
                                    );
                                }

                                if (options?.save && properties.draft) {
                                    savePending();
                                }
                            }}
                            pending={
                                !!pendingRects.find((p) =>
                                    equals(p.id, rect.id)
                                )
                            }
                            fit={
                                properties.appearance === "chat-view-images"
                                    ? "cover"
                                    : properties.appearance === "chat-view-text"
                                    ? undefined
                                    : "contain"
                            }
                        />
                        <svg
                            xmlns="https://www.w3.org/2000/svg"
                            className="border-0 clip-0 h-[1px] -m-[1px] overflow-hidden p-0 absolute w-[1px]"
                            version="1.1"
                        >
                            <filter id="gaussianBlurCanvas">
                                <feGaussianBlur
                                    stdDeviation="20"
                                    result="blur"
                                />
                            </filter>
                        </svg>
                        {!rectIsStaticMarkdownText(rect) &&
                            properties.bgBlur && (
                                <div className="absolute opacity-10 -z-10 w-[150%] h-[150%] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2  [filter:url('#gaussianBlurCanvas')]">
                                    <Frame
                                        thumbnail={false}
                                        active={false}
                                        setActive={() => {}}
                                        delete={() => {}}
                                        editMode={false}
                                        showCanvasControls={false}
                                        element={rect}
                                        replace={async () => {}}
                                        onLoad={() => {}}
                                        onContentChange={() => {}}
                                        pending={false}
                                        fit="cover"
                                    />
                                </div>
                            )}
                    </div>
                </div>
            );
        });
    };

    // Exclude the first rect if it is a text content form rendering in chat-view-images appearance mode

    return (
        <div
            className={`flex ${
                properties.appearance === "chat-view-images"
                    ? "gap-4 p-4"
                    : "flex-col gap-4"
            } ${properties.fitHeight ? "h-full" : ""} ${
                properties.fitWidth ? "w-full" : ""
            }`}
        >
            {renderRects(filteredRects)}
            {filteredRects.length > 0 ? properties.children : null}
        </div>
    );
};
