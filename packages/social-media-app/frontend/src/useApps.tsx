import { usePeer, useProgram } from "@peerbit/react";
import React, {
    useContext,
    useEffect,
    useRef,
    useState,
    useReducer,
} from "react";
import { AppPreview, SimpleWebManifest } from "@dao-xyz/app-service";
import { BrowsingHistory } from "@dao-xyz/social";
import {
    SearchRequest,
    StringMatch,
    Or,
    StringMatchMethod,
} from "@peerbit/document";

export type ManifestWithSource = { source: 'search' | 'history' | 'curated', manifest: SimpleWebManifest }

interface IApps {
    history: BrowsingHistory;
    /*  resolve: (url: string) => Promise<SimpleWebManifest | undefined>; */
    search: (urlOrName: string) => Promise<ManifestWithSource[]>;
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

interface CuratedApp {
    match: string | string[];
    title?: string | ((manifest: SimpleWebManifest) => string);
    prefixReplace: string;
    suffixReplace: string;
}

const curatedApps: CuratedApp[] = [
    {
        match: "https://kick.com",
        title: "Kick.com",
        prefixReplace: "https://player.kick.com",
        suffixReplace: "?autoplay=true",
    },
    {
        match: "https://twitch.tv/",
        title: (manifest: SimpleWebManifest) =>
            "Twitch Channel " +
            manifest.url.substring("https://twitch.tv/".length),
        prefixReplace: "https://player.twitch.tv/?channel=",
        suffixReplace: "&parent=" + window.location.host,
    },
    {
        match: [
            "https://www.youtube.com/watch?v=",
            "https://youtube.com/watch?v=",
        ],
        prefixReplace: "https://www.youtube.com/embed/",
        suffixReplace: "",
    },
];

const getCuratedManifest = (
    curated: CuratedApp,
    url: string,
    fromManifest: SimpleWebManifest
): SimpleWebManifest => {
    if (typeof curated.title === "string") {
        return new SimpleWebManifest({
            ...fromManifest,
            title: curated.title,
            url,
        });
    }
    return new SimpleWebManifest({
        ...fromManifest,
        title: curated.title ? curated.title(fromManifest) : fromManifest.title,
        url,
    });
};
const getCurated = (url: string) => {
    for (const app of curatedApps) {
        for (const match of Array.isArray(app.match)
            ? app.match
            : [app.match]) {
            if (url.startsWith(match)) {
                return app;
            }
        }
    }
};

const resolveCuratedUrl = (app: CuratedApp, url: string) => {
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
    const [_x, forceUpdate] = useReducer((x) => x + 1, 0);
    const { peer } = usePeer();
    const appServiceRef = useRef<AppPreview>();
    const { program: historyDB } = useProgram(
        peer
            ? new BrowsingHistory({ rootTrust: peer?.identity.publicKey })
            : undefined
    );

    useEffect(() => {
        if (!peer) {
            return;
        }

        const _x = AppPreview; // without this lines AppPreview import might not be included when bundling

        peer.dial("/dns4/87ecf9778ccaa08bd9f1e8c6104d82c469b35511.peerchecker.com/tcp/4003/wss/p2p/12D3KooWLuLq8k8wskzXn72RY6rx9Yw2VNjP4T29EdMBcYq6Xwgb").then(() => {
            peer.open<AppPreview>(
                "zb2rhXREnAbm5Twtm2ahJM7QKT6FoQGNksWv5jp7o5W6BQ7au"
            ).then((appPreview) => {
                appServiceRef.current = appPreview;
                Promise.allSettled(
                    [STREAMING_APP, CHAT_APP, TEXT_APP].map((address) =>
                        appPreview.resolve(address)
                    )
                ).then((result) => {
                    /* setApps(
                        result
                            .filter((x) => x.status === "fulfilled" && x.value)
                            .map(
                                (x) =>
                                    (x as PromiseFulfilledResult<SimpleWebManifest>)
                                        .value
                            )
                    ); */
                    forceUpdate();
                });
            });

        })

    }, [peer?.identity.publicKey.hashcode()]);
    const memo = React.useMemo<IApps>(
        () => ({
            history: historyDB,
            search: async (urlOrName): Promise<ManifestWithSource[]> => {
                let result: Map<string, ManifestWithSource> = new Map();

                let maybeUrl: string | undefined = undefined;
                try {
                    new URL(urlOrName);
                    maybeUrl = urlOrName;
                } catch (error) {
                    try {
                        let withProtocol = "https://" + urlOrName;
                        new URL(withProtocol);
                        maybeUrl = withProtocol;
                    } catch (error) {
                        urlOrName = undefined;
                    }
                }

                const resolvedFromUrl = await appServiceRef.current?.resolve(
                    maybeUrl
                );
                if (resolvedFromUrl) {
                    result.set(urlOrName, { manifest: resolvedFromUrl, source: 'search' });
                }

                // Curated apps are url transformations that are wanted
                // e.g. embedding twitch directly does not work, but there are embeddable urls that we actually want to use
                // though end users might just want to copy a raw twitch url and are expecting viewable results
                const curatedApp = maybeUrl && getCurated(maybeUrl);
                let curatedUrl =
                    curatedApp && resolveCuratedUrl(curatedApp, maybeUrl);
                if (resolvedFromUrl && curatedApp) {
                    console.log(
                        "CURATED",
                        curatedUrl,
                        getCuratedManifest(
                            curatedApp,
                            curatedUrl,
                            resolvedFromUrl
                        )
                    );
                    result.set(
                        curatedUrl,
                        {
                            source: 'curated',
                            manifest: getCuratedManifest(
                                curatedApp,
                                curatedUrl,
                                resolvedFromUrl
                            )
                        }
                    );
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
                            result.set(app.app.url, { source: 'history', manifest: app.app });
                        }
                    }
                }
                return [...result.values()];
            },
            /*  resolve: async (url) => {
                 let app = apps.find((x) => x.url === url);
                 if (app) {
                     return app;
                 }
                 app = await appServiceRef.current?.resolve(url);
                 if (app) {
                     setApps([...apps, app]);
                     return app;
                 }
                 return undefined;
             }, */
        }),
        [_x, appServiceRef.current?.address, historyDB?.address]
    );

    return <AppContext.Provider value={memo}>{children}</AppContext.Provider>;
};
