import { useEffect, useRef, useState, forwardRef } from "react";
import { useNames } from "./names/useNames";
import { MdSave, MdEdit } from "react-icons/md";
import { Path } from "./room/Path";
import { PiUserCircleThin } from "react-icons/pi";
export const Header = forwardRef((props: any, ref) => {
    let [showInput, setShowInput] = useState(false);
    let inputRef = useRef<HTMLInputElement>();
    const { name, setName } = useNames();
    const [localName, setLocalName] = useState(name || "");

    useEffect(() => {
        if (name != null) {
            setLocalName(name);
        }
    }, [name]);
    useEffect(() => {
        if (!inputRef.current) {
            return;
        }

        let listener = (e) => {
            if (!inputRef.current) {
                return;
            }
            const rect = inputRef.current.getBoundingClientRect();
            if (
                rect.left < e.clientX &&
                e.clientX < rect.right &&
                rect.top < e.clientY &&
                e.clientY < rect.bottom
            ) {
                // inside
            } else {
                setShowInput(false);
            }
        };
        globalThis.addEventListener("click", listener);
        return () => globalThis.removeEventListener("click", listener);
    }, [inputRef.current]);

    const saveName = () => {
        setName(localName);
        setShowInput(false);
    };

    return (
        <div
            ref={ref as any}
            className="flex flex-row w-full pl-4 pr-4 pt-2 pb-2 items-center"
        >
            <span className="opacity-50">dao | xyz</span>
            <div className="ml-auto">
                {!showInput && (
                    <div
                        className="flex flex-row items-center cursor-pointer"
                        onClick={() => {
                            setShowInput(true);
                        }}
                    >
                        <div>
                            {name ? (
                                <span>{name || ""}</span>
                            ) : (
                                <button className="btn-icon btn-icon-md">
                                    <PiUserCircleThin />
                                </button>
                            )}{" "}
                        </div>
                    </div>
                )}
                {showInput && (
                    <div className="flex-row items-center p-1">
                        <div>
                            <input
                                ref={inputRef}
                                onKeyDown={(e) =>
                                    e.key === "Enter" && saveName()
                                }
                                id="name-input"
                                className="ml-auto"
                                placeholder="Name"
                                value={localName}
                                onChange={(e) => {
                                    setLocalName(e.target.value);
                                }}
                            />
                        </div>
                        <div className="ml-1">
                            <button onClick={saveName}>
                                <MdSave className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
});
