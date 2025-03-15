import React, { forwardRef, useState } from "react";
import { Canvas as CanvasDB } from "@dao-xyz/social";
import { CanvasWrapper, useCanvas } from "../CanvasWrapper";
import { ImageUploadTrigger } from "../../content/native/image/ImageUploadToCanvas";
import { FaPlus } from "react-icons/fa";
import { SaveButton } from "../SaveCanvasButton";
import { Canvas } from "../Canvas";
import { AppSelect } from "./AppSelect";
import { SimpleWebManifest } from "@dao-xyz/app-service";
import { DebugGeneratePostButton } from "./DebugGeneratePostButton";
import { BsCamera } from "react-icons/bs";

// Child component that calls useCanvas
const ToolbarContent = forwardRef<
    HTMLDivElement,
    { contentEmpty: boolean; setContentEmpty: (empty: boolean) => void }
>((props, ref) => {
    // useCanvas is now called inside a child of CanvasWrapper
    // so it is guaranteed to have the context.
    const { insertDefault } = useCanvas();

    // Insert a new app post
    const handleNew = (app: SimpleWebManifest) =>
        insertDefault({ app, increment: true });

    return (
        <div
            ref={ref}
            className="flex flex-col sticky z-20 bottom-0 w-full left-0 pb-4"
        >
            {/* Top area: single plus button for images */}
            <Canvas appearance="chat-view-images">
                <ImageUploadTrigger className="btn-elevated btn-icon btn-icon-md btn-toggle flex items-center justify-center bg-white">
                    {/* Add the icon size class to the icon itself */}
                    <FaPlus className="btn-icon-md" />
                </ImageUploadTrigger>
            </Canvas>

            {/* Bottom area: integrated controls and conditional button */}
            <div className="flex items-center gap-4 p-4 bg-neutral-50 dark:bg-neutral-950">
                {/* Left side controls */}
                <div className="flex flex-row items-center gap-2 max-w-[600px]">
                    {/* If you want the debug bug icon to match, add the same classes here */}
                    {import.meta.env.MODE === "development" && (
                        <DebugGeneratePostButton />
                    )}
                    {/* Example: an AppSelect control */}
                    <AppSelect onSelected={(app) => handleNew(app)} />
                </div>

                {/* Main text canvas */}
                <Canvas fitWidth draft={true} appearance="chat-view-text" />

                {/* Right side: conditionally show camera vs. send button */}
                {props.contentEmpty ? (
                    <ImageUploadTrigger className=" btn-icon btn-icon-md flex items-center justify-center ">
                        <BsCamera />
                    </ImageUploadTrigger>
                ) : (
                    <SaveButton />
                )}
            </div>
        </div>
    );
});

// Parent component wrapping with CanvasWrapper
export const Toolbar = forwardRef<
    HTMLDivElement,
    { pendingCanvas: CanvasDB; onSavePending: () => void }
>((props, ref) => {
    // Local state to track if the content is empty
    const [contentEmpty, setContentEmpty] = useState(true);

    return (
        <CanvasWrapper
            canvas={props.pendingCanvas}
            draft={true}
            multiCanvas
            onSave={props.onSavePending}
            onContentChange={(e) => {
                // Update based on content; assume e.content.isEmpty is provided.
                setContentEmpty(e.content.isEmpty);
            }}
        >
            <ToolbarContent
                ref={ref}
                contentEmpty={contentEmpty}
                setContentEmpty={setContentEmpty}
            />
        </CanvasWrapper>
    );
});
