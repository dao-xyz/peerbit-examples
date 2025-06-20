import React, { useState } from "react";
import { useView } from "../reply/view/ViewContex";
import { Header } from "../header/Header";
import { CanvasPreview } from "./Preview";
import { IoColorPaletteOutline, IoSave, IoSaveOutline } from "react-icons/io5";
import { MdPublic } from "react-icons/md";
import { usePeer } from "@peerbit/react";
import { CustomizationSettings } from "../custom/CustomizationSettings";
import { useVisualization } from "../custom/CustomizationProvider";
import * as Toggle from "@radix-ui/react-toggle";
import { FiEdit } from "react-icons/fi";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MdAutoFixHigh } from "react-icons/md";
import { LuOrigami } from "react-icons/lu";
import { CanvasEditorProvider, useEditTools } from "../toolbar/ToolbarContext";
import { InlineEditor } from "../toolbar/FullscreenEditor";
import { CloseableAppPane } from "../toolbar/Toolbar";
import { ToolbarEdit } from "../toolbar/ToolbarEdit";
import { useToolbarVisibilityContext } from "../toolbar/ToolbarVisibilityProvider";
import { CanvasWrapper } from "../CanvasWrapper";
import { HIGH_QUALITY } from "@giga-app/interface";
import {
    EditModeProvider,
    useEditModeContext,
} from "../toolbar/EditModeProvider";

const DetailedViewInner: React.FC<{
    ref?: React.Ref<HTMLDivElement>;
    onEditModeChange?: (value: boolean) => void;
}> = ({ ref, onEditModeChange }) => {
    const { canvases, viewRoot } = useView();
    const { setDisabled: setBottomToolbarDisabled } =
        useToolbarVisibilityContext();
    const { peer } = usePeer();
    const { createDraft, cancelDraft } = useVisualization();
    const isOwner = viewRoot?.publicKey.equals(peer.identity.publicKey);
    const { editMode, setEditMode } = useEditModeContext();

    /* local UI state (show / hide panel) */
    const [openCustomizer, _setOpenCustomizer] = useState(false);

    const toggleOpenCustomizer = () => {
        _setOpenCustomizer((prev) => {
            let value = !prev;
            if (value) {
                createDraft();
            } else {
                cancelDraft();
            }
            return value;
        });
    };

    const toggleEditMode = (newValue?: boolean) => {
        setEditMode((prev) => {
            let value = newValue ?? !prev;
            if (value) {
                setBottomToolbarDisabled(true);
            } else {
                setBottomToolbarDisabled(false);
            }
            onEditModeChange?.(value);
            return value;
        });
    };

    const postTypes: { label: string; value: string; icon: React.ReactNode }[] =
        [
            { label: "Automatic", value: "magic", icon: <MdAutoFixHigh /> },
            { label: "Original", value: "original", icon: <LuOrigami /> },
        ];

    const [currentType, setCurrentType] = useState(postTypes[0]);
    return (
        <div className="mx-auto w-full" ref={ref}>
            {editMode ? (
                <CanvasEditorProvider pendingCanvas={viewRoot}>
                    <InlineEditor />
                    <CloseableAppPane>
                        <ToolbarEdit />
                    </CloseableAppPane>
                </CanvasEditorProvider>
            ) : (
                <CanvasPreview variant="detail" />
            )}
            {canvases.length > 1 && (
                <div className="flex flex-row justify-center items-center w-full inset-shadow-sm">
                    <Header
                        variant="medium"
                        canvas={viewRoot}
                        detailed
                        className="pb-2 h-8 "
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
                                                className={` flex flex-row items-center gap-2 cursor-pointer px-4 py-2 text-sm whitespace-nowrap transition ${
                                                    currentType === v
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
    const { viewRoot } = useView();
    return (
        <EditModeProvider>
            <CanvasWrapper canvas={viewRoot} quality={HIGH_QUALITY}>
                <DetailedViewInner onEditModeChange={onEditModeChange} />
            </CanvasWrapper>
        </EditModeProvider>
    );
};
