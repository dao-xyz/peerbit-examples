import { field, variant, fixedArray, vec } from "@dao-xyz/borsh";
import {
    DeleteOperation,
    Documents,
    PutOperation,
    Role,
} from "@peerbit/document";
import { PublicSignKey, randomBytes } from "@peerbit/crypto";
import { Ed25519Keypair } from "@peerbit/crypto";
import { Program } from "@peerbit/program";
import { SyncFilter } from "@peerbit/shared-log";

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

export abstract class RectContent {}

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
}

@variant(0)
export class Rect<T extends RectContent = any> {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: vec(Layout) })
    layout: Layout[];

    @field({ type: RectContent })
    content: T;

    // Don't serialize/store
    keypair: Ed25519Keypair;

    constructor(properties: {
        id?: Uint8Array;
        layout: Layout[];
        publicKey: PublicSignKey;
        content: T;
        keypair: Ed25519Keypair;
    }) {
        this.layout = properties.layout;
        this.publicKey = properties.publicKey;
        this.content = properties.content;
        this.id = properties.id || randomBytes(32);
        this.keypair = properties.keypair;
    }
}

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
export class Canvas extends Program {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: Documents<Rect> })
    rects: Documents<Rect>;

    @field({ type: PublicSignKey })
    key: PublicSignKey;

    @field({ type: TitleAndDescription })
    info: TitleAndDescription;

    constructor(properties: {
        rootTrust: PublicSignKey;
        info: TitleAndDescription;
    }) {
        super();
        this.id = randomBytes(32);
        this.key = properties.rootTrust;
        this.rects = new Documents();
        this.info = properties.info;
    }

    open(): Promise<void> {
        return this.rects.open({
            type: Rect,
            canAppend: async (entry) => {
                /**
                 * Only allow updates if we created it
                 *  or from myself (this allows us to modifyo someone elsecanvas locally)
                 */
                return (
                    entry.signatures.find(
                        (x) =>
                            x.publicKey.equals(this.key) ||
                            x.publicKey.equals(this.node.identity.publicKey)
                    ) != null
                );
            },
        });
    }
}
type Args = { role?: Role; sync?: SyncFilter };

@variant("spaces")
export class Spaces extends Program<Args> {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: Documents<Rect> })
    canvases: Documents<Canvas>;

    constructor() {
        super();
        this.id = randomBytes(32);
        this.canvases = new Documents();
    }

    open(args?: Args): Promise<void> {
        return this.canvases.open({
            type: Canvas,
            canAppend: async (entry) => {
                // Only allow modifications from author
                const payload = await entry.getPayloadValue();
                if (payload instanceof PutOperation) {
                    console.log("VALUE?", payload);
                    const from = (payload as PutOperation<Canvas>).getValue(
                        this.canvases.index.valueEncoding
                    ).key;
                    return (
                        entry.signatures.find((x) =>
                            x.publicKey.equals(from)
                        ) != null
                    );
                } else if (payload instanceof DeleteOperation) {
                    const canvas = await this.canvases.index.get(payload.key);
                    const from = canvas.key;
                    if (
                        entry.signatures.find((x) =>
                            x.publicKey.equals(from)
                        ) != null
                    ) {
                        return true;
                    }
                }
                return false;
            },
            canOpen: () => Promise.resolve(false), // don't open things that appear in the db
            role: args?.role,
            sync: args?.sync,
        });
    }
}
