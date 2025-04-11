import React, { forwardRef, useEffect, useState } from "react";
import { useCanvas } from "../CanvasWrapper";
import { Canvas } from "../Canvas";
import { ImageUploadTrigger } from "../../content/native/image/ImageUploadToCanvas";
import { MdAdd as FaPlus, MdClear } from "react-icons/md";
import { SaveButton } from "../SaveCanvasButton";
import { FiSend } from "react-icons/fi";
import { BsCamera, BsArrowsCollapse } from "react-icons/bs";
import { useToolbar } from "./Toolbar";
import { useApps } from "../../content/useApps";
import { AppButton } from "./AppButton";
import { SimpleWebManifest } from "@giga-app/interface";
import * as Switch from "@radix-ui/react-switch";
import { useView } from "../../view/ViewContex";
import { useAIReply } from "../../ai/AIReployContext";
import { useAutoReply } from "../AutoReplyContext";

interface ToolbarContentProps {
    onToggleAppSelect: (open?: boolean) => void;
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

        const { replyTo, disable: disableAutoReply } = useAutoReply();
        const { fullscreenEditorActive, setFullscreenEditorActive } =
            useToolbar();

        const { view, viewRoot } = useView();
        const { isReady } = useAIReply();
        const { search } = useApps();
        const [resolvedApp, setResolvedApp] =
            useState<null | SimpleWebManifest>(null);

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
                onClick={() => props.onToggleAppSelect(true)}
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
                        <div className="flex-shrink-0 flex items-center bg-neutral-50 dark:bg-neutral-700 p-4">
                            {AddButton()}

                            <button
                                className="btn btn-icon btn-icon-md ml-auto"
                                onClick={() => setFullscreenEditorActive(false)}
                            >
                                <BsArrowsCollapse />
                            </button>
                            {isEmpty ? (
                                <ImageUploadTrigger
                                    onFileChange={() =>
                                        props.onToggleAppSelect(false)
                                    }
                                    className="btn btn-icon btn-icon-md flex items-center justify-center"
                                >
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
                    className="flex flex-col z-20 w-full left-0 rounded bg-neutral-100 dark:bg-neutral-700 safe-area-bottom"
                >
                    {/* Top area: pending images canvas positioned above the toolbar */}
                    <div
                        className="absolute flex justify-center"
                        style={{ top: "0", transform: "translateY(-100%)" }}
                    >
                        <Canvas appearance="chat-view-images">
                            <ImageUploadTrigger
                                onFileChange={() =>
                                    props.onToggleAppSelect(false)
                                }
                                className="btn-elevated btn-icon btn-icon-md btn-toggle flex items-center justify-center bg-white dark:bg-black"
                            >
                                <FaPlus className="btn-icon-md" />
                            </ImageUploadTrigger>
                        </Canvas>
                    </div>

                    {/* First row: Input field */}
                    <div className="pt-1">
                        <Canvas
                            fitWidth
                            draft={true}
                            appearance="chat-view-text"
                            className="rounded"
                        />
                    </div>

                    {/* Second row: Toolbar buttons */}
                    <div className="flex items-center p-1 pt-0 h-full">
                        {/* Left: Plus button */}
                        {AddButton()}
                        {/* AI reply slider */}
                        <form>
                            <div className="flex items-center px-1">
                                <label
                                    className={`ganja-font ${
                                        !isReady ? "text-neutral-500" : ""
                                    }`}
                                    htmlFor="use-ai"
                                    style={{ paddingRight: 15 }}
                                >
                                    AI Reply
                                </label>
                                <Switch.Root
                                    className="switch-root"
                                    id="use-ai"
                                    disabled={!isReady}
                                    checked={requestAIReply}
                                    onCheckedChange={(e) => {
                                        setRequestAIReply(e);
                                    }}
                                >
                                    <Switch.Thumb className="switch-thumb" />
                                </Switch.Root>
                            </div>
                        </form>

                        {/* AI reply button */}
                        {/*  <Toggle.Root
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
                        </Toggle.Root> */}

                        {/* Center: Space for additional buttons */}
                        <div className="flex justify-center ml-auto">
                            {resolvedApp && (
                                <AppButton
                                    app={resolvedApp}
                                    onClick={(insertDefaultValue) => {
                                        if (!insertDefaultValue) {
                                            return;
                                        }
                                        console.log(
                                            "INSERT DEFAULT",
                                            resolvedApp
                                        );
                                        insertDefault({
                                            app: resolvedApp,
                                            increment: true,
                                        });
                                    }}
                                    className="btn items-center px-2 p-1"
                                    orientation="horizontal"
                                    showTitle={true}
                                />
                            )}
                        </div>

                        {/* Right: Send button */}
                        {view === "chat" &&
                            replyTo &&
                            replyTo.idString !== viewRoot.idString && (
                                <button
                                    className="btn btn-icon btn-icon-md "
                                    onClick={() => {
                                        disableAutoReply();
                                    }}
                                >
                                    <MdClear className="animated-bg-btn [--inner-bg:theme('colors.primary.900')] dark:[--inner-bg:theme('colors.primary.200')] text-white  dark:text-black " />
                                </button>
                            )}
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
