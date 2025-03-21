import {
    StaticContent,
    StaticMarkdownText,
    StaticImage,
} from "@dao-xyz/social";
import { MarkdownContent } from "./Markdown";
import { ImageContent } from "./image/Image";
import { ChangeCallback } from "./types";

/**
 * Props for the EditableStaticContent component.
 */
export type EditableStaticContentProps = {
    staticContent: StaticContent["content"];
    onResize: (dims: { width: number; height: number }) => void;
    editable?: boolean;
    onChange?: ChangeCallback;
    thumbnail?: boolean;
    fit?: "cover" | "contain";
    previewLines?: number;
    noPadding?: boolean;
    inFullscreen?: boolean;
};

/**
 * Component for rendering different types of static content with editing capabilities.
 *
 * @param props - Component props
 * @param props.staticContent - The static content to display
 * @param props.onResize - Callback when the content resizes, provides dimensions {width, height}
 * @param props.editable - Whether the content can be edited by the user (default: false)
 * @param props.onChange - Callback when content is changed during editing
 * @param props.thumbnail - Whether the content is displayed as a thumbnail
 * @param props.fit - How images should fit in their container (cover or contain)
 * @param props.previewLines - Number of lines to show in preview mode, content will be truncated
 * @param props.noPadding - Whether to remove padding from the container
 *
 * @returns Rendered content based on type
 */
export const EditableStaticContent = ({
    staticContent,
    onResize,
    editable = false,
    onChange,
    thumbnail,
    fit,
    previewLines,
    noPadding,
    inFullscreen,
}: EditableStaticContentProps) => {
    if (staticContent instanceof StaticMarkdownText) {
        return (
            <MarkdownContent
                content={staticContent}
                onResize={onResize}
                editable={editable}
                onChange={onChange}
                thumbnail={thumbnail}
                previewLines={previewLines}
                noPadding={noPadding}
                inFullscreen={inFullscreen}
            />
        );
    }
    if (staticContent instanceof StaticImage) {
        return (
            <ImageContent
                content={staticContent}
                onResize={onResize}
                editable={editable}
                onChange={onChange}
                thumbnail={thumbnail}
                fit={fit}
            />
        );
    }
    return <span>Unsupported static content</span>;
};
