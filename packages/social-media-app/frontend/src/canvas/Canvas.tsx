import {
    Element,
    ElementContent,
    HIGHEST_QUALITY,
    LOWEST_QUALITY,
    MEDIUM_QUALITY,
    StaticContent,
} from "@giga-app/interface";
import "./Canvas.css";
import { Frame } from "../content/Frame.js";
import { useCanvas } from "./CanvasWrapper";
import { ReactNode, useMemo, useReducer } from "react";
import {
    rectIsStaticImage,
    rectIsStaticMarkdownText,
    rectIsStaticPartialImage,
} from "./utils/rect";
import { IoIosArrowDown, IoIosArrowUp } from "react-icons/io";
import { MdClear } from "react-icons/md";

type SizeProps = {
    width?: number;
    height?: number;
    scaled?: boolean;
    fitHeight?: boolean;
    fitWidth?: boolean;
};

const onlyLowestQuality = (rect: Element<any>[]): Element[] => {
    if (rect.length === 0) return rect;
    for (const quality of [LOWEST_QUALITY, MEDIUM_QUALITY, HIGHEST_QUALITY]) {
        let out = rect.filter(
            (x) =>
                x.content instanceof StaticContent === false ||
                x.content.quality === quality
        );
        if (
            out.length > 0 &&
            out.find((x) => x.content instanceof StaticContent)
        ) {
            return out; // if we found one static content with the quality we are looking for, return all rects that are filtered by that quality
        }
    }
    return rect;
};

export const Canvas = (
    properties: SizeProps & {
        appearance?: "chat-view-images" | "chat-view-text";
        children?: ReactNode;
        bgBlur?: boolean;
    } & ({ draft: true; inFullScreen?: boolean } | { draft?: false }) & {
            className?: string;
        }
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
        mutate,
        reduceElementsForViewing, // from context!
    } = useCanvas();
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);

    // First filter based on appearance, then group partial images.
    const filteredRects = useMemo(() => {
        let allRects = [...rects, ...pendingRects].filter((rect, i) =>
            properties.appearance === "chat-view-images"
                ? rectIsStaticImage(rect) || rectIsStaticPartialImage(rect)
                : properties.appearance === "chat-view-text"
                ? rectIsStaticMarkdownText(rect)
                : true
        );
        if (properties.appearance === "chat-view-images") {
            allRects = onlyLowestQuality(allRects);
        }
        return reduceElementsForViewing(allRects);
    }, [rects, pendingRects, properties.appearance, reduceElementsForViewing]);

    if (properties.appearance === "chat-view-images") {
        console.log(filteredRects);
    }

    const renderRects = (rectsToRender: Element<ElementContent>[]) => {
        return rectsToRender.map((rect, ix) => {
            const deleteFn = async () => {
                removePending(rect.id);
                try {
                    await canvas?.elements.del(rect.id);
                } catch (error) {
                    // Ignore errors if the entry is already missing.
                }
                forceUpdate();
            };
            return (
                <div
                    key={ix}
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
                            delete={deleteFn}
                            editMode={
                                properties.appearance === "chat-view-images"
                                    ? false
                                    : editMode
                            }
                            showEditControls={
                                properties.appearance !== "chat-view-images" &&
                                editMode &&
                                filteredRects.length > 1
                            }
                            element={rect}
                            onLoad={() => {}}
                            fit={
                                properties.appearance === "chat-view-images"
                                    ? "cover"
                                    : properties.appearance === "chat-view-text"
                                    ? undefined
                                    : "contain"
                            }
                            inFullscreen={
                                properties.draft && properties.inFullScreen
                            }
                            editControls={
                                <>
                                    <button
                                        className="btn btn-elevated m-1 btn-icon btn-icon-sm"
                                        disabled={ix === 0}
                                        onClick={() => {
                                            return mutate(
                                                (element, ix) => {
                                                    const prev =
                                                        filteredRects[ix - 1];
                                                    element.location.y -= 1;
                                                    return mutate(
                                                        (element) => {
                                                            element.location.y += 1;
                                                            forceUpdate();
                                                            return true;
                                                        },
                                                        {
                                                            filter: (el) =>
                                                                el.idString ===
                                                                prev.idString,
                                                        }
                                                    );
                                                },
                                                {
                                                    filter: (el) =>
                                                        el.idString ===
                                                        rect.idString,
                                                }
                                            );
                                        }}
                                    >
                                        <IoIosArrowUp />
                                    </button>
                                    <button
                                        className="btn btn-elevated m-1 btn-icon btn-icon-sm"
                                        onClick={deleteFn}
                                    >
                                        <MdClear />
                                    </button>
                                    <button
                                        className="btn btn-elevated m-1 btn-icon btn-icon-sm"
                                        disabled={
                                            rectsToRender.length - 1 === ix
                                        }
                                        onClick={() => {
                                            return mutate(
                                                (element, ix) => {
                                                    const next =
                                                        filteredRects[ix + 1];
                                                    element.location.y += 1;
                                                    return mutate(
                                                        (element) => {
                                                            element.location.y -= 1;
                                                            return true;
                                                        },
                                                        {
                                                            filter: (el) =>
                                                                el.idString ===
                                                                next.idString,
                                                        }
                                                    );
                                                },
                                                {
                                                    filter: (el) =>
                                                        el.idString ===
                                                        rect.idString,
                                                }
                                            );
                                        }}
                                    >
                                        <IoIosArrowDown />
                                    </button>
                                </>
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
                                <div className="absolute opacity-10 -z-10 w-[150%] h-[150%] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 [filter:url('#gaussianBlurCanvas')]">
                                    <Frame
                                        thumbnail={false}
                                        active={false}
                                        setActive={() => {}}
                                        delete={() => {}}
                                        editMode={false}
                                        showEditControls={false}
                                        element={rect}
                                        onLoad={() => {}}
                                        fit="cover"
                                    />
                                </div>
                            )}
                    </div>
                </div>
            );
        });
    };

    return (
        (filteredRects.length > 0 && (
            <div
                className={`flex ${
                    properties.appearance === "chat-view-images"
                        ? "gap-4 p-4"
                        : "flex-col gap-4"
                } ${properties.fitHeight ? "h-full" : ""} ${
                    properties.fitWidth ? "w-full" : ""
                } ${properties.className ?? ""}`}
            >
                {renderRects(filteredRects)}
                {filteredRects.length > 0 ? properties.children : null}
            </div>
        )) || <></>
    );
};
