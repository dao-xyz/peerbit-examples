import { usePeer } from "@peerbit/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Room } from "@dao-xyz/social";
import { useNavigate } from "react-router-dom";
import Tags from "@yaireo/tagify/dist/react.tagify";
import "./path.css";
import Tagify from "@yaireo/tagify";

// Tagify settings object
const baseTagifySettings = {
    blacklist: ["xxx", "yyy", "zzz"],
    maxTags: 6,
    onChangeAfterBlur: false,
    addTagOnBlur: false,
    //backspace: "edit",
    placeholder: "type a path",
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
    let [canvases, setCanvases] = useState<Room[]>([]);
    const [textInput, setTextInput] = useState("");
    const handleTextInputChange = (event) => {
        setTextInput(event.target.value);
    };

    const [tagifySettings, setTagifySettings] = useState([]);
    const tagifyRef1 = useRef<Tagify>();

    const [tagifyProps, setTagifyProps] = useState({});

    const onChange = useCallback((e) => {
        //console.log("CHANGED:", e.detail.value)
    }, []);

    // access Tagify internal methods example:
    const clearAll = () => {
        tagifyRef1.current && tagifyRef1.current.removeAllTags();
    };

    const settings = {
        ...baseTagifySettings,
        ...tagifySettings,
    };

    return (
        <Tags
            tagifyRef={tagifyRef1}
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
            defaultValue="🌍,My things,Dog memes"
            autoFocus={true}
            {...tagifyProps}
            whitelist={[{ value: "hello" }, { value: "world" }]}
            onChange={onChange}
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
            onEditInput={(e) => console.log("onEditInput", e)}
            onEditBeforeUpdate={() => console.log`onEditBeforeUpdate`}
            onEditUpdated={() => console.log("onEditUpdated")}
            onEditStart={() => console.log("onEditStart")}
            onEditKeydown={(e) => console.log("onEditKeydown")}
            onDropdownShow={() => console.log("onDropdownShow")}
            onDropdownHide={() => console.log("onDropdownHide")}
            onDropdownSelect={() => console.log("onDropdownSelect")}
            onDropdownScroll={() => console.log("onDropdownScroll")}
            onDropdownNoMatch={() => console.log("onDropdownNoMatch")}
            onDropdownUpdated={() => console.log("onDropdownUpdated")}
        />
    );
};
