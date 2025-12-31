import { Element, ElementContent } from "@giga-app/interface";
import { toBase64URL } from "@peerbit/crypto";
import {
    rectIsStaticImage,
    rectIsStaticMarkdownText,
    rectIsStaticPartialImage,
} from "./rect";

export function normalizeGigaImageRef(ref: string): string {
    return ref.trim().replace(/=+$/, "");
}

export function parseGigaImageRef(src: string): string | undefined {
    const m = /^giga:\/\/image\/([A-Za-z0-9_-]+)(?:=+)?$/i.exec(src.trim());
    if (!m?.[1]) return undefined;
    return normalizeGigaImageRef(m[1]);
}

export function extractGigaImageRefsFromMarkdown(markdown: string): string[] {
    const refs: string[] = [];
    const seen = new Set<string>();
    for (const m of markdown.matchAll(/giga:\/\/image\/([A-Za-z0-9_-]+)/gi)) {
        const ref = normalizeGigaImageRef(m[1] ?? "");
        if (!ref || seen.has(ref)) continue;
        seen.add(ref);
        refs.push(ref);
    }
    return refs;
}

export function collectInlineGigaImageRefs(
    rects: Element<ElementContent>[]
): Set<string> {
    const refs = new Set<string>();
    for (const r of rects) {
        if (!rectIsStaticMarkdownText(r)) continue;
        const text = r.content.content.text;
        if (!text) continue;
        for (const ref of extractGigaImageRefsFromMarkdown(text)) {
            refs.add(ref);
        }
    }
    return refs;
}

/**
 * Removes image elements that are referenced inline from markdown via:
 *   ![alt](giga://image/<ref>)
 *
 * Note: This does NOT remove them from the canvas; it's purely a rendering helper
 * to avoid showing the same image twice (once inline, once as a standalone element).
 */
export function filterOutInlineGigaImages(
    rects: Element<ElementContent>[]
): Element<ElementContent>[] {
    const refs = collectInlineGigaImageRefs(rects);
    if (refs.size === 0) return rects;

    return rects.filter((r) => {
        if (!(rectIsStaticImage(r) || rectIsStaticPartialImage(r))) return true;
        const ref = normalizeGigaImageRef(toBase64URL(r.content.contentId));
        return !refs.has(ref);
    });
}
