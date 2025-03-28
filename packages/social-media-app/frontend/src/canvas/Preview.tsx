import {
    StaticContent,
    StaticImage,
    StaticMarkdownText,
    Element,
    ElementContent,
    StaticPartialImage,
} from "@dao-xyz/social";
import { useMemo } from "react";
import { Frame } from "../content/Frame";
import {
    rectIsStaticMarkdownText,
    rectIsStaticPartialImage,
} from "./utils/rect";
import { tw } from "../utils/tailwind";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import { useCanvas } from "./CanvasWrapper";

type VariantType =
    | "tiny"
    | "post"
    | "breadcrumb"
    | "expanded-breadcrumb"
    | "chat-message";

type BaseCanvasPreviewProps = {
    onClick?: () => void;
    variant: VariantType;
};

type StandardVariantProps = BaseCanvasPreviewProps & {
    variant: Exclude<VariantType, "chat-message">;
    align?: never;
};

type ChatMessageVariantProps = BaseCanvasPreviewProps & {
    variant: "chat-message";
    align: "left" | "right";
};

export type CanvasPreviewProps = StandardVariantProps | ChatMessageVariantProps;

function getRectsForVariant<V extends VariantType>(
    separatedRects: {
        text: Element<ElementContent>[];
        other: Element<ElementContent>[];
    },
    variant: V
): V extends "tiny" | "breadcrumb"
    ? Element<ElementContent> | undefined
    : { text?: Element<ElementContent>; other: Element<ElementContent>[] } {
    switch (variant) {
        case "tiny":
        case "breadcrumb":
            return (separatedRects.other[0] ??
                separatedRects.text[0] ??
                undefined) as any;
        case "post":
        case "expanded-breadcrumb":
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
}: {
    element: Element<ElementContent>;
    previewLines?: number;
    bgBlur?: boolean;
    maximizeHeight?: boolean;
    fit?: "cover" | "contain";
    noPadding?: boolean;
    onClick?: () => void;
}) => (
    <div
        className={`flex flex-col relative overflow-hidden w-full ${
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
            onLoad={() => {}}
            fit={fit}
            previewLines={previewLines}
            noPadding={noPadding}
            onClick={onClick}
            canOpenFullscreen={false}
        />
        {bgBlur && (
            <BlurredBackground element={element} noPadding={noPadding} />
        )}
    </div>
);

const BlurredBackground = ({
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
        <div className="absolute opacity-10 -z-10 w-[150%] h-[150%] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 [filter:url('#gaussianBlurPreview')]">
            <Frame
                thumbnail={false}
                active={false}
                setActive={() => {}}
                delete={() => {}}
                editMode={false}
                showEditControls={false}
                element={element}
                onLoad={() => {}}
                fit="cover"
                noPadding={noPadding}
            />
        </div>
    </>
);

const TinyPreview = ({
    rect,
    onClick,
}: {
    rect: Element<ElementContent>;
    onClick?: () => void;
}) => (
    <PreviewFrame element={rect} fit="cover" maximizeHeight onClick={onClick} />
);

const BreadcrumbPreview = ({
    rect,
    onClick,
}: {
    rect: Element<ElementContent>;
    onClick?: () => void;
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
                "flex-none h-6 rounded-md overflow-hidden border border-neutral-950 dark:border-neutral-50"
            )}
        >
            <PreviewFrame
                element={rect}
                fit="cover"
                previewLines={1}
                noPadding={isText}
                maximizeHeight
                onClick={onClick}
            />
        </div>
    );
};

const ExpandedBreadcrumbPreview = ({
    rects,
    onClick,
}: {
    rects: { text?: Element<ElementContent>; other: Element<ElementContent>[] };
    onClick?: () => void;
}) => {
    const { other: apps, text } = rects;
    return (
        <div className="col-span-full flex gap-1.5 items-start w-full rounded-lg">
            {apps.slice(0, 2).map((app, i) => (
                <div
                    key={i}
                    className="shrink-0 w-[3.625rem] h-[3.625rem] rounded-sm overflow-hidden border border-neutral-950 dark:border-neutral-50 relative"
                >
                    <PreviewFrame
                        element={app}
                        fit="cover"
                        maximizeHeight
                        onClick={onClick}
                    />
                    {i === 1 && apps.slice(2).length > 0 && (
                        <div className="absolute inset-0 bg-neutral-50/80 dark:bg-neutral-950/80 flex items-center justify-center">
                            +{apps.slice(2).length}
                        </div>
                    )}
                </div>
            ))}
            {text && (
                <div className="border border-neutral-950 dark:border-neutral-50 bg-neutral-50 dark:bg-neutral-950 rounded-md px-1.5 py-1">
                    <PreviewFrame
                        element={text}
                        previewLines={2}
                        noPadding
                        onClick={onClick}
                    />
                </div>
            )}
        </div>
    );
};

const PostPreview = ({
    rects,
    onClick,
}: {
    rects: { text?: Element<ElementContent>; other: Element<ElementContent>[] };
    onClick?: () => void;
}) => {
    const [firstApp, ...secondaryApps] = rects.other;
    const { text } = rects;
    return (
        <>
            {firstApp && (
                <button
                    onClick={onClick}
                    className="col-span-full max-h-[40vh] flex flex-col overflow-hidden h-full rounded-md relative"
                >
                    <PreviewFrame
                        bgBlur
                        element={firstApp}
                        fit="contain"
                        maximizeHeight
                    />
                </button>
            )}
            {secondaryApps.length > 0 && (
                <div className="col-span-full flex overflow-x-scroll no-scrollbar px-2.5">
                    {secondaryApps.map((app, i) => (
                        <button
                            onClick={onClick}
                            className="aspect-[1] w-12 rounded-md overflow-hidden"
                            key={i}
                        >
                            <PreviewFrame
                                element={app}
                                fit="cover"
                                maximizeHeight
                            />
                        </button>
                    ))}
                </div>
            )}
            {text && (
                <button
                    onClick={onClick}
                    className="col-start-2 col-span-1 bg-neutral-50 dark:bg-neutral-950 rounded-md px-1.5 py-1"
                >
                    <PreviewFrame element={text} previewLines={3} noPadding />
                </button>
            )}
        </>
    );
};

const ChatMessagePreview = ({
    rects,
    onClick,
}: {
    rects: { text?: Element<ElementContent>; other: Element<ElementContent>[] };
    onClick?: () => void;
}) => {
    const { other: apps, text } = rects;
    return (
        <>
            {apps.map((app) => (
                <button
                    key={app.id.toString()}
                    onClick={onClick}
                    className="col-start-2 col-span-3 w-fit max-h-[40vh] flex flex-col overflow-hidden h-full rounded-md relative"
                >
                    <PreviewFrame
                        bgBlur
                        element={app}
                        fit="cover"
                        maximizeHeight
                    />
                </button>
            ))}
            {text && (
                <button
                    onClick={onClick}
                    className="max-w-prose col-span-3 col-start-2 border border-neutral-500 bg-neutral-50 dark:bg-neutral-950 rounded-md px-1.5 py-1"
                >
                    <PreviewFrame element={text} previewLines={3} noPadding />
                </button>
            )}
        </>
    );
};

export const CanvasPreview = ({ variant, onClick }: CanvasPreviewProps) => {
    const { rects, pendingRects, separateAndSortRects } = useCanvas();

    const variantRects = useMemo(
        () =>
            getRectsForVariant(
                separateAndSortRects([...rects, ...pendingRects]),
                variant
            ),
        [rects, pendingRects, variant, separateAndSortRects]
    );

    if (!variantRects) return null;

    switch (variant) {
        case "tiny":
            return (
                <TinyPreview
                    rect={variantRects as Element<ElementContent>}
                    onClick={onClick}
                />
            );
        case "breadcrumb":
            return (
                <BreadcrumbPreview
                    rect={variantRects as Element<ElementContent>}
                    onClick={onClick}
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
                />
            );
        case "post":
            return (
                <PostPreview
                    rects={
                        variantRects as {
                            text?: Element<ElementContent>;
                            other: Element<ElementContent>[];
                        }
                    }
                    onClick={onClick}
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
                />
            );
        default:
            return null;
    }
};
