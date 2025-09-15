import {
    Element,
    ElementContent,
    StaticContent,
    StaticMarkdownText,
} from "@giga-app/interface";
import {
    JSX,
    ReactNode,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useCallback,
} from "react";
import { Frame } from "../../../content/Frame";
import {
    rectIsStaticImage,
    rectIsStaticMarkdownText,
    rectIsStaticPartialImage,
} from "../../utils/rect";
import clsx from "clsx";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import { useCanvas } from "../../CanvasWrapper";
import { equals } from "uint8arrays";
import { emitDebugEvent } from "../../../debug/debug";
import { toBase64URL } from "@peerbit/crypto";
import { FaChevronLeft, FaChevronRight } from "react-icons/fa";
import { isTouchDevice } from "../../../utils/device";
import { on } from "events";

type AlignedVariantType = "quote" | "chat-message";

type VariantType =
    | "tiny"
    | "post"
    | "row"
    | "breadcrumb"
    | "expanded-breadcrumb"
    | "detail"
    | AlignedVariantType;

type BaseCanvasPreviewProps = {
    onClick?: (e: Element<ElementContent>) => void;
    variant: VariantType;
    // forward ref
    forwardRef?: React.Ref<any>;
    className?: string;
    classNameContent?: string | ((element: Element<ElementContent>) => string);
    onLoad?: () => void;
    whenEmpty?: JSX.Element;
    debug?: boolean;
};

type StandardVariantProps = BaseCanvasPreviewProps & {
    variant: Exclude<VariantType, AlignedVariantType>;
    align?: never;
};

type ChatMessageVariantProps = BaseCanvasPreviewProps & {
    variant: AlignedVariantType;
    align: "left" | "right";
};

export type CanvasPreviewProps = StandardVariantProps | ChatMessageVariantProps;

function getRectsForVariant<V extends VariantType>(
    separatedRects: {
        text: Element<StaticContent<StaticMarkdownText>>[];
        other: Element<ElementContent>[];
    },
    variant: V
): V extends "tiny" | "breadcrumb"
    ? Element<ElementContent> | undefined
    : {
        text?: Element<StaticContent<StaticMarkdownText>>;
        other: Element<ElementContent>[];
    } {
    switch (variant) {
        case "tiny":
        case "breadcrumb":
            return (separatedRects.other[0] ??
                separatedRects.text[0] ??
                undefined) as any;
        case "post":
        case "detail":
        case "expanded-breadcrumb":
        case "quote":
        case "row":
        case "chat-message":
            return {
                text: separatedRects.text[0],
                other: separatedRects.other,
            } as any;
    }
}

const PreviewFrame = ({
    element,
    previewLines,
    bgBlur,
    maximizeHeight,
    fit,
    noPadding,
    onClick,
    className,
    onLoad,
    canOpenFullscreen,
    classNameContent,
}: {
    element: Element<ElementContent>;
    previewLines?: number;
    bgBlur?: boolean;
    maximizeHeight?: boolean;
    fit?: "cover" | "contain";
    noPadding?: boolean;
    onClick?: (e: Element<ElementContent>) => void;
    className?: string | ((element: Element<ElementContent>) => string);
    onLoad?: () => void;
    canOpenFullscreen?: boolean;
    classNameContent?: string;
}) => (
    <div
        className={`flex flex-col relative w-full ${maximizeHeight ? "h-full" : ""
            }`}
        onClick={(e) => {
            if (onClick) {
                onClick(element);
                e.stopPropagation();
            }
        }}
    >
        <Frame
            thumbnail={false}
            active={false}
            setActive={() => { }}
            delete={() => { }}
            editMode={false}
            showEditControls={false}
            element={element}
            onLoad={onLoad}
            fit={fit}
            previewLines={previewLines}
            noPadding={noPadding}
            canOpenFullscreen={canOpenFullscreen}
            className={
                "z-1 " +
                (typeof className === "function"
                    ? className(element)
                    : className)
            }
        />

        {bgBlur && (
            <BlurredBackground element={element} noPadding={noPadding} />
        )}
    </div>
);

/* const BlurredBackground = ({
    element,
    noPadding,
}: {
    element: Element<ElementContent>;
    noPadding?: boolean;
}) => (
    <>
        <svg
            xmlns="https://www.w3.org/2000/svg"
            className="border-0 clip-0 h-[1px] -m-[1px] overflow-hidden p-0 absolute w-[1px]"
            version="1.1"
        >
            <filter id="gaussianBlurPreview">
                <feGaussianBlur stdDeviation="20" result="blur" />
            </filter>
        </svg>

        <div
            id="frame-with-blur"
            className="absolute bg-white dark:bg-black w-[150%] h-[150%] left-1/2 top-1/2  -translate-x-1/2 -translate-y-1/2 "
        >
            <div className=" opacity-30  [filter:url('#gaussianBlurCanvas')]">
                <Frame
                    thumbnail={false}
                    active={false}
                    setActive={() => { }}
                    delete={() => { }}
                    editMode={false}
                    showEditControls={false}
                    element={element}
                    onLoad={() => { }}
                    fit="cover"
                />
            </div>
        </div>
    </>
); */

const BlurredBackground = ({
    element,
    noPadding,
}: {
    element: Element<ElementContent>;
    noPadding?: boolean;
}) =>
    /* one absolutely‑positioned layer, never re‑rendered by React */
    rectIsStaticImage(element) || rectIsStaticPartialImage(element) ? (
        <div
            className="absolute inset-0 overflow-hidden pointer-events-none
                 select-none will-change-transform will-change-filter"
        >
            <Frame
                /* ← same props you already pass elsewhere */
                thumbnail={false}
                active={false}
                setActive={() => { }}
                delete={() => { }}
                editMode={false}
                showEditControls={false}
                element={element}
                onLoad={() => { }}
                fit="cover"
                /* ⚡ key performance classes */
                className="w-full h-full object-cover
                   scale-110 blur-xl opacity-30"
            />
        </div>
    ) : (
        <></>
    );

const TinyPreview = ({
    rect,
    onClick,
    onAllElementsLoaded,
    className,
}: {
    rect: Element<ElementContent>;
    onClick?: (e: Element<ElementContent>) => void;
    onAllElementsLoaded?: () => void;
    className?: string | ((element: Element<ElementContent>) => string);
}) => {
    const loadedRef = useRef(false);
    useEffect(() => {
        loadedRef.current = false;
    }, [rect?.idString]);
    const handleLoad = () => {
        if (!loadedRef.current) {
            loadedRef.current = true;
            onAllElementsLoaded?.();
        }
    };
    return (
        <PreviewFrame
            element={rect}
            fit="cover"
            maximizeHeight
            onClick={onClick}
            onLoad={handleLoad}
            canOpenFullscreen={false}
            className={className}
        />
    );
};

const BreadcrumbPreview = ({
    rect,
    onClick,
    onAllElementsLoaded,
    className,
}: {
    rect;
    onClick?: (e: Element<ElementContent>) => void;
    onAllElementsLoaded?: () => void;
    className?: string | ((element: Element<ElementContent>) => string);
}) => {
    let isText = false;
    let textLength: number | undefined = undefined;
    if (rectIsStaticMarkdownText(rect)) {
        isText = true;
        textLength = toString(fromMarkdown(rect.content.content.text)).length;
    }
    const loadedRef = useRef(false);
    useEffect(() => {
        loadedRef.current = false;
    }, [rect?.idString]);
    const handleLoad = () => {
        if (!loadedRef.current) {
            loadedRef.current = true;
            onAllElementsLoaded?.();
        }
    };
    return (
        <div
            className={clsx(
                isText
                    ? textLength && textLength > 10
                        ? "w-[8ch]"
                        : "w-fit"
                    : "w-",
                isText && "px-1",
                "flex-none h-full flex items-center justify-center rounded overflow-hidden  ",
                className
            )}
        >
            <PreviewFrame
                element={rect}
                fit="cover"
                previewLines={1}
                noPadding={isText}
                maximizeHeight
                onClick={onClick}
                onLoad={handleLoad}
                className={"w-full h-full flex items-center justify-center"}
            />
        </div>
    );
};

const RowPreview = ({
    rects,
    onClick,
    className,
    onAllElementsLoaded,
}: {
    rects;
    className?: string;
    onClick?: (e: Element<ElementContent>) => void;
    onAllElementsLoaded?: () => void;
}) => {
    const { other: apps, text } = rects;
    const expected = Math.min(2, apps.length) + (text ? 1 : 0);
    const loadedIds = useRef<Set<string>>(new Set());
    useEffect(() => {
        loadedIds.current.clear();
    }, [apps, text]);
    const handleLoad = (el: Element<ElementContent>) => {
        if (!el?.idString) return;
        loadedIds.current.add(el.idString);
        if (loadedIds.current.size >= expected) {
            onAllElementsLoaded?.();
        }
    };
    return (
        <div className={"flex flex-row   items-center " + (className ?? "")}>
            {apps.slice(0, 2).map((app, i) => (
                <div
                    key={i}
                    className="w-6 rounded-sm overflow-hidden  relative"
                >
                    <PreviewFrame
                        element={app}
                        fit="cover"
                        maximizeHeight
                        onClick={onClick}
                        onLoad={() => handleLoad(app)}
                    />
                    {i === 1 && apps.slice(2).length > 0 && (
                        <div className="absolute inset-0 bg-neutral-50/80 dark:bg-neutral-950/80 flex items-center justify-center">
                            +{apps.slice(2).length}
                        </div>
                    )}
                </div>
            ))}
            {text && (
                <div className="rounded-md px-1.5 max-w-[150px] py-1">
                    <PreviewFrame
                        element={text}
                        previewLines={1}
                        noPadding
                        onClick={onClick}
                        onLoad={() => handleLoad(text)}
                    />
                </div>
            )}
        </div>
    );
};

const ExpandedBreadcrumbPreview = ({
    rects,
    onClick,
    forwardedRef,
    onAllElementsLoaded,
}: {
    rects: { text?: Element<ElementContent>; other: Element<ElementContent>[] };
    onClick?: (e: Element<ElementContent>) => void;
    forwardedRef?: React.Ref<HTMLDivElement>;
    onAllElementsLoaded?: () => void;
}) => {
    const { other: apps, text } = rects;
    const expected = Math.min(2, apps.length) + (text ? 1 : 0);
    const loadedIds = useRef<Set<string>>(new Set());
    useEffect(() => {
        loadedIds.current.clear();
    }, [apps, text]);
    const handleLoad = (el: Element<ElementContent>) => {
        if (!el?.idString) return;
        loadedIds.current.add(el.idString);
        if (loadedIds.current.size >= expected) {
            onAllElementsLoaded?.();
        }
    };
    return (
        <div
            className="col-span-full flex gap-1.5 items-start w-full rounded-lg"
            ref={forwardedRef}
        >
            {apps.slice(0, 2).map((app, i) => (
                <div
                    key={i}
                    className="shrink-0 w-[3.625rem] h-[3.625rem] rounded-sm overflow-hidden  relative"
                >
                    <PreviewFrame
                        element={app}
                        fit="cover"
                        maximizeHeight
                        onClick={onClick}
                        onLoad={() => handleLoad(app)}
                    />
                    {i === 1 && apps.slice(2).length > 0 && (
                        <div className="absolute inset-0 bg-neutral-50/80 dark:bg-neutral-950/80 flex items-center justify-center">
                            +{apps.slice(2).length}
                        </div>
                    )}
                </div>
            ))}
            {text && (
                <div className="  rounded-md px-1.5 py-1">
                    <PreviewFrame
                        element={text}
                        previewLines={2}
                        noPadding
                        onClick={onClick}
                        onLoad={() => handleLoad(text)}
                    />
                </div>
            )}
        </div>
    );
};

const PostQuotePreview = ({
    rects,
    onClick,
    author,
    forwardedRef,
    onAllElementsLoaded,
}: {
    rects: {
        text?: Element<StaticContent<StaticMarkdownText>>;
        other: Element<ElementContent>[];
    };
    onClick?: (e: Element<ElementContent>) => void;
    author?: string;
    forwardedRef?: React.Ref<HTMLDivElement>;
    onAllElementsLoaded?: () => void;
}) => {
    const { other: apps, text } = rects;
    const expected = Math.min(2, apps.length) + (text ? 1 : 0);
    const loadedIds = useRef<Set<string>>(new Set());
    useEffect(() => {
        loadedIds.current.clear();
    }, [apps, text]);
    const handleLoad = (el: Element<ElementContent>) => {
        if (!el?.idString) return;
        loadedIds.current.add(el.idString);
        if (loadedIds.current.size >= expected) {
            onAllElementsLoaded?.();
        }
    };
    return (
        <div
            ref={forwardedRef}
            className="col-start-2 col-span-3 flex items-stretch w-fit max-w-prose rounded-lg border border-l-4 border-l-neutral-950 dark:border-l-neutral-50 border-neutral-700 dark:border-neutral-300 bg-neutral-200 dark:bg-neutral-800"
        >
            <svg
                xmlns="https://www.w3.org/2000/svg"
                className="border-0 clip-0 h-[1px] -m-[1px] overflow-hidden p-0 absolute w-[1px]"
                version="1.1"
            >
                <filter id="gaussianBlurCanvas">
                    <feGaussianBlur stdDeviation="20" result="blur" />
                </filter>
            </svg>
            {apps.slice(0, 2).map((app, i) => (
                <div
                    key={i}
                    className={clsx(
                        "shrink-0 w-[3.625rem] h-[3.625rem] rounded-sm overflow-hidden outline outline-neutral-700 dark:outline-neutral-300 relative",
                        i === 1 ? "-ml-10" : "z-1"
                    )}
                >
                    <div
                        className={clsx(
                            "w-full h-full",
                            i === 1 &&
                            apps.slice(1).length > 0 &&
                            "[filter:url('#gaussianBlurCanvas')]"
                        )}
                    >
                        <PreviewFrame
                            element={app}
                            fit="cover"
                            maximizeHeight
                            onClick={onClick}
                            onLoad={() => handleLoad(app)}
                        />
                    </div>
                    {i === 1 && apps.slice(2).length > 0 && (
                        <div className="absolute inset-0 bg-neutral-50/80 dark:bg-neutral-950/80 flex items-center justify-center">
                            +{apps.slice(2).length}
                        </div>
                    )}
                </div>
            ))}
            <div className="px-2 py-2 flex flex-col justify-around gap-0.5">
                <b className="leading-tight">{author?.substring(0, 7)}</b>
                {text?.content.content.text ? (
                    <span className="leading-tight">
                        <PreviewFrame
                            element={text}
                            noPadding
                            onClick={onClick}
                            onLoad={() => handleLoad(text)}
                        />
                    </span>
                ) : (
                    <i className="leading-tight">
                        {apps.length} {apps.length > 1 ? "Apps" : "App"}
                    </i>
                )}
            </div>
        </div>
    );
};

const PostPreview = ({
    rects,
    onClick,
    forwardRef,
    className,
    classNameContent,
    onAllElementsLoaded,
}: {
    rects: {
        text?: Element<StaticContent<StaticMarkdownText>>;
        other: Element<ElementContent>[];
    };
    onClick?: (e: Element<ElementContent>) => void;
    forwardRef?: React.Ref<any>;
    className?: string;
    classNameContent?: string | ((el: Element<ElementContent>) => string);
    onAllElementsLoaded?: () => void;
}) => {
    const { text, other: media } = rects;
    const expected = (media?.length || 0) + (text ? 1 : 0);
    const loadedIds = useRef<Set<string>>(new Set());
    useEffect(() => {
        loadedIds.current.clear();
    }, [media, text]);
    const handleLoad = (el: Element<ElementContent>) => {
        if (!el?.idString) return;
        loadedIds.current.add(el.idString);
        if (loadedIds.current.size >= expected) {
            onAllElementsLoaded?.();
        }
    };
    if (media.length === 0 && !text) return null;
    /* ─────────────── layout ─────────────── */
    return (
        <div
            ref={forwardRef}
            className={clsx("flex flex-col w-full gap-2", className)}
        >
            {media.length > 0 && (
                /* 1️⃣ height-capped wrapper */
                <div className="max-h-[60vh] min-h-20 overflow-hidden">
                    {/* 2️⃣ let flexbox respect the cap */}
                    <MediaCarousel
                        elements={media}
                        onClick={onClick}
                        onLoad={handleLoad}
                        classNameContent={classNameContent + " min-h-0"}
                    />
                </div>
            )}

            {text && (
                <div className="px-2">
                    <PreviewFrame
                        element={text}
                        noPadding
                        onClick={onClick}
                        onLoad={() => handleLoad(text)}
                        className={classNameContent}
                        canOpenFullscreen
                    />
                </div>
            )}
        </div>
    );
};

const MediaCarousel = ({
    elements,
    onClick,
    onLoad,
    classNameContent,
}: {
    elements: Element<ElementContent>[];
    onClick?: (e: Element<ElementContent>) => void;
    onLoad?: (el: Element<ElementContent>) => void;
    classNameContent?: string | ((el: Element<ElementContent>) => string);
}) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const [index, setIndex] = useState(0);

    /* keep active index in sync with scroll-snap position */
    useEffect(() => {
        const el = trackRef.current;
        if (!el) return;
        const handle = () => {
            setIndex(Math.round(el.scrollLeft / el.clientWidth));
        };
        el.addEventListener("scroll", handle, { passive: true });
        return () => el.removeEventListener("scroll", handle);
    }, []);

    const scrollTo = (i: number) => {
        if (i < 0) {
            i = elements.length - 1;
        }
        if (i >= elements.length) {
            i = 0;
        }

        setIndex(i);
        trackRef.current?.scrollTo({
            left: i * (trackRef.current?.clientWidth ?? 0),
            behavior: "instant",
        });
    };

    /* aggregate onLoad events, bubble once */
    const loaded = useRef<Set<string>>(new Set());
    const bubble = (el: Element<ElementContent>) => {
        loaded.current.add(el.idString);
        if (onLoad) {
            onLoad(el);
        }
    };

    if (elements.length === 0) return null;

    return (
        /* relative so thumbs can be absolutely positioned */
        <div className="relative flex flex-col w-full h-full">
            {/* ── big slides ────────────────────────────── */}
            <div
                ref={trackRef}
                className="flex w-full overflow-x-auto no-scrollbar snap-x snap-mandatory"
            >
                {elements.map((el) => (
                    <div
                        key={el.idString}
                        className="flex-shrink-0 w-full snap-center"
                        onClick={() => onClick(el)}
                    >
                        <PreviewFrame
                            bgBlur
                            element={el}
                            fit="contain"
                            maximizeHeight
                            onLoad={() => bubble(el)}
                            className={classNameContent + " min-h-0"}
                            canOpenFullscreen
                        />
                    </div>
                ))}
            </div>
            {/* Arrow controls — shown ≥ md breakpoint */}
            {elements.length > 1 && (
                <>
                    <button
                        aria-label="Previous image"
                        onClick={() => scrollTo(index - 1)}
                        className=" flex absolute left-2 top-1/2 -translate-y-1/2 z-1 bg-white/70 dark:bg-black/40 backdrop-blur p-1.5 rounded-full hover:scale-105 transition"
                    >
                        <FaChevronLeft size={20} />
                    </button>
                    <button
                        aria-label="Next image"
                        onClick={() => scrollTo(index + 1)}
                        className=" flex absolute right-2 top-1/2 -translate-y-1/2 z-1 bg-white/70 dark:bg-black/40 backdrop-blur p-1.5 rounded-full hover:scale-105 transition"
                    >
                        <FaChevronRight size={20} />
                    </button>
                </>
            )}

            {/* ── round thumbnail indicator ─────────────── */}
            {elements.length > 1 && (
                <div
                    className="
             absolute bottom-1 left-1/2 -translate-x-1/2
             flex gap-3 p-1.5
             bg-white/60 dark:bg-black/40 backdrop-blur
             rounded-full
             z-1 
             scale-50
             hover:scale-100
            transition-transform
             "
                >
                    {elements.map((el, i) => (
                        <button
                            key={el.idString}
                            aria-label={`Slide ${i + 1}`}
                            onClick={() => scrollTo(i)}
                            className={clsx(
                                "flex-none w-8 h-8 rounded-full overflow-hidden btn-bouncy",
                                "transition",
                                i === index
                                    ? "ring-2 ring-primary-500 scale-105"
                                    : "opacity-75 hover:opacity-100 grayscale"
                            )}
                        >
                            <PreviewFrame
                                element={el}
                                fit="cover"
                                maximizeHeight
                                className="w-full h-full"
                                canOpenFullscreen={false}
                            />
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

/**
 * Horizontally‑scrollable carousel using CSS scroll‑snap.
 */

type CarouselProps = {
    elements: Element<ElementContent>[];
    onClick?: (e: Element<ElementContent>) => void;
    onLoad?: (el: Element<ElementContent>) => void;
    classNameContent?: string | ((el: Element<ElementContent>) => string);
};

/**
 * Wrapper that clamps its children vertically and toggles on click.
 */
const Expandable = ({
    children,
    collapsedMaxHeight,
}: {
    children: ReactNode;
    collapsedMaxHeight: number | string;
}) => {
    const [expanded, setExpanded] = useState(false);
    const [overflowing, setOverflowing] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    // detect overflow whenever content, size, or expansion state changes
    const checkOverflow = () => {
        const el = ref.current;
        if (!el) return;
        const isOverflowing = el.scrollHeight > el.clientHeight + 1; // tolerance
        setOverflowing(isOverflowing);
    };

    useLayoutEffect(() => {
        checkOverflow();
    }, [children, expanded]);

    useEffect(() => {
        window.addEventListener("resize", checkOverflow);
        return () => window.removeEventListener("resize", checkOverflow);
    }, []);

    const style = expanded
        ? undefined
        : ({
            maxHeight:
                typeof collapsedMaxHeight === "number"
                    ? `${collapsedMaxHeight}px`
                    : collapsedMaxHeight,
            overflow: "hidden",
        } as React.CSSProperties);

    const toggle = (e: React.MouseEvent) => {
        e.stopPropagation();
        setExpanded((p) => !p);
    };

    return (
        <div className="relative" onClick={toggle}>
            <div ref={ref} style={style} className="select-text">
                {children}
            </div>

            {/* gradient fade when collapsed */}
            {!expanded && overflowing && (
                <div className="pointer-events-none absolute bottom-0 left-0 h-12 w-full bg-gradient-to-t from-white dark:from-black via-transparent" />
            )}

            {/* Show‑more / less button */}
            {overflowing && (
                <button
                    onClick={toggle}
                    className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 bg-white/80 dark:bg-black/60 backdrop-blur px-3 py-0.5 rounded-full text-xs font-medium shadow hover:scale-105 transition"
                >
                    {expanded ? "Show less" : "Show more"}
                </button>
            )}
        </div>
    );
};

export const DetailedPreview = ({
    rects,
    onClick,
    forwardRef,
    className,
    classNameContent,
    onAllElementsLoaded,
}: {
    rects: {
        text?: Element<StaticContent<StaticMarkdownText>>;
        other: Element<ElementContent>[];
    };
    onClick?: (e: Element<ElementContent>) => void;
    forwardRef?: React.Ref<any>;
    className?: string;
    classNameContent?: string | ((el: Element<ElementContent>) => string);
    onAllElementsLoaded?: () => void;
}) => {
    const images = rects.other;
    const text = rects.text;
    const expected = (images?.length || 0) + (text ? 1 : 0);
    const loadedIds = useRef<Set<string>>(new Set());
    useEffect(() => {
        loadedIds.current.clear();
    }, [images, text]);
    const handleLoad = (el: Element<ElementContent>) => {
        if (!el?.idString) return;
        loadedIds.current.add(el.idString);
        if (loadedIds.current.size >= expected) {
            onAllElementsLoaded?.();
        }
    };
    const allOthersAreImages =
        images.length > 0 &&
        images.every(
            (el) => rectIsStaticImage(el) || rectIsStaticPartialImage(el)
        );

    // ────────────────── layout cases ──────────────────

    if (images.length > 0) {
        return (
            <div
                ref={forwardRef}
                className={clsx("flex flex-col w-full", className)}
            >
                <MediaCarousel
                    elements={images}
                    onClick={onClick}
                    onLoad={handleLoad}
                    classNameContent={
                        classNameContent +
                        (text ? " max-h-[40vh]" : " max-h-[60vh]")
                    } // add max-height if text is present
                />

                {text && (
                    <div className="p-2">
                        <Expandable
                            collapsedMaxHeight={
                                allOthersAreImages ? 150 : "60vh"
                            }
                        >
                            <PreviewFrame
                                element={text}
                                noPadding
                                onClick={onClick}
                                onLoad={() => handleLoad(text)}
                                className={classNameContent}
                            />
                        </Expandable>
                    </div>
                )}
            </div>
        );
    }

    // Only text
    if (text) {
        return (
            <div
                ref={forwardRef}
                className={clsx("flex flex-col w-full px-4 py-4", className)}
            >
                <Expandable collapsedMaxHeight="60vh">
                    <PreviewFrame
                        element={text}
                        noPadding
                        onClick={onClick}
                        onLoad={() => handleLoad(text)}
                        className={classNameContent}
                    />
                </Expandable>
            </div>
        );
    }

    return null;
};

const ChatMessagePreview = ({
    rects,
    onClick,
    forwardRef,
    className,
    classNameContent,
    onAllElementsLoaded,
}: {
    rects: { text?: Element<ElementContent>; other: Element<ElementContent>[] };
    onClick?: (e: Element<ElementContent>) => void;
    forwardRef?: React.Ref<any>;
    className?: string;
    classNameContent?: string | ((element: Element<ElementContent>) => string);
    onAllElementsLoaded?: () => void;
}) => {
    const { other: apps, text } = rects;
    const expected = (apps?.length || 0) + (text ? 1 : 0);
    const loadedIds = useRef<Set<string>>(new Set());
    useEffect(() => {
        loadedIds.current.clear();
    }, [apps, text]);
    const handleLoad = (el: Element<ElementContent>) => {
        if (!el?.idString) return;
        loadedIds.current.add(el.idString);
        if (loadedIds.current.size >= expected) {
            onAllElementsLoaded?.();
        }
    };
    return (
        <div className={"flex flex-col h-full " + className} ref={forwardRef}>
            {apps.map((app) => (
                <div
                    key={app.idString}
                    onClick={() => onClick(app)}
                    className="w-fit max-height-inherit-children flex flex-col overflow-hidden h-full rounded-md relative"
                >
                    <PreviewFrame
                        bgBlur
                        element={app}
                        fit="contain"
                        maximizeHeight
                        onLoad={() => handleLoad(app)}
                        className={classNameContent}
                    />
                </div>
            ))}
            {text && (
                <div
                    onClick={() =>
                        onClick(text)
                    } /* bg-neutral-50 dark:bg-neutral-950  */
                    className="max-w-prose rounded-md px-2 py-1"
                >
                    <PreviewFrame
                        element={text}
                        previewLines={3}
                        noPadding
                        onLoad={() => handleLoad(text)}
                        className={classNameContent}
                    />
                </div>
            )}
        </div>
    );
};

export const CanvasPreview = ({
    variant,
    onClick,
    forwardRef,
    className,
    onLoad,
    whenEmpty,
    classNameContent, // TODO is this property really needed?
}: CanvasPreviewProps) => {
    const { rects, pendingRects, separateAndSortRects, canvas } = useCanvas();

    // Prefer actual element presence over potentially stale index metadata.
    // Some publishes can momentarily report elements=0 in the index row even
    // after elements are persisted; rely on rect queries for visibility.
    const hasLocalRects =
        (rects?.length ?? 0) + (pendingRects?.length ?? 0) > 0;

    const variantRects = useMemo(() => {
        // Defensive: only render elements that belong to THIS canvas id
        const cid = canvas?.id;
        const own = cid
            ? [...rects, ...pendingRects].filter((e) => equals(e.canvasId, cid))
            : [...rects];
        return getRectsForVariant(separateAndSortRects(own), variant);
    }, [canvas?.idString, rects, pendingRects, variant]);

    // Debug: log what text we are about to render for this canvas
    useEffect(() => {
        try {
            const cid = canvas?.id ? toBase64URL(canvas.id) : undefined;
            const texts: string[] = [];
            const collectText = (els: Element<ElementContent>[]) => {
                els.forEach((e) => {
                    if (
                        e.content instanceof StaticContent &&
                        e.content.content instanceof StaticMarkdownText
                    ) {
                        texts.push(e.content.content.text);
                    }
                });
            };
            if (variantRects instanceof Element) {
                collectText([variantRects as any]);
            } else if (variantRects) {
                const vr = variantRects as any;
                if (vr.text) collectText([vr.text]);
                if (vr.other) collectText(vr.other);
            }
            emitDebugEvent({
                source: "CanvasPreview",
                name: "render",
                canvasId: cid,
                texts,
                rects: rects.length,
                pending: pendingRects.length,
                variant,
            });
        } catch (e) {
            // safe to ignore debug issues
        }
    }, [canvas?.idString, rects.length, pendingRects.length, variant]);

    const isEmpty = useMemo(() => {
        return (
            !variantRects ||
            (variantRects instanceof Element === false &&
                variantRects.other.length === 0 &&
                !variantRects.text)
        );
    }, [variantRects]);

    // If the canvas has no elements, consider it "loaded" immediately so feed can reveal.
    useEffect(() => {
        // Reset the sentinel on canvas/variant change
        // and only report once per empty state
        if (canvas?.__indexed?.elements === 0n) {
            onLoad?.();
        }
    }, [canvas?.idString]);

    // Bubble up when all elements loaded
    const [allLoaded, setAllLoaded] = useState(false);
    useEffect(() => {
        if (allLoaded && onLoad) {
            onLoad();
        }
    }, [allLoaded, onLoad]);

    // Reset on canvas/variant change
    useEffect(() => {
        setAllLoaded(false);
    }, [canvas?.idString, variant]);

    const onAllElementsLoaded = useCallback(() => {
        setAllLoaded(true);
    }, []);

    const onEmpty = useMemo(() => whenEmpty ?? <></>, [whenEmpty]);

    // If we truly have nothing yet, allow placeholder/empty.
    if (!hasLocalRects && isEmpty) {
        return null;
    }
    if (isEmpty) {
        return onEmpty;
    }

    switch (variant) {
        case "tiny":
            return (
                <TinyPreview
                    className={className}
                    rect={variantRects as Element<ElementContent>}
                    onClick={onClick}
                    onAllElementsLoaded={onAllElementsLoaded}
                />
            );

        case "breadcrumb":
            return (
                <BreadcrumbPreview
                    className={className}
                    rect={variantRects as Element<ElementContent>}
                    onClick={onClick}
                    onAllElementsLoaded={onAllElementsLoaded}
                />
            );
        case "expanded-breadcrumb":
            return (
                <ExpandedBreadcrumbPreview
                    rects={
                        variantRects as {
                            text?: Element<ElementContent>;
                            other: Element<ElementContent>[];
                        }
                    }
                    onClick={onClick}
                    onAllElementsLoaded={onAllElementsLoaded}
                />
            );
        case "row":
            return (
                <RowPreview
                    className={className}
                    rects={
                        variantRects as {
                            text?: Element<ElementContent>;
                            other: Element<ElementContent>[];
                        }
                    }
                    onClick={onClick}
                    onAllElementsLoaded={onAllElementsLoaded}
                />
            );
        case "quote":
            return (
                <PostQuotePreview
                    rects={
                        variantRects as {
                            text?: Element<StaticContent<StaticMarkdownText>>;
                            other: Element<ElementContent>[];
                        }
                    }
                    onClick={onClick}
                    author={canvas?.publicKey.hashcode()}
                    onAllElementsLoaded={onAllElementsLoaded}
                />
            );
        case "post":
            return (
                <PostPreview
                    rects={
                        variantRects as {
                            text?: Element<StaticContent<StaticMarkdownText>>;
                            other: Element<ElementContent>[];
                        }
                    }
                    onClick={onClick}
                    className={className}
                    forwardRef={forwardRef}
                    onAllElementsLoaded={onAllElementsLoaded}
                    classNameContent={classNameContent}
                />
            );
        case "detail":
            return (
                <DetailedPreview
                    rects={
                        variantRects as {
                            text?: Element<StaticContent<StaticMarkdownText>>;
                            other: Element<ElementContent>[];
                        }
                    }
                    onClick={onClick}
                    className={className}
                    classNameContent={classNameContent}
                    forwardRef={forwardRef}
                    onAllElementsLoaded={onAllElementsLoaded}
                />
            );
        case "chat-message":
            return (
                <ChatMessagePreview
                    rects={
                        variantRects as {
                            text?: Element<ElementContent>;
                            other: Element<ElementContent>[];
                        }
                    }
                    onClick={onClick}
                    className={className}
                    forwardRef={forwardRef}
                    classNameContent={classNameContent}
                    onAllElementsLoaded={onAllElementsLoaded}
                />
            );
        default:
            return null;
    }
};
