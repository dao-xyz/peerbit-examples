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

interface CanvasPreviewProps {
    variant: "tiny" | "post";
}

const rectIsStaticMarkdownText = (rect: Element<ElementContent>): boolean => {
    return (
        rect.content instanceof StaticContent &&
        rect.content.content instanceof StaticMarkdownText
    );
};

const rectIsStaticImage = (rect: Element<ElementContent>): boolean => {
    return (
        rect.content instanceof StaticContent &&
        rect.content.content instanceof StaticImage
    );
};

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
            <Frame
                thumbnail={false}
                active={false}
                setActive={(v) => {}}
                delete={() => {}}
                editMode={false}
                showCanvasControls={false}
                element={variantRects as RectsForVariant<"tiny">}
                replace={() => {}}
                onLoad={() => {}}
                onContentChange={() => {}}
                pending={false}
                coverParent={true}
                fit="cover"
            />
        );
    }
    if (variant === "post")
        return (
            <CanvasWrapper canvas={canvas}>
                <div className="w-full flex flex-col items-center relative overflow-hidden">
                    {/* Real image preview */}
                    <Canvas fitHeight />
                </div>
            </CanvasWrapper>
        );
};
