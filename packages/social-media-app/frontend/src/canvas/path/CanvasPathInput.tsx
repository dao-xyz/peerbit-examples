import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, FilterModel } from "@giga-app/interface";
import { useCanvases } from "../useCanvas";
import { useNavigate } from "react-router";
import { getCanvasPath } from "../../routes";
import { RiSearchEyeLine } from "react-icons/ri";

import clsx from "clsx";
import { useStream } from "../feed/StreamContext";
import { HeaderLogo } from "../../Logo";
import { TiChevronRight, TiChevronLeft } from "react-icons/ti";
import { useBackToParent } from "../useBackToParent";
import { smartPath } from "./utils";

const DEFAULT_VIEW = "best"; // Default view ID for the "Best" chip
const DEBOUNCE = 300; // ms

export const CanvasPathInput: React.FC<{
    onFocusChange?: (state: boolean) => void;
    className?: string;
}> = ({ onFocusChange, className }) => {
    /* ── global state ─────────────────────────────────────────────── */
    const {
        filterModel,
        dynamicViews,
        defaultViews,
        timeFilter,
        typeFilter,
        setQueryParams,
        query,
    } = useStream();

    /* ── breadcrumb state ─────────────────────────────────────────── */
    const { path } = useCanvases();
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
        ...(filterModel &&
            filterModel.id !== "best" &&
            filterModel.id !== "chat"
            ? [
                {
                    key: "view",
                    label: filterModel.name,
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
    const streamSettingsLookup = useMemo(() => {
        const m = new Map<string, FilterModel>();
        [
            ...dynamicViews.map((v) => v.toFilterModel()),
            ...defaultViews,
        ].forEach((v) => m.set(v.name.toLowerCase(), v));
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
        const match =
            filterModel?.id === DEFAULT_VIEW && streamSettingsLookup.get(last);
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
        else if (filterModel?.id !== DEFAULT_VIEW)
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
                "flex flex-wrap items-center gap-1 my-1",
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

            {/*  <ExperienceDropdownButton /> */}

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
                    focused ? "min-w-[40px]" : "w-fit" /* max-w-[60px] */
                )}
            />
        </div>
    );
};

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
