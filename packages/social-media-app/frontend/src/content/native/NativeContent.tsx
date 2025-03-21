import {
    StaticContent,
    StaticMarkdownText,
    StaticImage,
} from "@dao-xyz/social";
import { MarkdownContent } from "./Markdown";
import { ImageContent } from "./image/Image";
import { ChangeCallback } from "./types";

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
