import {
    StaticContent,
    StaticMarkdownText,
    ElementContent,
    Element,
    StaticImage,
} from "@dao-xyz/social";

export const rectIsStaticMarkdownText = (
    rect: Element<ElementContent>
): boolean => {
    return (
        rect.content instanceof StaticContent &&
        rect.content.content instanceof StaticMarkdownText
    );
};

export const rectIsStaticImage = (rect: Element<ElementContent>): boolean => {
    return (
        rect.content instanceof StaticContent &&
        rect.content.content instanceof StaticImage
    );
};
