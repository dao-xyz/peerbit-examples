import { field, variant } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import { RPC } from "@peerbit/rpc";
import { parse } from "parse5";
import { RequestURL } from "./types.js";
import { SimpleWebManifest } from "@giga-app/interface";

export const resolveAppFromUrl = async (
    address: string
): Promise<SimpleWebManifest> => {
    const timeout = 3000;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const txt = await (
        await fetch(address + "/index.html", {
            signal: controller.signal,
        })
    ).text();
    clearTimeout(id);
    const htmlDoc = parse(txt);
    const head = (
        htmlDoc.childNodes.find((x) => x.nodeName === "html") as any
    )?.childNodes.find((x) => x.nodeName === "head");
    const title = head.childNodes.find((x) => x.nodeName === "title")
        .childNodes[0].value;
    const metaTitle = head.childNodes
        .filter(
            (x) =>
                x.nodeName === "meta" &&
                x.attrs.find(
                    (y) => y.name === "property" && y.value === "og:title"
                )
        )[0]
        ?.attrs.find((x) => x.name === "content").value;
    const metaDescription = head.childNodes
        .filter(
            (x) =>
                x.nodeName === "meta" &&
                x.attrs.find(
                    (y) => y.name === "property" && y.value === "og:description"
                )
        )[0]
        ?.attrs.find((x) => x.name === "content").value;
    const icon = head.childNodes
        .filter(
            (x) =>
                x.nodeName === "link" &&
                x.attrs.find((y) => y.name === "rel" && y.value === "icon")
        )[0]
        ?.attrs.find((x) => x.name === "href").value;

    return new SimpleWebManifest({
        title,
        metaTitle,
        metaDescription,
        icon,
        url: address,
    });
};

const isNode = typeof window === "undefined";

type Args = {
    server?: boolean;
};

@variant("app-preview")
export class AppPreview extends Program<Args> {
    @field({ type: RPC })
    rpc: RPC<RequestURL, SimpleWebManifest>;

    constructor() {
        super();
        this.rpc = new RPC();
    }

    open(args?: Args): Promise<void> {
        return this.rpc.open({
            responseType: SimpleWebManifest,
            queryType: RequestURL,
            topic: "request-app-preview",
            responseHandler:
                args?.server ?? isNode
                    ? async (query, _context) => {
                          return resolveAppFromUrl(query.url);
                      }
                    : undefined,
        });
    }

    async resolve(
        url: string,
        timeout = 1000
    ): Promise<SimpleWebManifest | undefined> {
        try {
            new URL(url);
        } catch (error) {
            return undefined;
        }
        const response = await this.rpc.request(new RequestURL({ url }), {
            amount: 1,
            timeout,
        });
        return response[0]?.response;
    }
}
