import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { FaUserGroup } from "react-icons/fa6";
import { PublicSignKey } from "@peerbit/crypto";
import { ProfileButton } from "./ProfileButton";
import { useOnline } from "@peerbit/react";
import clsx from "clsx";
import { useCanvases } from "../canvas/useCanvas";

// A simple button to display online peers count
const _OnlinePeersButton = (props?: { peers?: PublicSignKey[] }) => {
    let colorStyle =
        !props?.peers || props?.peers?.length === 0
            ? "text-gray-400 dark:text-gray-500"
            : "text-blue-500";

    return (
        <div className="flex flex-row justify-center items-center gap-1">
            <FaUserGroup className={colorStyle} />
            <span
                className={clsx("text-xs ", colorStyle)}
                style={{
                    marginLeft: "-2px",
                    marginTop: "-9px",
                }}
            >
                {props?.peers?.length || 0}
            </span>
        </div>
    );
};

// The dropdown component that shows profiles in a scrollable list
export const OnlineProfiles = () => {
    const canvas = useCanvases();
    const online = useOnline(canvas.leaf?.nearestScope);
    return (
        <DropdownMenu.Root>
            {/* Trigger for the dropdown */}
            <DropdownMenu.Trigger asChild>
                <button className="flex btn p-1 items-center">
                    <_OnlinePeersButton peers={online.peers} />
                </button>
            </DropdownMenu.Trigger>

            {/* Dropdown content: a scrollable list of profiles */}
            <DropdownMenu.Content
                className=" bg-neutral-200 mr-2 dark:bg-neutral-800 max-h-30 overflow-y-auto  "
                sideOffset={5}
            >
                <div className="p-2 bg-blue-200 flex flex-wrap gap-2 justify-start items-center">
                    {online?.peers.map((peer) => (
                        <DropdownMenu.Item asChild key={peer.toString()}>
                            <ProfileButton
                                publicKey={peer}
                                size={32}
                                className="shrink-0"
                                direction="row"
                            />
                        </DropdownMenu.Item>
                    ))}
                </div>
            </DropdownMenu.Content>
        </DropdownMenu.Root>
    );
};
