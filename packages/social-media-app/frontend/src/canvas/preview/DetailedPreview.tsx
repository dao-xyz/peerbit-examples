import React, { useState } from "react";
import { Header } from "../header/Header";
import { CanvasPreview } from "./Preview";
import { IoColorPaletteOutline, IoSave, IoSaveOutline } from "react-icons/io5";
import { MdPublic } from "react-icons/md";
import { usePeer } from "@peerbit/react";
import { CustomizationSettings } from "../custom/CustomizationSettings";
import * as Toggle from "@radix-ui/react-toggle";
import { FiEdit } from "react-icons/fi";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MdAutoFixHigh } from "react-icons/md";
import { LuOrigami } from "react-icons/lu";
import { CanvasEditorProvider } from "../edit/ToolbarContext";
import { InlineEditor } from "../edit/InlineEditor";
import { CloseableAppPane } from "../edit/CloseableAppPane";
import { ToolbarEdit } from "../edit/ToolbarEdit";
import { useToolbarVisibilityContext } from "../edit/ToolbarVisibilityProvider";
import { CanvasWrapper } from "../CanvasWrapper";
import { HIGH_QUALITY } from "@giga-app/interface";
import { EditModeProvider, useEditModeContext } from "../edit/EditModeProvider";
import { useVisualizationContext } from "../custom/CustomizationProvider";
import { useCanvases } from "../useCanvas";

const DetailedViewInner: React.FC<{
    ref?: React.Ref<HTMLDivElement>;
    onEditModeChange?: (value: boolean) => void;
}> = ({ ref, onEditModeChange }) => {
    const { viewRoot } = useCanvases();
    const { setDisabled: setBottomToolbarDisabled } =
        useToolbarVisibilityContext();
    const { peer } = usePeer();
    const { createDraft, cancelDraft } = useVisualizationContext();
    const isOwner = viewRoot?.publicKey.equals(peer.identity.publicKey);
    const { editMode, setEditMode } = useEditModeContext();

    /* local UI state (show / hide panel) */
    const [openCustomizer, _setOpenCustomizer] = useState(false);

    const toggleOpenCustomizer = () => {
        let value = !openCustomizer;
        if (value) {
            createDraft();
        } else {
            cancelDraft();
        }
        _setOpenCustomizer(value);
    };

    const toggleEditMode = (newValue?: boolean) => {
        let value = newValue ?? !editMode;
        if (value) {
            setBottomToolbarDisabled(true);
        } else {
            setBottomToolbarDisabled(false);
        }
        onEditModeChange?.(value);
        setEditMode(value);
    };

    const postTypes: { label: string; value: string; icon: React.ReactNode }[] =
        [
            { label: "Automatic", value: "magic", icon: <MdAutoFixHigh /> },
            { label: "Original", value: "original", icon: <LuOrigami /> },
        ];

    const [currentType, setCurrentType] = useState(postTypes[0]);
    const shouldShowMetaInfo =
        viewRoot?.path.length >
        0; /* !visualization || visualization.replies !== ReplyVisualization.NAVIGATION */
    return (
        <div className="mx-auto w-full" ref={ref}>
            {editMode ? (
                <CanvasEditorProvider
                    parent={viewRoot}
                    pendingCanvas={viewRoot}
                >
                    <InlineEditor className="pb-12 " />
                    <CloseableAppPane>
                        <ToolbarEdit onSave={() => setEditMode(false)} />
                    </CloseableAppPane>
                </CanvasEditorProvider>
            ) : (
                <CanvasPreview variant="detail" />
            )}
            {shouldShowMetaInfo && (
                <div className="flex flex-row justify-center items-center w-full inset-shadow-sm">
                    <Header
                        variant="medium"
                        canvas={viewRoot}
                        detailed
                        className="h-8 "
                        showPath={false}
                    />

                    <div className="ml-auto pr-2 flex gap-1">
                        {isOwner && (
                            <>
                                {/* {editMode && (
                                    <button
                                        onClick={async () => {
                                            await savePending();
                                            toggleEditMode(false);
                                        }}
                                        className="btn btn-icon btn-toggle btn-toggle-flat border-none  gap-2"
                                        aria-label="Save Edit"
                                    >
                                        <IoSaveOutline size={20} />
                                        <span className="hidden sm:block">Save</span>
                                    </button>
                                )} */}
                                <Toggle.Root
                                    onPressedChange={toggleEditMode}
                                    pressed={editMode}
                                    className="btn-icon btn-toggle btn-toggle-flat border-none  gap-2"
                                    aria-label="Toggle Edit"
                                >
                                    <FiEdit size={20} />
                                    <span className="hidden sm:block">
                                        Edit
                                    </span>
                                </Toggle.Root>
                            </>
                        )}
                        {isOwner && (
                            <>
                                <DropdownMenu.Root>
                                    <DropdownMenu.Trigger className=" btn btn-icon flex flex-center gap-2 flex-row ">
                                        {currentType.icon}
                                        <span className="hidden sm:block">
                                            {currentType.label}
                                        </span>
                                    </DropdownMenu.Trigger>

                                    <DropdownMenu.Content
                                        align="end"
                                        sideOffset={6}
                                        className="bg-white dark:bg-neutral-800 rounded-md shadow-lg py-2 z-30"
                                    >
                                        <DropdownMenu.Label className="px-4 py-1 text-xs text-neutral-600">
                                            Select layout
                                        </DropdownMenu.Label>
                                        {postTypes.map((v) => (
                                            <DropdownMenu.Item
                                                key={v.value}
                                                /*  onClick={() => select(v)} */
                                                className={` flex flex-row items-center gap-2 cursor-pointer px-4 py-2 text-sm whitespace-nowrap transition ${currentType === v
                                                    ? "underline font-semibold"
                                                    : "text-neutral-600 hover:text-gray-700"
                                                    }`}
                                            >
                                                {v.icon}
                                                {v.label}
                                            </DropdownMenu.Item>
                                        ))}
                                    </DropdownMenu.Content>
                                </DropdownMenu.Root>
                            </>
                        )}

                        {isOwner && (
                            <Toggle.Root
                                onPressedChange={toggleOpenCustomizer}
                                pressed={openCustomizer}
                                className="btn-icon btn-toggle btn-toggle-flat border-none  gap-2"
                                aria-label="Toggle Customize"
                            >
                                <IoColorPaletteOutline size={20} />
                                <span className="hidden sm:block">
                                    Customize
                                </span>
                            </Toggle.Root>
                        )}
                        <button
                            disabled
                            className="btn btn-icon gap-2 opacity-60"
                        >
                            <MdPublic size={20} />
                            <span className="hidden sm:block">Public</span>
                        </button>
                    </div>
                </div>
            )}

            {/* inline, mobile-friendly customisation panel ------------------- */}
            {openCustomizer && isOwner && (
                <div className="w-full p-4">
                    <CustomizationSettings onClose={toggleOpenCustomizer} />
                </div>
            )}
        </div>
    );
};

export const DetailedView: React.FC<{
    ref?: React.Ref<HTMLDivElement>;
    onEditModeChange?: (value: boolean) => void;
}> = ({ ref, onEditModeChange }) => {
    const { viewRoot } = useCanvases();
    return (
        <EditModeProvider>
            <CanvasWrapper canvas={viewRoot} quality={HIGH_QUALITY}>
                <DetailedViewInner onEditModeChange={onEditModeChange} />
            </CanvasWrapper>
        </EditModeProvider>
    );
};
