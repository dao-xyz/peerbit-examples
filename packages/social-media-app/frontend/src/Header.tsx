import { useState, forwardRef } from "react";
import { MdOutlineDarkMode, MdOutlineLightMode } from "react-icons/md";
import { CanvasPath } from "./context/CanvasPath";
import { ProfileButton } from "./profile/ProfileButton";
import { usePeer } from "@peerbit/react";
import { Spinner } from "./utils/Spinner";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useNavigate } from "react-router-dom";
import { CONNECT_DEVICES } from "./routes";
import { HeaderLogo } from "./Logo";

export const Header = forwardRef((props: any, ref) => {
    // Read initial theme from localStorage or default to "light"
    const [theme, setTheme] = useState<"dark" | "light">(
        localStorage.theme || "light"
    );
    const { peer } = usePeer();
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
            className="sticky top-0 flex flex-row w-full  gap-2 bg-neutral-50 dark:bg-neutral-950 z-20 items-center max-h-[50px]"
        >
            <HeaderLogo />
            <div className="ml-auto mr-auto max-w-xl flex-1 h-[40px] overflow-hidden">
                <CanvasPath />
            </div>

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
                            onSelect={() => console.log("See profile")}
                        >
                            See Profile
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                            className="menu-item"
                            onSelect={() => console.log("Shareß profile")}
                        >
                            Share Profile
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                            className="menu-item"
                            onSelect={() => console.log("Change identity")}
                        >
                            Change Identity
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                            className="menu-item"
                            onSelect={() => navigate(CONNECT_DEVICES, {})}
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
                                        <span>Turn on the lights</span>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2">
                                        <MdOutlineDarkMode />
                                        <span>Turn off the lights</span>
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
    );
});
