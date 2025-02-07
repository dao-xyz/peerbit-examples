import { useEffect, useReducer, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Tags from "@yaireo/tagify/dist/react.tagify";
import "./path.css";
import Tagify from "@yaireo/tagify";
import { getRoomByPath } from "../routes";
import { getRoomPathFromURL } from "../useRooms";
import { MdSearch } from "react-icons/md";

// Tagify settings object
const baseTagifySettings = {
    onChangeAfterBlur: false,
    addTagOnBlur: false,
    //backspace: "edit",
    duplicates: true,
    placeholder: "",
    dropdown: {
        enabled: 1, // show suggestion after 1 typed character
        fuzzySearch: false, // match only suggestions that starts with the typed characters
        position: "text" as const, // position suggestions list next to typed text
        caseSensitive: true, // allow adding duplicate items if their case is different
    },
};

export const HEIGHT = "35px";
export const Path = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const [focus, setFocus] = useState(false);
    const [tags, setTags] = useState<string[]>([]);
    const tagifyInitializedAtPath = useRef<string | undefined>();
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);

    const tagifyRef = useRef<Tagify>();

    // access Tagify internal methods example:
    const clearAll = () => {
        tagifyRef.current &&
            tagifyRef.current.removeAllTags({ withoutChangeEvent: true });
    };

    const onChange = () => {
        if (!tagifyRef.current) {
            return;
        }

        const path = getRoomPathFromURL();
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
            console.log(
                "NAVIGATE TO NEW PATH",
                newPath,
                getRoomByPath(newPath)
            );
            navigate(getRoomByPath(newPath), {});
        }
    };

    useEffect(() => {
        function handleClickOutside(event) {
            // If not clicking inside the tag input and not clicking on some of the tags, set focus to false
            if (
                tagifyRef.current &&
                !tagifyRef.current.DOM.input.contains(event.target) &&
                !tagifyRef.current
                    .getTagElms()
                    .find((x) => x.contains(event.target))
            ) {
                setFocus(false);
            }
        }
        // Bind the event listener
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            // Unbind the event listener on clean up
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    useEffect(() => {
        console.log("UPDATE TAGS FROM URL .----  ", getRoomPathFromURL());
        setTags(getRoomPathFromURL());
    }, [location]);

    useEffect(() => {
        if (tagifyRef.current) {
            tagifyRef.current.removeAllTags({ withoutChangeEvent: true });
            tagifyRef.current.addTags(getRoomPathFromURL(), true);
            tagifyInitializedAtPath.current = window.location.hash;
            tagifyRef.current.DOM.input.focus();
            forceUpdate();
        }

        if (!focus) {
            tagifyInitializedAtPath.current = undefined;
        }
    }, [tagifyRef.current, focus]);
    const settings = {
        ...baseTagifySettings,
    };

    return (
        <>
            {focus ? (
                <Tags
                    tagifyRef={tagifyRef}
                    settings={{
                        ...settings,

                        templates: {
                            tag(tagData: any, _ref: Tagify) {
                                let isFirst = _ref.value.length === 0;
                                let _s = _ref.settings;

                                /*   if (!focus) {
                                  return `<tag title="${tagData.title || tagData.value} tabIndex="${_s.a11y.focusableTags ? 0 : -1}" ${this.getAttributes(tagData)} class="${_s.classNames.tag} ${tagData.class || ""} m-0 !border-hidden !pointer-events-none" ><div>${(isFirst ? "" : "/")}${(tagData[_s.tagTextProp] || tagData.value)}</div></tag>`
                              } */

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
                      tabIndex="${_s.a11y.focusableTags ? 0 : -1}"
                      class="${_s.classNames.tag} ${
                                    tagData.class || ""
                                } ${prefixCss} leading-[13px]"
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
                                return tagString;
                            },
                        },
                    }}
                    defaultValue=""
                    autoFocus={true}
                    // this function can never change and can not depend on global states such as location.pathname
                    // so we just update a state here and useEffect later to do proper change effects
                    onChange={onChange}
                    onInput={(e) => {
                        const currentText: string =
                            tagifyRef.current["state"].inputText.trim();
                        if (
                            currentText.length > 1 &&
                            currentText.endsWith("/")
                        ) {
                            // insert path
                            tagifyRef.current.addTags(
                                currentText.substring(0, currentText.length - 1)
                            );
                            tagifyRef.current.DOM.input.innerHTML = "";
                        }
                    }}
                />
            ) : (
                <button
                    className="tagify  btn w-full leading-normal  p-1 pl-4 pr-4 flex flex-row cursor-pointer"
                    disabled={focus}
                    onClick={() => {
                        setFocus(true);
                    }}
                >
                    <span>{(tags || []).join("/") || "/"}</span>
                    {focus && <>FOCUS</>}
                    <MdSearch className="ml-auto" size={20} />
                </button>
            )}
        </>
    );
};
