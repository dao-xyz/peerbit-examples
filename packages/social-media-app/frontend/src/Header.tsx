import { useEffect, useRef, useState, forwardRef } from "react";
import { useNames } from "./names/useNames";
import { MdSave } from "react-icons/md";
import { MdOutlineDarkMode, MdOutlineLightMode } from "react-icons/md";
import { PiUserCircleThin } from "react-icons/pi";
import Logo from "/android-icon-192x192.png";
import TagInput from "./context/TagInput";
import { CanvasPath } from "./context/CanvasPath";

export const Header = forwardRef((props: any, ref) => {
    const [theme, setTheme] = useState<"dark" | "light">(localStorage.theme);
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
            className="sticky top-0 flex flex-row w-full p-2 gap-2 bg-neutral-50 dark:bg-neutral-950 z-20 items-center max-h-[50px]"
        >
            {/* <span className="icon leading-[10px] ml-2 mr-2 text-neutral-500 dark:text-neutral-400 font-[monospace]">
                DAO
                <br />
                XYZ
            </span> */}
            {/* <img src={Logo} width="20px" /> */}
            <img className="mr-auto ml-2" src={Logo} width="35px" />
            <div className="mr-auto max-w-xl flex-1 max-h-[40px] overflow-visible">
                <CanvasPath />
            </div>
            <button
                className="btn-icon btn-icon-md"
                onClick={() => {
                    localStorage.theme =
                        localStorage.theme === "dark" ? "light" : "dark";
                    if (localStorage.theme === "dark") {
                        setTheme("dark");
                        document.documentElement.classList.add("dark");
                    } else {
                        setTheme("light");
                        document.documentElement.classList.remove("dark");
                    }
                }}
            >
                {theme === "dark" ? (
                    <MdOutlineLightMode />
                ) : (
                    <MdOutlineDarkMode />
                )}
            </button>
            <div>
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
