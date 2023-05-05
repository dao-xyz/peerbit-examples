import { field, variant, fixedArray, vec } from "@dao-xyz/borsh";
import {
    DeleteOperation,
    DocumentIndex,
    Documents,
    PutOperation,
} from "@dao-xyz/peerbit-document";
import { PublicSignKey, randomBytes } from "@dao-xyz/peerbit-crypto";
import { Ed25519Keypair } from "@dao-xyz/peerbit-crypto";
import { BORSH_ENCODING } from "@dao-xyz/peerbit-log";
import { Program } from "@dao-xyz/peerbit-program";

@variant(0)
export class Layout {
    @field({ type: "u32" })
    x: number;

    @field({ type: "u32" })
    y: number;

    @field({ type: "u32" })
    z: number;

    @field({ type: "u32" })
    w: number;

    @field({ type: "u32" })
    h: number;

    @field({ type: "string" })
    breakpoint: string;

    constructor(properties: {
        breakpoint: string;
        x: number;
        y: number;
        z: number;
        w: number;
        h: number;
    }) {
        this.breakpoint = properties.breakpoint;
        this.x = properties.x;
        this.y = properties.y;
        this.z = properties.z;
        this.w = properties.w;
        this.h = properties.h;
    }
}

export abstract class RectContent {
    abstract setup(): Promise<void>;
}

@variant(0)
export class IFrameContent extends RectContent {
    @field({ type: "string" })
    src: string; // https://a.cool.thing.com/abc123

    @field({ type: "bool" })
    resizer: boolean; // if IFrameResizer is installed on the target site

    constructor(properties: { src: string; resizer: boolean }) {
        super();
        this.src = properties.src;
        this.resizer = properties.resizer;
    }
    setup(): Promise<void> {
        return;
    }
}

@variant("rect")
export class Rect<T extends RectContent = any> extends Program {
    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: PublicSignKey })
    creator: PublicSignKey;

    @field({ type: vec(Layout) })
    layout: Layout[];

    @field({ type: RectContent })
    content: T;

    @field({ type: Documents<Rect> })
    children: Documents<Rect>;

    // Don't serialize/store
    keypair: Ed25519Keypair;

    constructor(properties: {
        id?: string;
        layout: Layout[];
        creator: PublicSignKey;
        content: T;
        keypair: Ed25519Keypair;
    }) {
        super(properties);
        this.layout = properties.layout;
        this.creator = properties.creator;
        this.content = properties.content;
        this.keypair = properties.keypair;
    }

    async setup(): Promise<void> {
        await this.content.setup();
        return this.children.setup({
            type: Rect,
            canAppend: async (entry) => {
                /**
                 * Only allow updates if we created it
                 *  or from myself (this allows us to modifyo someone elsecanvas locally)
                 */
                return (
                    entry.signatures.find(
                        (x) =>
                            x.publicKey.equals(this.creator) ||
                            x.publicKey.equals(this.identity.publicKey)
                    ) != null
                );
            },
        });
    }
}

/*
@variant(0)
export class TitleAndDescription {
    @field({ type: "string" })
    name: string;

    @field({ type: "string" })
    description: string;

    constructor(name: string, description: string) {
        this.name = name;
        this.description = description;
    }
}
 @variant("canvas")
export class Canvas {

    @field({ type: TitleAndDescription })
    info: TitleAndDescription;

    constructor(properties: {
        rootTrust: PublicSignKey;
        info: TitleAndDescription;
    }) {
        super();
        this.key = properties.rootTrust;
        this.rects = new Documents({
            index: new DocumentIndex({ indexBy: "id" }),
        });
        this.info = properties.info;
    }


} */
/* 
@variant("spaces")
export class Spaces extends Program {
    @field({ type: Documents<Rect> })
    canvases: Documents<Canvas>;

    constructor() {
        super({ id: "STATIC" });
        this.canvases = new Documents({
            index: new DocumentIndex({ indexBy: "id" }),
        });
    }

    setup(): Promise<void> {
        return this.canvases.setup({
            type: Canvas,
            canAppend: async (entry) => {
                // Only allow modifications from author
                const payload = await entry.getPayloadValue();
                if (payload instanceof PutOperation) {
                    console.log("VALUE?", payload);
                    const from = (payload as PutOperation<Canvas>).getValue(
                        BORSH_ENCODING(this.canvases.index.type)
                    ).key;
                    return (
                        entry.signatures.find((x) =>
                            x.publicKey.equals(from)
                        ) != null
                    );
                } else if (payload instanceof DeleteOperation) {
                    const canvas = await this.canvases.index.get(payload.key);
                    for (const result of canvas.results) {
                        const from = result.value.key;
                        if (
                            entry.signatures.find((x) =>
                                x.publicKey.equals(from)
                            ) != null
                        ) {
                            return true;
                        }
                    }
                }
                return false;
            },
            canOpen: () => Promise.resolve(false), // don't open things that appear in the db
        });
    }
}
 */