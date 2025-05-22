import { StickyHeader } from "./StickyHeader";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useView } from "../../view/ViewContex";
import { ViewModel } from "../../view/defaultViews";
import { FaChevronDown } from "react-icons/fa6";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface SubHeaderProps {
    onBackToTop?: () => void;
    onViewChange: (view: ViewModel) => void;
    onCollapse: (collapsed: boolean) => void;
}

interface ViewSelectorSubheaderProps {
    onViewChange?: (view: ViewModel) => void;
    gapPx?: number; // Tailwind `gap-2` is 8px
}

const ViewSelectorSubheader = ({
    onViewChange,
    gapPx = 8,
}: ViewSelectorSubheaderProps) => {
    const { views: viewOrg, view: currentView, setView } = useView();

    const [views, setViews] = useState<ViewModel[]>(viewOrg);
    useEffect(() => {
        setViews(viewOrg);
    }, [viewOrg]);

    // State: measured widths and container width
    const [buttonWidths, setButtonWidths] = useState<Record<string, number>>(
        {}
    );
    const [containerWidth, setContainerWidth] = useState(0);

    // Refs
    const containerRef = useRef<HTMLDivElement>(null);
    const measurerRefs = useRef<Record<string, HTMLButtonElement | null>>({});

    // 1️⃣ Measure all button widths via hidden measurer
    const measureAll = useCallback(() => {
        const newWidths: Record<string, number> = {};
        for (const vm of views) {
            const btn = measurerRefs.current[vm.id];
            if (btn) {
                newWidths[vm.id] = btn.offsetWidth;
            }
        }
        setButtonWidths(newWidths);
    }, [views]);

    useEffect(() => {
        measureAll();
        // If your view names can change dynamically, you can add a ResizeObserver here:
        // but for simplicity we re-measure on views change only.
    }, [measureAll]);

    // 2️⃣ Watch container width
    useEffect(() => {
        if (!containerRef.current) return;
        const obs = new ResizeObserver(([entry]) => {
            setContainerWidth(entry.contentRect.width);
        });
        obs.observe(containerRef.current);
        return () => obs.disconnect();
    }, []);

    // 3️⃣ Decide which views fit
    let used = 0;
    const visible: ViewModel[] = [];
    const overflow: ViewModel[] = [];

    // subtract a bit of padding if needed
    const avail = containerWidth - gapPx;

    for (const vm of views) {
        const w = buttonWidths[vm.id] ?? 120; // fallback
        const need = visible.length > 0 ? w + gapPx : w;
        if (used + need <= avail) {
            visible.push(vm);
            used += need;
        } else {
            overflow.push(vm);
        }
    }

    const handleSelect = (vm: ViewModel) => {
        setView(vm.id);
        onViewChange?.(vm);
    };

    return (
        <>
            {/* Hidden measurer */}
            <div
                aria-hidden
                style={{
                    position: "absolute",
                    visibility: "hidden",
                    height: 0,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                }}
            >
                {views.map((vm) => (
                    <button
                        key={vm.id}
                        ref={(el) => (measurerRefs.current[vm.id] = el)}
                        className="px-4 py-2 text-sm whitespace-nowrap"
                        onClick={() => handleSelect(vm)}
                    >
                        {vm.name}
                    </button>
                ))}
            </div>

            {/* Actual toolbar */}
            <div className="flex flex-row items-center w-full gap-2">
                <div className="flex flex-wrap gap-2 w-full" ref={containerRef}>
                    {visible.map((vm) => (
                        <button
                            key={vm.id}
                            onClick={() => handleSelect(vm)}
                            className={`whitespace-nowrap px-4 py-2 text-sm transition duration-200 ${
                                currentView?.id === vm.id
                                    ? "underline underline-offset-4 font-semibold"
                                    : "text-neutral-500 dark:text-neutral-400 hover:text-gray-700"
                            }`}
                        >
                            {vm.name}
                        </button>
                    ))}
                </div>

                {overflow.length > 0 && (
                    <DropdownMenu.Root>
                        <DropdownMenu.Trigger className="ml-auto px-4 py-2 text-sm rounded-md hover:bg-gray-100 dark:hover:bg-neutral-800">
                            <FaChevronDown />
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content
                            align="start"
                            sideOffset={5}
                            className="bg-white dark:bg-neutral-900 rounded-md shadow-lg py-2"
                            style={{ minWidth: 150 }}
                        >
                            {overflow.map((vm) => (
                                <DropdownMenu.Item
                                    key={vm.id}
                                    onClick={() => handleSelect(vm)}
                                    className={`cursor-pointer w-full text-left whitespace-nowrap px-4 py-2 text-sm transition duration-200 ${
                                        currentView?.id === vm.id
                                            ? "underline underline-offset-4 font-semibold "
                                            : "dark:text-neutral-400 text-neutral-600  hover:text-gray-700"
                                    }`}
                                >
                                    {vm.name}
                                </DropdownMenu.Item>
                            ))}
                        </DropdownMenu.Content>
                    </DropdownMenu.Root>
                )}
            </div>
        </>
    );
};

export const SubHeader = ({
    onBackToTop: onBackToTop,
    onViewChange,
    onCollapse,
}: SubHeaderProps) => {
    return (
        <StickyHeader onStateChange={onCollapse}>
            <div className="w-full max-w-[876px] mx-auto flex flex-row items-center">
                <ViewSelectorSubheader onViewChange={onViewChange} />
                {/*  {onBackToTop && (
                    <button
                        onClick={onBackToTop}
                        className="px-1 ml-auto btn flex flex-row justify-center items-cent"
                    >
                        <span className="ganja-font">To the top</span>
                        <ChevronUpIcon className="ml-2 " />
                    </button>
                )} */}
                {/*     <div className="ml-auto">
                    <OnlineProfilesDropdown peers={peers} />
                </div> */}
            </div>
        </StickyHeader>
    );
};

{
    /* <DropdownMenu.Root>
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
 */
}
