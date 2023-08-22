import { MdAdd } from "react-icons/md";
import { useRef, useState } from "react";
import Twitch from "./assets/twitch-filled.png";
import { MdVideoCall, MdChat } from "react-icons/md";
import { IFrameContent, ElementContent } from "@dao-xyz/social";
import { CHAT_APP, getChatPath, getStreamPath, STREAMING_APP } from "../routes";
import { Identity } from "@peerbit/crypto";
import Tags from "@yaireo/tagify/dist/react.tagify";
import { IoMdSend } from "react-icons/io";
import { useApps } from "../useApps";
import Tagify from "@yaireo/tagify";

export type ElementGenerator = (properties: {
    keypair: Identity;
}) => ElementContent;

export const AddElement = (properties: {
    onContent?: (generator: ElementGenerator) => void;
}) => {
    const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
    const open = Boolean(anchorEl);
    const handleClick = (event: React.MouseEvent<HTMLElement>) => {
        setAnchorEl(event.currentTarget);
    };
    const handleClose = () => {
        setAnchorEl(null);
    };
    const tagifyRef1 = useRef<Tagify>();

    const btn = useRef(null);
    return (
        <div className="flex flex-row">
            <Tags
                tagifyRef={tagifyRef1}
                settings={{
                    /*  ...settings, */

                    templates: {
                        tag(tagData: any, _ref: Tagify) {
                            let _s = _ref.settings;
                            console.log(tagData);
                            let tagString = `<tag title="${
                                tagData.title || tagData.value
                            }"
                                      contenteditable='false'
                                      spellcheck='false'
                                      tabIndex="${
                                          _s.a11y.focusableTags ? 0 : -1
                                      }"
                                      class="${_s.classNames.tag} ${
                                tagData.class || ""
                            }"
                                      ${this.getAttributes(tagData)}>

                              <x title='' class="${
                                  _s.classNames.tagX
                              }" role='button' aria-label='remove tag'></x>
                            <img class="w-4 h-4 ml-2"  src=${
                                tagData.icon
                            }></img>
                              <div>
                                  <span class="${_s.classNames.tagText}">${
                                tagData[_s.tagTextProp] || tagData.value
                            }</span>
                              </div>
                          </tag>`;

                            /*  if (!isFirst) {
                                 tagString = `<span class="${_s.classNames.tag} border-none p-0 m-0">${tagString}</span>`
     
                             } */
                            return tagString;
                        },
                    },
                }}
                className="customLook"
                /*  whitelist={apps.map(x => { return { ...x, value: x.name } })}
                 defaultValue={apps.map(x => { return { ...x, value: x.name } })} */
                autoFocus={true}
                /*       {...tagifyProps}
                      onChange={onChange} */
                onInput={(e) => {
                    const currentText: string =
                        tagifyRef1.current["state"].inputText.trim();
                    if (currentText.length > 1 && currentText.endsWith("/")) {
                        // insert path
                        tagifyRef1.current.addTags(
                            currentText.substring(0, currentText.length - 1)
                        );
                        tagifyRef1.current.DOM.input.innerHTML = "";
                    }
                }}
            />
            <button className="btn-icon btn-icon-md">
                <IoMdSend />
            </button>
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
        </div>
    );
};
