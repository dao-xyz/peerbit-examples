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
    variant: "tiny" | "post";
}

const PreviewFrame = ({
    element,
    coverParent,
    previewLines,
    bgBlur,
}: {
    element: Element<ElementContent>;
    coverParent: boolean;
    previewLines?: number;
    bgBlur?: boolean;
}) => (
    <div className="relative overflow-hidden h-full">
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
            coverParent={coverParent}
            fit="contain"
            previewLines={previewLines}
        />
        <svg
            xmlns="https://www.w3.org/2000/svg"
            className="border-0 clip-0 h-[1px] -m-[1px] overflow-hidden p-0 absolute w-[1px]"
            version="1.1"
        >
            <filter id="gaussianBlurPreview">
                <feGaussianBlur stdDeviation="20" result="blur" />
            </filter>
        </svg>
        {bgBlur && (
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
                    coverParent={true}
                    fit="cover"
                />
            </div>
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

type RectsForVariant<V> = V extends "tiny"
    ? Element<ElementContent> | undefined
    : V extends "post"
    ? { text?: Element<ElementContent>; other: Element<ElementContent>[] }
    : never;

function getRectsForVariant<Variant extends "tiny" | "post">(
    separatedRects: SeparatedRects,
    variant: Variant
): RectsForVariant<Variant> {
    // get image, or if not present text, or if not present undefined
    switch (variant) {
        case "tiny":
            return (separatedRects.other[0] ??
                separatedRects.text[0] ??
                undefined) as RectsForVariant<Variant>;
        case "post":
            return {
                text: separatedRects.text[0],
                other: separatedRects.other,
            } as RectsForVariant<Variant>;
    }
    return undefined;
}

export const CanvasPreview = ({ variant }: CanvasPreviewProps) => {
    const { pendingRects, rects, canvas } = useCanvas();

    const variantRects = useMemo(
        () =>
            getRectsForVariant(
                seperateAndSortRects([...rects, ...pendingRects]),
                variant
            ),
        [rects, pendingRects, variant]
    );
    // variantRects needs to be defined.
    // TODO @marcus @ben - investigate why it isnt for some previews!
    if (!variantRects) return null;
    if (variant === "tiny") {
        return (
            <PreviewFrame
                element={variantRects as RectsForVariant<"tiny">}
                coverParent={true}
            />
        );
    }
    if (variant === "post") {
        const [firstApp, ...secondaryApps] = (
            variantRects as RectsForVariant<"post">
        ).other;
        const text = (variantRects as RectsForVariant<"post">).text;
        return (
            <div className="w-full flex flex-col gap-4">
                {firstApp && (
                    <div className="w-full max-h-[40vh] rounded-md overflow-hidden">
                        <PreviewFrame
                            bgBlur
                            element={firstApp}
                            coverParent={true}
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
                                    coverParent={true}
                                />
                            </div>
                        ))}
                    </div>
                )}

                {text && (
                    <PreviewFrame
                        element={text}
                        coverParent={false}
                        previewLines={3}
                    />
                )}
            </div>
        );
    }
};
