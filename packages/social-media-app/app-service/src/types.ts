import { field, variant } from "@dao-xyz/borsh";

@variant(0)
export class RequestURL {
    @field({ type: "string" })
    url: string;

    constructor(properties: { url: string }) {
        this.url = properties.url;
    }
}
