import {
    StaticContent,
    StaticMarkdownText,
    ElementContent,
    StaticImage,
    StaticPartialImage,
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

export const rectIsStaticPartialImage = (rect: {
    content: ElementContent;
}): rect is { content: StaticContent<StaticPartialImage> } => {
    return (
        rect.content instanceof StaticContent &&
        rect.content.content instanceof StaticPartialImage
    );
};
