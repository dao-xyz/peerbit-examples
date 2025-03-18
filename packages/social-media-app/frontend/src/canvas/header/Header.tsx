import { useState } from "react";
import { ProfileButton } from "../../profile/ProfileButton";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { HiDotsHorizontal } from "react-icons/hi";
import { usePeer } from "@peerbit/react";
import { useProfiles } from "../../profile/useProfiles";
import { Canvas } from "@dao-xyz/social";
import RelativeTimestamp from "./RelativeTimestamp";
import { WithContext } from "@peerbit/document";

// Assume peer is imported or available from context

export const Header = ({
    canvas,
    direction,
    className,
    variant,
    onClick,
}: {
    canvas?: Canvas | WithContext<Canvas>;
    direction?: "row" | "col";
    className?: string;
    variant: "tiny" | "large";
    onClick?: () => void;
}) => {
    const [bgColor, setBgColor] = useState("transparent");
    const { peer } = usePeer();
    const { profiles } = useProfiles();

    // Check if the current user is the owner of the post
    const isOwner = peer.identity.publicKey.equals(canvas?.publicKey);

    return (
        <>
            {canvas && (
                <div
                    className={`flex items-center ${
                        variant === "large" ? "gap-6" : "gap-1.5"
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
                    <ProfileButton
                        publicKey={canvas.publicKey}
                        setBgColor={setBgColor}
                        size={variant === "large" ? 32 : 16}
                        onClick={onClick}
                    />
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
                                variant === "large" ? "text-sm" : "text-xs"
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
                            {/* We use the "dropdown-menu-responsive" class to make sure the dropdown menu is rendered in the right direaction */}
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
                            </DropdownMenu.Content>
                        </DropdownMenu.Root>
                    )}
                </div>
            )}
        </>
    );
};
