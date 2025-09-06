// CanvasBase.tsx
import "./Canvas.css";
import { ReactNode, useEffect, useMemo, useReducer } from "react";
import { IoIosArrowDown, IoIosArrowUp } from "react-icons/io";
import { MdClear } from "react-icons/md";

import { Element, ElementContent } from "@giga-app/interface";
import { useEditModeContext } from "../../edit/EditModeProvider";
import { useCanvas } from "../../CanvasWrapper";
import { rectIsStaticMarkdownText } from "../../utils/rect";
import { Spinner } from "../../../utils/Spinner";
import { Frame } from "../../../content/Frame";

type SizeProps = {
    width?: number;
    height?: number;
    scaled?: boolean;
    fitHeight?: boolean;
    fitWidth?: boolean;
};

type BaseProps = SizeProps & {
    children?: ReactNode;
    bgBlur?: boolean;
    requestPublish?: () => void | Promise<void>;
} & ({ draft: true; inFullScreen?: boolean } | { draft: false }) & {
        className?: string;
        onLoad?: () => void;
        /** Optional explicit editability override; defaults to context (often tied to `draft`) */
        editable?: boolean;
    };

// Configuration the wrappers pass down
export type ControlContext = {
    rect: Element<any>;
    index: number;
    list: Element<any>[];
    remove: () => Promise<void>;
    moveUp: () => Promise<void>;
    moveDown: () => Promise<void>;
    editEnabled: boolean;
};

export type CanvasBaseConfig = {
    mode: "mixed" | "images" | "text";
    containerClass: string;
    frameFit: "cover" | "contain" | undefined;
    editModeEnabled: (globalEditMode: boolean) => boolean;
    showEditControls: (globalEditMode: boolean, items: number) => boolean;
    filterRects: (rects: Element<any>[]) => Element<any>[];
    itemWrapperClass: (rect: Element<any>) => string;
    renderControls?: (ctx: ControlContext) => React.ReactNode;
    enableDrag?: boolean;
};

export const CanvasBase = (props: BaseProps & { config: CanvasBaseConfig }) => {
    const asThumbnail = !!props.scaled;

    const {
        active,
        setActive,
        pendingRects,
        rects,
        removePending,
        canvas,
        mutate,
        isLoading,
        reduceElementsForViewing,
    } = useCanvas();

    const { editMode, setEditMode } = useEditModeContext();
    // Only drive the shared edit mode context when explicitly requested
    useEffect(() => {
        if (props.editable !== undefined) {
            setEditMode(props.editable);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.editable]);

    const [_, forceUpdate] = useReducer((x) => x + 1, 0);

    // 1) Filter by mode; 2) optional onlyLowestQuality for images; 3) group/normalize in context
    const filteredRects = useMemo(() => {
        let all = [...rects, ...pendingRects];
        all = props.config.filterRects(all);
        return reduceElementsForViewing(all);
    }, [rects, pendingRects, reduceElementsForViewing, props.config]);

    // Aggregate onLoad — only call props.onLoad once all frames loaded
    const loadedSet: Set<string> = useMemo(() => new Set(), []);
    const handleLoad = (el: Element<ElementContent>) => {
        loadedSet.add(el.idString);
        if (props.onLoad && loadedSet.size === filteredRects.length) {
            props.onLoad();
        }
    };

    const sizingClassNames = ` ${props.fitHeight ? "h-full" : ""} ${
        props.fitWidth ? "w-full" : ""
    } ${props.draft ? (props.inFullScreen ? "" : "") : ""}`;

    // Allow explicit override via props.editable; otherwise use context
    const rawEditable = props.editable ?? editMode;
    const effectiveEditMode = props.config.editModeEnabled(rawEditable);
    const showControls = props.config.showEditControls(
        editMode,
        filteredRects.length
    );

    const renderRects = (toRender: Element<ElementContent>[]) =>
        toRender.map((rect, ix) => {
            const deleteFn = async () => {
                removePending(rect.id);
                try {
                    await canvas?.elements.del(rect.id);
                } catch {}
                forceUpdate();
            };

            return (
                <div
                    key={rect.idString}
                    className={props.config.itemWrapperClass(rect)}
                >
                    <div
                        className={`relative flex flex-col overflow-hidden ${
                            rectIsStaticMarkdownText(rect)
                                ? ""
                                : "max-h-[60vh] h-full"
                        }`}
                    >
                        {filteredRects.length === 0 && isLoading && (
                            <div className="absolute right-2 flex justify-center align-middle">
                                <Spinner />
                            </div>
                        )}
                        {filteredRects.length > 0 && (
                            <>
                                <Frame
                                    requestPublish={props.requestPublish}
                                    thumbnail={asThumbnail}
                                    active={active.has(rect.id)}
                                    className="z-1"
                                    setActive={(v) => {
                                        if (v)
                                            setActive(
                                                new Set(active.add(rect.id))
                                            );
                                        else
                                            setActive(
                                                new Set(
                                                    [...active].filter(
                                                        (el) => el !== rect.id
                                                    )
                                                )
                                            );
                                    }}
                                    delete={deleteFn}
                                    editMode={effectiveEditMode}
                                    showEditControls={showControls}
                                    element={rect}
                                    onLoad={() => handleLoad(rect)}
                                    fit={props.config.frameFit}
                                    inFullscreen={
                                        props.draft && props.inFullScreen
                                    }
                                    editControls={
                                        showControls ? (
                                            <div className="mx-1 flex flex-col items-center">
                                                <button
                                                    className="mb-2 btn border btn-icon btn-icon-sm"
                                                    disabled={ix === 0}
                                                    onClick={() =>
                                                        mutate(
                                                            (element) => {
                                                                const prev =
                                                                    filteredRects[
                                                                        ix - 1
                                                                    ];
                                                                element.location.y -= 1;
                                                                return mutate(
                                                                    (e) => {
                                                                        e.location.y += 1;
                                                                        forceUpdate();
                                                                        return true;
                                                                    },
                                                                    {
                                                                        filter: (
                                                                            el
                                                                        ) =>
                                                                            el.idString ===
                                                                            prev.idString,
                                                                    }
                                                                );
                                                            },
                                                            {
                                                                filter: (el) =>
                                                                    el.idString ===
                                                                    rect.idString,
                                                            }
                                                        )
                                                    }
                                                >
                                                    <IoIosArrowUp />
                                                </button>

                                                <button
                                                    className="mb-2 btn border btn-icon btn-icon-sm"
                                                    onClick={deleteFn}
                                                >
                                                    <MdClear />
                                                </button>

                                                <button
                                                    className="mb-2 btn border btn-icon btn-icon-sm"
                                                    disabled={
                                                        toRender.length - 1 ===
                                                        ix
                                                    }
                                                    onClick={() =>
                                                        mutate(
                                                            (element) => {
                                                                const next =
                                                                    filteredRects[
                                                                        ix + 1
                                                                    ];
                                                                element.location.y += 1;
                                                                return mutate(
                                                                    (e) => {
                                                                        e.location.y -= 1;
                                                                        return true;
                                                                    },
                                                                    {
                                                                        filter: (
                                                                            el
                                                                        ) =>
                                                                            el.idString ===
                                                                            next.idString,
                                                                    }
                                                                );
                                                            },
                                                            {
                                                                filter: (el) =>
                                                                    el.idString ===
                                                                    rect.idString,
                                                            }
                                                        )
                                                    }
                                                >
                                                    <IoIosArrowDown />
                                                </button>
                                            </div>
                                        ) : null
                                    }
                                />

                                {/* blur bg for non-text */}
                                <svg
                                    xmlns="https://www.w3.org/2000/svg"
                                    className="border-0 clip-0 h-[1px] -m-[1px] overflow-hidden p-0 absolute w-[1px]"
                                    version="1.1"
                                >
                                    <filter id="gaussianBlurCanvas">
                                        <feGaussianBlur
                                            stdDeviation="25"
                                            result="blur"
                                        />
                                    </filter>
                                </svg>

                                {!rectIsStaticMarkdownText(rect) &&
                                    props.bgBlur && (
                                        <div className="absolute bg-white dark:bg-black w-[150%] h-[150%] left-1/2 top-1/2  -translate-x-1/2 -translate-y-1/2 ">
                                            <div className="opacity-30 [filter:url('#gaussianBlurCanvas')]">
                                                <Frame
                                                    thumbnail={false}
                                                    active={false}
                                                    setActive={() => {}}
                                                    delete={() => {}}
                                                    editMode={false}
                                                    showEditControls={false}
                                                    element={rect}
                                                    onLoad={() => {}}
                                                    fit="cover"
                                                />
                                            </div>
                                        </div>
                                    )}
                            </>
                        )}
                    </div>
                </div>
            );
        });

    const hasChildren = !!props.children;
    if (!hasChildren && filteredRects.length === 0) {
        return <></>;
    }
    return (
        <div
            className={`flex ${
                props.config.containerClass
            } ${sizingClassNames} ${props.className ?? ""}`}
        >
            {filteredRects.length > 0 ? renderRects(filteredRects) : null}
            {props.children}
        </div>
    );
};
