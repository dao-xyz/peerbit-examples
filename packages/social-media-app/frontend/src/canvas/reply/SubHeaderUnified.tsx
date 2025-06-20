import { StickyHeader } from "./StickyHeader";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useView } from "./view/ViewContex";
import { FaChevronDown } from "react-icons/fa6";
import {
    Fragment,
    ReactNode,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { LOWEST_QUALITY, View, ViewModel } from "@giga-app/interface";
import { CreateNewViewMenuItem } from "./view/CreateNewViewMenuItem";
import * as Popover from "@radix-ui/react-popover";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { GoPin, GoPeople } from "react-icons/go";
import { GrNotification } from "react-icons/gr";
import { useCanvases } from "../useCanvas";
import { useNavigate } from "react-router";
import { getCanvasPath } from "../../routes";
import { CanvasWrapper } from "../CanvasWrapper";
import { CanvasPreview } from "../preview/Preview";
import { IoSettingsOutline } from "react-icons/io5";
import { RiSearchEyeLine } from "react-icons/ri";
import { FaAngleDoubleUp } from "react-icons/fa";

import clsx from "clsx";
import { useOnline } from "@peerbit/react";

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
const DEBOUNCE = 300; // ms

/*********************************************************************/
/*  TokenInput with breadcrumb-chips                                 */
/*********************************************************************/

export const TokenInput: React.FC<{
    onFocusChange?: (state: boolean) => void;
}> = ({ onFocusChange }) => {
    /* ── global state ─────────────────────────────────────────────── */
    const {
        query,
        timeFilter,
        typeFilter,
        view: currentView,
        dynamicViews,
        defaultViews,
        setQueryParams,
    } = useView();

    /* ── breadcrumb state ─────────────────────────────────────────── */
    const { path, root } = useCanvases();
    const navigate = useNavigate();
    const popRoom = async () => {
        if (path.length <= 1) return;
        const tags = path.slice(1, -1).map((c) => c.address);
        const newPath = await root.getCreateRoomByPath(tags);
        navigate(getCanvasPath(newPath.at(-1)!));
    };

    /* ── chips for filters+view ───────────────────────────────────── */
    const chips = [
        ...(currentView?.id !== DEFAULT_VIEW
            ? [
                  {
                      key: "view",
                      label: currentView.name,
                      icon: <RiSearchEyeLine size={12} />,
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

    /* ── view-name lookup for auto-conversion  ─────────────────────── */
    const viewLookup = useMemo(() => {
        const m = new Map<string, View | ViewModel>();
        [...dynamicViews.map((v) => v.toViewModel()), ...defaultViews].forEach(
            (v) => m.set(v.name.toLowerCase(), v)
        );
        return m;
    }, [dynamicViews, defaultViews]);

    /* ── local text & debounce push to ?q= ────────────────────────── */
    const [text, setText] = useState(query ?? "");
    useEffect(() => setText(query ?? ""), [query]);

    const tRef = useRef<NodeJS.Timeout>();
    const push = (val: string) => {
        clearTimeout(tRef.current);
        tRef.current = setTimeout(
            () => setQueryParams({ query: val }),
            DEBOUNCE
        );
    };

    /* ── focus state (controls shrinking & breadcrumb) ────────────── */
    const [focused, setF] = useState(false);
    useEffect(() => onFocusChange?.(focused), [focused, onFocusChange]);

    const inputRef = useRef<HTMLInputElement>(null);

    /* ── input handlers ───────────────────────────────────────────── */
    const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        const words = val.split(/\s+/);
        const last = words.at(-1)!.toLowerCase();
        const match = currentView?.id === DEFAULT_VIEW && viewLookup.get(last);
        if (match && match.id !== DEFAULT_VIEW) {
            words.pop();
            clearTimeout(tRef.current);
            const rest = words.join(" ").trimStart();
            setText(rest);
            setQueryParams({ view: match.id, query: rest });
        } else {
            setText(val);
            push(val);
        }
    };
    const onBack = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== "Backspace" || e.currentTarget.value) return;
        if (typeFilter.key !== "all") setQueryParams({ type: "all" });
        else if (timeFilter.key !== "all") setQueryParams({ time: "all" });
        else if (currentView?.id !== DEFAULT_VIEW)
            setQueryParams({ view: DEFAULT_VIEW });
        else if (path.length > 1) popRoom();
    };

    /* ── render ───────────────────────────────────────────────────── */
    return (
        <div
            className={clsx(
                "flex items-center gap-1   px-2 py-1",
                "dark:border-neutral-600 border-neutral-300 w-full"
                /* focused ? "flex-grow" : "flex-grow-0 max-w-[280px]" */
            )}
        >
            {/* collapsible search-glass */}
            {/*   {!focused && (
                <button
                    className="btn btn-icon mr-1"
                    onClick={() => { setF(true); setTimeout(() => inputRef.current?.focus(), 0); }}
                >
                    <FaSearch size={12} />
                </button>
            )} */}

            {/* breadcrumb (only when focused) */}
            {focused &&
                path.slice(1).map((c, i) => (
                    <Fragment key={c.idString}>
                        {<span className="text-neutral-400">/</span>}
                        <button
                            onClick={popRoom}
                            className="flex h-6 items-center"
                        >
                            <CanvasWrapper canvas={c} quality={LOWEST_QUALITY}>
                                <CanvasPreview variant="breadcrumb" />
                            </CanvasWrapper>
                        </button>
                    </Fragment>
                ))}

            {!focused && path.length > 1 && (
                <Fragment key={path[path.length - 1].idString}>
                    {path.length > 2 && (
                        <span className="text-neutral-400">…</span>
                    )}
                    <span className="text-neutral-400">/</span>
                    <button onClick={popRoom} className="flex h-6 items-center">
                        <CanvasWrapper
                            canvas={path[path.length - 1]}
                            quality={LOWEST_QUALITY}
                        >
                            <CanvasPreview variant="breadcrumb" />
                        </CanvasWrapper>
                    </button>
                </Fragment>
            )}

            {/* view/time/type chips (only when focused) */}
            {chips.map((ch) => (
                <Chip
                    key={ch.key}
                    icon={ch.icon}
                    label={ch.label}
                    onClick={ch.remove}
                />
            ))}

            {/* caret */}
            <input
                ref={inputRef}
                value={text}
                onChange={onChange}
                onKeyDown={onBack}
                onFocus={() => setF(true)}
                onBlur={() => setF(false)}
                placeholder="Search…"
                className="ml-1 flex-grow min-w-[60px] bg-transparent outline-none text-xs md:text-sm"
            />
        </div>
    );
};

/* private ref needed for auto-focus */
/* const inputRef = { current: null } as React.MutableRefObject<HTMLInputElement | null>;

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
                {dynamicViews.length > 0 && (
                    <>
                        <DropdownMenu.Label className="px-2 py-1 text-xs text-primary-600">
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

                <DropdownMenu.Separator className="my-2 h-px bg-neutral-200 dark:bg-neutral-700" />
                <CreateNewViewMenuItem />
            </DropdownMenu.Content>
        </DropdownMenu.Root>
    );
}; */

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
                    <button className="px-3 btn py-1 flex items-center gap-1 text-xs rounded whitespace-nowrap">
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
interface ChipProps {
    label: string;
    onClick: () => void;
    /** optional element to render left of the label, e.g. <FaClock /> */
    icon?: ReactNode;
}
const Chip = ({ label, icon, onClick }: ChipProps) => (
    <button
        onClick={onClick}
        className="
      flex items-center gap-1
      px-2 py-0.5 text-xs rounded-full
      bg-neutral-200 dark:bg-neutral-700
      hover:bg-neutral-300 dark:hover:bg-neutral-600
      transition
      whitespace-nowrap
    "
    >
        {icon && <span className="flex items-center">{icon}</span>}
        <span>{label}</span>
        <span className="text-[10px] leading-none">&times;</span>
    </button>
);

/*********************************************************************/
/*  2.  Top bar (search + icons)                                     */
/*********************************************************************/
const TopControls = ({
    onViewChange,
    goToTop,
}: {
    onViewChange?: (v: ViewModel) => void;
    goToTop: () => void;
}) => {
    /* hide the right-side controls while the input is focussed */
    const [searchFocused, setFocused] = useState(false);

    return (
        <div className="flex items-center gap-2 w-full z-30 ">
            {/* search / breadcrumb input */}
            <div className="flex-grow">
                <TokenInput onFocusChange={setFocused} />
            </div>
            <div className="ml-auto">
                <button className="btn btn-icon" onClick={goToTop}>
                    <FaAngleDoubleUp size={20} />
                </button>
            </div>
            {/* these controls disappear when input is focused (mobile-style) */}
        </div>
    );
};

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
        ].filter((x) => x.index == null);
        const byId = new Map(all.map((v) => [v.id, v]));

        const mru = recent
            .map((id) => byId.get(id))
            .filter(Boolean) as ViewModel[];

        const rest = all.filter((v) => !recent.includes(v.id));

        return [...mru, ...rest].filter((v) => v.id !== currentView?.id);
    }, [recent, dynamicViews, defaultViews, currentView]);

    const pinned: ViewModel[] = useMemo(() => {
        const all = [
            ...dynamicViews.map((x) => x.toViewModel()),
            ...defaultViews,
        ].filter((x) => x.index != null);

        return all
            .filter((v) => v.index != null)
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    }, [dynamicViews, defaultViews]);

    /* ───────────── measurement (buttons + container) ───────────── */
    const [buttonW, setButtonW] = useState<Record<string, number>>({});
    const [containerW, setContainerW] = useState(0);

    const measurerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const containerRef = useRef<HTMLDivElement>(null);

    const measureAll = useCallback(() => {
        const w: Record<string, number> = {};
        let viewsToMeaure = [...orderedOthers, ...pinned];

        if (viewsToMeaure.find((x) => x.id === currentView?.id) === undefined) {
            viewsToMeaure.push(currentView!);
        }

        for (const v of viewsToMeaure) {
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
                    {pinned.map((v) => (
                        <button
                            key={v.id}
                            onClick={() => select(v)}
                            className="btn px-4 py-2 text-sm text-neutral-500 dark:text-neutral-400  hover:text-white hover:dark:text-black whitespace-nowrap transition"
                        >
                            {v.name}
                        </button>
                    ))}

                    {/* selected view – counted in width */}
                    {currentView &&
                        pinned.find((x) => x.id !== currentView.id) && (
                            <button
                                onClick={() => select(currentView)}
                                className="px-4 py-2 text-sm font-semibold underline underline-offset-4  whitespace-nowrap"
                            >
                                {currentView.name}
                            </button>
                        )}

                    {/* vertical separator (centred same as before) */}
                    {/*   {orderedOthers.length > 0 && (
                        <div className="flex items-center">
                            <div className="h-6 border-l border-gray-300" />
                        </div>
                    )} */}

                    {/* visible buttons */}
                    {visible.map((v) => (
                        <button
                            key={v.id}
                            onClick={() => select(v)}
                            className="btn px-4 py-2 text-sm text-neutral-500 dark:text-neutral-400  hover:text-white hover:dark:text-black whitespace-nowrap transition"
                        >
                            {v.name}
                        </button>
                    ))}
                    {/* dropdown */}
                    <DropdownMenu.Root>
                        <DropdownMenu.Trigger className=" px-3 py-2 rounded hover:bg-gray-100 dark:hover:bg-neutral-800">
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
                                        <DropdownMenu.Label className="px-4 py-1 text-xs text-primary-600 dark:text-primary-300">
                                            Your views
                                        </DropdownMenu.Label>
                                        {dynamicList.map((v) => (
                                            <DropdownMenu.Item
                                                key={v.id}
                                                onClick={() => select(v)}
                                                className={`w-full flex flex-row px-2 py-2`}
                                            >
                                                <button
                                                    className={`btn px-2 justify-start flex-grow  underline text-sm whitespace-nowrap transition  ${
                                                        currentView?.id === v.id
                                                            ? " font-semibold"
                                                            : "text-neutral-600 hover:text-neutral-700 dark:text-neutral-400 hover:dark:text-neutral-300"
                                                    }`}
                                                >
                                                    {v.id}
                                                </button>
                                                <button className="ml-auto btn btn-icon btn-icon-small">
                                                    <GoPin size={12} />
                                                </button>
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
                                                        : "text-neutral-600 hover:text-neutral-700"
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
            </div>
        </>
    );
};
/* 
const People = () => {
    const [peopleOpen, setPeopleOpen] = useState(false);
    const onlineCount = useOnline()
    const participants = [];

    return <DropdownMenu.Root open={peopleOpen} onOpenChange={setPeopleOpen}>
        <DropdownMenu.Trigger asChild>
            <button
                className="btn-icon flex items-center gap-1"
                aria-label="People in this view"
            >
                <GoPeople size={20} />
                <span className="text-xs font-medium">{onlineCount}</span>
            </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="w-64 bg-white dark:bg-neutral-800
                     rounded shadow-lg p-2 space-y-1"
        >
            {participants.map(p => (
                <div key={p.id} className="flex items-center gap-2 p-1 rounded
                                        hover:bg-neutral-100 dark:hover:bg-neutral-700">
                    <span className="flex-1 text-sm">{p.name}</span>
                    {p.online && <span className="h-2 w-2 rounded-full bg-green-500" />}
                </div>
            ))}
        </DropdownMenu.Content>
    </DropdownMenu.Root>

} */

const BottomControls = (props: {
    onViewChange?: (view: ViewModel) => void;
}) => {
    return (
        <div className="flex flex-row">
            <ViewSelectorSubheader onViewChange={props?.onViewChange} />
            {/*  <People /> */}
            {
                <>
                    {/* <SortDropdown/>
                     */}
                    <button className="btn btn-icon hidden sm:block">
                        <GrNotification size={16} />
                    </button>
                    <button className="btn btn-icon">
                        <IoSettingsOutline size={20} />
                    </button>
                </>
            }
        </div>
    );
};

/*********************************************************************/
/*  4.  Wrapper component                                             */
/*********************************************************************/
export const SubHeader = ({
    onViewChange,
    onBackToTop,
    onCollapse: _onCollapsed,
}: SubHeaderProps) => {
    const [collaped, setCollapsed] = useState(false);
    const [headerHeight, setHeaderHeight] = useState(0);
    const headerRef = useRef<HTMLDivElement>(null);

    const onCollapse = useCallback(
        (collapsed: boolean) => {
            setCollapsed(collapsed);
            _onCollapsed?.(collapsed);
        },
        [_onCollapsed]
    );

    useLayoutEffect(() => {
        if (headerRef.current) {
            setHeaderHeight(headerRef.current.offsetHeight);
        }
    }, []);

    const { view } = useView();

    const toolBarBG = ` bg-neutral-50 ${
        view?.id === "chat" ? "dark:bg-neutral-700" : "dark:bg-neutral-900"
    } bg-white border-[#ccc] dark:border-none dark:bg-[linear-gradient(15deg,var(--color-neutral-950),var(--color-neutral-800))] `; /* dark:bg-[linear-gradient(15deg,rgba(23,23,23,1),rgba(45,45,45,1))] */

    return (
        <StickyHeader onStateChange={onCollapse}>
            <div className="w-full max-w-[876px]  flex flex-col">
                <div
                    className={`${toolBarBG}  z-30  inset-shadow-neutral-200 dark:inset-shadow-neutral-950 inset-shadow-sm`}
                >
                    <TopControls
                        onViewChange={onViewChange}
                        goToTop={onBackToTop}
                    />
                </div>
                <div className="relative">
                    <div
                        ref={headerRef}
                        className="absolute bg-neutral-100 dark:bg-neutral-700 rounded-b-lg z-0 transition-transform duration-800 ease-in-out  w-full"
                        style={{
                            transform: !collaped
                                ? "translateY(0)"
                                : `translateY(-${headerHeight}px)`,
                            willChange: "transform",
                            backfaceVisibility: "hidden",
                        }}
                    >
                        <BottomControls onViewChange={onViewChange} />
                    </div>
                </div>
            </div>
        </StickyHeader>
    );
};
