import {
    AbstractStaticContent,
    BrowsingHistory,
    StaticImage,
    StaticMarkdownText,
    SimpleWebManifest,
    NATIVE_TEXT_APP_URL,
    NATIVE_IMAGE_APP_URL,
} from "@giga-app/interface";
import {
    SearchRequest,
    StringMatch,
    Or,
    StringMatchMethod,
} from "@peerbit/document";
import { AppPreview } from "./remote.js";

export interface CuratedAppUrls {
    streaming?: string;
    chess?: string;
}

// External app URLs based on mode.
const STREAMING_APP = (mode?: string, appUrls?: CuratedAppUrls) =>
    appUrls?.streaming?.trim() ||
    (["development", "staging"].includes(mode ?? "")
        ? "https://stream.test:5801"
        : "https://stream.apps.peerbit.org");

const CHESS_APP = (mode?: string, appUrls?: CuratedAppUrls) =>
    appUrls?.chess?.trim() ||
    (["development", "staging"].includes(mode ?? "")
        ? "https://chess.test:5806"
        : "https://chess.apps.peerbit.org");

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
    /** Permissions Policy features granted to this app's iframe. */
    iframePermissions?: readonly CuratedWebAppPermission[];
    /**
     * Whether this first-party app is known to bundle the iframe-resizer child
     * protocol. Persisted IFrameContent metadata is only a request; the host
     * must also grant this capability from the curated registry.
     */
    iframeResizer?: boolean;
    /**
     * Match an iframe URL using this app's exact embed policy. Search matching
     * is deliberately fuzzy for usability; capability matching must not be.
     */
    isTrustedIframeUrl?: (url: string, host: string) => boolean;
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

export type CuratedWebAppPermission =
    | "autoplay"
    | "camera"
    | "clipboard-write"
    | "display-capture"
    | "encrypted-media"
    | "fullscreen"
    | "microphone"
    | "picture-in-picture";

const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const parseThirdPartyEmbedUrl = (
    value: string,
    expectedHostname: string
): URL | undefined => {
    try {
        const url = new URL(value);
        if (
            url.protocol !== "https:" ||
            url.hostname !== expectedHostname ||
            url.port !== "" ||
            url.username !== "" ||
            url.password !== ""
        ) {
            return undefined;
        }
        return url;
    } catch {
        return undefined;
    }
};

const hasExactSearchEntries = (
    url: URL,
    expected: readonly (readonly [string, string])[]
): boolean => {
    const actual = [...url.searchParams.entries()];
    return (
        actual.length === expected.length &&
        expected.every(
            ([expectedKey, expectedValue]) =>
                actual.filter(
                    ([key, value]) =>
                        key === expectedKey && value === expectedValue
                ).length === 1
        )
    );
};

const isTrustedTwitchIframeUrl = (value: string, host: string): boolean => {
    const url = parseThirdPartyEmbedUrl(value, "player.twitch.tv");
    if (!url || url.pathname !== "/" || url.hash !== "") {
        return false;
    }
    const channel = url.searchParams.get("channel");
    return (
        channel !== null &&
        USERNAME_PATTERN.test(channel) &&
        hasExactSearchEntries(url, [
            ["channel", channel],
            ["parent", host],
        ])
    );
};

const isTrustedKickIframeUrl = (value: string): boolean => {
    const url = parseThirdPartyEmbedUrl(value, "player.kick.com");
    if (!url || url.hash !== "") {
        return false;
    }
    const pathMatch = /^\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    return (
        pathMatch !== null &&
        USERNAME_PATTERN.test(pathMatch[1]) &&
        hasExactSearchEntries(url, [["autoplay", "true"]])
    );
};

const isTrustedFigJamIframeUrl = (value: string): boolean => {
    const url = parseThirdPartyEmbedUrl(value, "embed.figma.com");
    if (!url || url.hash !== "") {
        return false;
    }

    // FigJam's human-readable slug is cosmetic. Trusted embed URLs omit it so
    // encoded path separators and dot segments never enter the allowlist.
    const pathMatch = /^\/board\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (!pathMatch) {
        return false;
    }

    const nodeIds = url.searchParams.getAll("node-id");
    const expected: [string, string][] = [["embed-host", "share"]];
    if (
        nodeIds.length === 1 &&
        nodeIds[0].length > 0 &&
        nodeIds[0].length <= 256
    ) {
        expected.push(["node-id", nodeIds[0]]);
    } else if (nodeIds.length !== 0) {
        return false;
    }
    return hasExactSearchEntries(url, expected);
};

const isTrustedYouTubeIframeUrl = (value: string): boolean => {
    const url = parseThirdPartyEmbedUrl(value, "www.youtube.com");
    if (!url || url.search !== "" || url.hash !== "") {
        return false;
    }
    const pathMatch = /^\/embed\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    return pathMatch !== null && YOUTUBE_VIDEO_ID_PATTERN.test(pathMatch[1]);
};

const isExactConfiguredIframeUrl = (
    value: string,
    expectedValue: string
): boolean => {
    try {
        const valueUrl = new URL(value);
        const expectedUrl = new URL(expectedValue);
        return (
            valueUrl.protocol === "https:" &&
            valueUrl.username === "" &&
            valueUrl.password === "" &&
            expectedUrl.protocol === "https:" &&
            expectedUrl.username === "" &&
            expectedUrl.password === "" &&
            valueUrl.href === expectedUrl.href
        );
    } catch {
        return false;
    }
};

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
export const curatedWebApps: (
    mode?: string,
    appUrls?: CuratedAppUrls
) => CuratedWebApp[] = (mode?: string, appUrls?: CuratedAppUrls) => [
    // Twitch
    {
        type: "web",
        match: ["https://twitch.tv/", "https://www.twitch.tv/", "twitch"],
        iframePermissions: ["autoplay", "fullscreen", "picture-in-picture"],
        isTrustedIframeUrl: isTrustedTwitchIframeUrl,
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
                    url: `https://player.twitch.tv/?${new URLSearchParams({
                        channel,
                        parent: host,
                    })}`,
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
            if (isTrustedTwitchIframeUrl(url, host)) {
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
        iframePermissions: ["autoplay", "fullscreen", "picture-in-picture"],
        isTrustedIframeUrl: isTrustedKickIframeUrl,
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
                    username = query
                        .substring(prefix.length)
                        .trim()
                        .replace(/^\/+|\/+$/g, "");
                    break;
                }
            }
            return {
                url: `https://player.kick.com/${encodeURIComponent(
                    username
                )}?autoplay=true`,
            };
        },
        manifest: new SimpleWebManifest({
            url: "https://kick.com",
            title: "Kick",
            icon: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Kick_logo.svg/200px-Kick_logo.svg.png",
        }),
        getStatus(url) {
            if (isTrustedKickIframeUrl(url)) {
                return { isReady: true };
            }
            return {
                isReady: false,
                info: "Invalid Kick embed URL. Please provide a single valid username. Example: https://player.kick.com/yourUsername?autoplay=true",
            };
        },
    },
    // FigJam (Figma board)
    {
        type: "web",
        match: ["https://www.figma.com/board/", "figma", "figjam"],
        iframePermissions: ["clipboard-write", "fullscreen"],
        isTrustedIframeUrl: isTrustedFigJamIframeUrl,
        transformer: (query: string) => {
            try {
                const urlObj = new URL(query);
                const pathMatch =
                    /^\/board\/([A-Za-z0-9_-]{1,128})(?:\/[^/]*)?$/.exec(
                        urlObj.pathname
                    );
                if (
                    urlObj.protocol !== "https:" ||
                    urlObj.hostname !== "www.figma.com" ||
                    urlObj.port !== "" ||
                    urlObj.username !== "" ||
                    urlObj.password !== "" ||
                    !pathMatch
                ) {
                    return { url: query };
                }
                const boardId = pathMatch[1];
                const nodeId = urlObj.searchParams.get("node-id");
                const search = new URLSearchParams();
                if (nodeId) {
                    search.set("node-id", nodeId);
                }
                search.set("embed-host", "share");
                return {
                    url: `https://embed.figma.com/board/${boardId}?${search}`,
                };
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
        getStatus(url) {
            if (isTrustedFigJamIframeUrl(url)) {
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
    {
        type: "web",
        match: [
            "https://www.youtube.com/watch?v=",
            "https://youtube.com/watch?v=",
        ],
        iframePermissions: [
            "autoplay",
            "encrypted-media",
            "fullscreen",
            "picture-in-picture",
        ],
        isTrustedIframeUrl: isTrustedYouTubeIframeUrl,
        transformer: (query: string) => {
            try {
                const url = new URL(query);
                if (
                    url.protocol === "https:" &&
                    (url.hostname === "www.youtube.com" ||
                        url.hostname === "youtube.com") &&
                    url.port === "" &&
                    url.username === "" &&
                    url.password === "" &&
                    url.pathname === "/watch"
                ) {
                    const videoId = url.searchParams.get("v") ?? "";
                    return {
                        url: `https://www.youtube.com/embed/${encodeURIComponent(
                            videoId
                        )}`,
                    };
                }
            } catch {
                // Return the input so getStatus can surface the validation error.
            }
            return { url: query };
        },
        manifest: new SimpleWebManifest({
            url: "https://www.youtube.com",
            title: "YouTube",
            metaDescription: "YouTube videos",
            icon: "https://www.gstatic.com/youtube/img/branding/favicon/favicon_144x144_v2.png",
        }),
        getStatus(url) {
            if (isTrustedYouTubeIframeUrl(url)) {
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
        // Streaming deliberately retains the capture capabilities it uses.
        iframePermissions: [
            "autoplay",
            "camera",
            "clipboard-write",
            "display-capture",
            "fullscreen",
            "microphone",
        ],
        // The owned streaming frontend renders @giga-app/sdk's AppProvider,
        // which bundles @iframe-resizer/child.
        iframeResizer: true,
        isTrustedIframeUrl: (url) =>
            isExactConfiguredIframeUrl(url, STREAMING_APP(mode, appUrls)),
        manifest: new SimpleWebManifest({
            url: STREAMING_APP(mode, appUrls),
            title: "Video",
            icon: "/apps/video.svg",
        }),
        getStatus(url, host) {
            const expectedUrl = STREAMING_APP(mode, appUrls);
            if (isExactConfiguredIframeUrl(url, expectedUrl)) {
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
        iframePermissions: [],
        // The owned chess frontend renders @giga-app/sdk's AppProvider, which
        // bundles @iframe-resizer/child.
        iframeResizer: true,
        isTrustedIframeUrl: (url) =>
            isExactConfiguredIframeUrl(url, CHESS_APP(mode, appUrls)),
        manifest: new SimpleWebManifest({
            url: CHESS_APP(mode, appUrls),
            title: "Chess",
            icon: "/apps/chess.svg",
        }),
        getStatus(url, host) {
            const expectedUrl = CHESS_APP(mode, appUrls);
            if (isExactConfiguredIframeUrl(url, expectedUrl)) {
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
    mode?: string,
    appUrls?: CuratedAppUrls
): (CuratedAppNative | CuratedWebApp)[] => [
    ...nativeApps,
    ...curatedWebApps(mode, appUrls),
];

/**
 * Resolve a browser-controlled iframe URL against the exact policies of the
 * curated registry. This is intentionally separate from fuzzy search matching.
 */
export const resolveCuratedWebApp = (properties: {
    apps: readonly CuratedWebApp[];
    url: string;
    host: string;
}): CuratedWebApp | undefined =>
    properties.apps.find((app) =>
        app.isTrustedIframeUrl?.(properties.url, properties.host)
    );

// ─────────────────────────────────────────────────────────────
// Helper to find a matching curated app.
// Now, we allow partial matching in both directions (i.e. query is a prefix of the match or vice versa)
const getCurated = (properties: {
    rawInput: string;
    maybeUrl?: string;
    host: string;
    mode: string;
    appUrls?: CuratedAppUrls;
}): CuratedAppNative | CuratedWebApp | undefined => {
    const lowerQuery = properties.rawInput.trim().toLowerCase();
    if (lowerQuery.length < 2) {
        // TODO do this better so we dont match https:// or www.
        return undefined;
    }
    return allCuratedApps(properties.mode, properties.appUrls).find((app) => {
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
    appUrls?: CuratedAppUrls;
}): {
    curated: CuratedAppCommon[];
    search: (appOrUrl: string) => Promise<SimpleWebManifest[]>;
    resolveCuratedWebApp: (url: string) => CuratedWebApp | undefined;
} => {
    const curated = allCuratedApps(properties.mode, properties.appUrls);
    const curatedWeb = curated.filter(
        (app): app is CuratedWebApp => app.type === "web"
    );
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
                appUrls: properties.appUrls,
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
    return {
        search,
        curated,
        resolveCuratedWebApp: (url) =>
            resolveCuratedWebApp({
                apps: curatedWeb,
                url,
                host: properties.host,
            }),
    };
};
