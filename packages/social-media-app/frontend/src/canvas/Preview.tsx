import {
    Canvas as CanvasDB,
    StaticContent,
    StaticImage,
    StaticMarkdownText,
    ElementContent,
    Element,
} from "@dao-xyz/social";
import { Canvas } from "./Canvas";
import { CanvasWrapper, useCanvas } from "./CanvasWrapper";
import { useMemo } from "react";
import { Frame } from "../content/Frame";
import { rectIsStaticMarkdownText } from "./utils/rect";

interface CanvasPreviewProps {
    variant:
        | "tiny"
        | "post"
        | "breadcrumb"
        | "expanded-breadcrumb"
        | "chat-message";
    onClick?: () => void;
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
        className={`flex flex-col relative overflow-hidden w-full  ${
            maximizeHeight ? "h-full" : ""
        }`}
    >
        <Frame
            thumbnail={false}
            active={false}
            setActive={(v) => {}}
            delete={() => {}}
            editMode={false}
            showCanvasControls={false}
            element={element}
            replace={() => {}}
            onLoad={() => {}}
            onContentChange={() => {}}
            pending={false}
            fit={fit}
            previewLines={previewLines}
            noPadding={noPadding}
            onClick={onClick}
        />
        {bgBlur && (
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
                <div className="absolute opacity-10 -z-10 w-[150%] h-[150%] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2  [filter:url('#gaussianBlurPreview')]">
                    <Frame
                        thumbnail={false}
                        active={false}
                        setActive={() => {}}
                        delete={() => {}}
                        editMode={false}
                        showCanvasControls={false}
                        element={element}
                        replace={async () => {}}
                        onLoad={() => {}}
                        onContentChange={() => {}}
                        pending={false}
                        fit="cover"
                        noPadding={noPadding}
                    />
                </div>
            </>
        )}
    </div>
);

interface SeparatedRects {
    text: Element<ElementContent>[];
    other: Element<ElementContent>[];
}

/* Separates rects by preview relevant types: text and other. Also sorts by y layout location. */
const seperateAndSortRects = (rects: Element<ElementContent>[]) => {
    const seperatedRects: SeparatedRects = { text: [], other: [] };

    rects.forEach((rect) => {
        if (rectIsStaticMarkdownText(rect)) {
            seperatedRects.text.push(rect);
        } else {
            seperatedRects.other.push(rect);
        }
    });

    seperatedRects.text.sort((a, b) => a.location[0].y - b.location[0].y);
    seperatedRects.other.sort((a, b) => a.location[0].y - b.location[0].y);

    return seperatedRects;
};

type RectsForVariant<
    V extends
        | "tiny"
        | "post"
        | "breadcrumb"
        | "expanded-breadcrumb"
        | "chat-message"
> = V extends "tiny"
    ? Element<ElementContent> | undefined
    : V extends "breadcrumb"
    ? Element<ElementContent> | undefined
    : V extends "expanded-breadcrumb"
    ? { text?: Element<ElementContent>; other: Element<ElementContent>[] }
    : V extends "post"
    ? { text?: Element<ElementContent>; other: Element<ElementContent>[] }
    : V extends "chat-message"
    ? { text?: Element<ElementContent>; other: Element<ElementContent>[] }
    : never;

function getRectsForVariant<
    Variant extends
        | "tiny"
        | "post"
        | "breadcrumb"
        | "expanded-breadcrumb"
        | "chat-message"
>(separatedRects: SeparatedRects, variant: Variant): RectsForVariant<Variant> {
    switch (variant) {
        case "tiny":
        case "breadcrumb":
            return (separatedRects.other[0] ??
                separatedRects.text[0] ??
                undefined) as RectsForVariant<Variant>;
        case "post":
        case "expanded-breadcrumb":
        case "chat-message":
            return {
                text: separatedRects.text[0],
                other: separatedRects.other,
            } as RectsForVariant<Variant>;
    }
}

export const CanvasPreview = ({ variant, onClick }: CanvasPreviewProps) => {
    const { pendingRects, rects, canvas } = useCanvas();

    const variantRects = useMemo(
        () =>
            getRectsForVariant(
                seperateAndSortRects([...rects, ...pendingRects]),
                variant
            ),
        [rects, pendingRects, variant]
    );

    if (!variantRects) return null;
    if (variant === "tiny") {
        return (
            <PreviewFrame
                element={variantRects as RectsForVariant<"tiny">}
                fit="cover"
                maximizeHeight
                onClick={onClick}
            />
        );
    }
    if (variant === "breadcrumb") {
        return (
            <div
                className={`${
                    rectIsStaticMarkdownText(
                        variantRects as RectsForVariant<"breadcrumb">
                    )
                        ? "w-[10ch] max-w-20% px-1"
                        : "w-6"
                } flex-none h-6 rounded-md overflow-hidden border border-neutral-950 dark:border-neutral-50`}
            >
                <PreviewFrame
                    element={variantRects as RectsForVariant<"breadcrumb">}
                    fit="cover"
                    previewLines={1}
                    noPadding={rectIsStaticMarkdownText(
                        variantRects as RectsForVariant<"breadcrumb">
                    )}
                    maximizeHeight
                    onClick={onClick}
                />
            </div>
        );
    }
    if (variant === "expanded-breadcrumb") {
        const variantRectsTyped =
            variantRects as RectsForVariant<"expanded-breadcrumb">;
        const apps = variantRectsTyped.other || [];
        const text = variantRectsTyped.text;

        return (
            <div className="flex gap-1.5 items-start w-full rounded-lg">
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
    }
    if (variant === "post" || variant === "chat-message") {
        const [firstApp, ...secondaryApps] = (
            variantRects as RectsForVariant<"post">
        ).other;
        const text = (variantRects as RectsForVariant<"post">).text;
        return (
            <div className="w-full flex flex-col gap-4 h-full">
                {firstApp && (
                    <div className="w-full max-h-[40vh] flex flex-col h-full rounded-md overflow-hidden">
                        <PreviewFrame
                            bgBlur
                            element={firstApp}
                            fit="contain"
                            maximizeHeight
                            onClick={onClick}
                        />
                    </div>
                )}
                {secondaryApps.length > 0 && (
                    <div className="flex overflow-x-scroll no-scrollbar px-2.5">
                        {secondaryApps.map((app, i) => (
                            <div
                                className="aspect-[1] w-12 rounded-md overflow-hidden"
                                key={i}
                            >
                                <PreviewFrame
                                    element={app}
                                    fit="cover"
                                    maximizeHeight
                                    onClick={onClick}
                                />
                            </div>
                        ))}
                    </div>
                )}

                {text && (
                    <PreviewFrame
                        onClick={onClick}
                        element={text}
                        previewLines={3}
                    />
                )}
            </div>
        );
    }
};
