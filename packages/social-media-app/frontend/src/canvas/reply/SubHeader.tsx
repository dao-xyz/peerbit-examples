import { useMemo } from "react";
import { StickyHeader } from "./StickyHeader";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useView, ViewType } from "../../view/ViewContex";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import { OnlineProfilesDropdown } from "../../profile/OnlinePeersButton";
import { useOnline } from "@peerbit/react";

const readableView = (view: ViewType) => {
    if (view === "chat") return "Chat view";
    if (view === "new") return "New stuff";
    if (view === "old") return "Old stuff";
    if (view === "best") return "Popular";
};

export const SubHeader = () => {
    const { view, viewRoot, setView } = useView();
    const viewAsReadable = useMemo(() => readableView(view), [view]);
    const { peers } = useOnline(viewRoot);

    return (
        <StickyHeader>
            <div className="w-full max-w-[876px] mx-auto flex flex-row">
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger className="btn flex flex-row justify-center items-center ganja-font">
                        <span>{viewAsReadable}</span>
                        <ChevronDownIcon className="ml-2" />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content
                        sideOffset={5}
                        style={{ padding: "0.5rem", minWidth: "150px" }}
                        className="bg-neutral-50 dark:bg-neutral-950 rounded-md shadow-lg"
                    >
                        {(["new", "old", "best", "chat"] as const).map(
                            (sortType) => (
                                <DropdownMenu.Item
                                    key={sortType}
                                    className="menu-item text-sm"
                                    onSelect={() => setView(sortType)}
                                >
                                    {readableView(sortType)}
                                </DropdownMenu.Item>
                            )
                        )}
                    </DropdownMenu.Content>
                </DropdownMenu.Root>
                <div className="ml-auto">
                    <OnlineProfilesDropdown peers={peers} />
                </div>
            </div>
        </StickyHeader>
    );
};
