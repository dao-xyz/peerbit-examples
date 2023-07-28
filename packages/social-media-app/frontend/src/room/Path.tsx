import { usePeer } from "@peerbit/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Room } from "@dao-xyz/social";
import { useLocation, useNavigate } from "react-router-dom";
import Tags from "@yaireo/tagify/dist/react.tagify";
import "./path.css";
import Tagify from "@yaireo/tagify";
import { getRoomByPath } from "../routes";
import { getRoomPathFromURL, useRooms } from "../useRooms";

// Tagify settings object
const baseTagifySettings = {
    onChangeAfterBlur: false,
    addTagOnBlur: false,
    //backspace: "edit",
    duplicates: true,
    placeholder: "Search",
    dropdown: {
        enabled: 1, // show suggestion after 1 typed character
        fuzzySearch: false, // match only suggestions that starts with the typed characters
        position: "text" as const, // position suggestions list next to typed text
        caseSensitive: true, // allow adding duplicate items if their case is different
    },
};

export const HEIGHT = "35px";
export const Path = () => {
    const { peer } = usePeer();
    const navigate = useNavigate();
    const location = useLocation();
    const [textInput, setTextInput] = useState("");
    const handleTextInputChange = (event) => {
        setTextInput(event.target.value);
    };
    const {} = useRooms();

    const [tagifySettings, setTagifySettings] = useState([]);

    const tagifyRef = useRef<Tagify>();

    const [tagifyProps, setTagifyProps] = useState({});

    // access Tagify internal methods example:
    const clearAll = () => {
        tagifyRef.current &&
            tagifyRef.current.removeAllTags({ withoutChangeEvent: true });
    };

    const onChange = (e) => {
        const path = getRoomPathFromURL(location.pathname);
        console.log("COMP START", path, tagifyRef.current);

        const newPath = tagifyRef.current.value.map((x) => x.value);
        let eq = newPath.length === path.length;
        if (eq) {
            for (let i = 0; i < newPath.length; i++) {
                if (newPath[i] !== path[i]) {
                    eq = false;
                    break;
                }
            }
        }

        if (!eq) {
            navigate(
                getRoomByPath(tagifyRef.current.value.map((x) => x.value)),
                {}
            );
        }
    };

    useEffect(() => {
        tagifyRef.current.removeAllTags({ withoutChangeEvent: true });
        tagifyRef.current.addTags(getRoomPathFromURL(location.pathname), true);
    }, [location.pathname]);

    const settings = {
        ...baseTagifySettings,
        ...tagifySettings,
    };

    return (
        <Tags
            tagifyRef={tagifyRef}
            settings={{
                ...settings,

                templates: {
                    tag(tagData: any, _ref: Tagify) {
                        let _s = _ref.settings;
                        let isFirst = _ref.value.length === 0;
                        let prefix = "";
                        let prefixCss = "";
                        if (!isFirst) {
                            prefix = `<span class="${_s.classNames.tagText} absolute -left-3">/</span>`;
                            prefixCss = "ml-5";
                        }

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
                        } ${prefixCss}"
                                      ${this.getAttributes(tagData)}>
                            ${prefix}
                              <x title='' class="${
                                  _s.classNames.tagX
                              }" role='button' aria-label='remove tag'></x>
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
            defaultValue=""
            autoFocus={true}
            {...tagifyProps}
            onChange={onChange}
            onInput={(e) => {
                const currentText: string =
                    tagifyRef.current["state"].inputText.trim();
                if (currentText.length > 1 && currentText.endsWith("/")) {
                    // insert path
                    tagifyRef.current.addTags(
                        currentText.substring(0, currentText.length - 1)
                    );
                    tagifyRef.current.DOM.input.innerHTML = "";
                }
            }}
        />
    );
};
