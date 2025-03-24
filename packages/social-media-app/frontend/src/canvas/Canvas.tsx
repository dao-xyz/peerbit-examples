import { Element, ElementContent } from "@dao-xyz/social";
import "./Canvas.css";
import { Frame } from "../content/Frame.js";
import { useCanvas } from "./CanvasWrapper";
import { ReactNode, useMemo, useReducer } from "react";
import { rectIsStaticMarkdownText } from "./utils/rect";
import { IoIosArrowDown, IoIosArrowUp } from "react-icons/io";
import { MdClear } from "react-icons/md";

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
    } = useCanvas();

    const [_, forceUpdate] = useReducer((x) => x + 1, 0);

    // rects and pendingRects purpose filtered for properties.appearance
    const filteredRects = useMemo(() => {
        return [...rects, ...pendingRects]
            .filter((rect, i) =>
                properties.appearance === "chat-view-images"
                    ? i > 0 || !rectIsStaticMarkdownText(rect)
                    : properties.appearance === "chat-view-text"
                    ? rectIsStaticMarkdownText(rect)
                    : true
            )
            .sort((x, y) => {
                // sort by y position
                return x.location.y - y.location.y;
            });
    }, [rects, _, pendingRects, properties.appearance]);

    const renderRects = (rectsToRender: Element<ElementContent>[]) => {
        return rectsToRender.map((rect, ix) => {
            const deleteFn = async () => {
                removePending(rect.id);
                // TODO: make this logic smarter in the future.
                // We don't always want to delete.
                try {
                    await canvas?.elements.del(rect.id);
                } catch (error) {
                    // missing entry
                    // TODO delete on save???
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
                                        className="btn btn-elevated  m-1 btn-icon btn-icon-sm "
                                        disabled={ix == 0}
                                        onClick={() => {
                                            return mutate(
                                                rect,
                                                (element, ix) => {
                                                    const prev =
                                                        filteredRects[ix - 1];
                                                    element.location.y -= 1;
                                                    return mutate(
                                                        prev,
                                                        (element) => {
                                                            element.location.y += 1;
                                                            forceUpdate();
                                                            return true;
                                                        }
                                                    )
                                                        .then(() => {
                                                            return true;
                                                        })
                                                        .catch((e) => {
                                                            console.error(e);
                                                            return false;
                                                        });
                                                }
                                            );
                                        }}
                                    >
                                        <IoIosArrowUp />
                                    </button>
                                    <button
                                        className="btn btn-elevated  m-1 btn-icon btn-icon-sm "
                                        onClick={deleteFn}
                                    >
                                        <MdClear />
                                    </button>

                                    <button
                                        className="btn btn-elevated m-1 btn-icon btn-icon-sm "
                                        disabled={
                                            rectsToRender.length - 1 === ix
                                        }
                                        onClick={() => {
                                            return mutate(
                                                rect,
                                                (element, ix) => {
                                                    const next =
                                                        filteredRects[ix + 1];
                                                    element.location.y += 1;
                                                    return mutate(
                                                        next,
                                                        (element) => {
                                                            element.location.y -= 1;
                                                            return true;
                                                        }
                                                    )
                                                        .then(() => {
                                                            forceUpdate();
                                                            return true;
                                                        })
                                                        .catch((e) => {
                                                            console.error(e);
                                                            return false;
                                                        });
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
                                <div className="absolute opacity-10 -z-10 w-[150%] h-[150%] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2  [filter:url('#gaussianBlurCanvas')]">
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

    // Exclude the first rect if it is a text content form rendering in chat-view-images appearance mode

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
