import {
    StaticContent,
    StaticMarkdownText,
    ElementContent,
    StaticImage,
} from "@dao-xyz/social";

export const rectIsStaticMarkdownText = (rect: {
    content: ElementContent;
}): boolean => {
    return (
        rect.content instanceof StaticContent &&
        rect.content.content instanceof StaticMarkdownText
    );
};

export const rectIsStaticImage = (rect: {
    content: ElementContent;
}): boolean => {
    return (
        rect.content instanceof StaticContent &&
        rect.content.content instanceof StaticImage
    );
};
