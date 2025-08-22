import { useEffect, useState } from "react";
import { useCanvas } from "../CanvasWrapper";
import { Canvas } from "../Canvas";
import { ImageUploadTrigger } from "../../content/native/image/ImageUploadToCanvas";
import { MdAdd as FaPlus, MdClear } from "react-icons/md";
import { SaveButton } from "./SaveCanvasButton";
import { BsSend } from "react-icons/bs";
import { useApps } from "../../content/useApps";
import { AppButton } from "./AppButton";
import {
    Canvas as CanvasDB,
    ChildVisualization,
    SimpleWebManifest,
} from "@giga-app/interface";
import { useAutoReply } from "../AutoReplyContext";
import { useEditTools } from "./ToolbarContext";
import { TbArrowsDiagonalMinimize2 } from "react-icons/tb";
import { ProfileButton } from "../../profile/ProfileButton";
import { usePeer } from "@peerbit/react";
import { useAIReply } from "../../ai/AIReployContext";
import { PrivacySwitch } from "./PrivacySwitch";
import { AiToggle } from "./AskAIToggle";
import { BiExpandAlt } from "react-icons/bi";
import { useVisualizationContext } from "../custom/CustomizationProvider";
import { usePendingCanvas } from "./PendingCanvasContext";
import { PrivateScope } from "../useScope";

export const ToolbarCreateNew = (props: {
    showProfile?: boolean;
    setInlineEditorActive: (value: boolean) => void;
    inlineEditorActive: boolean;
    parent: CanvasDB;
    className?: string;
}) => {
    const {
        isEmpty,
        text,
        insertDefault,
        canvas,
        pendingRects,
        requestAIReply,
        setRequestAIReply,
    } = useCanvas();

    const { savedOnce, pendingCanvas } = usePendingCanvas()
    const { isReady } = useAIReply();
    const { replyTo, disable: disableAutoReply } = useAutoReply();
    const { visualization } = useVisualizationContext();
    const { search } = useApps();
    const [resolvedApp, setResolvedApp] = useState<null | SimpleWebManifest>(
        null
    );
    const { peer } = usePeer();
    const privateScope = PrivateScope.useScope().scope;

    useEffect(() => {
        if (
            isEmpty === true && savedOnce !== true &&
            /*  !isSavingCanvas && !isSavingElements &&  */ pendingRects.length ===
            0 &&
            canvas
        ) {
            console.log("Insert default!")
            insertDefault({ once: true, scope: privateScope });
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
            className="btn btn-icon p-0 m-0 h-full"
        >
            <FaPlus
                className={`ml-[-2] mt-[-2] w-8 h-8 transition-transform duration-300  ${appSelectOpen ? "rotate-45" : "rotate-0"
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
                        <button
                            className="btn btn-icon btn-icon-md ml-auto"
                            onClick={() => props.setInlineEditorActive(false)}
                        >
                            <TbArrowsDiagonalMinimize2 />
                        </button>
                    </div>
                </div>
            </div>

            /* <div className="flex flex-col z-20 w-full left-0">
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
            </div> */
        );
    }
    const isChat =
        visualization?.view === ChildVisualization.CHAT;
    const colorStyle =
        "dark:bg-neutral-700 " + (isChat ? "bg-neutral-200" : "bg-neutral-50");
    const { publish } = usePendingCanvas()

    return (
        <div
            className={`flex flex-col z-20 w-full left-0  ${colorStyle} ${props.className}`}
        >
            {/* Top area: pending images canvas positioned above the toolbar */}
            <div
                className="absolute flex justify-center"
                style={{ top: "0", transform: "translateY(-100%)" }}
            >
                <Canvas appearance="chat-view-images" requestPublish={publish}>
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
            <div className="flex flex-row ">
                <div className="p-2">
                    {props.showProfile && (
                        <ProfileButton
                            size={24}
                            rounded
                            className="p-1"
                            publicKey={peer.identity.publicKey}
                        />
                    )}
                </div>
                <Canvas
                    fitWidth
                    fitHeight
                    draft={true}
                    appearance="chat-view-text"
                    className="pt-2 rounded min-h-10 justify-center"
                    requestPublish={publish}
                />
            </div>
            {/* Second row: Toolbar buttons */}
            <div className="flex items-center p-1 pt-0 ">
                {/* Left: Plus button */}
                {AddButton()}
                {/* AI reply slider */}
                {/* <form>
                        <div className="flex items-center px-1">
                            <label
                                className={`font-ganja ${
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
                    </form> */}

                {/* AI reply button */}
                {/*  <button
                        onClick={() => { }}
                        className="btn btn-toggle btn-icon flex flex-row gap-2 h-full  px-2  p-1 "
                        style={{
                            fontFamily: "monospace",
                        }}
                        aria-label="Toggle italic"
                    >
                        <span>Ask AI</span>
                    </button> */}

                {/*  <Toggle.Root
                        onPressedChange={(e) => {
                            setRequestAIReply(e);
                        }}
                        disabled={!isReady}
                        pressed={requestAIReply}
                        className="btn btn-icon btn-toggle btn-toggle-flat flex flex-row gap-2 h-full px-2  p-1 font-normal"
                        aria-label="Ask AI toggle"
                    >
                        Ask AI
                    </Toggle.Root> */}
                <AiToggle
                    onPressedChange={(e) => {
                        setRequestAIReply(e);
                    }}
                    disabled={!isReady}
                    pressed={requestAIReply}
                />

                {/* Center: Space for additional buttons */}
                <div className="flex justify-center ">
                    {resolvedApp && (
                        <AppButton
                            app={resolvedApp}
                            onClick={(insertDefaultValue) => {
                                if (!insertDefaultValue) {
                                    return;
                                }
                                insertDefault({
                                    app: resolvedApp,
                                    increment: true,
                                    scope: privateScope,
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
                    className="btn btn-icon btn-icon-md "
                    onClick={() => props.setInlineEditorActive(true)}
                >
                    <BiExpandAlt size={20} />
                </button>

                {isChat &&
                    replyTo &&
                    replyTo.idString !== props.parent.idString && (
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
                <PrivacySwitch className="ml-auto" />

                <SaveButton
                    onClick={() => props.setInlineEditorActive(false)}
                    icon={BsSend}
                />
            </div>
        </div>
    );
};
