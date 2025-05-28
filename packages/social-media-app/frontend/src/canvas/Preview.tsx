import {
    Element,
    ElementContent,
    StaticContent,
    StaticMarkdownText,
} from "@giga-app/interface";
import { useMemo } from "react";
import { Frame } from "../content/Frame";
import {
    rectIsStaticImage,
    rectIsStaticMarkdownText,
    rectIsStaticPartialImage,
} from "./utils/rect";
import { tw } from "../utils/tailwind";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import { useCanvas } from "./CanvasWrapper";

type AlignedVariantType = "quote" | "chat-message";

type VariantType =
    | "tiny"
    | "post"
    | "breadcrumb"
    | "expanded-breadcrumb"
    | AlignedVariantType;

type BaseCanvasPreviewProps = {
    onClick?: (e: React.MouseEvent<HTMLElement>) => void;
    variant: VariantType;
    // forward ref
    forwardRef?: React.Ref<any>;
    className?: string;
    classNameContent?: string | ((element: Element<ElementContent>) => string);
    onLoad?: () => void;
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
        case "expanded-breadcrumb":
        case "quote":
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
}: {
    element: Element<ElementContent>;
    previewLines?: number;
    bgBlur?: boolean;
    maximizeHeight?: boolean;
    fit?: "cover" | "contain";
    noPadding?: boolean;
    onClick?: (e: React.MouseEvent<HTMLElement>) => void;
    className?: string | ((element: Element<ElementContent>) => string);
    onLoad?: () => void;
}) => (
    <div
        className={`flex flex-col relative w-full ${
            maximizeHeight ? "h-full" : ""
        }`}
    >
        <Frame
            thumbnail={false}
            active={false}
            setActive={() => {}}
            delete={() => {}}
            editMode={false}
            showEditControls={false}
            element={element}
            onLoad={onLoad}
            fit={fit}
            previewLines={previewLines}
            noPadding={noPadding}
            onClick={onClick}
            canOpenFullscreen={false}
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
                setActive={() => {}}
                delete={() => {}}
                editMode={false}
                showEditControls={false}
                element={element}
                onLoad={() => {}}
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
    onLoad,
}: {
    rect: Element<ElementContent>;
    onClick?: (e: React.MouseEvent<HTMLElement>) => void;
    onLoad?: () => void;
}) => (
    <PreviewFrame
        element={rect}
        fit="cover"
        maximizeHeight
        onClick={onClick}
        onLoad={onLoad}
    />
);

const BreadcrumbPreview = ({
    rect,
    onClick,
    onLoad,
}: {
    rect: Element<ElementContent>;
    onClick?: (e: React.MouseEvent<HTMLElement>) => void;
    onLoad?: () => void;
}) => {
    let isText = false;
    let textLength: number | undefined = undefined;
    if (rectIsStaticMarkdownText(rect)) {
        isText = true;
        textLength = toString(fromMarkdown(rect.content.content.text)).length;
    }
    return (
        <div
            className={tw(
                isText
                    ? textLength && textLength > 10
                        ? "w-[10ch]"
                        : "w-fit"
                    : "w-6",
                isText && "px-1",
                "flex-none h-full flex items-center justify-center rounded overflow-hidden border border-neutral-400 dark:border-neutral-600 "
            )}
        >
            <PreviewFrame
                element={rect}
                fit="cover"
                previewLines={1}
                noPadding={isText}
                maximizeHeight
                onClick={onClick}
                onLoad={onLoad}
                className={"w-full h-full flex items-center justify-center"}
            />
        </div>
    );
};

const ExpandedBreadcrumbPreview = ({
    rects,
    onClick,
    forwardedRef,
    onLoad,
}: {
    rects: { text?: Element<ElementContent>; other: Element<ElementContent>[] };
    onClick?: (e: React.MouseEvent<HTMLElement>) => void;
    forwardedRef?: React.Ref<HTMLDivElement>;
    onLoad?: () => void;
}) => {
    const { other: apps, text } = rects;

    const loadedSet: Set<string> = useMemo(() => new Set(), []);

    const handleLoad = (element: Element<ElementContent>) => {
        loadedSet.add(element.idString);
        if (onLoad && loadedSet.size === rects.other.length + (text ? 1 : 0)) {
            onLoad();
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
    onLoad,
}: {
    rects: {
        text?: Element<StaticContent<StaticMarkdownText>>;
        other: Element<ElementContent>[];
    };
    onClick?: (e: React.MouseEvent<HTMLElement>) => void;
    author?: string;
    forwardedRef?: React.Ref<HTMLDivElement>;
    onLoad?: () => void;
}) => {
    const { other: apps, text } = rects;
    const loadedSet: Set<string> = useMemo(() => new Set(), []);
    const handleLoad = (element: Element<ElementContent>) => {
        loadedSet.add(element.idString);
        if (onLoad && loadedSet.size === apps.length + (text ? 1 : 0)) {
            onLoad();
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
                    className={tw(
                        "shrink-0 w-[3.625rem] h-[3.625rem] rounded-sm overflow-hidden outline outline-neutral-700 dark:outline-neutral-300 relative",
                        i === 1 ? "-ml-10" : "z-1"
                    )}
                >
                    <div
                        className={tw(
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
    onLoad,
}: {
    rects: {
        text?: Element<StaticContent<StaticMarkdownText>>;
        other: Element<ElementContent>[];
    };
    onClick?: (e: React.MouseEvent<HTMLElement>) => void;
    forwardRef?: React.Ref<any>;
    className?: string;
    classNameContent?: string | ((element: Element<ElementContent>) => string);
    onLoad?: () => void;
}) => {
    const [firstApp, ...secondaryApps] = rects.other;
    const text = rects.text;

    const loadedSet: Set<string> = useMemo(() => new Set(), []);
    const handleLoad = (element: Element<ElementContent>) => {
        loadedSet.add(element.idString);
        if (onLoad && loadedSet.size === rects.other.length + (text ? 1 : 0)) {
            onLoad();
        }
    };

    return (
        <div
            ref={forwardRef}
            className={"flex flex-col h-full w-full " + className}
        >
            {firstApp && (
                <div
                    onClick={onClick}
                    className={
                        "min-h-20 btn  col-span-full max-h-[60vh] flex flex-col overflow-hidden h-full relative "
                    }
                >
                    <PreviewFrame
                        bgBlur
                        element={firstApp}
                        fit="contain"
                        maximizeHeight
                        onLoad={() => handleLoad(firstApp)}
                        className={classNameContent}
                    />
                </div>
            )}
            {secondaryApps.length > 0 && (
                <div
                    className={
                        "px-2 col-span-full flex overflow-x-scroll  no-scrollbar gap-2 pt-2 "
                    }
                >
                    {secondaryApps.map((app, i) => (
                        <button
                            onClick={onClick}
                            className="btn aspect-[1] w-12  rounded overflow-hidden"
                            key={app.idString}
                        >
                            <PreviewFrame
                                element={app}
                                fit="cover"
                                maximizeHeight
                                onLoad={() => handleLoad(app)}
                                className={classNameContent}
                            />
                        </button>
                    ))}
                </div>
            )}
            {text && (
                <div
                    onClick={onClick}
                    className={
                        "col-start-2 col-span-1 overflow-y-auto rounded-md py-1 "
                    }
                >
                    <PreviewFrame
                        element={text}
                        className={classNameContent}
                        onLoad={() => handleLoad(text)}
                    />
                </div>
            )}
        </div>
    );
};

const ChatMessagePreview = ({
    rects,
    onClick,
    forwardRef,
    className,
    classNameContent,
    onLoad,
}: {
    rects: { text?: Element<ElementContent>; other: Element<ElementContent>[] };
    onClick?: (e: React.MouseEvent<HTMLElement>) => void;
    forwardRef?: React.Ref<any>;
    className?: string;
    classNameContent?: string | ((element: Element<ElementContent>) => string);
    onLoad?: () => void;
}) => {
    const { other: apps, text } = rects;

    const loadedSet: Set<string> = useMemo(() => new Set(), []);
    const handleLoad = (element: Element<ElementContent>) => {
        loadedSet.add(element.idString);
        if (onLoad && loadedSet.size === apps.length + (text ? 1 : 0)) {
            onLoad();
        }
    };

    return (
        <div className={"flex flex-col h-full " + className} ref={forwardRef}>
            {apps.map((app) => (
                <div
                    key={app.idString}
                    onClick={onClick}
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
                    onClick={onClick} /* bg-neutral-50 dark:bg-neutral-950  */
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
    classNameContent,
    onLoad,
}: CanvasPreviewProps) => {
    const { rects, pendingRects, separateAndSortRects, canvas } = useCanvas();

    const variantRects = useMemo(() => {
        const out = getRectsForVariant(
            separateAndSortRects([...rects, ...pendingRects]),
            variant
        );
        return out;
    }, [rects, pendingRects, variant]);

    if (!variantRects) {
        return null;
    }

    switch (variant) {
        case "tiny":
            return (
                <TinyPreview
                    rect={variantRects as Element<ElementContent>}
                    onClick={onClick}
                    onLoad={onLoad}
                />
            );
        case "breadcrumb":
            return (
                <BreadcrumbPreview
                    rect={variantRects as Element<ElementContent>}
                    onClick={onClick}
                    onLoad={onLoad}
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
                    onLoad={onLoad}
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
                    onLoad={onLoad}
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
                    classNameContent={classNameContent}
                    forwardRef={forwardRef}
                    onLoad={onLoad}
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
                    onLoad={onLoad}
                />
            );
        default:
            return null;
    }
};
