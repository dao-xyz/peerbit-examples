import { FaChevronDown } from "react-icons/fa6";
import {
    Fragment,
    ReactNode,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { Canvas, LOWEST_QUALITY, View, ViewModel } from "@giga-app/interface";
import * as Popover from "@radix-ui/react-popover";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useCanvases } from "../useCanvas";
import { useNavigate } from "react-router";
import { getCanvasPath } from "../../routes";
import { CanvasWrapper } from "../CanvasWrapper";
import { CanvasPreview } from "../preview/Preview";
import { RiSearchEyeLine } from "react-icons/ri";

import clsx from "clsx";
import { useFeed } from "../feed/FeedContext";
import { HeaderLogo } from "../../Logo";
import { TiChevronRight, TiChevronLeft } from "react-icons/ti";
import { useBackToParent } from "../useBackToParent";
import { renderPath, renderPathElement, smartPath } from "./utils";

const DEFAULT_VIEW = "best"; // Default view ID for the "Best" chip
const DEBOUNCE = 300; // ms

export const CanvasPathInput: React.FC<{
    onFocusChange?: (state: boolean) => void;
    className?: string;
}> = ({ onFocusChange, className }) => {
    /* ── global state ─────────────────────────────────────────────── */
    const {
        view: currentView,
        dynamicViews,
        defaultViews,
        timeFilter,
        typeFilter,
        setQueryParams,
        query,
    } = useFeed();

    /* ── breadcrumb state ─────────────────────────────────────────── */
    const { path, root } = useCanvases();
    const navigate = useNavigate();
    const popRoom = async () => {
        if (path.length <= 1) {
            return;
        }
        navigate(getCanvasPath(path[path.length - 2]));
    };

    const backToParent = useBackToParent(path[path.length - 2]);

    /* ── chips for filters+view ───────────────────────────────────── */
    const chips = [
        ...(currentView.id !== "best"
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

    const tRef = useRef<NodeJS.Timeout>(undefined);
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
        else if (path.length > 1) {
            popRoom();
        }
    };

    const pathElement = useMemo(
        () => <TiChevronRight className="w-4 h-4 text-neutral-400" />,
        []
    );

    const navigateToCanvas = (canvas: Canvas) =>
        navigate(getCanvasPath(canvas));

    const renderPathSelection = useMemo(() => {
        return smartPath(focused, pathElement, path.slice(1), navigateToCanvas);
    }, [focused, path]);

    /* ── render ───────────────────────────────────────────────────── */
    return (
        <div
            className={clsx(
                "flex flex-wrap items-center gap-1",
                "dark:border-neutral-600 border-neutral-300 w-full",
                className
                /* focused ? "flex-grow" : "flex-grow-0 max-w-[280px]" */
            )}
        >
            {path.length > 1 && (
                <button
                    className=" btn btn-bouncy btn-icon bg-neutral-200 dark:bg-neutral-700 rounded-full flex flex-row gap-1 h-6"
                    onClick={() => {
                        backToParent();
                    }}
                >
                    <TiChevronLeft />
                </button>
            )}

            <HeaderLogo className="py-0 px-1" />

            {renderPathSelection}

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
                className={clsx(
                    "ml-1 flex-grow  bg-transparent outline-none text-xs md:text-sm",
                    focused ? "min-w-[40px]" : "max-w-[60px] w-fit"
                )}
            />
        </div>
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
