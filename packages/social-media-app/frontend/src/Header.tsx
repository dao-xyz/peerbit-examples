import { useState, forwardRef, ReactNode } from "react";
import { MdOutlineDarkMode, MdOutlineLightMode } from "react-icons/md";
import { CanvasPath } from "./context/CanvasPath";
import { ProfileButton } from "./profile/ProfileButton";
import { usePeer } from "@peerbit/react";
import { Spinner } from "./utils/Spinner";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useNavigate } from "react-router-dom";
import { CONNECT_DEVICES, getCanvasPath } from "./routes";
import { HeaderLogo } from "./Logo";
import { useCanvases } from "./canvas/useCanvas";
import { IoIosArrowBack } from "react-icons/io";

// Define props interface
interface HeaderProps {
    children?: ReactNode;
    fullscreen?: boolean;
}

export const Header = forwardRef((props: HeaderProps, ref) => {
    // Read initial theme from localStorage or default to "light"
    const [theme, setTheme] = useState<"dark" | "light">(
        localStorage.theme || "light"
    );
    const [isBreadcrumbExpanded, setIsBreadcrumbExpanded] = useState(false); // Add breadcrumbExpanded state
    const { peer } = usePeer();
    const { path } = useCanvases();
    const navigate = useNavigate();

    // Toggle the dark/light mode
    const toggleTheme = () => {
        const newTheme = theme === "dark" ? "light" : "dark";
        localStorage.theme = newTheme;
        setTheme(newTheme);
        if (newTheme === "dark") {
            document.documentElement.classList.add("dark");
        } else {
            document.documentElement.classList.remove("dark");
        }
    };

    return (
        <div
            ref={ref as any}
            className="grid h-full w-full grid-cols-[0.5rem_auto_0.5rem_1fr_min-content_0.5rem_minmax(0%,var(--container-xl))_1fr_0.5rem_auto_0.5rem] grid-rows-[0.5rem_auto_0.5rem_1fr]"
        >
            {!props.fullscreen && (
                <>
                    <div className="col-span-full row-start-1 bg-neutral-50 dark:bg-neutral-950"></div>
                    <div className="col-start-2 flex items-center">
                        <HeaderLogo />
                    </div>
                    {path.length > 1 && (
                        <button
                            className="col-start-5 btn btn-icon flex flex-row items-center gap-1 h-8 self-center"
                            onClick={() => {
                                navigate(
                                    getCanvasPath(path[path.length - 2]),
                                    {}
                                );
                            }}
                        >
                            <IoIosArrowBack size={15} />
                        </button>
                    )}
                    <div className="col-start-7 relative flex h-full w-full items-center">
                        <div className="w-full h-[40px] overflow-hidden">
                            <CanvasPath
                                isBreadcrumbExpanded={isBreadcrumbExpanded}
                                setIsBreadcrumbExpanded={
                                    setIsBreadcrumbExpanded
                                }
                            />
                        </div>
                    </div>

                    <div className="z-40 col-start-10 flex items-center">
                        {peer ? (
                            <DropdownMenu.Root>
                                <DropdownMenu.Trigger asChild>
                                    <ProfileButton
                                        size={40}
                                        publicKey={peer.identity.publicKey}
                                    />
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Content
                                    className="bg-white dark:bg-neutral-950 p-2 rounded shadow-md"
                                    style={{ minWidth: "200px" }}
                                >
                                    <DropdownMenu.Item
                                        className="menu-item"
                                        onSelect={() =>
                                            console.log("See profile")
                                        }
                                    >
                                        See Profile
                                    </DropdownMenu.Item>
                                    <DropdownMenu.Item
                                        className="menu-item"
                                        onSelect={() =>
                                            console.log("Shareß profile")
                                        }
                                    >
                                        Share Profile
                                    </DropdownMenu.Item>
                                    <DropdownMenu.Item
                                        className="menu-item"
                                        onSelect={() =>
                                            console.log("Change identity")
                                        }
                                    >
                                        Change Identity
                                    </DropdownMenu.Item>
                                    <DropdownMenu.Item
                                        className="menu-item"
                                        onSelect={() =>
                                            navigate(CONNECT_DEVICES, {})
                                        }
                                    >
                                        Connect Devices
                                    </DropdownMenu.Item>

                                    <hr className="my-1" />
                                    {/* Custom theme toggle that prevents menu closing */}
                                    <DropdownMenu.Item asChild>
                                        <div
                                            className="menu-item"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                toggleTheme();
                                            }}
                                        >
                                            {theme === "dark" ? (
                                                <div className="flex items-center gap-2">
                                                    <MdOutlineLightMode />
                                                    <span>
                                                        Turn on the lights
                                                    </span>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-2">
                                                    <MdOutlineDarkMode />
                                                    <span>
                                                        Turn off the lights
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    </DropdownMenu.Item>
                                </DropdownMenu.Content>
                            </DropdownMenu.Root>
                        ) : (
                            <Spinner />
                        )}
                    </div>
                    <div className="col-span-full row-start-3 bg-neutral-50 dark:bg-neutral-950"></div>
                    {/* overlay with expanded breadcrumbs and search results */}
                    {isBreadcrumbExpanded && (
                        <div className="sm:col-span-1 col-span-full sm:col-start-7 col-start-1 row-span-2 sm:row-start-3 row-start-4 z-40 sm:pb-10">
                            <div className="w-full h-full sm:h-fit sm:max-h-full overflow-y-auto sm:border sm:rounded-md sm:bg-neutral-50 dark:sm:bg-neutral-950">
                                <div className="h-[120vh] w-full"></div>
                            </div>
                        </div>
                    )}
                </>
            )}
            <div className="col-span-full relative row-start-4 overflow-hidden">
                {/* background blur overlay over content (header still visible)*/}
                {isBreadcrumbExpanded && (
                    <div className="absolute inset-0 z-30 backdrop-blur-3xl sm:bg-neutral-50/50 dark:sm:bg-neutral-950/50 bg-neutral-50/80 dark:bg-neutral-950/80"></div>
                )}

                <div className="w-full h-full">{props.children}</div>
            </div>
        </div>
    );
});
