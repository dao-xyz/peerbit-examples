const DEFAULT_SHARE_BASE_URL = "https://files.dao.xyz";

const SHARE_PATH_PREFIX = "/s/";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export const parseShareReference = (reference?: string | null) => {
    if (!reference) {
        return undefined;
    }

    const trimmed = reference.trim();
    if (trimmed.length === 0) {
        return undefined;
    }

    try {
        const parsed = new URL(trimmed);
        const hashMatch = parsed.hash.match(/#\/?s\/([^/?#]+)/);
        if (hashMatch?.[1]) {
            return decodeURIComponent(hashMatch[1]);
        }

        const pathMatch = parsed.pathname.match(/\/s\/([^/?#]+)/);
        if (pathMatch?.[1]) {
            return decodeURIComponent(pathMatch[1]);
        }
    } catch {
        // Not a URL, fall back to path-like parsing below.
    }

    const prefixed = trimmed.match(/^\/?s\/([^/?#]+)/);
    if (prefixed?.[1]) {
        return decodeURIComponent(prefixed[1]);
    }

    return trimmed;
};

export const formatShareUrl = (
    address: string,
    baseUrl = DEFAULT_SHARE_BASE_URL
) => `${trimTrailingSlash(baseUrl)}#${SHARE_PATH_PREFIX}${address}`;

