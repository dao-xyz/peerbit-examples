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

const DEFAULT_VIEW = "best"; // Default view ID for the "Best" chip

export const TokenInput = () => {
    const {
        query /* current ?q= */,
        timeFilter,
        typeFilter /* filter state */,
        view: currentView,
        setQueryParams /* ← new unified setter */,
    } = useView();

    /* ----------------- chips ---------------------------------------- */
    const chips = [
        ...(currentView?.id !== DEFAULT_VIEW
            ? [
                  {
                      key: "view",
                      label: currentView.name,
                      remove: () => setQueryParams({ view: DEFAULT_VIEW }),
                  },
              ]
            : []),
        ...(timeFilter.key !== "all"
            ? [
                  {
                      key: "time",
                      label: timeFilter.name,
                      remove: () => setQueryParams({ time: "all" }),
                  },
              ]
            : []),
        ...(typeFilter.key !== "all"
            ? [
                  {
                      key: "type",
                      label: typeFilter.name,
                      remove: () => setQueryParams({ type: "all" }),
                  },
              ]
            : []),
    ];

    /* ----------------- lookup for view names ------------------------ */
    const { defaultViews, dynamicViews } = useView();
    const viewLookup = useMemo(() => {
        const map = new Map<string, View | ViewModel>();
        [...dynamicViews.map((v) => v.toViewModel()), ...defaultViews].forEach(
            (v) => map.set(v.name.toLowerCase(), v)
        );
        return map;
    }, [dynamicViews, defaultViews]);

    /* ----------------- local text state ----------------------------- */
    const [text, setText] = useState(query ?? "");
    useEffect(() => setText(query ?? ""), [query]);

    /* debounced push for normal typing */
    const timer = useRef<ReturnType<typeof setTimeout>>();
    const pushQuery = (val: string) => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setQueryParams({ query: val }), 3e2);
    };

    /* ----------------- handle change -------------------------------- */
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        const words = val.split(/\s+/);
        const last = words[words.length - 1].toLowerCase();

        const match = currentView?.id === DEFAULT_VIEW && viewLookup.get(last);
        if (match && match.id !== DEFAULT_VIEW) {
            words.pop(); // consume word

            /// stop any queued debounce
            clearTimeout(timer.current!);
            timer.current = null;

            const rest = words.join(" ").trimStart();
            setText(rest);
            setQueryParams({ view: match.id, query: rest });
        } else {
            setText(val);
            pushQuery(val);
        }
    };

    /* ----------------- backspace deletes chips ---------------------- */
    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== "Backspace" || e.currentTarget.value) return;

        if (typeFilter.key !== "all") setQueryParams({ type: "all" });
        else if (timeFilter.key !== "all") setQueryParams({ time: "all" });
        else if (currentView?.id !== DEFAULT_VIEW)
            setQueryParams({ view: DEFAULT_VIEW });
    };

    /* ----------------- render --------------------------------------- */
    return (
        <div className="flex items-center flex-wrap gap-1 border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 w-full">
            <FaSearch className="text-neutral-400 mr-1" size={12} />
            {chips.map((c) => (
                <Chip key={c.key} label={c.label} onClick={c.remove} />
            ))}
            <input
                value={text}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                placeholder="Search…"
                className="flex-grow min-w-[60px] bg-transparent outline-none text-xs md:text-sm"
            />
        </div>
    );
};

const ViewDropdown = ({ onChange }: { onChange?: (v: ViewModel) => void }) => {
    const {
        view: currentView,
        setView,
        defaultViews,
        dynamicViews,
    } = useView();

    const select = (v: ViewModel | View) => {
        setView(v.id);
        onChange?.(v instanceof View ? v.toViewModel() : v);
    };

    return (
        <DropdownMenu.Root>
            {/* trigger – same look as ResponsiveFilter button */}
            <DropdownMenu.Trigger asChild>
                <button className="px-3 btn py-1 flex items-center gap-1 text-xs rounded">
                    View: {currentView?.name ?? "—"}
                    <FaChevronDown className="text-[10px]" />
                </button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Content
                side="bottom"
                align="start"
                sideOffset={4}
                className="bg-white dark:bg-neutral-800 p-2 rounded shadow-md max-h-[300px] overflow-y-auto"
            >
                {/* Dynamic views */}
                {dynamicViews.length > 0 && (
                    <>
                        <DropdownMenu.Label className="px-2 py-1 text-xs text-blue-600">
                            Your views
                        </DropdownMenu.Label>
                        {dynamicViews.map((v) => (
                            <DropdownMenu.Item
                                key={v.id}
                                onClick={() => select(v)}
                                className="cursor-pointer px-2 py-1 text-sm rounded hover:bg-neutral-100 dark:hover:bg-neutral-700"
                            >
                                {v.id}
                            </DropdownMenu.Item>
                        ))}
                        {defaultViews.length > 0 && (
                            <DropdownMenu.Separator className="my-2 h-px bg-neutral-200 dark:bg-neutral-700" />
                        )}
                    </>
                )}

                {/* Default views */}
                {defaultViews.length > 0 && (
                    <>
                        <DropdownMenu.Label className="px-2 py-1 text-xs text-neutral-400 dark:text-neutral-300">
                            Default views
                        </DropdownMenu.Label>
                        {defaultViews.map((v) => (
                            <DropdownMenu.Item
                                key={v.id}
                                onClick={() => select(v)}
                                className="cursor-pointer px-2 py-1 text-sm rounded hover:bg-neutral-100 dark:hover:bg-neutral-700"
                            >
                                {v.name}
                            </DropdownMenu.Item>
                        ))}
                    </>
                )}

                {/* Create-new */}
                <DropdownMenu.Separator className="my-2 h-px bg-neutral-200 dark:bg-neutral-700" />
                <CreateNewViewMenuItem />
            </DropdownMenu.Content>
        </DropdownMenu.Root>
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

/*********************************************************************/
/*  1.  Tag component                                               */
/*********************************************************************/
const Chip = ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button
        onClick={onClick}
        className="
      flex items-center gap-1
      px-2 py-0.5 text-xs rounded-full
      bg-neutral-200 dark:bg-neutral-700
      hover:bg-neutral-300 dark:hover:bg-neutral-600
      transition
    "
    >
        {label}
        <span className="text-[10px]">&times;</span>
    </button>
);

/*********************************************************************/
/*  2.  Top bar (search + icons)                                     */
/*********************************************************************/
const TopBar = () => {
    const { query, setQuery } = useView();
    const [text, setText] = useState(query);

    useEffect(() => setText(query), [query]);
    useEffect(() => {
        const id = setTimeout(() => setQuery(text), 100);
        return () => clearTimeout(id);
    }, [text, setQuery]);

    return (
        <div className="flex items-center gap-2 w-full">
            {/* search input */}
            <div className="flex-grow">
                <TokenInput />
            </div>

            {/* icons */}
            <button disabled className="btn btn-icon">
                <FaBell size={16} />
            </button>
            <button disabled className="btn btn-icon">
                <FaCog size={16} />
            </button>
        </div>
    );
};

/*********************************************************************/
/*  3.  Filter / tag bar                                             */
/*********************************************************************/
const FilterBar = ({
    onViewChange,
}: {
    onViewChange: (v: ViewModel) => void;
}) => {
    const {
        view: currentView,
        timeFilter,
        typeFilter,
        setTimeFilter,
        setTypeFilter,
        query,
        setQuery,
    } = useView();

    /* Build tag list */
    const tags = useMemo(() => {
        const t: { key: string; label: string; remove: () => void }[] = [];
        if (query?.trim()) {
            query
                .split(" ")
                .filter(Boolean)
                .forEach((word) =>
                    t.push({
                        key: `q-${word}`,
                        label: word,
                        remove: () => setQuery(""), // TODO: real parsing later
                    })
                );
        }
        if (timeFilter.key !== "all") {
            t.push({
                key: "time",
                label: timeFilter.name,
                remove: () => setTimeFilter("all"),
            });
        }
        if (typeFilter.key !== "all") {
            t.push({
                key: "type",
                label: typeFilter.name,
                remove: () => setTypeFilter("all"),
            });
        }
        return t;
    }, [query, timeFilter, typeFilter, setTimeFilter, setTypeFilter, setQuery]);

    return (
        <div className="flex items-center flex-wrap gap-2 text-sm">
            {/* View dropdown (reuse earlier component) */}
            <ViewDropdown onChange={onViewChange} />

            {/* Responsive Filters */}
            <ResponsiveFilter
                label="Time"
                value={timeFilter.key}
                onChange={setTimeFilter}
                options={[
                    { val: "all", label: "All" },
                    { val: "24h", label: "24 h" },
                    { val: "7d", label: "7 d" },
                    { val: "30d", label: "30 d" },
                ]}
            />
            <ResponsiveFilter
                label="Type"
                value={typeFilter.key}
                onChange={setTypeFilter}
                options={[
                    { val: "all", label: "All" },
                    { val: "image", label: "Images" },
                    { val: "text", label: "Text" },
                ]}
            />
        </div>
    );
};

/*********************************************************************/
/*  4.  Wrapper component                                             */
/*********************************************************************/
export const SubHeader = ({ onViewChange, onCollapse }: SubHeaderProps) => {
    const { view: currentView } = useView();

    return (
        <StickyHeader onStateChange={onCollapse}>
            <div className="w-full max-w-[876px] mx-auto flex flex-col gap-y-1 py-1">
                <TopBar />

                {currentView && <FilterBar onViewChange={onViewChange} />}
            </div>
        </StickyHeader>
    );
};
