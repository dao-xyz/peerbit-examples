import { field, variant, option } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import { RPC } from "@peerbit/rpc";
import { parse } from "parse5";

@variant(0)
export class RequestURL {
    @field({ type: "string" })
    url: string;

    constructor(properties: { url: string }) {
        this.url = properties.url;
    }
}

@variant(0)
export class ResponseApp {
    @field({ type: option("string") })
    title?: string;

    @field({ type: option("string") })
    metaTitle?: string;

    @field({ type: option("string") })
    metaDescription?: string;

    @field({ type: option("string") })
    icon?: string;

    @field({ type: "u32" })
    url: string;

    constructor(properties: {
        title?: string;
        icon?: string;
        metaTitle?: string;
        metaDescription?: string;
        url: string;
    }) {
        this.title = properties.title;
        this.icon = properties.icon;
        this.url = properties.url;
    }
}

const resolveAppFromUrl = async (address: string): Promise<ResponseApp> => {
    const txt = await (await fetch(address + "/index.html")).text();
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

    return new ResponseApp({
        title,
        metaTitle,
        metaDescription,
        icon,
        url: address,
    });
};

type Args = { server: boolean };

@variant("app-preview")
export class AppPreview extends Program<Args> {
    @field({ type: RPC })
    rpc: RPC<RequestURL, ResponseApp>;

    constructor() {
        super();
        this.rpc = new RPC();
    }

    open(args?: Args): Promise<void> {
        return this.rpc.open({
            responseType: ResponseApp,
            queryType: RequestURL,
            topic: "request-app-preview",
            responseHandler: args?.server
                ? async (query, context) => {
                      return resolveAppFromUrl(query.url);
                  }
                : undefined,
        });
    }

    async resolve(url: string): Promise<ResponseApp | undefined> {
        const response = await this.rpc.request(new RequestURL({ url }), {
            amount: 1,
        });
        return response[0]?.response;
    }
}
