import { usePeer, useProgram } from "@peerbit/react";
import React, { useContext, useRef, useState, useReducer } from "react";
import {
    AppPreview,
    CuratedAppCommon,
    CuratedAppNative,
    CuratedWebApp,
    getApps,
    SimpleWebManifest,
} from "@giga-app/app-service";
import { BrowsingHistory } from "@dao-xyz/social";
import { ImageUploadTrigger } from "./native/image/ImageUploadToCanvas";

interface IApps {
    apps: SimpleWebManifest[];
    history: BrowsingHistory;
    resolve: (url: string) => Promise<SimpleWebManifest | undefined>;
    search: (urlOrName: string) => Promise<SimpleWebManifest[]>;
    getCuratedNativeApp: (url: string) => CuratedAppNative | undefined;
    getCuratedWebApp: (url: string) => CuratedWebApp | undefined;
}

const allApps = getApps({
    host: window.location.host,
    mode: import.meta.env.MODE as any,
});
export const resolveTrigger = (
    app: SimpleWebManifest
):
    | React.ComponentType<{
          className?: string;
          children?: React.ReactNode;
      }>
    | undefined => {
    if (app.url === "native:image") {
        return ImageUploadTrigger;
    }
    return undefined;
};

export const AppContext = React.createContext<IApps>({} as any);
export const useApps = () => useContext(AppContext);
export const AppProvider = ({ children }: { children: JSX.Element }) => {
    const [apps, setApps] = useState<SimpleWebManifest[]>(
        [...allApps.curated]
            .filter((x) => x.type === "native")
            .map((x) => x.manifest)
    );
    const nativeApps = allApps.curated.filter(
        (x) => x.type === "native"
    ) as CuratedAppNative[];
    const allCuratedWebApps = allApps.curated.filter(
        (x) => x.type === "web"
    ) as CuratedWebApp[];

    const { peer } = usePeer();
    const [_x, forceUpdate] = useReducer((x) => x + 1, 0);
    const appServiceRef = useRef<AppPreview>();
    const { program: historyDB } = useProgram(
        peer
            ? new BrowsingHistory({ rootTrust: peer?.identity.publicKey })
            : undefined
    );

    const __x = AppPreview; // without this lines AppPreview import might not be included when bundling

    const memo = React.useMemo<IApps>(
        () => ({
            apps,
            history: historyDB,
            getCuratedNativeApp: (url) => {
                const result = nativeApps.find((x) => x.manifest.url === url);
                return result;
            },
            getCuratedWebApp: (url) => {
                const result = allCuratedWebApps.find(
                    (x) => x.manifest.url === url
                );
                return result;
            },
            search: allApps.search,
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
