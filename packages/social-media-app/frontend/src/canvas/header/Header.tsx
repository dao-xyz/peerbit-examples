import { useState } from "react";
import { ProfileButton } from "../../profile/ProfileButton";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { HiDotsHorizontal } from "react-icons/hi";
import { usePeer } from "@peerbit/react";
import { useProfiles } from "../../profile/useProfiles";
import { Canvas, IFrameContent } from "@dao-xyz/social";
import RelativeTimestamp from "./RelativeTimestamp";
import { WithContext } from "@peerbit/document";
import * as Dialog from "@radix-ui/react-dialog";

export const Header = ({
    canvas,
    direction,
    className,
    variant,
    onClick,
    reverseLayout,
}: {
    canvas?: Canvas | WithContext<Canvas>;
    direction?: "row" | "col";
    className?: string;
    variant: "tiny" | "large" | "medium";
    onClick?: () => void;
    reverseLayout?: boolean;
}) => {
    const [bgColor, setBgColor] = useState("transparent");
    const { peer } = usePeer();
    const { profiles } = useProfiles();

    // State for controlling the More Info dialog and its content
    const [moreInfoOpen, setMoreInfoOpen] = useState(false);
    const [elementsInfo, setElementsInfo] = useState<
        Array<{ type: string; url?: string }>
    >([]);

    // Check if the current user is the owner of the post
    const isOwner = canvas && peer.identity.publicKey.equals(canvas.publicKey);

    // Fetch and show more info about the post's elements
    const handleMoreInfo = async () => {
        if (!canvas) return;
        try {
            const elements = await canvas.elements.index.iterate({}).all();
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
                    className={`flex ${
                        reverseLayout ? "flex-row-reverse" : ""
                    } items-center ${
                        variant === "large"
                            ? "gap-6"
                            : variant === "medium"
                            ? "gap-3"
                            : "gap-1.5"
                    } ${direction === "col" ? "flex-col" : "flex-row"} ${
                        className ?? ""
                    }`}
                    style={
                        {
                            "--bgcolor": bgColor
                                .replace("rgb", "rgba")
                                .replace(")", ",0.2)"),
                        } as React.CSSProperties
                    }
                >
                    <div
                        className={`overflow-hidden flex ${
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
                            onClick={onClick}
                        />
                    </div>
                    {"__context" in canvas && (
                        <RelativeTimestamp
                            timestamp={
                                new Date(
                                    Number(
                                        canvas.__context.created /
                                            BigInt(1000000)
                                    )
                                )
                            }
                            className={
                                variant === "large" || variant === "medium"
                                    ? "text-sm"
                                    : "text-xs"
                            }
                            onClick={onClick}
                        />
                    )}

                    {/* Additional management menu for the post if the user is the author */}
                    {isOwner && variant !== "tiny" && (
                        <DropdownMenu.Root>
                            <DropdownMenu.Trigger asChild>
                                <button
                                    className={
                                        "btn btn-icon btn-icon-sm " +
                                        (direction === "col"
                                            ? "mt-auto"
                                            : "ml-auto")
                                    }
                                >
                                    <HiDotsHorizontal size={20} />
                                </button>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Content className="dropdown-menu-responsive bg-white dark:bg-black p-2 rounded shadow-md">
                                <DropdownMenu.Item
                                    className="menu-item"
                                    onSelect={() => {
                                        // Handler to delete the post
                                        console.log("Delete post");
                                    }}
                                >
                                    Delete Post
                                </DropdownMenu.Item>
                                <DropdownMenu.Item
                                    className="menu-item"
                                    onSelect={() => {
                                        return profiles.create({
                                            profile: canvas,
                                        });
                                    }}
                                >
                                    Set as Profile Photo
                                </DropdownMenu.Item>
                                <DropdownMenu.Item
                                    className="menu-item"
                                    onSelect={handleMoreInfo}
                                >
                                    More info
                                </DropdownMenu.Item>
                            </DropdownMenu.Content>
                        </DropdownMenu.Root>
                    )}
                </div>
            )}

            {/* Dialog to display the additional post information */}
            <Dialog.Root open={moreInfoOpen} onOpenChange={setMoreInfoOpen}>
                <Dialog.Portal>
                    <Dialog.Overlay className="fixed inset-0 " />
                    <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2  p-6 rounded-lg shadow-lg w-6/12 max-w-md bg-neutral-100 dark:bg-neutral-900 z-20">
                        <Dialog.Title>
                            <h2>Post Details</h2>
                        </Dialog.Title>
                        <div className="space-y-2">
                            <p>Element Count: {elementsInfo.length}</p>
                            <ul>
                                {elementsInfo.map((info, index) => (
                                    <li key={index} className="py-1">
                                        <span>Type: </span>
                                        {info.type}
                                        {info.url && (
                                            <>
                                                <a
                                                    href={info.url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="ml-2 text-blue-500 underline"
                                                >
                                                    {info.url}
                                                </a>
                                            </>
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
