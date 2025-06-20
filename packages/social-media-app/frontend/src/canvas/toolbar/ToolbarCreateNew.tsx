import { forwardRef, useEffect, useState } from "react";
import { useCanvas } from "../CanvasWrapper";
import { Canvas } from "../Canvas";
import { ImageUploadTrigger } from "../../content/native/image/ImageUploadToCanvas";
import { MdAdd as FaPlus, MdClear, MdSave } from "react-icons/md";
import { SaveButton } from "../SaveCanvasButton";
import { BsCamera, BsSend } from "react-icons/bs";
import { useApps } from "../../content/useApps";
import { AppButton } from "./AppButton";
import { SimpleWebManifest } from "@giga-app/interface";
import * as Switch from "@radix-ui/react-switch";
import { useView } from "../reply/view/ViewContex";
import { useAIReply } from "../../ai/AIReployContext";
import { useAutoReply } from "../AutoReplyContext";
import { BsArrowsAngleExpand } from "react-icons/bs";
import { useEditTools } from "./ToolbarContext";
import { TbArrowsDiagonalMinimize2 } from "react-icons/tb";
import { usePendingCanvas } from "../PendingCanvasContext";

export const ToolbarCreateNew = (props: {
    setInlineEditorActive: (value: boolean) => void;
    inlineEditorActive: boolean;
}) => {
    const {
        isEmpty,
        text,
        insertDefault,
        setRequestAIReply,
        requestAIReply,
        canvas,
        pendingRects,
        isSaving: isSavingElements,
        savedOnce,
    } = useCanvas();
    const { isSaving: isSavingCanvas } = usePendingCanvas();
    const { replyTo, disable: disableAutoReply } = useAutoReply();
    const { view, viewRoot } = useView();
    const { isReady } = useAIReply();
    const { search } = useApps();
    const [resolvedApp, setResolvedApp] = useState<null | SimpleWebManifest>(
        null
    );

    useEffect(() => {
        if (
            !savedOnce &&
            /*  !isSavingCanvas && !isSavingElements &&  */ pendingRects.length ===
                0 &&
            canvas
        ) {
            insertDefault();
        }
    }, [
        isEmpty,
        savedOnce,
        /* isSavingCanvas, isSavingElements, */ canvas?.idString,
        pendingRects,
    ]);

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
    const { appSelectOpen, setAppSelectOpen } = useEditTools();
    const onToggleAppSelect = (open) => {
        if (open != null) {
            setAppSelectOpen(open);
        } else {
            setAppSelectOpen((appSelectOpen) => !appSelectOpen);
        }
    };

    const AddButton = () => (
        <button
            onClick={() => onToggleAppSelect(null)}
            className="btn btn-icon p-0 m-0"
        >
            <FaPlus
                className={`ml-[-2] mt-[-2] w-8 h-8 transition-transform duration-300  ${
                    appSelectOpen ? "rotate-45" : "rotate-0"
                }`}
            />
        </button>
    );

    // Fullscreen mode: retain your existing layout.
    if (props.inlineEditorActive) {
        return (
            <div className="flex flex-col z-20 w-full left-0">
                <div className="flex flex-col h-full">
                    <div className="px-1 flex-shrink-0 flex items-center bg-neutral-50 dark:bg-neutral-700">
                        {AddButton()}

                        <button
                            className="btn btn-icon btn-icon-md ml-auto"
                            onClick={() => props.setInlineEditorActive(false)}
                        >
                            <TbArrowsDiagonalMinimize2 />
                        </button>
                        {isEmpty ? (
                            <ImageUploadTrigger
                                onFileChange={() => onToggleAppSelect(false)}
                                className="btn btn-icon btn-icon-md flex items-center justify-center"
                            >
                                <BsCamera />
                            </ImageUploadTrigger>
                        ) : (
                            <SaveButton
                                onClick={() =>
                                    props.setInlineEditorActive(false)
                                }
                                icon={BsSend}
                            />
                        )}
                    </div>
                </div>
            </div>
        );
    }
    const colorStyle =
        "dark:bg-neutral-700 " +
        (view?.id === "chat" ? "bg-neutral-200" : "bg-neutral-100");
    return (
        <>
            <div
                className={`flex flex-col z-20 w-full left-0  ${colorStyle} rounded-t-lg`}
            >
                {/* Top area: pending images canvas positioned above the toolbar */}
                <div
                    className="absolute flex justify-center"
                    style={{ top: "0", transform: "translateY(-100%)" }}
                >
                    <Canvas appearance="chat-view-images">
                        <ImageUploadTrigger
                            onFileChange={() => onToggleAppSelect(false)}
                            className="btn-elevated btn-icon btn-icon-md btn-toggle flex items-center justify-center bg-white dark:bg-black"
                        >
                            <FaPlus className="btn-icon-md" />
                        </ImageUploadTrigger>
                    </Canvas>
                </div>

                {/* First row: Input field */}
                {/* We set the min height here because without it switching views might lead to flickering behaviour where the input field gets removed and re-added */}
                <Canvas
                    fitWidth
                    draft={true}
                    appearance="chat-view-text"
                    className="rounded min-h-10 pt-1"
                />
                {/* Second row: Toolbar buttons */}
                <div className="flex items-center p-1 pt-0 ">
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
                                    console.log("INSERT DEFAULT", resolvedApp);
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
                    {/* Right: Fullscreen button */}
                    <button
                        className="btn btn-icon btn-icon-md ml-auto"
                        onClick={() => props.setInlineEditorActive(true)}
                    >
                        <BsArrowsAngleExpand />
                    </button>

                    {view?.id === "chat" &&
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

                    {/* Right: Send button */}
                    {/*  <button
                        onClick={() => savePending()}
                        className="btn btn-icon btn-icon-md"
                    >
                        <FiSend className="btn-icon-sm" />
                    </button> */}
                    <SaveButton
                        onClick={() => props.setInlineEditorActive(false)}
                        icon={BsSend}
                    />
                </div>
            </div>
        </>
    );
};
