import { MdAdd } from "react-icons/md";
import { useRef, useState } from "react";
import Twitch from "./assets/twitch-filled.png";
import { MdVideoCall, MdChat } from "react-icons/md";
import { IFrameContent, ElementContent } from "@dao-xyz/social";
import { CHAT_APP, getChatPath, getStreamPath, STREAMING_APP } from "../routes";
import { Identity } from "@peerbit/crypto";

export type ElementGenerator = (properties: {
    keypair: Identity;
}) => ElementContent;
export const AddElement = (properties: {
    onContent: (generator: ElementGenerator) => void;
}) => {
    const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
    const open = Boolean(anchorEl);
    const handleClick = (event: React.MouseEvent<HTMLElement>) => {
        setAnchorEl(event.currentTarget);
    };
    const handleClose = () => {
        setAnchorEl(null);
    };

    const btn = useRef(null);
    return (
        <>
            <button
                className="btn-icon btn-icon-md"
                ref={btn}
                onClick={handleClick}
            >
                <MdAdd />
            </button>
            <input></input>
            {/*   <Menu
                anchorEl={btn.current}
                id="add-rect"
                open={open}
                onClose={handleClose}
            >
                <MenuList dense disablePadding>
                    <MenuItem
                        onClick={() => {
                            properties.onContent(
                                ({ keypair }) =>
                                    new IFrameContent({
                                        src:
                                            STREAMING_APP +
                                            getStreamPath(keypair.publicKey),
                                        resizer: false,
                                    })
                            );
                            handleClose();
                        }}
                    >
                        <ListItemIcon>
                            <VideoCallIcon fontSize="small" />
                        </ListItemIcon>
                        <ListItemText>Stream</ListItemText>
                    </MenuItem>

                    <MenuItem
                        onClick={() => {
                            properties.onContent(
                                ({ keypair }) =>
                                    new IFrameContent({
                                        src:
                                            CHAT_APP +
                                            getChatPath(keypair.publicKey),
                                        resizer: false,
                                    })
                            );
                            handleClose();
                        }}
                    >
                        <ListItemIcon>
                            <ChatIcon fontSize="small" />
                        </ListItemIcon>
                        <ListItemText>Chat</ListItemText>
                    </MenuItem>

                    <MenuItem onClick={() => console.log("website")}>
                        <ListItemIcon>
                            <Avatar
                                sx={{ width: 20, height: 20 }}
                                alt="twitch"
                                src={Twitch}
                                variant="square"
                            />
                        </ListItemIcon>

                        <ListItemText>Twitch</ListItemText>
                    </MenuItem>
                </MenuList>
            </Menu> */}
        </>
    );
};
