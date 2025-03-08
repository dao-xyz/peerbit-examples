import { usePeer, useProgram } from "@peerbit/react";
import React, {
    useContext,
    useEffect,
    useRef,
    useState,
    useReducer,
} from "react";
import { AppPreview, SimpleWebManifest } from "@dao-xyz/app-service";
import {
    AbstractStaticContent,
    BrowsingHistory,
    StaticContent,
    StaticImage,
    StaticMarkdownText,
} from "@dao-xyz/social";
import {
    SearchRequest,
    StringMatch,
    Or,
    StringMatchMethod,
} from "@peerbit/document";
import { Constructor } from "@dao-xyz/borsh";
import { ImageUploadTrigger } from "./native/image/ImageUploadToCanvas";

interface IApps {
    apps: SimpleWebManifest[];
    history: BrowsingHistory;
    resolve: (url: string) => Promise<SimpleWebManifest | undefined>;
    search: (urlOrName: string) => Promise<SimpleWebManifest[]>;
    getNativeApp: (url: string) => CuratedNativeApp | undefined;
}

const STREAMING_APP = ["development", "staging"].includes(import.meta.env.MODE)
    ? "https://stream.test.xyz:5801"
    : "https://stream.dao.xyz";

const CHAT_APP = ["development", "staging"].includes(import.meta.env.MODE)
    ? "https://chat.test.xyz:5802"
    : "https://chat.dao.xyz";

const TEXT_APP = ["development", "staging"].includes(import.meta.env.MODE)
    ? "https://text.test.xyz:5803"
    : "https://text.dao.xyz";

export const getRoomPathFromURL = (pathname: string): string[] => {
    const path = pathname.split("/").map((x) => decodeURIComponent(x));
    path.splice(0, 2); // remove '' and 'path'
    return path;
};

interface CuratedWebApp {
    type: "web";
    match: string | string[];
    title?: string | ((manifest: SimpleWebManifest) => string);
    prefixReplace: string;
    suffixReplace: string;
}

interface CuratedNativeApp {
    type: "native";
    match: string | string[];
    title: string;
    trigger?: React.ComponentType<{
        className?: string;
        children?: React.ReactNode;
    }>;
    default: () => AbstractStaticContent;
    manifest: SimpleWebManifest;
}

type CuratedApp = CuratedNativeApp | CuratedWebApp;

export const NATIVE_TEXT_APP_URL = "native:text";
export const NATIVE_IMAGE_APP_URL = "native:image";
const nativeApps: CuratedNativeApp[] = [
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
        match: "Image",
        title: "Image",
        trigger: ImageUploadTrigger,
        default: () => new StaticImage({} as any), // TODO type safe
        manifest: new SimpleWebManifest({
            url: NATIVE_IMAGE_APP_URL,
            title: "Image",
            metaDescription: "Image",
            icon: "/apps/image.svg",
        }),
    },
];

const curatedApps: CuratedApp[] = [
    ...nativeApps,
    {
        type: "web",
        match: "https://kick.com",
        title: "Kick.com",
        prefixReplace: "https://player.kick.com",
        suffixReplace: "?autoplay=true",
    },
    {
        type: "web",
        match: "https://twitch.tv/",
        title: (manifest: SimpleWebManifest) =>
            "Twitch Channel " +
            manifest.url.substring("https://twitch.tv/".length),
        prefixReplace: "https://player.twitch.tv/?channel=",
        suffixReplace: "&parent=" + window.location.host,
    },
    {
        type: "web",
        match: [
            "https://www.youtube.com/watch?v=",
            "https://youtube.com/watch?v=",
        ],
        prefixReplace: "https://www.youtube.com/embed/",
        suffixReplace: "",
    },
];

const getCuratedManifest = (props: {
    curated: CuratedApp;
    url: string;
    fromManifest: SimpleWebManifest;
}): SimpleWebManifest => {
    if (typeof props.curated.title === "string") {
        return new SimpleWebManifest({
            ...props.fromManifest,
            title: props.curated.title,
            url: props.url,
        });
    }
    return new SimpleWebManifest({
        ...props.fromManifest,
        title: props.curated.title
            ? props.curated.title(props.fromManifest)
            : props.fromManifest.title,
        url: props.url,
    });
};

const getCurated = (rawInput: string, maybeUrl?: string) => {
    for (const app of curatedApps) {
        for (const match of Array.isArray(app.match)
            ? app.match
            : [app.match]) {
            if (match.startsWith(rawInput)) {
                return app;
            }

            if (maybeUrl?.startsWith(match)) {
                return app;
            }
        }
    }
};

const resolveCuratedUrl = (app: CuratedWebApp, url: string) => {
    for (const match of Array.isArray(app.match) ? app.match : [app.match]) {
        if (url.startsWith(match)) {
            let newUrl =
                app.prefixReplace +
                url.substring(app.match.length) +
                app.suffixReplace;
            return newUrl;
        }
    }
    throw new Error("Unexpected");
};

export const AppContext = React.createContext<IApps>({} as any);
export const useApps = () => useContext(AppContext);
export const AppProvider = ({ children }: { children: JSX.Element }) => {
    const [apps, setApps] = useState<SimpleWebManifest[]>(
        [...curatedApps]
            .filter((x) => x.type === "native")
            .map((x) => x.manifest)
    );
    const [_x, forceUpdate] = useReducer((x) => x + 1, 0);
    const { peer } = usePeer();
    const appServiceRef = useRef<AppPreview>();
    const { program: historyDB } = useProgram(
        peer
            ? new BrowsingHistory({ rootTrust: peer?.identity.publicKey })
            : undefined
    );

    useEffect(() => {
        if (!peer || (true as any)) {
            return;
        }

        const _x = AppPreview; // without this lines AppPreview import might not be included when bundling
        /*  peer.open<AppPreview>(
             "zb2rhXREnAbm5Twtm2ahJM7QKT6FoQGNksWv5jp7o5W6BQ7au"
         ).then((appPreview) => {
             appServiceRef.current = appPreview;
             Promise.allSettled(
                 [STREAMING_APP, CHAT_APP, TEXT_APP].map((address) =>
                     appPreview.resolve(address)
                 )
             ).then((result) => {
                 setApps(
                     result
                         .filter((x) => x.status === "fulfilled" && x.value)
                         .map(
                             (x) =>
                                 (x as PromiseFulfilledResult<SimpleWebManifest>)
                                     .value
                         )
                 );
                 forceUpdate();
             });
         }); */
    }, [peer?.identity.publicKey.hashcode()]);
    const memo = React.useMemo<IApps>(
        () => ({
            apps,
            history: historyDB,
            getNativeApp: (url) =>
                nativeApps.find((x) => x.manifest.url === url),
            search: async (urlOrName) => {
                let result: Map<string, SimpleWebManifest> = new Map();

                let providedUrl: string | undefined = undefined;
                try {
                    new URL(urlOrName);
                    providedUrl = urlOrName;
                } catch (error) {
                    try {
                        let withProtocol = "https://" + urlOrName;
                        new URL(withProtocol);
                        providedUrl = withProtocol;
                    } catch (error) {
                        urlOrName = undefined;
                    }
                }

                const resolvedManifestFromUrl =
                    await appServiceRef.current?.resolve(providedUrl);
                if (resolvedManifestFromUrl) {
                    result.set(urlOrName, resolvedManifestFromUrl);
                }

                // Curated apps are url transformations that are wanted
                // e.g. embedding twitch directly does not work, but there are embeddable urls that we actually want to use
                // though end users might just want to copy a raw twitch url and are expecting viewable results
                const curatedApp = getCurated(urlOrName, providedUrl);
                console.log("RESOLVED CURATED FROM", urlOrName, curatedApp);

                if (curatedApp) {
                    if (curatedApp.type === "web") {
                        let curatedUrl =
                            curatedApp &&
                            resolveCuratedUrl(curatedApp, providedUrl);
                        if (resolvedManifestFromUrl) {
                            result.set(
                                curatedUrl,
                                getCuratedManifest({
                                    curated: curatedApp,
                                    url: curatedUrl,
                                    fromManifest: resolvedManifestFromUrl,
                                })
                            );
                        }
                    } else {
                        console.log(
                            "SET RESULT",
                            curatedApp.title,
                            curatedApp.manifest
                        );
                        result.set(curatedApp.title, curatedApp.manifest);
                    }
                }

                // historical searches
                const fromHistory = historyDB
                    ? await historyDB.visits.index.search(
                          new SearchRequest({
                              query: [
                                  new Or([
                                      new StringMatch({
                                          key: ["app", "title"],
                                          value: urlOrName,
                                          caseInsensitive: false,
                                          method: StringMatchMethod.contains,
                                      }),
                                      new StringMatch({
                                          key: ["app", "url"],
                                          value: urlOrName,
                                          caseInsensitive: false,
                                          method: StringMatchMethod.prefix,
                                      }),
                                  ]),
                              ],
                          })
                      )
                    : [];
                if (fromHistory) {
                    for (const app of fromHistory) {
                        if (!result.has(app.app.url)) {
                            result.set(app.app.url, app.app);
                        }
                    }
                }

                return [...result.values()];
            },
            resolve: async (url) => {
                let app = apps.find((x) => x.url === url);
                if (app) {
                    return app;
                }
                app = await appServiceRef.current.resolve(url);
                if (app) {
                    setApps([...apps, app]);
                    return app;
                }
                return undefined;
            },
        }),
        [_x, appServiceRef.current?.address, historyDB?.address]
    );

    return <AppContext.Provider value={memo}>{children}</AppContext.Provider>;
};
