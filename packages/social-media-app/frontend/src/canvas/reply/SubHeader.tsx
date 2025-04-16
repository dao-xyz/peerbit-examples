import { useMemo } from "react";
import { StickyHeader } from "./StickyHeader";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useView, ViewType } from "../../view/ViewContex";
import { ChevronDownIcon, ChevronUpIcon } from "@radix-ui/react-icons";

interface SubHeaderProps {
    onBackToTop?: () => void;
    onViewChange: (view: ViewType) => void;
    onCollapse: (collapsed: boolean) => void;
}

const readableView = (view: ViewType) => {
    if (view === "chat") {
        return "Chat view";
    }
    if (view === "new") {
        return "New stuff";
    }
    if (view === "old") {
        return "Old stuff";
    }
    if (view === "best") {
        return "Popular";
    }
};

export const SubHeader = ({
    onBackToTop: onBackToTop,
    onViewChange,
    onCollapse,
}: SubHeaderProps) => {
    const { view, viewRoot, setView: _setView } = useView();
    const viewAsReadable = useMemo(() => readableView(view), [view]);
    const setView = (view: ViewType) => {
        _setView(view);
        onViewChange(view);
    };
    return (
        <StickyHeader onStateChange={onCollapse}>
            <div className="w-full max-w-[876px] mx-auto flex flex-row items-center">
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger className="btn px-1 flex flex-row justify-center items-center ganja-font">
                        <span>{viewAsReadable}</span>
                        <ChevronDownIcon className="ml-2" />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content
                        sideOffset={5}
                        style={{ padding: "0.5rem", minWidth: "150px" }}
                        className="bg-neutral-50 dark:bg-neutral-900 rounded-md shadow-lg"
                    >
                        {(["best", "chat", "new", "old"] as const).map(
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
                {onBackToTop && (
                    <button
                        onClick={onBackToTop}
                        className="px-1 ml-auto btn flex flex-row justify-center items-cent"
                    >
                        <span className="ganja-font">To the top</span>
                        <ChevronUpIcon className="ml-2 " />
                    </button>
                )}
                {/*     <div className="ml-auto">
                    <OnlineProfilesDropdown peers={peers} />
                </div> */}
            </div>
        </StickyHeader>
    );
};
