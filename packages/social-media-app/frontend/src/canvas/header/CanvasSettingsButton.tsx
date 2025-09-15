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
                    <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 p-6 rounded-lg shadow-lg w-11/12 max-w-md bg-neutral-100 dark:bg-neutral-900 z-30">
                        <Dialog.Title className="text-lg font-bold mb-4">
                            Canvas Details
                        </Dialog.Title>

                        <p className="mb-2">
                            Element Count: {elementsInfo.elements.length}
                            Expected Element Count:{" "}
                            {elementsInfo.expectedElementCount}
                        </p>
                        <ul className="space-y-1 mb-6">
                            {elementsInfo.elements.map((info, idx) => (
                                <li key={idx}>
                                    Type: {info.type}
                                    {info.url && (
                                        <a
                                            href={info.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="block break-all text-blue-500 underline"
                                        >
                                            {info.url}
                                        </a>
                                    )}
                                </li>
                            ))}
                        </ul>

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
