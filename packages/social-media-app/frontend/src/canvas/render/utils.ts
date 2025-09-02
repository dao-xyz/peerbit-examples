import {
    Element,
    ElementContent,
    HIGHEST_QUALITY,
    LOWEST_QUALITY,
    MEDIUM_QUALITY,
    StaticContent,
} from "@giga-app/interface";

export const onlyLowestQuality = (rects: Element<any>[]): Element[] => {
    if (rects.length === 0) return rects;
    for (const q of [LOWEST_QUALITY, MEDIUM_QUALITY, HIGHEST_QUALITY]) {
        const out = rects.filter(
            (x) =>
                !(x.content instanceof StaticContent) || x.content.quality === q
        );
        if (
            out.length > 0 &&
            out.find((x) => x.content instanceof StaticContent)
        ) {
            return out;
        }
    }
    return rects;
};
