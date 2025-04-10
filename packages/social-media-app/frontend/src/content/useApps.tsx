import React, {
    useContext,
    useRef,
    useState,
    useReducer,
    useMemo,
} from "react";
import { usePeer, useProgram } from "@peerbit/react";
import {
    AppPreview,
    CuratedAppNative,
    CuratedWebApp,
    getApps,
} from "@giga-app/app-service";
import { BrowsingHistory, SimpleWebManifest } from "@giga-app/interface";
import { ImageUploadTrigger } from "./native/image/ImageUploadToCanvas";

interface IApps {
    apps: SimpleWebManifest[];
    history: BrowsingHistory;
    resolve: (url: string) => Promise<SimpleWebManifest | undefined>;
    search: (query: string) => Promise<SimpleWebManifest[]>;
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
          onClick?: (insertDefault: boolean) => void;
      }>
    | undefined => {
    if (app.url === "native:image") {
        return ImageUploadTrigger;
    }
    return undefined;
};

export const AppContext = React.createContext<IApps>({} as IApps);
export const useApps = () => useContext(AppContext);

export const AppProvider = ({ children }: { children: JSX.Element }) => {
    // Initialize our apps state from curated native apps.
    const [apps, setApps] = useState<SimpleWebManifest[]>(() =>
        [...allApps.curated]
            .filter((x) => x.type === "native")
            .map((x) => x.manifest)
    );

    // Derive native and web apps from curated list.
    const nativeApps = useMemo(
        () =>
            allApps.curated.filter(
                (x) => x.type === "native"
            ) as CuratedAppNative[],
        []
    );
    const allCuratedWebApps = useMemo(
        () =>
            allApps.curated.filter((x) => x.type === "web") as CuratedWebApp[],
        []
    );

    const { peer } = usePeer();
    const [, forceUpdate] = useReducer((x) => x + 1, 0);
    // Ensure AppPreview is included in the bundle by assigning it to our ref.
    const appServiceRef = useRef<AppPreview | undefined>(undefined);
    const { program: historyDB } = useProgram(
        peer
            ? new BrowsingHistory({ rootTrust: peer.identity.publicKey })
            : undefined
    );

    const memo = useMemo<IApps>(
        () => ({
            apps,
            history: historyDB,
            getCuratedNativeApp: (url: string) =>
                nativeApps.find((x) => x.manifest.url === url),
            getCuratedWebApp: (url: string) =>
                allCuratedWebApps.find((x) => x.manifest.url === url),
            search: allApps.search,
            resolve: async (url: string) => {
                // Check our current list first.
                let found = apps.find((x) => x.url === url);
                if (found) {
                    return found;
                }
                // Otherwise, attempt to resolve using the AppPreview service.
                if (appServiceRef.current?.resolve) {
                    found = await appServiceRef.current.resolve(url);
                    if (found) {
                        setApps((prev) => [...prev, found]);
                        return found;
                    }
                }
                return undefined;
            },
        }),
        [apps, historyDB, nativeApps, allCuratedWebApps]
    );

    return <AppContext.Provider value={memo}>{children}</AppContext.Provider>;
};
