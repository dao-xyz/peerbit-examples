import { field, variant, option } from "@dao-xyz/borsh";

@variant(0)
export class RequestURL {
    @field({ type: "string" })
    url: string;

    constructor(properties: { url: string }) {
        this.url = properties.url;
    }
}

export const NATIVE_PREFIX = "native:";
const isNative = (url: string) => url.startsWith(NATIVE_PREFIX);
@variant(0)
export class SimpleWebManifest {
    @field({ type: option("string") })
    title?: string;

    @field({ type: option("string") })
    metaTitle?: string;

    @field({ type: option("string") })
    metaDescription?: string;

    @field({ type: option("string") })
    icon?: string;

    @field({ type: "string" })
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
        this.metaTitle = properties.metaTitle;
        this.metaDescription = properties.metaDescription;
    }

    get isNative() {
        return isNative(this.url);
    }
}
