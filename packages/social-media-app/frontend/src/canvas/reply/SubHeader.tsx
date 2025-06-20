// this file is kept for historical reasons, it is not used anymore

import { StickyHeader } from "./StickyHeader";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useView } from "./view/ViewContex";
import { FaChevronDown } from "react-icons/fa6";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, ViewModel } from "@giga-app/interface";
import { CreateNewViewMenuItem } from "./view/CreateNewViewMenuItem";
import * as Popover from "@radix-ui/react-popover";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { TimeFilterType, TypeFilterType } from "./view/filters";
import { FaBell, FaCog, FaSearch } from "react-icons/fa";

interface SubHeaderProps {
    onBackToTop?: () => void;
    onViewChange: (view: ViewModel) => void;
    onCollapse: (collapsed: boolean) => void;
}

interface ViewSelectorSubheaderProps {
    onViewChange?: (view: ViewModel) => void;
    gapPx?: number; // Tailwind gap-2 ≈ 8 px
}

export const ViewSelectorSubheader = ({
    onViewChange,
    gapPx = 8,
}: ViewSelectorSubheaderProps) => {
    /* ─────────────────────────── context ─────────────────────────── */
    const {
        defaultViews,
        dynamicViews,
        view: currentView,
        setView,
        viewRoot,
        query,
        setQuery,
    } = useView();

    /* ─────────────────── MRU list (ids, newest → oldest) ──────────── */
    const [recent, setRecent] = useState<string[]>([]);

    useEffect(() => {
        setRecent([]);
    }, [viewRoot]);

    const select = (v: ViewModel | View) => {
        if (currentView && v.id !== currentView.id) {
            setRecent((prev) => {
                const withoutDup = prev.filter(
                    (id) => id !== currentView.id && id !== v.id
                );
                return [currentView.id, ...withoutDup].slice(0, 20);
            });
        }
        setView(v.id);
        onViewChange?.(v instanceof View ? v.toViewModel() : v);
    };

    /* ── order “others”: MRU first, then remaining (dynamic ∪ default) ── */
    const orderedOthers: ViewModel[] = useMemo(() => {
        const all = [
            ...dynamicViews.map((x) => x.toViewModel()),
            ...defaultViews,
        ];
        const byId = new Map(all.map((v) => [v.id, v]));

        const mru = recent
            .map((id) => byId.get(id))
            .filter(Boolean) as ViewModel[];

        const rest = all.filter((v) => !recent.includes(v.id));

        return [...mru, ...rest].filter((v) => v.id !== currentView?.id);
    }, [recent, dynamicViews, defaultViews, currentView]);

    /* ───────────── measurement (buttons + container) ───────────── */
    const [buttonW, setButtonW] = useState<Record<string, number>>({});
    const [containerW, setContainerW] = useState(0);

    const measurerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const containerRef = useRef<HTMLDivElement>(null);

    const measureAll = useCallback(() => {
        const w: Record<string, number> = {};
        for (const v of [currentView, ...orderedOthers]) {
            if (!v) continue;
            const el = measurerRefs.current[v.id];
            if (el) w[v.id] = el.offsetWidth;
        }
        setButtonW(w);
    }, [orderedOthers, currentView]);

    useEffect(measureAll, [measureAll]);

    useEffect(() => {
        if (!containerRef.current) return;
        const ro = new ResizeObserver(([e]) =>
            setContainerW(e.contentRect.width)
        );
        ro.observe(containerRef.current);
        return () => ro.disconnect();
    }, []);

    /* ───────────── decide which “others” fit on the line ─────────── */
    let used = 0;
    const visible: ViewModel[] = [];
    const avail = containerW - 32; // tiny pad

    for (const v of [currentView, ...orderedOthers]) {
        if (!v) continue;
        const w = buttonW[v.id] ?? 120;
        const need = visible.length ? w + gapPx : w;
        if (used + need <= avail) {
            if (v !== currentView) visible.push(v);
            used += need;
        }
    }

    /* ────────── dropdown lists (always sectioned) ────────── */
    const inDynamic = (v: ViewModel) => dynamicViews.some((d) => d.id === v.id);
    const dynamicList = [...dynamicViews];
    const defaultList = [...defaultViews];

    /* ─────────────────────────── render ─────────────────────────── */
    return (
        <>
            {/* hidden measurer */}
            <div
                aria-hidden
                className="absolute h-0 overflow-hidden whitespace-nowrap"
                style={{ visibility: "hidden" }}
            >
                {[currentView, ...orderedOthers].map(
                    (v) =>
                        v && (
                            <button
                                key={v.id}
                                ref={(el) => (measurerRefs.current[v.id] = el)}
                                className="px-4 py-2 text-sm"
                            >
                                {v.name}
                            </button>
                        )
                )}
            </div>

            {/* toolbar */}
            <div className="flex items-center gap-2 w-full">
                <div ref={containerRef} className="flex flex-wrap gap-2 w-full">
                    {/* selected view – counted in width */}
                    {currentView && (
                        <button
                            onClick={() => select(currentView)}
                            className="px-4 py-2 text-sm font-semibold underline underline-offset-4  whitespace-nowrap"
                        >
                            {currentView.name}
                        </button>
                    )}

                    {/* vertical separator (centred same as before) */}
                    {orderedOthers.length > 0 && (
                        <div className="flex items-center">
                            <div className="h-6 border-l border-gray-300" />
                        </div>
                    )}

                    {/* visible buttons */}
                    {visible.map((v) => (
                        <button
                            key={v.id}
                            onClick={() => select(v)}
                            className="px-4 py-2 text-sm text-neutral-500 dark:text-neutral-400 hover:text-gray-700 whitespace-nowrap transition"
                        >
                            {v.name}
                        </button>
                    ))}
                </div>

                {/* dropdown */}
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger className="ml-auto px-3 py-2 rounded hover:bg-gray-100 dark:hover:bg-neutral-800">
                        <FaChevronDown />
                    </DropdownMenu.Trigger>

                    <DropdownMenu.Content
                        align="end"
                        sideOffset={6}
                        className="bg-white dark:bg-neutral-800 rounded-md shadow-lg py-2 max-w-[220px]"
                    >
                        <div className="max-h-[300px] overflow-y-auto">
                            {/* ── Dynamic section ───────────────────────────── */}
                            {dynamicList.length > 0 && (
                                <>
                                    <DropdownMenu.Label className="px-4 py-1 text-xs text-primary-600">
                                        Your views
                                    </DropdownMenu.Label>
                                    {dynamicList.map((v) => (
                                        <DropdownMenu.Item
                                            key={v.id}
                                            onClick={() => select(v)}
                                            className={`cursor-pointer px-4 py-2 text-sm whitespace-nowrap transition ${
                                                currentView?.id === v.id
                                                    ? "underline font-semibold"
                                                    : "text-neutral-600 hover:text-gray-700"
                                            }`}
                                        >
                                            {v.id} {/* TODO better */}
                                        </DropdownMenu.Item>
                                    ))}
                                    {defaultList.length > 0 && (
                                        <DropdownMenu.Separator className="my-2 h-px bg-neutral-200 dark:bg-neutral-700" />
                                    )}
                                </>
                            )}

                            {/* ── Default section ───────────────────────────── */}
                            {defaultList.length > 0 && (
                                <>
                                    <DropdownMenu.Label className="px-4 py-1 text-xs text-neutral-400 dark:text-neutral-300">
                                        Default views
                                    </DropdownMenu.Label>
                                    {defaultList.map((v) => (
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
                                </>
                            )}
                        </div>

                        {/* add to a newly created view*/}
                        <DropdownMenu.Separator className="my-2 h-px bg-neutral-200 dark:bg-neutral-700" />
                        <CreateNewViewMenuItem />
                    </DropdownMenu.Content>
                </DropdownMenu.Root>
            </div>
        </>
    );
};

interface ResponsiveFilterProps {
    label: string; // e.g. "Time" / "Type"
    value: string; // current value
    options: { val: string; label: string }[];
    onChange: (val: string) => void;
    pillClassName?: string;
}

/** A pill style used both inline and inside the popover */
const pillStyle =
    "px-2 py-1 text-xs rounded border border-neutral-400 dark:border-neutral-600 " +
    "data-[state=on]:bg-primary-500 data-[state=on]:text-white";

export const ResponsiveFilter = ({
    label,
    value,
    options,
    onChange,
    pillClassName = pillStyle,
}: ResponsiveFilterProps) => {
    /* -------- narrow screen: trigger button -------- */
    const currentLabel =
        options.find((o) => o.val === value)?.label ??
        options.find((o) => o.val === "all")?.label ??
        value;

    return (
        <div className="">
            {/* md-up: inline pills (is this wanted?) */}
            {/*  <ToggleGroup.Root
                type="single"
                value={value}
                onValueChange={(v) => v && onChange(v)}
                className="hidden md:flex gap-1  "
            >
                {options.map((o) => (
                    <ToggleGroup.Item
                        key={o.val}
                        value={o.val}
                        className={pillClassName}
                    >
                        {o.label}
                    </ToggleGroup.Item>
                ))}
            </ToggleGroup.Root> */}

            {/* sub-md: popover */}
            <Popover.Root>
                <Popover.Trigger asChild>
                    <button className="px-3 btn py-1 flex items-center gap-1 text-xs rounded">
                        {" "}
                        {/* md:hidden  for responsive */}
                        {label}: {currentLabel}
                        <FaChevronDown className="text-[10px]" />
                    </button>
                </Popover.Trigger>

                <Popover.Content
                    side="bottom"
                    align="start"
                    sideOffset={4}
                    className="bg-white dark:bg-neutral-800 p-2 rounded shadow-md  space-y-1"
                >
                    <ToggleGroup.Root
                        type="single"
                        value={value}
                        onValueChange={(v) => v && onChange(v)}
                        className="flex flex-wrap gap-1 max-w-[220px]"
                    >
                        {options.map((o) => (
                            <ToggleGroup.Item
                                key={o.val}
                                value={o.val}
                                className={pillClassName + " whitespace-nowrap"}
                            >
                                {o.label}
                            </ToggleGroup.Item>
                        ))}
                    </ToggleGroup.Root>
                </Popover.Content>
            </Popover.Root>
        </div>
    );
};

/* ------------------------------------------------------------------ */
/*  👉  Use inside your InlineFiltersToolbar                           */
/* ------------------------------------------------------------------ */
const InlineFiltersToolbar = () => {
    const {
        timeFilter,
        typeFilter,
        setTimeFilter,
        setTypeFilter,
        query,
        setQuery,
    } = useView();

    /* local input state mirrors query */
    const [text, setText] = useState(query || "");

    /* keep local state in sync */
    useEffect(() => setText(query ?? ""), [query]);

    /* debounce push to URL */
    useEffect(() => {
        const id = setTimeout(() => setQuery(text), 100);
        return () => clearTimeout(id);
    }, [text]);

    return (
        <div className="flex items-center justify-between gap-4 text-sm">
            {/* left – filters */}
            <div className="w-full flex items-center gap-2 flex-wrap">
                {/* ── left: two responsive filters ───────────────────────────── */}
                <ResponsiveFilter
                    label="Time"
                    value={timeFilter?.key}
                    onChange={setTimeFilter}
                    options={
                        [
                            { val: "all", label: "All" },
                            { val: "24h", label: "24 h" },
                            { val: "7d", label: "7 d" },
                            { val: "30d", label: "30 d" },
                        ] as { val: TimeFilterType; label: string }[]
                    }
                />

                <ResponsiveFilter
                    label="Type"
                    value={typeFilter?.key}
                    onChange={setTypeFilter}
                    options={
                        [
                            { val: "all", label: "All" },
                            { val: "image", label: "Images" },
                            { val: "text", label: "Text" },
                        ] as { val: TypeFilterType; label: string }[]
                    }
                />

                {/* ── middle: search field (grows) ──────────────────────────── */}
                <div className="flex-grow min-w-[140px] md:min-w-[220px]">
                    <div className="relative">
                        <input
                            type="text"
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            placeholder="Search..."
                            className="
              w-full pl-8 pr-2 py-1
              border border-neutral-300 dark:border-neutral-600
              rounded bg-transparent
              focus:outline-none 
              text-xs md:text-sm
            "
                        />
                        <FaSearch
                            className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none"
                            size={12}
                        />
                    </div>
                </div>
            </div>

            {/* right: notifications + settings */}
            <div className="flex items-center gap-2 ml-auto">
                <button
                    disabled
                    className="btn btn-icon"
                    onClick={() => console.log("notifications")}
                >
                    <FaBell size={16} />
                </button>
                <button
                    disabled
                    className="btn btn-icon"
                    onClick={() => console.log("settings")}
                >
                    <FaCog size={16} />
                </button>
            </div>
        </div>
    );
};

export const SubHeader = ({
    onBackToTop: onBackToTop,
    onViewChange,
    onCollapse,
}: SubHeaderProps) => {
    const { view: currentView } = useView();
    return (
        <StickyHeader onStateChange={onCollapse}>
            <div className="w-full max-w-[876px] mx-auto flex flex-col gap-y-1 py-1">
                {/* ── 1st toolbar: view selector ─────────────────────────── */}
                <div className="flex flex-row items-center">
                    <ViewSelectorSubheader onViewChange={onViewChange} />
                </div>

                {/* ── 2nd toolbar: filters + icons  (only if a view selected) ── */}
                {
                    currentView && (
                        <InlineFiltersToolbar />
                    ) /*  <InlineFiltersToolbar /> */
                }
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
