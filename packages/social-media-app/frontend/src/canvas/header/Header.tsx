import React, { useEffect, useState } from "react";
import { ProfileButton } from "../../profile/ProfileButton";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { HiDotsHorizontal } from "react-icons/hi";
import { FaSpinner } from "react-icons/fa";
import { useCount, usePeer } from "@peerbit/react";
import { useProfiles } from "../../profile/useProfiles";
import {
    Canvas,
    getOwnedElementsQuery,
    IFrameContent,
} from "@giga-app/interface";
import RelativeTimestamp from "./RelativeTimestamp";
import { WithContext } from "@peerbit/document";
import * as Dialog from "@radix-ui/react-dialog";
import { FaRegComment } from "react-icons/fa";
import { MdOpenInFull } from "react-icons/md";

export const Header = ({
    canvas,
    direction,
    className,
    variant,
    open: open,
    reverseLayout,
    forwardRef,
    detailed,
}: {
    canvas?: Canvas | WithContext<Canvas>;
    direction?: "row" | "col";
    className?: string;
    variant: "tiny" | "large" | "medium";
    open?: () => void;
    reverseLayout?: boolean;
    forwardRef?: React.Ref<HTMLDivElement>;
    detailed?: boolean; // detailed view
}) => {
    const [bgColor, setBgColor] = useState("transparent");
    const { peer } = usePeer();
    const { create } = useProfiles();

    /* useEffect(() => {
        if (!canvas) return;
        if (canvas.isOrigin) {
            return;
        }
        if (canvas.context) {
            return;
        }
        canvas.loadContext();
    }, [canvas]);
 */
    const replyCount = useCount(
        canvas?.loadedReplies ? canvas.replies : undefined,
        !canvas || canvas.closed
            ? undefined
            : {
                  id: canvas.address.toString(),
                  query: canvas.getCountQuery(),
              }
    );

    // State for controlling the More Info dialog and its content.
    const [moreInfoOpen, setMoreInfoOpen] = useState(false);
    const [elementsInfo, setElementsInfo] = useState<
        Array<{ type: string; url?: string }>
    >([]);

    // Always show "More info" regardless of ownership.
    const handleMoreInfo = async () => {
        if (!canvas) return;
        try {
            const elements = await canvas.elements.index
                .iterate({ query: getOwnedElementsQuery(canvas) })
                .all();
            const info = elements.map((x) => {
                if (x.content instanceof IFrameContent) {
                    return { type: "IFrame", url: x.content.src };
                } else {
                    return { type: x.content.constructor.name };
                }
            });
            setElementsInfo(info);
            setMoreInfoOpen(true);
        } catch (error) {
            console.error("Failed to fetch elements info", error);
        }
    };

    return (
        <>
            {canvas && (
                <div
                    ref={forwardRef}
                    className={`flex px-2 pt-2 ${
                        reverseLayout ? "flex-row-reverse" : ""
                    } items-center gap-1 ${
                        direction === "col" ? "flex-col" : "flex-row"
                    } ${className ?? ""} ${variant === "large" && "w-full"}`}
                    style={
                        {
                            "--bgcolor": bgColor
                                .replace("rgb", "rgba")
                                .replace(")", ",0.2)"),
                        } as React.CSSProperties
                    }
                >
                    <div
                        className={`overflow-hidden flex mr-1 ${
                            variant === "tiny" || variant === "medium"
                                ? "rounded-full"
                                : "rounded-lg"
                        }`}
                    >
                        <ProfileButton
                            publicKey={canvas.publicKey}
                            setBgColor={setBgColor}
                            size={
                                variant === "large"
                                    ? 32
                                    : variant === "medium"
                                    ? 24
                                    : 16
                            }
                        />
                    </div>
                    {canvas.loadedContext && (
                        <div className="px-1">
                            <RelativeTimestamp
                                timestamp={
                                    new Date(
                                        Number(
                                            canvas.context.created /
                                                BigInt(1000000)
                                        )
                                    )
                                }
                                className={
                                    variant === "large" || variant === "medium"
                                        ? "text-sm"
                                        : "text-xs"
                                }
                            />
                        </div>
                    )}

                    {variant === "large" && !detailed && (
                        <>
                            {/* Show comment icon with comment counts if applicable */}

                            <button
                                className="btn flex p-2 flex-row items-center gap-1"
                                onClick={open}
                            >
                                <FaRegComment size={16} />
                                <span className="text-xs">{replyCount}</span>
                            </button>

                            {/* Show a "go to post" buttom */}
                            <button
                                className="btn flex p-2 flex-row items-center gap-1"
                                onClick={open}
                            >
                                <MdOpenInFull size={16} />
                            </button>
                        </>
                    )}

                    {/* Dropdown menu always available */}
                    <DropdownMenu.Root>
                        <DropdownMenu.Trigger
                            asChild
                            onPointerDown={(e) => {
                                console.log(e);
                                e.preventDefault();
                            }}
                        >
                            <button className={"btn btn-icon btn-icon-sm "}>
                                <HiDotsHorizontal size={20} />
                            </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content className="dropdown-menu-responsive bg-white dark:bg-black p-2 rounded shadow-md">
                            <DropdownMenu.Item
                                className="menu-item"
                                onSelect={() => open?.()}
                            >
                                Open
                            </DropdownMenu.Item>
                            {canvas &&
                                peer.identity.publicKey.equals(
                                    canvas.publicKey
                                ) &&
                                variant !== "tiny" && (
                                    <>
                                        <DropdownMenu.Item
                                            className="menu-item"
                                            onSelect={() => {
                                                console.log("Delete post");
                                            }}
                                        >
                                            Delete Post
                                        </DropdownMenu.Item>
                                        <DropdownMenu.Item
                                            className="menu-item"
                                            onSelect={() => {
                                                return create({
                                                    profile: canvas,
                                                });
                                            }}
                                        >
                                            Set as Profile Photo
                                        </DropdownMenu.Item>
                                    </>
                                )}
                            <DropdownMenu.Item
                                className="menu-item"
                                onSelect={handleMoreInfo}
                            >
                                More info
                            </DropdownMenu.Item>
                        </DropdownMenu.Content>
                    </DropdownMenu.Root>
                </div>
            )}

            {/* Dialog to display the additional post information */}
            <Dialog.Root open={moreInfoOpen} onOpenChange={setMoreInfoOpen}>
                <Dialog.Portal>
                    <Dialog.Overlay
                        className="fixed inset-0 z-20"
                        style={{
                            backgroundColor: "rgba(0,0,0,0.1)",
                            backdropFilter: "blur(4px)",
                        }}
                    />
                    <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 p-6 rounded-lg shadow-lg w-11/12 max-w-md bg-neutral-100 dark:bg-neutral-900 z-30">
                        <Dialog.Title className="text-lg font-bold mb-2">
                            Post Details
                        </Dialog.Title>
                        <div className="space-y-2">
                            <p>Element Count: {elementsInfo.length}</p>
                            <ul className="space-y-1">
                                {elementsInfo.map((info, index) => (
                                    <li key={index} className="py-1">
                                        <span>Type: {info.type}</span>
                                        {info.url && (
                                            <div className="mt-1">
                                                <a
                                                    href={info.url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-blue-500 underline break-all block"
                                                    style={{
                                                        wordBreak: "break-all",
                                                    }}
                                                >
                                                    {info.url}
                                                </a>
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <Dialog.Close asChild>
                            <div className="w-full flex">
                                <button className="mt-4 ml-auto btn btn-secondary">
                                    Close
                                </button>
                            </div>
                        </Dialog.Close>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </>
    );
};
