import { StickyHeader } from "./StickyHeader";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useView } from "../../view/ViewContex";
import { FaChevronDown } from "react-icons/fa6";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaPlus } from "react-icons/fa";
import { ViewModel } from "@giga-app/interface";

interface SubHeaderProps {
    onBackToTop?: () => void;
    onViewChange: (view: ViewModel) => void;
    onCollapse: (collapsed: boolean) => void;
}

interface ViewSelectorSubheaderProps {
    onViewChange?: (view: ViewModel) => void;
    gapPx?: number; // Tailwind gap-2 = 8 px
}

const ViewSelectorSubheader = ({
    onViewChange,
    gapPx = 8,
}: ViewSelectorSubheaderProps) => {
    /* ------------------------------------------------------------------ */
    /*  🌳  STATE & CONTEXT                                               */
    /* ------------------------------------------------------------------ */
    const {
        defaultViews,
        dynamicViews,
        view: currentView,
        setView,
        createView, // async name => View
    } = useView();

    // ⚠️ Dynamic views should appear first
    const allViews = useMemo(() => {
        return [...dynamicViews, ...defaultViews];
    }, [defaultViews, dynamicViews]);

    /* ------------------------------------------------------------------ */
    /*  📏  MEASUREMENT (hidden measurer + container ResizeObserver)       */
    /* ------------------------------------------------------------------ */
    const [buttonW, setButtonW] = useState<Record<string, number>>({});
    const [containerW, setContainerW] = useState(0);

    const measurerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const containerRef = useRef<HTMLDivElement>(null);

    // measure buttons
    const measureAll = useCallback(() => {
        const w: Record<string, number> = {};
        for (const v of allViews) {
            const el = measurerRefs.current[v.id];
            if (el) w[v.id] = el.offsetWidth;
        }
        setButtonW(w);
    }, [allViews]);

    useEffect(measureAll, [measureAll]);

    // measure container
    useEffect(() => {
        if (!containerRef.current) return;
        const ro = new ResizeObserver(([e]) =>
            setContainerW(e.contentRect.width)
        );
        ro.observe(containerRef.current);
        return () => ro.disconnect();
    }, []);

    /* ------------------------------------------------------------------ */
    /*  🧮  LAYOUT – split into visible / overflow                         */
    /* ------------------------------------------------------------------ */
    let used = 0;
    const visible: ViewModel[] = [];

    const avail = containerW - 32; // slight padding

    for (const v of currentView ? [currentView, ...allViews] : allViews) {
        const w = buttonW[v.id] ?? 120;
        const need = visible.length ? w + gapPx : w;
        if (used + need <= avail) {
            if (v !== currentView) {
                visible.push(v);
            }
            used += need;
        }
    }

    /* ------------------------------------------------------------------ */
    /*  ➕  “Create view” local state                                      */
    /* ------------------------------------------------------------------ */
    const [newName, setNewName] = useState("");
    const [saving, setSaving] = useState(false);

    const handleCreate = async () => {
        if (!newName.trim()) return;
        setSaving(true);
        await createView(newName.trim());
        setNewName("");
        setSaving(false);
    };

    /* ------------------------------------------------------------------ */
    /*  🔗  Handlers                                                      */
    /* ------------------------------------------------------------------ */
    const select = (v: ViewModel) => {
        setView(v.id);
        onViewChange?.(v);
    };

    /* ------------------------------------------------------------------ */
    /*  🖼  RENDER                                                         */
    /* ------------------------------------------------------------------ */
    return (
        <>
            {/* invisible measurer */}
            <div
                aria-hidden
                className="absolute h-0 overflow-hidden whitespace-nowrap"
                style={{ visibility: "hidden" }}
            >
                {allViews.map((v) => (
                    <button
                        key={v.id}
                        ref={(el) => (measurerRefs.current[v.id] = el)}
                        className="px-4 py-2 text-sm whitespace-nowrap"
                    >
                        {v.id}
                    </button>
                ))}
            </div>

            {/* toolbar */}
            <div className="flex items-center gap-2 w-full">
                <div ref={containerRef} className="flex flex-wrap gap-2 w-full">
                    {/* selected view – fixed far-left */}
                    {currentView && (
                        <button
                            onClick={() => select(currentView)}
                            className="px-4 py-2 text-sm font-semibold underline underline-offset-4 text-blue-600 whitespace-nowrap"
                        >
                            {currentView.name}
                        </button>
                    )}

                    {/* vertical rule */}
                    {allViews.length > 0 && (
                        <div className="flex items-center">
                            <div className="h-6 border-l border-gray-300 " />
                        </div>
                    )}

                    {visible.map((v) => (
                        <button
                            key={v.id}
                            onClick={() => select(v)}
                            className={`px-4 py-2 text-sm whitespace-nowrap transition ${
                                currentView?.id === v.id
                                    ? "underline underline-offset-4 font-semibold"
                                    : "text-neutral-500 dark:text-neutral-400 hover:text-gray-700"
                            } ${
                                dynamicViews.find((d) => d.id === v.id)
                                    ? "" // Style dynamic views differently?
                                    : ""
                            }`}
                        >
                            {v.name}
                        </button>
                    ))}
                </div>

                {/* dropdown with overflow & creator */}
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger className="ml-auto px-3 py-2 rounded hover:bg-gray-100 dark:hover:bg-neutral-800">
                        <FaChevronDown />
                    </DropdownMenu.Trigger>

                    <DropdownMenu.Content
                        align="end"
                        sideOffset={6}
                        className=" bg-white dark:bg-neutral-800 rounded-md shadow-lg py-2 max-w-[220px]"
                    >
                        {/* Dynamic overflow first */}
                        <div className="max-h-[300px] overflow-y-auto">
                            {allViews.filter((v) =>
                                dynamicViews.some((d) => d.id === v.id)
                            ).length > 0 && (
                                <>
                                    <DropdownMenu.Label className=" px-4 py-1 text-xs text-blue-600">
                                        Your views
                                    </DropdownMenu.Label>
                                    {allViews
                                        .filter((v) =>
                                            dynamicViews.some(
                                                (d) => d.id === v.id
                                            )
                                        )
                                        .map((v) => (
                                            <DropdownMenu.Item
                                                key={v.id}
                                                onClick={() => select(v)}
                                                className={`cursor-pointer px-4 py-2 text-sm whitespace-nowrap transition ${
                                                    currentView?.id === v.id
                                                        ? "underline font-semibold"
                                                        : "text-neutral-600 hover:text-gray-700"
                                                }`}
                                            >
                                                {v.name}
                                            </DropdownMenu.Item>
                                        ))}
                                    <DropdownMenu.Separator className="my-2 h-px bg-neutral-200 dark:bg-neutral-700" />
                                </>
                            )}

                            {/* Default */}
                            {allViews.filter(
                                (v) => !dynamicViews.some((d) => d.id === v.id)
                            ).length > 0 && (
                                <>
                                    <DropdownMenu.Label className="px-4 py-1 text-xs text-neutral-400 dark:text-neutral-300">
                                        Default views
                                    </DropdownMenu.Label>
                                    {allViews
                                        .filter(
                                            (v) =>
                                                !dynamicViews.some(
                                                    (d) => d.id === v.id
                                                )
                                        )
                                        .map((v) => (
                                            <DropdownMenu.Item
                                                key={v.id}
                                                onClick={() => select(v)}
                                                className={`cursor-pointer px-4 py-2 text-sm whitespace-nowrap transition ${
                                                    currentView?.id === v.id
                                                        ? "underline font-semibold"
                                                        : "text-neutral-600 hover:text-gray-700"
                                                }`}
                                            >
                                                {v.name}
                                            </DropdownMenu.Item>
                                        ))}
                                    <DropdownMenu.Separator className="my-2 h-px bg-neutral-200 dark:bg-neutral-700" />
                                </>
                            )}
                        </div>

                        {/* Create-new section */}
                        <div className="px-4 pt-1 pb-2 space-y-2">
                            <input
                                type="text"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder="New view name"
                                className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <button
                                disabled={newName.trim().length === 0 || saving}
                                onClick={handleCreate}
                                className={`w-full flex items-center justify-center gap-2 rounded px-3 py-1.5 text-sm transition ${
                                    newName.trim().length === 0 || saving
                                        ? "bg-neutral-300 dark:bg-neutral-700 cursor-not-allowed text-neutral-500"
                                        : "bg-blue-600 hover:bg-blue-700 text-white"
                                }`}
                            >
                                <FaPlus className="text-xs" />
                                Save view
                            </button>
                        </div>
                    </DropdownMenu.Content>
                </DropdownMenu.Root>
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
