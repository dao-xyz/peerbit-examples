import { field, variant, fixedArray } from "@dao-xyz/borsh";
import {
    DeleteOperation,
    DocumentIndex,
    Documents,
    PutOperation,
} from "@dao-xyz/peerbit-document";
import { PublicSignKey, randomBytes } from "@dao-xyz/peerbit-crypto";
import { Program } from "@dao-xyz/peerbit-program";
import { toBase64, Ed25519Keypair } from "@dao-xyz/peerbit-crypto";

@variant(0)
export class Position {
    @field({ type: "u32" }) // TODO i64
    x: number;

    @field({ type: "u32" }) // TODO i64
    y: number;

    @field({ type: "u32" }) // TODO i64
    z: number;

    constructor(properties: { x: number; y: number; z: number }) {
        this.x = properties.x;
        this.y = properties.y;
        this.z = properties.z;
    }
}

@variant(0)
export class Size {
    @field({ type: "u32" })
    width: number;

    @field({ type: "u32" })
    height: number;

    constructor(properties: { width: number; height: number }) {
        this.width = properties.width;
        this.height = properties.height;
    }
}

@variant(0)
export class Rect {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: Position })
    position: Position;

    @field({ type: Size })
    size: Size;

    @field({ type: "string" })
    src: string; // https://a.cool.thing.com/abc123

    // Don't serialize/store
    keypair: Ed25519Keypair;

    constructor(properties: {
        position: Position;
        publicKey: PublicSignKey;
        size: Size;
        src: string;
        keypair: Ed25519Keypair;
    }) {
        this.position = properties.position;
        this.size = properties.size;
        this.publicKey = properties.publicKey;
        this.src = properties.src;
        this.id = randomBytes(32);
        this.keypair = properties.keypair;
    }
}

@variant("canvas")
export class MyCanvas extends Program {
    @field({ type: Documents<Rect> })
    rects: Documents<Rect>;

    @field({ type: PublicSignKey })
    key: PublicSignKey;

    constructor(properties: { rootTrust: PublicSignKey }) {
        super({ id: properties.rootTrust.hashcode() });
        this.key = properties.rootTrust;
        this.rects = new Documents({
            index: new DocumentIndex({ indexBy: "id" }),
        });
    }

    setup(): Promise<void> {
        return this.rects.setup({
            type: Rect,
            canAppend: async (entry) => {
                /**
                 * Only allow updates if we created it
                 */
                return (
                    entry.signatures.find((x) =>
                        x.publicKey.equals(this.key)
                    ) != null
                );
            },
        });
    }
}

@variant("canvases")
export class CanvasDB extends Program {
    @field({ type: Documents<Rect> })
    canvases: Documents<MyCanvas>;

    constructor() {
        super({ id: "STATIC" });
        this.canvases = new Documents({
            index: new DocumentIndex({ indexBy: "id" }),
        });
    }

    setup(): Promise<void> {
        return this.canvases.setup({ type: MyCanvas });
    }
}
