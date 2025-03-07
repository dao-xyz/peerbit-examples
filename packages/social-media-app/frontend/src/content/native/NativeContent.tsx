import {
    StaticContent,
    StaticMarkdownText,
    StaticImage,
} from "@dao-xyz/social";
import { MarkdownContent } from "./Markdown";
import { ImageContent } from "./Image";

export type EditableStaticContentProps = {
    staticContent: StaticContent["content"];
    onResize: (dims: { width: number; height: number }) => void;
    editable?: boolean;
    onChange?: (newContent: StaticContent["content"]) => void;
    thumbnail?: boolean;
    coverParent?: boolean;
};

export const EditableStaticContent = ({
    staticContent,
    onResize,
    editable = false,
    onChange,
    thumbnail,
    coverParent,
}: EditableStaticContentProps) => {
    if (staticContent instanceof StaticMarkdownText) {
        return (
            <MarkdownContent
                content={staticContent}
                onResize={onResize}
                editable={editable}
                onChange={onChange}
                thumbnail={thumbnail}
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
                coverParent={coverParent}
            />
        );
    }
    return <span>Unsupported static content</span>;
};
