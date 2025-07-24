import { ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { MdOutlineDarkMode, MdOutlineLightMode } from "react-icons/md";
import { ProfileButton } from "./profile/ProfileButton";
import { usePeer } from "@peerbit/react";
import { Spinner } from "./utils/Spinner";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useNavigate } from "react-router";
import { CONNECT_DEVICES, DRAFTS } from "./routes";
import { useThemeContext } from "./theme/useTheme";
import { buildCommit } from "./utils";
import { CanvasPathInput } from "./canvas/path/CanvasPathInput";
import { MdKeyboardDoubleArrowUp } from "react-icons/md";
import { useFocusProvider } from "./FocusProvider";
import { useCssVarHeight } from "./utils/useCssVarHeight";
import { ExperienceDropdownButton } from "./canvas/custom/ExperienceDropdown";
import { useVisualizationContext } from "./canvas/custom/CustomizationProvider";
import { ChildVisualization } from "@giga-app/interface";
import { PublishStatusButton } from "./canvas/PublishStatusButton";
import { useCanvases } from "./canvas/useCanvas";
import { FaRegUser } from "react-icons/fa";
import { VscCommentDraft } from "react-icons/vsc";
import { MdSwitchAccount } from "react-icons/md";
import { TbPlugConnected } from "react-icons/tb";


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

    const ref = useCssVarHeight<HTMLDivElement>({ cssVar: "--header-h" });

    const { visualization } = useVisualizationContext();

    // show profile button if we are at the root of the path, or screen is wider than sm
    const showProfileButton = path.length <= 1 || window.innerWidth >= 640;

    const { onScrollToTop, scrollToTop, focused } = useFocusProvider();

    return (
        <div
            ref={ref}
            className={`flex flex-row w-full relative h-full justify-center `}
        >
            {!props.fullscreen && (
                <div
                    className={`flex flex-row max-w-[876px] items-start w-full px-1  z-50    rounded-b-lg bg-neutral-50 dark:bg-neutral-900`}
                >
                    <CanvasPathInput
                        className="mt-1 py-1 px-1" /* className={"transition-padding ease-in-out duration-500 " + (headerIsVisible ? "p-1" : "p-0")}  */
                    />
                    {visualization?.childrenVisualization === ChildVisualization.CHAT && focused && (
                        <button
                            className="btn  btn-sm  h-8 flex flex-row p-1 gap-1"
                            onClick={scrollToTop}
                        >
                            <span className="flex flex-row text-nowrap text-sm">
                                Go to top
                            </span>
                            <MdKeyboardDoubleArrowUp size={20} />
                        </button>
                    )}
                    <div className="flex flex-row  gap-1 my-1">
                        <ExperienceDropdownButton />
                        <PublishStatusButton />

                        {/*  TODO do we really need to set the z-index to 2 here? */}
                        {(visualization?.childrenVisualization !== ChildVisualization.CHAT || !focused) &&
                            showProfileButton && (
                                <div className="  z-4 col-start-10 flex items-center ">
                                    {" "}
                                    {/*  last class is needed to prevent max-h-[inherit] to be applied to the menu*/}
                                    {peer ? (
                                        <DropdownMenu.Root>
                                            <DropdownMenu.Trigger asChild>
                                                <ProfileButton
                                                    size={24}
                                                    className="h-full p-1 "
                                                    publicKey={
                                                        peer.identity.publicKey
                                                    }
                                                />
                                            </DropdownMenu.Trigger>
                                            <DropdownMenu.Content
                                                className="z-10 bg-white dark:bg-neutral-950 p-2 rounded shadow-md max-h-[unset]"
                                                style={{ minWidth: "200px" }}
                                            >
                                                <DropdownMenu.Item
                                                    className="menu-item"
                                                    onSelect={() =>
                                                        console.log(
                                                            "See profile"
                                                        )
                                                    }
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <FaRegUser />
                                                        <span>See profile</span>
                                                    </div>
                                                </DropdownMenu.Item>
                                                <DropdownMenu.Item
                                                    className="menu-item"
                                                    onSelect={() =>
                                                        navigate(DRAFTS, {})
                                                    }
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <VscCommentDraft />
                                                        <span>See drafts</span>
                                                    </div>
                                                </DropdownMenu.Item>
                                                {/*   <DropdownMenu.Item
                                                    className="menu-item"
                                                    onSelect={() =>
                                                        console.log(
                                                            "Share profile"
                                                        )
                                                    }
                                                >
                                                    Share Profile
                                                </DropdownMenu.Item> */}
                                                <DropdownMenu.Item
                                                    className="menu-item"
                                                    onSelect={() =>
                                                        console.log(
                                                            "Change identity"
                                                        )
                                                    }
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <MdSwitchAccount />
                                                        <span>Change identity</span>
                                                    </div>
                                                </DropdownMenu.Item>
                                                <DropdownMenu.Item
                                                    className="menu-item"
                                                    onSelect={() =>
                                                        navigate(
                                                            CONNECT_DEVICES,
                                                            {}
                                                        )
                                                    }
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <TbPlugConnected />
                                                        <span>Connect devices</span>
                                                    </div>
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
                                                                    Turn on the
                                                                    lights
                                                                </span>
                                                            </div>
                                                        ) : (
                                                            <div className="flex items-center gap-2">
                                                                <MdOutlineDarkMode />
                                                                <span>
                                                                    Turn off the
                                                                    lights
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
