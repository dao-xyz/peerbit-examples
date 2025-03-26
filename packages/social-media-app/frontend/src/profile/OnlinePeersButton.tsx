import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { FaUserGroup } from "react-icons/fa6";
import { PublicSignKey } from "@peerbit/crypto";
import { ProfileButton } from "./ProfileButton";

// A simple button to display online peers count
export const OnlinePeersButton = (props: { peers: PublicSignKey[] }) => (
    <div className="flex flex-row justify-center items-center gap-1">
        <FaUserGroup />
        <span
            className="text-xs"
            style={{
                marginLeft: "-2px",
                marginTop: "-9px",
            }}
        >
            {props.peers.length || 0}
        </span>
    </div>
);

// The dropdown component that shows profiles in a scrollable list
export const OnlineProfilesDropdown = (props: { peers: PublicSignKey[] }) => {
    return (
        <DropdownMenu.Root>
            {/* Trigger for the dropdown */}
            <DropdownMenu.Trigger asChild>
                <button className="flex btn p-1 items-center">
                    <OnlinePeersButton peers={props.peers} />
                </button>
            </DropdownMenu.Trigger>

            {/* Dropdown content: a scrollable list of profiles */}
            <DropdownMenu.Content
                className="flex flex-col gap-2"
                sideOffset={5}
            >
                {props.peers.map((peer) => (
                    <DropdownMenu.Item asChild key={peer.toString()}>
                        <ProfileButton
                            publicKey={peer}
                            size={32}
                            direction="row"
                        />
                    </DropdownMenu.Item>
                ))}
            </DropdownMenu.Content>
        </DropdownMenu.Root>
    );
};
