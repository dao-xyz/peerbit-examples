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
import ExpandedContext from "./context/ExpandedContext";
import { useThemeContext } from "./theme/useTheme";

// Define props interface
interface HeaderProps {
    children?: ReactNode;
    fullscreen?: boolean;
}

export const HEIGHT = "40px";

export const Header = forwardRef((props: HeaderProps, ref) => {
    // Read initial theme from localStorage or default to "light"
    const { toggleTheme, theme } = useThemeContext();
    const [isBreadcrumbExpanded, setIsBreadcrumbExpanded] = useState(false); // Add breadcrumbExpanded state
    const { peer } = usePeer();
    const { path } = useCanvases();
    const navigate = useNavigate();

    return (
        <div
            ref={ref as any}
            className="h-fit grid grid-rows-[auto_1fr_auto] min-h-full relative"
        >
            {!props.fullscreen && (
                <>
                    <div className="sticky top-0 inset-x-0 grid grid-cols-[0.5rem_auto_0.5rem_1fr_min-content_0.5rem_minmax(0%,var(--container-xl))_1fr_0.5rem_auto_0.5rem] grid-rows-[0.5rem_auto_0.5rem] z-40 bg-neutral-50 dark:bg-neutral-950">
                        <div className="col-span-full row-start-1 bg-neutral-50 dark:bg-neutral-950"></div>
                        <div className="col-start-2 flex items-center">
                            <HeaderLogo
                                onClick={() => setIsBreadcrumbExpanded(false)}
                            />
                        </div>
                        {path?.length > 1 && (
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
                        <div className="col-start-7 relative flex h-full w-full items-center bg-neutral-50 dark:bg-neutral-950">
                            <div
                                className={`w-full z-10 h-[${HEIGHT}] overflow-visible`}
                            >
                                <CanvasPath
                                    isBreadcrumbExpanded={isBreadcrumbExpanded}
                                    setIsBreadcrumbExpanded={
                                        setIsBreadcrumbExpanded
                                    }
                                />
                                {/* overlay with expanded breadcrumbs and search results */}
                                {isBreadcrumbExpanded && (
                                    <div
                                        onClick={() => {
                                            setIsBreadcrumbExpanded(false);
                                        }}
                                        className="fixed inset-x-0 top-14 sm:absolute sm:top-full z-40 sm:pb-10"
                                    >
                                        <div className="w-full h-full sm:h-fit sm:max-h-full overflow-y-auto sm:border-x sm:border-b sm:rounded-b-md sm:bg-neutral-50 dark:sm:bg-neutral-950">
                                            <div className="w-full p-5">
                                                <ExpandedContext />
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                            {/* helper block to cover the distance between overlay and breadcrumb bar */}
                            {isBreadcrumbExpanded && (
                                <div className="hidden sm:block absolute top-1/2 bottom-0 inset-x-0 bg-neutral-50 dark:bg-neutral-950 border-neutral-950 dark:border-neutral-50 border-x"></div>
                            )}
                        </div>

                        <div className="z-50 col-start-10 flex items-center">
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
                    </div>
                </>
            )}
            {/* background blur overlay over content (header still visible)*/}
            {isBreadcrumbExpanded && (
                <div
                    onClick={() => setIsBreadcrumbExpanded(false)}
                    className="absolute inset-0 z-30 backdrop-blur-3xl sm:bg-neutral-50/50 dark:sm:bg-neutral-950/50 bg-neutral-50/95 dark:bg-neutral-950/95"
                ></div>
            )}
            {props.children}
        </div>
    );
});
