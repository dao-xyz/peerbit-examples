import { forwardRef, useEffect, useState } from "react";
import { useCanvas } from "../CanvasWrapper";
import { Canvas } from "../Canvas";
import { ImageUploadTrigger } from "../../content/native/image/ImageUploadToCanvas";
import { FaPlus } from "react-icons/fa";
import { SaveButton } from "../SaveCanvasButton";
import { BsCamera } from "react-icons/bs";
import { BsArrowsFullscreen, BsArrowsCollapse } from "react-icons/bs";
import { HEIGHT as HEADER_HEIGHT } from "../../Header";
import { rectIsStaticImage, rectIsStaticMarkdownText } from "../utils/rect";
import { StaticContent, StaticMarkdownText } from "@dao-xyz/social";
import { useToolbar } from "./Toolbar";

interface ToolbarContentProps {
    onToggleAppSelect: () => void;
    appSelectOpen: boolean;
}

const ToolbarContent = forwardRef<HTMLDivElement, ToolbarContentProps>(
    (props, ref) => {
        const { isEmpty, pendingRects } = useCanvas();
        const { fullscreenEditorActive, setFullscreenEditorActive } =
            useToolbar();
        const [fullscreenAutomaticallyOnce, setFullscreenAutomaticallyOnce] =
            useState(false);

        const toggleFullscreen = () => {
            setFullscreenEditorActive((prev) => !prev);
        };

        useEffect(() => {
            // only do automatic fullscreen behaviour once
            if (fullscreenAutomaticallyOnce) {
                return;
            }
            // if we have 2 or more text elements, go fullscreen
            // if we have a non static content, go fullscreen
            // TODO if apps are in pending state, go fullscreen

            let fullScreenForNonStaticContent = pendingRects.some(
                (rect) =>
                    !rectIsStaticMarkdownText(rect) && !rectIsStaticImage(rect)
            );
            let fullScreenForText =
                !fullScreenForNonStaticContent &&
                pendingRects.filter((rect) => rectIsStaticMarkdownText(rect))
                    .length > 1;
            if (fullScreenForNonStaticContent || fullScreenForText) {
                setFullscreenEditorActive(true);
                setFullscreenAutomaticallyOnce(true);
            }
        }, [pendingRects]);

        const showFullscreenEditor =
            pendingRects.some((rect) => !rectIsStaticMarkdownText(rect)) ||
            pendingRects.some(
                (rect) =>
                    rect.content instanceof StaticContent &&
                    rect.content.content instanceof StaticMarkdownText &&
                    rect.content.content.text.length > 0
            );

        if (fullscreenEditorActive) {
            return (
                <div ref={ref} className="flex flex-col z-20 w-full left-0">
                    {/* Fullscreen mode layout */}
                    <div className="flex flex-col h-full">
                        {/* Canvas wrapper: scrollable only on this area */}
                        {/* Bottom toolbar: not part of the scrolling area */}
                        <div className="flex-shrink-0 flex items-center  bg-neutral-50 dark:bg-neutral-950 box-border p-4 mb-4">
                            <div className="flex flex-row items-center gap-2">
                                <button
                                    onClick={props.onToggleAppSelect}
                                    className="btn btn-icon btn-icon-md"
                                >
                                    <FaPlus
                                        className={`btn-icon-md transition-transform duration-300 ${
                                            props.appSelectOpen
                                                ? "rotate-45"
                                                : "rotate-0"
                                        }`}
                                    />
                                </button>
                            </div>
                            <button
                                className="btn btn-icon btn-icon-md ml-auto"
                                onClick={toggleFullscreen}
                            >
                                <BsArrowsCollapse />
                            </button>
                            {isEmpty ? (
                                <ImageUploadTrigger className="btn-icon btn-icon-md flex items-center justify-center">
                                    <BsCamera />
                                </ImageUploadTrigger>
                            ) : (
                                <SaveButton
                                    onClick={() =>
                                        setFullscreenEditorActive(false)
                                    }
                                />
                            )}
                        </div>
                    </div>
                </div>
            );
        }

        // Non-fullscreen layout remains unchanged.
        return (
            <div ref={ref} className="flex flex-col z-20 w-full left-0">
                {/* Top area: single plus button for images */}
                <Canvas appearance="chat-view-images">
                    <ImageUploadTrigger className="btn-elevated btn-icon btn-icon-md btn-toggle flex items-center justify-center bg-white">
                        <FaPlus className="btn-icon-md" />
                    </ImageUploadTrigger>
                </Canvas>

                {/* Bottom area: integrated one-row controls */}
                <div className="flex items-end bg-neutral-50 dark:bg-neutral-950 flex-shrink-0 box-border p-4">
                    <div className="flex flex-row items-center gap-2">
                        <button
                            onClick={props.onToggleAppSelect}
                            className="btn btn-icon btn-icon-md"
                        >
                            <FaPlus
                                className={`btn-icon-md transition-transform duration-300 ${
                                    props.appSelectOpen
                                        ? "rotate-45"
                                        : "rotate-0"
                                }`}
                            />
                        </button>
                    </div>

                    <div className="w-full h-full">
                        <Canvas
                            fitWidth
                            draft={true}
                            appearance="chat-view-text"
                        />
                    </div>

                    {showFullscreenEditor && (
                        <button
                            className="btn btn-icon btn-icon-md ml-auto"
                            onClick={toggleFullscreen}
                        >
                            <BsArrowsFullscreen />
                        </button>
                    )}

                    {isEmpty ? (
                        <ImageUploadTrigger className="btn btn-icon btn-icon-md flex items-center justify-center">
                            <BsCamera />
                        </ImageUploadTrigger>
                    ) : (
                        <SaveButton />
                    )}
                </div>
            </div>
        );
    }
);

export default ToolbarContent;
