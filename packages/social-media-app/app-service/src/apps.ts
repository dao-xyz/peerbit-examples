import {
    AbstractStaticContent,
    BrowsingHistory,
    StaticImage,
    StaticMarkdownText,
} from "@dao-xyz/social";
import {
    SearchRequest,
    StringMatch,
    Or,
    StringMatchMethod,
} from "@peerbit/document";
import { SimpleWebManifest } from "./types";
import { AppPreview } from "./remote";

// ─────────────────────────────────────────────────────────────
// Native app URL constants.
export const NATIVE_TEXT_APP_URL = "native:text";
export const NATIVE_IMAGE_APP_URL = "native:image";

// External app URLs based on mode.
const STREAMING_APP = (mode?: string) =>
    ["development", "staging"].includes(mode ?? "")
        ? "https://stream.test.xyz:5801"
        : "https://stream.dao.xyz";

const CHESS_APP = (mode?: string) =>
    ["development", "staging"].includes(mode ?? "")
        ? "https://chess.test.xyz:5806"
        : "https://chess.dao.xyz";

// ─────────────────────────────────────────────────────────────
// Define a common interface for curated apps.
export interface CuratedAppCommon {
    type: "native" | "web";
    // One or more strings that indicate a match (case-insensitive)
    match: string | string[];

    // Optional static title or title transformer for display.
    title?:
        | string
        | ((manifest: SimpleWebManifest, transformedUrl: string) => string);
    // For native apps, a default content creator.
    default?: () => AbstractStaticContent;
    // A base manifest.
    manifest?: SimpleWebManifest;
}
// ─────────────────────────────────────────────────────────────
// Define a common interface for curated apps.
export interface CuratedAppNative extends CuratedAppCommon {
    type: "native";
}

// ─────────────────────────────────────────────────────────────
// Define a common interface for curated apps.
export interface CuratedWebApp extends CuratedAppCommon {
    type: "web";
    //  transformer function to turn the raw query (and host) into a URL (and optional title)
    transformer?: (
        query: string,
        host: string
    ) => { url: string; title?: string };
    getStatus: (
        url: string,
        host: string
    ) => { isReady: true } | { isReady: false; info: string };
}

// ─────────────────────────────────────────────────────────────
// Native apps – note the addition of isNative in the manifest.
export const nativeApps: CuratedAppNative[] = [
    {
        type: "native",
        match: "text",
        title: "Text",
        default: () => new StaticMarkdownText({ text: "" }),
        manifest: new SimpleWebManifest({
            url: NATIVE_TEXT_APP_URL,
            title: "Text",
            metaDescription: "Text",
            icon: "/apps/text.svg",
        }),
    },
    {
        type: "native",
        match: ["image", "img"],
        title: "Image",
        default: () => new StaticImage({} as any),
        manifest: new SimpleWebManifest({
            url: NATIVE_IMAGE_APP_URL,
            title: "Image",
            metaDescription: "Image",
            icon: "/apps/image.svg",
        }),
    },
];

// ─────────────────────────────────────────────────────────────
// Web (iframeable) apps – using transformer functions.
export const curatedWebApps: (mode?: string) => CuratedWebApp[] = (
    mode?: string
) => [
    // Twitch – already has a getStatus implementation.
    {
        type: "web",
        match: ["https://twitch.tv/", "https://www.twitch.tv/", "twitch"],
        transformer: (query: string, host: string) => {
            const lower = query.toLowerCase();
            let channel = "";
            const prefixes = [
                "https://twitch.tv/",
                "https://www.twitch.tv/",
                "twitch",
            ];
            for (const prefix of prefixes) {
                if (lower.startsWith(prefix)) {
                    channel = query.substring(prefix.length).trim();
                    break;
                }
            }
            if (!channel) {
                return { url: "https://twitch.tv" };
            } else {
                return {
                    url: `https://player.twitch.tv/?channel=${channel}&parent=${host}`,
                    title: `Twitch Channel ${channel}`,
                };
            }
        },
        manifest: new SimpleWebManifest({
            url: "https://twitch.tv",
            title: "Twitch",
            metaDescription:
                "Twitch is the world's leading video platform and community for gamers.",
            icon: "https://assets.twitch.tv/assets/favicon-32-e29e246c157142c94346.png",
        }),
        getStatus(url, host) {
            if (
                url.startsWith("https://player.twitch.tv/?channel=") &&
                url.endsWith(`&parent=${host}`)
            ) {
                return { isReady: true };
            } else {
                return {
                    isReady: false,
                    info: `Invalid URL. Please paste a link to a Twitch channel. Example: https://player.twitch.tv/?channel=yourChannel&parent=${host}`,
                };
            }
        },
    },
    // Kick
    {
        type: "web",
        match: ["https://kick.com", "https://www.kick.com", "kick"],
        transformer: (query: string) => {
            const lower = query.toLowerCase();
            let username = "";
            const prefixes = [
                "https://kick.com",
                "https://www.kick.com",
                "kick",
            ];
            for (const prefix of prefixes) {
                if (lower.startsWith(prefix)) {
                    username = query.substring(prefix.length).trim();
                    break;
                }
            }
            return { url: `https://player.kick.com/${username}?autoplay=true` };
        },
        manifest: new SimpleWebManifest({
            url: "https://kick.com",
            title: "Kick",
            icon: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Kick_logo.svg/200px-Kick_logo.svg.png",
        }),
        getStatus(url, host) {
            try {
                const urlObj = new URL(url);
                // Remove leading/trailing slashes from the pathname.
                const username = urlObj.pathname.replace(/^\/+|\/+$/g, "");
                if (!username) {
                    return {
                        isReady: false,
                        info: "No username provided. Please provide a valid Kick username. Example: https://player.kick.com/yourUsername?autoplay=true",
                    };
                }
                return { isReady: true };
            } catch (e) {
                return {
                    isReady: false,
                    info: "Invalid URL format for Kick. Example: https://player.kick.com/yourUsername?autoplay=true",
                };
            }
        },
    },
    // FigJam (Figma board)
    {
        type: "web",
        match: ["https://www.figma.com/board/"],
        transformer: (query: string) => {
            try {
                const urlObj = new URL(query);
                const pathname = urlObj.pathname; // e.g., /board/UVuAdACJVPBgW7XOqxiDWv/GigaJam
                const nodeId = urlObj.searchParams.get("node-id");
                const search = nodeId
                    ? `?node-id=${nodeId}&embed-host=share`
                    : "";
                return { url: `https://embed.figma.com${pathname}${search}` };
            } catch (e) {
                return { url: query };
            }
        },
        manifest: new SimpleWebManifest({
            url: "https://embed.figma.com/board/",
            title: "FigJam",
            metaDescription: "Figma FigJam Board",
            icon: "https://static.figma.com/app/icon/1/favicon.svg",
        }),
        getStatus(url, host) {
            const prefix = "https://embed.figma.com/board/";
            // If the URL is exactly the prefix, it's missing board details and is invalid.
            if (url.startsWith(prefix) && url.length > prefix.length) {
                return { isReady: true };
            } else {
                return {
                    isReady: false,
                    info: "Invalid FigJam board URL. Please ensure it's a valid FigJam link. Example: https://embed.figma.com/board/yourBoardID?node-id=yourNodeId&embed-host=share",
                };
            }
        },
    },
    // YouTube
    // YouTube
    {
        type: "web",
        match: [
            "https://www.youtube.com/watch?v=",
            "https://youtube.com/watch?v=",
        ],
        transformer: (query: string) => {
            const prefixes = [
                "https://www.youtube.com/watch?v=",
                "https://youtube.com/watch?v=",
            ];
            for (const prefix of prefixes) {
                if (query.startsWith(prefix)) {
                    return {
                        url: `https://www.youtube.com/embed/${query.substring(
                            prefix.length
                        )}`,
                    };
                }
            }
            return { url: query };
        },
        manifest: new SimpleWebManifest({
            url: "https://www.youtube.com",
            title: "YouTube",
            metaDescription: "YouTube videos",
            icon: "https://www.gstatic.com/youtube/img/branding/favicon/favicon_144x144_v2.png",
        }),
        getStatus(url, host) {
            // Handle YouTube watch URLs
            if (url.startsWith("https://www.youtube.com/watch?v=")) {
                const id = url.substring(
                    "https://www.youtube.com/watch?v=".length
                );
                if (id.trim().length === 0) {
                    return {
                        isReady: false,
                        info: "Invalid YouTube video URL. Missing video id. Example: https://www.youtube.com/watch?v=VIDEO_ID",
                    };
                }
                return { isReady: true };
            }
            if (url.startsWith("https://youtube.com/watch?v=")) {
                const id = url.substring("https://youtube.com/watch?v=".length);
                if (id.trim().length === 0) {
                    return {
                        isReady: false,
                        info: "Invalid YouTube video URL. Missing video id. Example: https://youtube.com/watch?v=VIDEO_ID",
                    };
                }
                return { isReady: true };
            }
            // Handle embed URLs
            if (url.startsWith("https://www.youtube.com/embed/")) {
                const id = url.substring(
                    "https://www.youtube.com/embed/".length
                );
                if (id.trim().length === 0) {
                    return {
                        isReady: false,
                        info: "Invalid YouTube video URL. Missing video id. Example: https://www.youtube.com/embed/VIDEO_ID",
                    };
                }
                return { isReady: true };
            }
            return {
                isReady: false,
                info: "Invalid YouTube video URL. Please provide a valid YouTube link. Example: https://www.youtube.com/embed/VIDEO_ID",
            };
        },
    },
    // Generic Video Stream
    {
        type: "web",
        match: ["video", "stream", "live-stream", "livestream"],
        manifest: new SimpleWebManifest({
            url: STREAMING_APP(mode),
            title: "Video",
            icon: "/apps/video.svg",
        }),
        getStatus(url, host) {
            const expectedUrl = STREAMING_APP(mode);
            if (url === expectedUrl) {
                return { isReady: true };
            } else {
                return {
                    isReady: false,
                    info: `Invalid video stream URL. Example: ${expectedUrl}`,
                };
            }
        },
    },
    // Chess
    {
        type: "web",
        match: ["chess"],
        manifest: new SimpleWebManifest({
            url: CHESS_APP(mode),
            title: "Chess",
            icon: "/apps/chess.svg",
        }),
        getStatus(url, host) {
            const expectedUrl = CHESS_APP(mode);
            if (url === expectedUrl) {
                return { isReady: true };
            } else {
                return {
                    isReady: false,
                    info: `Invalid chess app URL. Example: ${expectedUrl}`,
                };
            }
        },
    },
];
// ─────────────────────────────────────────────────────────────
// Merge native and web apps.
const allCuratedApps = (
    mode?: string
): (CuratedAppNative | CuratedWebApp)[] => [
    ...nativeApps,
    ...curatedWebApps(mode),
];

// ─────────────────────────────────────────────────────────────
// Helper to find a matching curated app.
// Now, we allow partial matching in both directions (i.e. query is a prefix of the match or vice versa)
const getCurated = (properties: {
    rawInput: string;
    maybeUrl?: string;
    host: string;
    mode: string;
}): CuratedAppNative | CuratedWebApp | undefined => {
    const lowerQuery = properties.rawInput.toLowerCase();
    return allCuratedApps(properties.mode).find((app) => {
        const matches = Array.isArray(app.match) ? app.match : [app.match];
        return matches.some((m) => {
            const lowerM = m.toLowerCase();
            return (
                lowerQuery.startsWith(lowerM) ||
                lowerM.startsWith(lowerQuery) ||
                (properties.maybeUrl &&
                    properties.maybeUrl.toLowerCase().startsWith(lowerM))
            );
        });
    });
};

// ─────────────────────────────────────────────────────────────
// Main getApps function.
export const getApps = (properties: {
    host: string;
    appService?: AppPreview;
    history?: BrowsingHistory;
    mode?: "development" | "staging" | "production";
}): {
    curated: CuratedAppCommon[];
    search: (appOrUrl: string) => Promise<SimpleWebManifest[]>;
} => {
    const curated = allCuratedApps(properties.mode);
    const search = async (urlOrName: string | undefined) => {
        const result: Map<string, SimpleWebManifest> = new Map();

        if (urlOrName) {
            let providedUrl: string | undefined;
            try {
                new URL(urlOrName);
                providedUrl = urlOrName;
            } catch (e) {
                try {
                    const withProtocol = "https://" + urlOrName;
                    new URL(withProtocol);
                    providedUrl = withProtocol;
                } catch (e) {}
            }
            const definedInput = urlOrName;
            const resolvedManifestFromUrl =
                providedUrl != null
                    ? await properties.appService?.resolve(providedUrl)
                    : undefined;
            if (resolvedManifestFromUrl) {
                result.set(definedInput, resolvedManifestFromUrl);
            }
            const curatedApp = getCurated({
                rawInput: definedInput,
                maybeUrl: providedUrl,
                host: properties.host,
                mode: properties.mode || "production",
            });
            if (curatedApp) {
                if (curatedApp.type === "web") {
                    const manifest =
                        curatedApp.manifest || resolvedManifestFromUrl;
                    if (manifest) {
                        let transformed: { url: string; title?: string } = {
                            url: definedInput,
                            title: manifest.title,
                        };
                        if (curatedApp.type === "web") {
                            if (curatedApp.transformer) {
                                transformed = curatedApp.transformer(
                                    definedInput,
                                    properties.host
                                );
                            } else {
                                transformed = {
                                    url: manifest.url,
                                    title: manifest.title,
                                };
                            }
                        }
                        const newManifest = new SimpleWebManifest({
                            ...manifest,
                            url: transformed.url,
                            title:
                                typeof curatedApp.title === "function"
                                    ? curatedApp.title(
                                          manifest,
                                          transformed.url
                                      )
                                    : transformed.title || manifest.title,
                        });
                        result.set(newManifest.url, newManifest);
                    }
                } else {
                    // Native app – use its manifest directly.
                    if (curatedApp.manifest) {
                        result.set(
                            curatedApp.manifest.url,
                            curatedApp.manifest
                        );
                    }
                }
            }
            if (properties.history) {
                const fromHistory =
                    await properties.history.visits.index.search(
                        new SearchRequest({
                            query: [
                                new Or([
                                    new StringMatch({
                                        key: ["app", "title"],
                                        value: definedInput,
                                        caseInsensitive: false,
                                        method: StringMatchMethod.contains,
                                    }),
                                    new StringMatch({
                                        key: ["app", "url"],
                                        value: definedInput,
                                        caseInsensitive: false,
                                        method: StringMatchMethod.prefix,
                                    }),
                                ]),
                            ],
                        })
                    );
                if (fromHistory) {
                    for (const app of fromHistory) {
                        if (!result.has(app.app.url)) {
                            result.set(app.app.url, app.app);
                        }
                    }
                }
            }
        } else {
            // Empty search – return all apps that have a manifest.
            curated.forEach((x) => {
                if (x.manifest) {
                    result.set(x.manifest.url, x.manifest);
                }
            });
        }
        return [...result.values()];
    };
    return { search, curated };
};
