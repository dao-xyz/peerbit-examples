import { usePeer } from "@peerbit/react";
import React, {
    useContext,
    useEffect,
    useRef,
    useState,
    useReducer,
} from "react";
import { Room } from "@dao-xyz/social";
import { useLocation } from "react-router-dom";
import axios from "axios";

export interface App {
    url: string;
    name: string;
    icon?: string;
}

interface IApps {
    apps: App[];
    resolve: (url: string) => Promise<App>;
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

const resolveAppFromUrl = async (address: string): Promise<App> => {
    let icon: string | undefined = undefined;
    const parser = new DOMParser();

    try {
        console.log(
            await (
                await fetch(address + "index.html", { redirect: "follow" })
            ).text()
        );
    } catch (error) {}
    const txt = (await axios.get(address + "/index.html")).data;
    const htmlDoc = parser.parseFromString(txt, "text/html");
    let name =
        htmlDoc.head.getElementsByTagName("title").item(0).innerText || "???";
    let links = htmlDoc.head.getElementsByTagName("link");
    for (let link of links) {
        if (link.getAttribute("rel") === "icon") {
            const hrefValue = link.getAttribute("href");
            icon =
                hrefValue.indexOf(address) !== -1
                    ? hrefValue
                    : address + hrefValue;
        }
    }
    return {
        icon,
        name,
        url: address,
    };
};

resolveAppFromUrl(TEXT_APP);

export const getRoomPathFromURL = (pathname: string): string[] => {
    const path = pathname.split("/").map((x) => decodeURIComponent(x));
    path.splice(0, 2); // remove '' and 'path'
    return path;
};

export const AppContext = React.createContext<IApps>({} as any);
export const useApps = () => useContext(AppContext);
export const AppProvider = ({ children }: { children: JSX.Element }) => {
    const [apps, setApps] = useState<App[]>([]);
    const [_x, forceUpdate] = useReducer((x) => x + 1, 0);

    useEffect(() => {
        Promise.allSettled(
            [STREAMING_APP, CHAT_APP, TEXT_APP].map((address) =>
                resolveAppFromUrl(address)
            )
        ).then((result) => {
            setApps(
                result
                    .filter((x) => x.status === "fulfilled")
                    .map((x) => (x as PromiseFulfilledResult<App>).value)
            );
            forceUpdate();
        });
    }, []);
    const memo = React.useMemo<IApps>(
        () => ({
            apps,
            resolve: async (url) => {
                let app = apps.find((x) => x.url === url);
                if (app) {
                    return app;
                }
                app = await resolveAppFromUrl(url);
                setApps([...apps, app]);
                return app;
            },
        }),
        [_x]
    );

    return <AppContext.Provider value={memo}>{children}</AppContext.Provider>;
};
