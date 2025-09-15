import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { HiDotsHorizontal } from "react-icons/hi";
import { usePeer } from "@peerbit/react";
import { useProfiles } from "../../profile/useProfiles";
import { useStream } from "../feed/StreamContext";
import {
    Canvas,
    getOwnedElementsQuery,
    IFrameContent,
    IndexableCanvas,
} from "@giga-app/interface";
import { WithIndexedContext } from "@peerbit/document";
import { CreateNewViewMenuItem } from "../feed/CreateNewViewMenuItem";

/**
 * A drop-in “settings” button for a canvas.
 * Place it anywhere in the tree, pass the canvas instance (and optionally
 * an `onOpen` callback if you want the “Open” item to route somewhere).
 *
 * Usage:
 *   <CanvasSettingsButton canvas={canvas} onOpen={() => …} />
 */
export const CanvasSettingsButton = ({
    canvas,
    onOpen,
    className,
}: {
    canvas: Canvas | WithIndexedContext<Canvas, IndexableCanvas>;
    onOpen?: () => void;
    className?: string; // optional className for styling
}) => {
    /* ─────────────────── hooks & deps ─────────────────── */
    const { peer } = usePeer();
    const { create } = useProfiles();
    const { dynamicViews, pinToView } = useStream();

    /* ─────────────────── “More info” state ─────────────────── */
    const [infoOpen, setInfoOpen] = useState(false);
    const [elementsInfo, setElementsInfo] = useState<{
        elements: Array<{ type: string; url?: string }>;
        expectedElementCount: number;
    }>({ elements: [], expectedElementCount: 0 });

    const handleMoreInfo = async () => {
        if (!canvas) return;
        try {
            const elements = await canvas.elements.index
                .iterate({ query: getOwnedElementsQuery(canvas) })
                .all();

            setElementsInfo({
                elements: elements.map((x) =>
                    x.content instanceof IFrameContent
                        ? { type: "IFrame", url: x.content.src }
                        : { type: x.content.constructor.name }
                ),
                expectedElementCount: Number(
                    (canvas as WithIndexedContext<Canvas, IndexableCanvas>)
                        .__indexed.elements
                ),
            });
            setInfoOpen(true);
        } catch (err) {
            console.error("Failed to fetch elements info", err);
        }
    };

    /* ─────────────────── render ─────────────────── */
    return (
        <>
            {/* ───── trigger (⋯) ───── */}
            <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                    <button className={"btn btn-icon btn-icon-sm " + className}>
                        <HiDotsHorizontal size={20} />
                    </button>
                </DropdownMenu.Trigger>

                {/* ───── menu ───── */}
                <DropdownMenu.Content className="dropdown-menu-responsive bg-white dark:bg-black p-2 rounded shadow-md">
                    <DropdownMenu.Item className="menu-item" onSelect={onOpen}>
                        Open
                    </DropdownMenu.Item>

                    {/* owner-only actions */}
                    {peer.identity.publicKey.equals(canvas.publicKey) && (
                        <>
                            <DropdownMenu.Item
                                className="menu-item"
                                onSelect={() => console.log("Delete post")}
                            >
                                Delete Post
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                                className="menu-item"
                                onSelect={() => create({ profile: canvas })}
                            >
                                Set as Profile Photo
                            </DropdownMenu.Item>
                        </>
                    )}

                    {/* always available */}
                    <DropdownMenu.Item
                        className="menu-item"
                        onSelect={handleMoreInfo}
                    >
                        More info
                    </DropdownMenu.Item>

                    {/* add-to-view submenu */}
                    <DropdownMenu.Sub>
                        <DropdownMenu.SubTrigger className="menu-item flex justify-between">
                            Add to view
                        </DropdownMenu.SubTrigger>
                        <DropdownMenu.SubContent
                            alignOffset={-4}
                            className="dropdown-menu-responsive bg-white dark:bg-black p-2 rounded shadow-md max-h-[280px] overflow-y-auto"
                        >
                            {dynamicViews.length > 0 ? (
                                <>
                                    <DropdownMenu.Label className="px-4 py-1 text-xs text-primary-600">
                                        Your views
                                    </DropdownMenu.Label>
                                    {dynamicViews.map((v) => (
                                        <DropdownMenu.Item
                                            key={v.id}
                                            onSelect={() =>
                                                pinToView(v, canvas)
                                            }
                                            className="cursor-pointer px-4 py-2 text-sm whitespace-nowrap hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
                                        >
                                            {v.id}
                                        </DropdownMenu.Item>
                                    ))}
                                </>
                            ) : (
                                <DropdownMenu.Item className="cursor-pointer px-4 py-2 text-sm whitespace-nowrap text-gray-500">
                                    No views available
                                </DropdownMenu.Item>
                            )}

                            <DropdownMenu.Separator className="my-2 h-px bg-neutral-200 dark:bg-neutral-700" />
                            <CreateNewViewMenuItem />
                        </DropdownMenu.SubContent>
                    </DropdownMenu.Sub>
                </DropdownMenu.Content>
            </DropdownMenu.Root>

            {/* ───── “More info” dialog ───── */}
            <Dialog.Root open={infoOpen} onOpenChange={setInfoOpen}>
                <Dialog.Portal>
                    <Dialog.Overlay
                        className="fixed inset-0 z-20"
                        style={{
                            backgroundColor: "rgba(0,0,0,0.1)",
                            backdropFilter: "blur(4px)",
                        }}
                    />
                    <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 p-6 rounded-lg shadow-lg w-11/12 max-w-lg bg-neutral-100 dark:bg-neutral-900 z-30">
                        <Dialog.Title className="text-lg font-bold mb-4">
                            Canvas Details
                        </Dialog.Title>

                        <div className="grid grid-cols-2 gap-3 mb-6">
                            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-800 p-3">
                                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                                    Elements
                                </div>
                                <div className="text-2xl font-semibold">
                                    {elementsInfo.elements.length}
                                </div>
                            </div>
                            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-800 p-3">
                                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                                    Expected elements
                                </div>
                                <div className="text-2xl font-semibold">
                                    {elementsInfo.expectedElementCount}
                                </div>
                            </div>
                        </div>

                        <div className="mb-2 font-semibold">Elements</div>
                        <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-800 max-h-64 overflow-auto divide-y divide-neutral-200 dark:divide-neutral-700 mb-6">
                            {elementsInfo.elements.length === 0 ? (
                                <div className="p-3 text-sm text-neutral-500">
                                    No elements found
                                </div>
                            ) : (
                                elementsInfo.elements.map((info, idx) => (
                                    <div
                                        key={idx}
                                        className="p-3 flex items-start justify-between gap-3"
                                    >
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200">
                                                {info.type}
                                            </span>
                                        </div>
                                        {info.url ? (
                                            <a
                                                href={info.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-xs text-blue-600 dark:text-blue-400 hover:underline break-all max-w-[60%] text-right"
                                                title={info.url}
                                            >
                                                {info.url}
                                            </a>
                                        ) : (
                                            <span className="text-xs text-neutral-500">
                                                —
                                            </span>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>

                        <Dialog.Close asChild>
                            <button className="btn btn-secondary w-full">
                                Close
                            </button>
                        </Dialog.Close>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </>
    );
};
