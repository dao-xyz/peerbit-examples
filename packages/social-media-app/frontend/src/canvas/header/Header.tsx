import { useState } from "react";
import { PublicSignKey } from "@peerbit/crypto";
import { ProfileButton } from "../../profile/ProfileButton";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { HiDotsHorizontal } from "react-icons/hi";
import { usePeer } from "@peerbit/react";
import { useProfiles } from "../../profile/useProfiles";
import { Canvas } from "@dao-xyz/social";

// Assume peer is imported or available from context

export const Header = (properties: {
    canvas?: Canvas;
    direction?: "row" | "col";
}) => {
    const [bgColor, setBgColor] = useState("transparent");
    const { peer } = usePeer();
    const { profiles } = useProfiles();

    // Check if the current user is the owner of the post
    const isOwner = peer.identity.publicKey.equals(
        properties.canvas?.publicKey
    );

    return (
        <>
            {properties.canvas && (
                <div
                    className={`flex items-center gap-4 ${
                        properties.direction === "col" ? "flex-col" : "flex-row"
                    } 
      bg-[linear-gradient(333deg,rgba(255,255,255,0.6)_34%,var(--bgcolor)_79%)]
      dark:bg-[linear-gradient(333deg,rgba(31,41,55,0.6)_34%,var(--bgcolor)_79%)]`}
                    style={
                        {
                            "--bgcolor": bgColor
                                .replace("rgb", "rgba")
                                .replace(")", ",0.2)"),
                        } as React.CSSProperties
                    }
                >
                    <ProfileButton
                        publicKey={properties.canvas.publicKey}
                        setBgColor={setBgColor}
                    />
                    {/* Additional management menu for the post if the user is the author */}
                    {isOwner && (
                        <DropdownMenu.Root>
                            <DropdownMenu.Trigger asChild>
                                <button
                                    className={
                                        "p-1 hover:bg-gray-200 rounded " +
                                        (properties.direction === "col"
                                            ? "mt-auto"
                                            : "ml-auto")
                                    }
                                >
                                    <HiDotsHorizontal size={20} />
                                </button>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Content className="bg-white dark:bg-black p-2 rounded shadow-md">
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
                                            profile: properties.canvas,
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
