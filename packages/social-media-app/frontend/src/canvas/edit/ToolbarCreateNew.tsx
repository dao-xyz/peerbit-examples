import { useEffect, useState } from "react";
import { useCanvas } from "../CanvasWrapper";
import { Canvas } from "../render/detailed/Canvas";
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
import { useEditTools } from "./CanvasEditorProvider";
import { TbArrowsDiagonalMinimize2 } from "react-icons/tb";
import { ProfileButton } from "../../profile/ProfileButton";
import { usePeer } from "@peerbit/react";
import { useAIReply } from "../../ai/AIReployContext";
import { PrivacySwitch } from "./PrivacySwitch";
import { AiToggle } from "./AskAIToggle";
import { BiExpandAlt } from "react-icons/bi";
import { useVisualizationContext } from "../custom/CustomizationProvider";
import { PrivateScope } from "../useScope";
import { useDraftSession } from "./draft/DraftSession";
import { ImageCanvas } from "../render/detailed/ImageCanvas";
import { TextCanvas } from "../render/detailed/TextCanvas";

export const ToolbarCreateNew = (props: {
    showProfile?: boolean;
    setInlineEditorActive: (value: boolean) => void;
    inlineEditorActive: boolean;
    parent: CanvasDB;
    className?: string;
    overlayRichMedia?: boolean;
    debug?: boolean;
}) => {
    const {
        hasTextElement,
        text,
        insertDefault,
        canvas,
        pendingRects,
        requestAIReply,
        setRequestAIReply,
    } = useCanvas();

    const { publish } = useDraftSession();
    const { isReady } = useAIReply();
    const { replyTo, disable: disableAutoReply } = useAutoReply();
    const { visualization } = useVisualizationContext();
    const { search } = useApps();
    const [resolvedApp, setResolvedApp] = useState<null | SimpleWebManifest>(
        null
    );
    const { peer } = usePeer();
    const privateScope = PrivateScope.useScope();

    useEffect(() => {
        if (!hasTextElement && canvas) {
            console.log("Inserting default text element");
            insertDefault({ once: true, scope: privateScope });
        }
    }, [
        hasTextElement,
        canvas?.idString,
        pendingRects.length,
        insertDefault,
        privateScope,
    ]);

    useEffect(() => {
        const trimmed = text?.trim();
        if (trimmed) {
            search(trimmed).then((apps) => setResolvedApp(apps[0] || null));
        } else {
            setResolvedApp(null);
        }
    }, [text, search]);

    const { appSelectOpen, setAppSelectOpen } = useEditTools();
    const onToggleAppSelect = (open: boolean | null) => {
        if (open != null) setAppSelectOpen(open);
        else setAppSelectOpen((prev) => !prev);
    };

    const AddButton = () => (
        <button
            onClick={() => onToggleAppSelect(null)}
            className="btn btn-icon p-0 m-0 h-full"
        >
            <FaPlus
                className={`ml-[-2] mt-[-2] w-8 h-8 transition-transform duration-300 ${
                    appSelectOpen ? "rotate-45" : "rotate-0"
                }`}
            />
        </button>
    );

    // Fullscreen branch unchanged
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
        );
    }

    const isChat = visualization?.view === ChildVisualization.CHAT;
    const colorStyle =
        "dark:bg-neutral-700 " + (isChat ? "bg-neutral-200" : "bg-neutral-50");

    return (
        <div
            className={`flex flex-col z-20 w-full left-0  ${colorStyle} ${
                props.className || ""
            }`}
        >
            {/* Top area: (unchanged) images canvas above toolbar */}

            {/* First row: input */}
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
                <TextCanvas
                    fitWidth
                    fitHeight
                    draft
                    className="pt-2 rounded min-h-10 justify-center"
                    requestPublish={publish}
                />
            </div>

            <div
                className=" flex justify-left "
                style={
                    props.overlayRichMedia
                        ? {
                              position: "absolute",
                              top: "0",
                              transform: "translateY(-100%)",
                          }
                        : {}
                }
            >
                <ImageCanvas draft={false} requestPublish={publish}>
                    <ImageUploadTrigger
                        onFileChange={() => onToggleAppSelect(false)}
                        className="btn-elevated btn-icon btn-icon-md btn-toggle flex items-center justify-center bg-white dark:bg-black"
                    >
                        <FaPlus className="btn-icon-md" />
                    </ImageUploadTrigger>
                </ImageCanvas>
            </div>

            {/* Second row: toolbar buttons (unchanged layout) */}
            <div className="flex items-center p-1 pt-0 ">
                {AddButton()}

                <AiToggle
                    onPressedChange={(e) => setRequestAIReply(e)}
                    disabled={!isReady}
                    pressed={requestAIReply}
                />

                <div className="flex justify-center ">
                    {resolvedApp && (
                        <AppButton
                            app={resolvedApp}
                            onClick={(insertDefaultValue) => {
                                if (!insertDefaultValue) return;
                                insertDefault({
                                    app: resolvedApp,
                                    increment: true,
                                    scope: privateScope,
                                });
                            }}
                            className="btn items-center px-2 p-1"
                            orientation="horizontal"
                            showTitle
                        />
                    )}
                </div>

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
                            <MdClear className="animated-bg-btn [--inner-bg:theme('colors.primary.900')] dark:[--inner-bg:theme('colors.primary.200')] text-white dark:text-black " />
                        </button>
                    )}

                <PrivacySwitch className="ml-auto" />
                <SaveButton
                    onClick={() => props.setInlineEditorActive(false)}
                    icon={BsSend}
                />
            </div>
        </div>
    );
};
