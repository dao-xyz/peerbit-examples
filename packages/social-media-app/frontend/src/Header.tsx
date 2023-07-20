import { useEffect, useRef, useState, forwardRef } from "react";
import { useNames } from "./names/useNames";
import { MdSave, MdEdit } from "react-icons/md";
import { Path } from "./room/Path";

export const HEIGHT = "40px";
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
            className="flex flex-row items-center w-full h-10 m-2"
            /*   sx={{
          width: "100%",
          height: HEIGHT,
          display: "flex",
          alignItems: "center",
      }} */
        >
            <Path></Path>
            <div className="ml-auto p-1">
                {!showInput && (
                    <div
                        className="flex flex-row items-center p-1 cursor-pointer"
                        onClick={() => {
                            setShowInput(true);
                        }}
                    >
                        <div>
                            {name ? (
                                <span>{name || ""}</span>
                            ) : (
                                <span className="italic">Anonymous</span>
                            )}{" "}
                        </div>
                        <div className="ml-1">
                            <MdEdit className="w-6 h-6" />
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
