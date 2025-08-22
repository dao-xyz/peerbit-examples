import { usePeer } from "@peerbit/react";
import { useCanvases } from "../useCanvas";
import * as Toggle from "@radix-ui/react-toggle";
import { IoColorPaletteOutline } from "react-icons/io5";
import { MdPublic } from "react-icons/md";
import { useVisualizationContext } from "../custom/CustomizationProvider";
import { useState } from "react";
import { PublishStatusButton } from "../PublishStatusButton";
import { useEditModeContext } from "./EditModeProvider";
import { CustomizationSettings } from "../custom/CustomizationSettings";
import { usePendingCanvas } from "./PendingCanvasContext";

export const TopEditBar = (properties?: {
    className?: string;
    onEditModeChange?: (value: boolean) => void;
}) => {
    const { viewRoot } = useCanvases();

    const { peer } = usePeer();
    const { createDraft, cancelDraft } = useVisualizationContext();
    const isOwner = viewRoot?.publicKey.equals(peer.identity.publicKey);
    const { } = usePendingCanvas()

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

    const { editMode } = useEditModeContext();
    const { hasUnpublishedChanges, pendingCanvas } = usePendingCanvas();

    if (!editMode) {
        return <></>;
    }

    return (
        <div
            className={
                " w-full flex flex-col gap-1 bg-primary-100 dark:bg-primary-900 " +
                properties.className
            }
        >
            <div className=" flex ">
                {/* {isOwner && (
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
        )} */}

                {isOwner && (
                    <Toggle.Root
                        onPressedChange={toggleOpenCustomizer}
                        pressed={openCustomizer}
                        className="btn-icon btn-sm btn-toggle btn-toggle-flat border-none  gap-2"
                        aria-label="Toggle Customize"
                    >
                        <IoColorPaletteOutline size={20} />
                        <span className="hidden sm:block">Customize</span>
                    </Toggle.Root>
                )}
                <button
                    disabled
                    className="btn btn-sm btn-icon gap-2 opacity-60"
                >
                    <MdPublic size={20} />
                    <span className="hidden sm:block">Public</span>
                </button>
                <PublishStatusButton canvas={viewRoot} className="ml-auto" />
            </div>

            {/* inline, mobile-friendly customisation panel ------------------- */}
            {openCustomizer && isOwner && (
                <div className="w-full p-4">
                    <CustomizationSettings onClose={toggleOpenCustomizer} />
                </div>
            )}
        </div>
    );
};
