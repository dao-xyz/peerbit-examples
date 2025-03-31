import React, { forwardRef, useEffect, useState } from "react";
import { useCanvas } from "../CanvasWrapper";
import { Canvas } from "../Canvas";
import { ImageUploadTrigger } from "../../content/native/image/ImageUploadToCanvas";
import { MdAdd as FaPlus } from "react-icons/md";
import { SaveButton } from "../SaveCanvasButton";
import { FiSend } from "react-icons/fi";
import { BsCamera, BsArrowsCollapse } from "react-icons/bs";
import { useToolbar } from "./Toolbar";
import { useApps } from "../../content/useApps";
import { AppButton } from "./AppButton";
import { SimpleWebManifest } from "@giga-app/interface";
import * as Toggle from "@radix-ui/react-toggle";

import VscRobot from "/vscrobot.svg";
import { useAIReply } from "../../ai/AIReployContext";

interface ToolbarContentProps {
    onToggleAppSelect: () => void;
    appSelectOpen: boolean;
}

const ToolbarContent = forwardRef<HTMLDivElement, ToolbarContentProps>(
    (props, ref) => {
        const {
            isEmpty,
            text,
            savePending,
            insertDefault,
            setRequestAIReply,
            requestAIReply,
        } = useCanvas();

        const { fullscreenEditorActive, setFullscreenEditorActive } =
            useToolbar();
        const { search } = useApps();
        const [resolvedApp, setResolvedApp] =
            useState<null | SimpleWebManifest>(null);
        const { isReady: isReadyLLM } = useAIReply();

        // Try to resolve a matching app when the text changes.
        useEffect(() => {
            const trimmed = text?.trim();
            if (trimmed) {
                search(trimmed).then((apps) => {
                    setResolvedApp(apps[0] || null);
                });
            } else {
                setResolvedApp(null);
            }
        }, [text, search]);

        const AddButton = () => (
            <button
                onClick={props.onToggleAppSelect}
                className="btn btn-icon p-0 m-0"
            >
                <FaPlus
                    className={`ml-[-2] mt-[-2] w-8 h-8 transition-transform duration-300 ${
                        props.appSelectOpen ? "rotate-45" : "rotate-0"
                    }`}
                />
            </button>
        );

        // Fullscreen mode: retain your existing layout.
        if (fullscreenEditorActive) {
            return (
                <div ref={ref} className="flex flex-col z-20 w-full left-0">
                    <div className="flex flex-col h-full">
                        <div className="flex-shrink-0 flex items-center bg-neutral-50 dark:bg-neutral-950 p-4">
                            {AddButton()}
                            <button
                                className="btn btn-icon btn-icon-md ml-auto"
                                onClick={() => setFullscreenEditorActive(false)}
                            >
                                <BsArrowsCollapse />
                            </button>
                            {isEmpty ? (
                                <ImageUploadTrigger className="btn btn-icon btn-icon-md flex items-center justify-center">
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

        return (
            <>
                <div
                    ref={ref}
                    className="flex flex-col z-20 w-full left-0 rounded bg-neutral-100 dark:bg-neutral-900"
                >
                    {/* First row: Input field */}
                    <div className="pt-2">
                        <Canvas
                            fitWidth
                            draft={true}
                            appearance="chat-view-text"
                            className="rounded"
                        />
                    </div>

                    {/* Second row: Toolbar buttons */}
                    <div className="flex items-center p-1 h-full">
                        {/* Left: Plus button */}
                        {AddButton()}

                        {/* AI reply button */}
                        <Toggle.Root
                            onPressedChange={(e) => {
                                setRequestAIReply(e);
                            }}
                            disabled={!isReadyLLM}
                            pressed={requestAIReply}
                            className="btn btn-elevated btn-toggle h-max flex flex-row pt-0 pb-0 px-2"
                            aria-label="Toggle italic"
                        >
                            <div className="flex flex-row items-center gap-2">
                                <img
                                    src={VscRobot}
                                    className="w-4 h-4 dark:invert"
                                    alt="AI reply"
                                />
                                <span className="ganja-font">AI reply</span>
                            </div>
                        </Toggle.Root>

                        {/* Center: Space for additional buttons */}
                        <div className="flex justify-center ml-auto">
                            {resolvedApp && (
                                <AppButton
                                    app={resolvedApp}
                                    onClick={() =>
                                        insertDefault({
                                            app: resolvedApp,
                                            increment: true,
                                        }).then(() => savePending())
                                    }
                                    className="btn items-center px-2 p-1"
                                    orientation="horizontal"
                                    showTitle={true}
                                />
                            )}
                        </div>

                        {/* Right: Send button */}
                        <button
                            onClick={() => savePending()}
                            className="btn btn-icon btn-icon-md"
                        >
                            <FiSend className="btn-icon-sm" />
                        </button>
                    </div>
                </div>
            </>
        );
    }
);

export default ToolbarContent;
