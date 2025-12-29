import { fromBase64URL, sha256Sync, toBase64URL } from "@peerbit/crypto";
import type { NewsApiArticle } from "./newsapi.js";

export type DownloadedImage = {
    bytes: Uint8Array;
    mimeType: string;
    width: number;
    height: number;
    url: string;
};

export const DEFAULT_MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB (matches frontend chunking threshold)
export const DEFAULT_IMAGE_TIMEOUT_MS = 12_000;

function normalizeMimeType(value: string | null | undefined): string | undefined {
    if (!value) return undefined;
    const mime = value.split(";")[0]?.trim().toLowerCase();
    if (!mime) return undefined;
    return mime;
}

function isHttpUrl(value: string): boolean {
    try {
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

function uniqStrings(values: (string | undefined)[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of values) {
        const s = typeof v === "string" ? v.trim() : "";
        if (!s) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}

function extractImageUrlsFromRaw(raw: any): string[] {
    if (!raw || typeof raw !== "object") return [];

    const direct = uniqStrings([
        raw.image,
        raw.imageUrl,
        raw.image_url,
        raw.urlToImage,
        raw.urlToImageLarge,
        raw.urlToImageSmall,
        raw.thumbnail,
        raw.thumbnailUrl,
        raw.thumbnail_url,
        raw.leadImageUrl,
        raw.mediaUrl,
        raw.picture,
        raw.pictureUrl,
    ]);

    const nested = uniqStrings([
        raw.image?.url,
        raw.image?.uri,
        raw.image?.link,
        raw.thumbnail?.url,
        raw.thumbnail?.uri,
    ]);

    const arrayish: string[] = [];
    const images = Array.isArray(raw.images) ? raw.images : undefined;
    if (images) {
        for (const i of images) {
            if (typeof i === "string") arrayish.push(i);
            else if (i && typeof i === "object") {
                if (typeof i.url === "string") arrayish.push(i.url);
                if (typeof i.uri === "string") arrayish.push(i.uri);
                if (typeof i.link === "string") arrayish.push(i.link);
            }
        }
    }

    return uniqStrings([...direct, ...nested, ...arrayish]).filter(isHttpUrl);
}

function parseMetaTags(html: string): Array<Record<string, string>> {
    const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
    return tags
        .map((tag) => {
            const attrs: Record<string, string> = {};
            for (const m of tag.matchAll(
                /([a-zA-Z_:\\-][a-zA-Z0-9_:\\-]*)\s*=\s*(["'])(.*?)\2/g
            )) {
                attrs[m[1].toLowerCase()] = m[3];
            }
            return attrs;
        })
        .filter((x) => Object.keys(x).length > 0);
}

export function extractOpenGraphImageUrl(
    html: string,
    baseUrl: string
): string | undefined {
    const tags = parseMetaTags(html);
    const keys = [
        "og:image",
        "og:image:url",
        "og:image:secure_url",
        "twitter:image",
        "twitter:image:src",
    ];
    for (const key of keys) {
        for (const attrs of tags) {
            const prop = attrs.property?.toLowerCase();
            const name = attrs.name?.toLowerCase();
            if (prop !== key && name !== key) continue;
            const content = attrs.content?.trim();
            if (!content) continue;
            try {
                const resolved = new URL(content, baseUrl).toString();
                if (isHttpUrl(resolved)) return resolved;
            } catch {}
        }
    }
    return undefined;
}

async function readResponseBytesWithLimit(
    res: Response,
    maxBytes: number
): Promise<Uint8Array> {
    const body = res.body;
    if (!body) return new Uint8Array(await res.arrayBuffer());
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
            throw new Error(
                `Response exceeded max size (${maxBytes} bytes).`
            );
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
    }
    return out;
}

async function fetchTextWithLimit(options: {
    url: string;
    timeoutMs: number;
    maxBytes: number;
}): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
        const res = await fetch(options.url, {
            signal: controller.signal,
            headers: {
                "user-agent":
                    "Mozilla/5.0 (compatible; PeerbitNewsBot/1.0; +https://github.com/dao-xyz/peerbit-examples)",
                accept: "text/html,application/xhtml+xml",
            },
        });
        if (!res.ok) {
            throw new Error(
                `Failed to fetch HTML (${res.status} ${res.statusText})`
            );
        }
        const bytes = await readResponseBytesWithLimit(res, options.maxBytes);
        return new TextDecoder().decode(bytes);
    } finally {
        clearTimeout(timeout);
    }
}

function sniffMimeTypeFromBytes(bytes: Uint8Array): string | undefined {
    // PNG
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    ) {
        return "image/png";
    }
    // JPEG
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        return "image/jpeg";
    }
    // GIF
    if (
        bytes.length >= 6 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61
    ) {
        return "image/gif";
    }
    // WebP (RIFF....WEBP)
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return "image/webp";
    }
    return undefined;
}

function readU32BE(bytes: Uint8Array, offset: number): number | undefined {
    if (offset + 4 > bytes.length) return undefined;
    return (
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]
    ) >>> 0;
}

function readU16BE(bytes: Uint8Array, offset: number): number | undefined {
    if (offset + 2 > bytes.length) return undefined;
    return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU16LE(bytes: Uint8Array, offset: number): number | undefined {
    if (offset + 2 > bytes.length) return undefined;
    return bytes[offset] | (bytes[offset + 1] << 8);
}

export function inferImageDimensions(
    bytes: Uint8Array,
    mimeType?: string
): { width: number; height: number } | undefined {
    const mime = (mimeType || sniffMimeTypeFromBytes(bytes))?.toLowerCase();

    if (mime === "image/png") {
        const w = readU32BE(bytes, 16);
        const h = readU32BE(bytes, 20);
        if (w && h) return { width: w, height: h };
        return undefined;
    }

    if (mime === "image/gif") {
        const w = readU16LE(bytes, 6);
        const h = readU16LE(bytes, 8);
        if (w && h) return { width: w, height: h };
        return undefined;
    }

    if (mime === "image/jpeg") {
        // Parse JPEG markers until we find SOF0/SOF2/etc.
        if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
            return undefined;
        }
        let offset = 2;
        while (offset + 1 < bytes.length) {
            // Find marker prefix 0xFF
            while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
            if (offset >= bytes.length) break;
            while (offset < bytes.length && bytes[offset] === 0xff) offset++;
            if (offset >= bytes.length) break;
            const marker = bytes[offset];
            offset++;

            // Standalone markers
            if (marker === 0xd8 || marker === 0xd9) continue; // SOI/EOI
            if (marker === 0xda) break; // SOS: image data begins

            const segLen = readU16BE(bytes, offset);
            if (!segLen || segLen < 2) return undefined;
            const segStart = offset + 2;

            const isSOF =
                (marker >= 0xc0 && marker <= 0xc3) ||
                (marker >= 0xc5 && marker <= 0xc7) ||
                (marker >= 0xc9 && marker <= 0xcb) ||
                (marker >= 0xcd && marker <= 0xcf);
            if (isSOF) {
                const h = readU16BE(bytes, segStart + 1);
                const w = readU16BE(bytes, segStart + 3);
                if (w && h) return { width: w, height: h };
                return undefined;
            }

            offset += segLen;
        }
        return undefined;
    }

    // WebP is common but parsing variants is non-trivial; the UI can still
    // infer intrinsic size after decode. Return undefined for now.
    return undefined;
}

async function downloadImage(options: {
    url: string;
    timeoutMs: number;
    maxBytes: number;
}): Promise<DownloadedImage> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
        const res = await fetch(options.url, {
            signal: controller.signal,
            headers: {
                "user-agent":
                    "Mozilla/5.0 (compatible; PeerbitNewsBot/1.0; +https://github.com/dao-xyz/peerbit-examples)",
                accept: "image/*,*/*;q=0.8",
            },
        });
        if (!res.ok) {
            throw new Error(
                `Failed to fetch image (${res.status} ${res.statusText})`
            );
        }

        const contentLengthHeader = res.headers.get("content-length");
        if (contentLengthHeader) {
            const n = Number(contentLengthHeader);
            if (Number.isFinite(n) && n > options.maxBytes) {
                throw new Error(
                    `Image too large (content-length ${n} > ${options.maxBytes})`
                );
            }
        }

        const bytes = await readResponseBytesWithLimit(res, options.maxBytes);
        const headerMime = normalizeMimeType(res.headers.get("content-type"));
        const mime = headerMime || sniffMimeTypeFromBytes(bytes);
        if (!mime || !mime.startsWith("image/")) {
            throw new Error(`Unsupported content-type: ${mime ?? "unknown"}`);
        }

        const dims = inferImageDimensions(bytes, mime);
        return {
            bytes,
            mimeType: mime,
            width: dims?.width ?? 0,
            height: dims?.height ?? 0,
            url: options.url,
        };
    } finally {
        clearTimeout(timeout);
    }
}

function decodeContentIdFromGigaUrl(url: string): Uint8Array | undefined {
    const m = /^giga:\/\/image\/([A-Za-z0-9_-]+)$/i.exec(url);
    if (!m) return undefined;
    try {
        return fromBase64URL(m[1]);
    } catch {
        return undefined;
    }
}

export function gigaImageUrlFromContentId(contentId: Uint8Array): string {
    return `giga://image/${toBase64URL(contentId)}`;
}

export async function findLeadImage(options: {
    articles: NewsApiArticle[];
    maxCandidates?: number;
    maxImageBytes?: number;
    timeoutMs?: number;
    preferEmbeddedUrl?: boolean;
    fetchOpenGraphFallback?: boolean;
}): Promise<DownloadedImage | undefined> {
    const maxCandidates = Math.max(1, options.maxCandidates ?? 5);
    const maxImageBytes = Math.max(
        64 * 1024,
        options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
    );
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS);
    const preferEmbeddedUrl = options.preferEmbeddedUrl ?? true;
    const fetchOpenGraphFallback = options.fetchOpenGraphFallback ?? true;

    const candidates = options.articles
        .filter((a) => a != null)
        .slice(0, Math.max(10, maxCandidates * 2));

    for (const article of candidates) {
        const byRaw = extractImageUrlsFromRaw(article.raw);
        const byOg = async (): Promise<string | undefined> => {
            const url = article.url?.trim();
            if (!url || !isHttpUrl(url)) return undefined;
            const html = await fetchTextWithLimit({
                url,
                timeoutMs,
                maxBytes: 512 * 1024,
            });
            return extractOpenGraphImageUrl(html, url);
        };

        const toTry = preferEmbeddedUrl ? byRaw : [];

        for (const imageUrl of toTry) {
            try {
                return await downloadImage({
                    url: imageUrl,
                    timeoutMs,
                    maxBytes: maxImageBytes,
                });
            } catch {
                // Try next candidate
            }
        }

        if (fetchOpenGraphFallback) {
            try {
                const ogUrl = await byOg();
                if (ogUrl && !toTry.includes(ogUrl)) {
                    return await downloadImage({
                        url: ogUrl,
                        timeoutMs,
                        maxBytes: maxImageBytes,
                    });
                }
            } catch {
                // Ignore OG failures; move to next article
            }
        }
    }
    return undefined;
}

export function collectEmbeddedGigaImageContentIds(
    markdown: string
): Uint8Array[] {
    const ids: Uint8Array[] = [];
    for (const m of markdown.matchAll(/giga:\/\/image\/([A-Za-z0-9_-]+)/gi)) {
        try {
            ids.push(fromBase64URL(m[1]));
        } catch {}
    }
    return ids;
}

export function isGigaImageUrl(url: string): boolean {
    return decodeContentIdFromGigaUrl(url) != null;
}

export function sha256ContentId(bytes: Uint8Array): Uint8Array {
    return sha256Sync(bytes);
}
