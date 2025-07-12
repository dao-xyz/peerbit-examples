import { ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { MdOutlineDarkMode, MdOutlineLightMode } from "react-icons/md";
import { ProfileButton } from "./profile/ProfileButton";
import { usePeer } from "@peerbit/react";
import { Spinner } from "./utils/Spinner";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useNavigate } from "react-router";
import { CONNECT_DEVICES } from "./routes";
import { useCanvases } from "./canvas/useCanvas";
import { useThemeContext } from "./theme/useTheme";
import { useHeaderVisibilityContext } from "./HeaderVisibilitiyProvider";
import { buildCommit } from "./utils";
import { CanvasPathInput } from "./canvas/path/CanvasPathInput";
import { MdKeyboardDoubleArrowUp } from "react-icons/md";
import { useFocusProvider } from "./FocusProvider";
import { useFeed } from "./canvas/feed/FeedContext";
import { useCssVarHeight } from "./utils/useCssVarHeight";

// Define props interface
interface HeaderProps {
    children?: ReactNode;
    fullscreen?: boolean;
}

export const Header = (props: HeaderProps) => {
    // Read initial theme from localStorage or default to "light"
    const { toggleTheme, theme } = useThemeContext();
    const { peer } = usePeer();
    const { path } = useCanvases();
    const navigate = useNavigate();
    const { visible: headerIsVisible } = useHeaderVisibilityContext();

    const ref = useCssVarHeight<HTMLDivElement>({ cssVar: "--header-h" });

    const { view } = useFeed();

    // show profile button if we are at the root of the path, or screen is wider than sm
    const showProfileButton = path.length <= 1 || window.innerWidth >= 640;

    const { onScrollToTop, scrollToTop, focused } = useFocusProvider();

    return (
        <div
            ref={ref}
            className={`flex flex-row w-full relative  h-full justify-center `}
        >
            {!props.fullscreen && (
                <div
                    className={`flex flex-row max-w-[876px] items-start w-full px-1  z-50 bg-neutral-50 dark:bg-neutral-900 py-1`}
                >
                    <CanvasPathInput
                        className="py-1 px-1" /* className={"transition-padding ease-in-out duration-500 " + (headerIsVisible ? "p-1" : "p-0")}  */
                    />
                    {view.id === "chat" && focused && (
                        <button
                            className="btn flex flex-row p-1 gap-1"
                            onClick={scrollToTop}
                        >
                            <span className="flex flex-row text-nowrap text-sm">
                                Go to top
                            </span>
                            <MdKeyboardDoubleArrowUp size={20} />
                        </button>
                    )}

                    {/*  TODO do we really need to set the z-index to 2 here? */}
                    {(view.id !== "chat" || !focused) && showProfileButton && (
                        <div className="z-4 col-start-10 flex items-center ">
                            {" "}
                            {/*  last class is needed to prevent max-h-[inherit] to be applied to the menu*/}
                            {peer ? (
                                <DropdownMenu.Root>
                                    <DropdownMenu.Trigger asChild>
                                        <ProfileButton
                                            size={26}
                                            className="h-full"
                                            publicKey={peer.identity.publicKey}
                                        />
                                    </DropdownMenu.Trigger>
                                    <DropdownMenu.Content
                                        className="z-10 bg-white dark:bg-neutral-950 p-2 rounded shadow-md max-h-[unset]"
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
                                                console.log("Share profile")
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
                                        <DropdownMenu.Item
                                            disabled /* keeps menu open */
                                            className="menu-item cursor-default select-text text-xs text-neutral-500"
                                        >
                                            {`Version ${buildCommit}`}
                                        </DropdownMenu.Item>
                                    </DropdownMenu.Content>
                                </DropdownMenu.Root>
                            ) : (
                                <Spinner />
                            )}
                        </div>
                    )}
                </div>
            )}
            {/* background blur overlay over content (header still visible)*/}
            {/* {isBreadcrumbExpanded && (
                <div
                    onClick={() => setIsBreadcrumbExpanded(false)}
                    className="absolute h-screen  inset-0 z-30 transparent"
                ></div>
            )} */}
            {props.children}
        </div>
    );
};
