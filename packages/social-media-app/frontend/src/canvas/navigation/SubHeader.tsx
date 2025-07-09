import { StickyHeader } from "../main/StickyHeader";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useView } from "../view/ViewContext";
import { FaChevronDown } from "react-icons/fa6";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { View, ViewModel } from "@giga-app/interface";
import { CreateNewViewMenuItem } from "../feed/CreateNewViewMenuItem";

import { GoPin } from "react-icons/go";
import { GrNotification } from "react-icons/gr";
import { IoSettingsOutline } from "react-icons/io5";
import { useFeed } from "../feed/FeedContext";
import { TabsOrList } from "./Collections";
import { useHeaderVisibilityContext } from "../../HeaderVisibilitiyProvider";
import { HiChevronDoubleUp } from "react-icons/hi";

interface SubHeaderProps {
    collapsable?: boolean; // if true, the header can be collapsed
    onBackToTop?: () => void;
    onViewChange: (view: ViewModel) => void;
    onCollapse: (collapsed: boolean) => void;
    onNavTypeChange?: (type: "tabs" | "rows") => void;
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
        feedRoot,
    } = useFeed();

    /* ─────────────────── MRU list (ids, newest → oldest) ──────────── */
    const [recent, setRecent] = useState<string[]>([]);

    useEffect(() => {
        setRecent([]);
    }, [feedRoot]);

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
            if (!v) {
                continue;
            }
            const el = measurerRefs.current[v.id];
            if (el) {
                w[v.id] = el.offsetWidth;
            }
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
            /* if (v !== currentView)  */
            visible.push(v);
            used += need;
        }
    }

    /* ────────── dropdown lists (always sectioned) ────────── */
    const inDynamic = (v: ViewModel) => dynamicViews.some((d) => d.id === v.id);
    const dynamicList = [...dynamicViews];
    const defaultList = [...defaultViews];

    const selectedViewStyle =
        "px-2 py-1 text-sm font-semibold underline underline-offset-4  whitespace-nowrap";

    const buttonStyle = (v: ViewModel) =>
        "btn h-full rounded-t-none px-2 py-1 text-sm text-neutral-500 dark:text-neutral-400  hover:text-white hover:dark:text-black whitespace-nowrap transition " +
        (currentView?.id === v.id ? selectedViewStyle : "");

    /* ─────────────────────────── render ─────────────────────────── */
    return (
        <>
            {/* hidden measurer */}
            <div
                aria-hidden
                className="absolute h-0 overflow-hidden whitespace-nowrap flex flex-row gap-2 w-full"
                style={{ visibility: "hidden" }}
            >
                {[currentView, ...orderedOthers].map(
                    (v) =>
                        v && (
                            <button
                                key={v.id}
                                ref={(el) => {
                                    measurerRefs.current[v.id] = el;
                                }}
                                className="px-2 py-2 text-sm"
                            >
                                {v.name}
                            </button>
                        )
                )}
            </div>

            {/* toolbar */}
            <div className="flex items-center gap-2 w-full h-full">
                <div
                    ref={containerRef}
                    className="flex flex-wrap  w-full  h-full"
                >
                    {pinned.map((v) => (
                        <button
                            key={v.id}
                            onClick={() => select(v)}
                            className={buttonStyle(v)}
                        >
                            {v.name}
                        </button>
                    ))}

                    {/* selected view – counted in width */}
                    {currentView &&
                        pinned.find((x) => x.id !== currentView.id) && (
                            <button
                                onClick={() => select(currentView)}
                                className={selectedViewStyle}
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
                            className={buttonStyle(v)}
                        >
                            {v.name}
                        </button>
                    ))}
                    {/* dropdown */}
                    <DropdownMenu.Root>
                        <DropdownMenu.Trigger className="btn px-3 py-2 rounded ">
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
                                                    className={`btn  px-2 justify-start flex-grow  underline text-sm whitespace-nowrap transition  ${
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
        <div className="flex flex-row h-full px-2 shadow-sm">
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
    collapsable,
    onCollapse: _onCollapsed,
    onNavTypeChange: _setNavType,
}: SubHeaderProps) => {
    const [collapsed, setCollapsed] = useState(false);
    const [headerHeight, setHeaderHeight] = useState(0);
    const headerRef = useRef<HTMLDivElement>(null);

    const onCollapse = useCallback(
        (collapsed: boolean) => {
            if (!collapsable) return;
            setCollapsed(collapsed);
            _onCollapsed?.(collapsed);
        },
        [_onCollapsed, collapsable]
    );

    useLayoutEffect(() => {
        if (headerRef.current) {
            setHeaderHeight(headerRef.current.offsetHeight);
        }
    }, []);

    const { view } = useFeed();
    const { viewRoot } = useView();

    const toolBarBG = ` bg-neutral-50 ${
        view?.id === "chat" ? "dark:bg-neutral-700" : "dark:bg-neutral-900"
    } bg-white border-[#ccc] dark:border-none dark:bg-[linear-gradient(15deg,var(--color-neutral-950),var(--color-neutral-800))] `; /* dark:bg-[linear-gradient(15deg,rgba(23,23,23,1),rgba(45,45,45,1))] */

    const [navType, setNavType] = useState<"tabs" | "rows">("tabs");

    const { visible } = useHeaderVisibilityContext();
    return (
        <StickyHeader collapsable={collapsable} onStateChange={onCollapse}>
            <div className="w-full max-w-[876px]  flex flex-col">
                <TabsOrList
                    className={
                        navType === "rows"
                            ? ""
                            : `${
                                  visible
                                      ? "bg-neutral-200 dark:bg-neutral-700"
                                      : "bg-neutral-50 dark:bg-neutral-900 transition-colors duration-800 ease-in-out"
                              } shadow-md `
                    }
                    canvas={viewRoot}
                    onChange={(change) => {
                        setNavType(change);
                        _setNavType?.(change);
                    }}
                    onBackToTop={onBackToTop}
                />
                {navType === "tabs" && (
                    <div className="relative">
                        <div
                            ref={headerRef}
                            className={`absolute h-8 bg-neutral-100 dark:bg-neutral-800 rounded-b-lg z-0 transition-transform duration-800 ease-in-out  w-full`}
                            style={{
                                transform: visible
                                    ? "translateY(0)"
                                    : `translateY(-${headerHeight}px)`,
                                willChange: "transform",
                                backfaceVisibility: "hidden",
                            }}
                        >
                            <BottomControls onViewChange={onViewChange} />
                        </div>
                    </div>
                )}
            </div>
        </StickyHeader>
    );
};
