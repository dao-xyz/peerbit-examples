import {
    StaticContent,
    StaticMarkdownText,
    ElementContent,
    StaticImage,
} from "@dao-xyz/social";

export const rectIsStaticMarkdownText = (rect: {
    content: ElementContent;
}): rect is { content: StaticContent<StaticMarkdownText> } => {
    return (
        rect.content instanceof StaticContent &&
        rect.content.content instanceof StaticMarkdownText
    );
};

export const rectIsStaticImage = (rect: {
    content: ElementContent;
}): rect is { content: StaticContent<StaticImage> } => {
    return (
        rect.content instanceof StaticContent &&
        rect.content.content instanceof StaticImage
    );
};
