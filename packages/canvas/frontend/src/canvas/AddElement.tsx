import { Add } from "@mui/icons-material";
import {
    Avatar,
    Divider,
    IconButton,
    ListItemIcon,
    ListItemText,
    Menu,
    MenuItem,
    MenuList,
    Typography,
} from "@mui/material";
import { useRef, useState } from "react";
import StreamIcon from "@mui/icons-material/Stream";
import Twitch from "./assets/twitch-filled.png";
import VideoCallIcon from "@mui/icons-material/VideoCall";
import ChatIcon from "@mui/icons-material/Chat";
import { IFrameContent, RectContent } from "./db";
import { CHAT_APP, getChatPath, getStreamPath, STREAMING_APP } from "../routes";
import { Ed25519Keypair } from "@peerbit/crypto";

export type ElementGenerator = (properties: {
    keypair: Ed25519Keypair;
}) => RectContent;
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
            <IconButton
                ref={btn}
                sx={{ borderRadius: 0 }}
                onClick={handleClick}
            >
                <Add />
            </IconButton>
            <Menu
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
            </Menu>
        </>
    );
};
