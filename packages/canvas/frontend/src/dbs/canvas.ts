import { field, variant, fixedArray } from "@dao-xyz/borsh";
import {
    DeleteOperation,
    DocumentIndex,
    Documents,
    PutOperation,
} from "@dao-xyz/peerbit-document";
import { PublicSignKey, randomBytes } from "@dao-xyz/peerbit-crypto";
import { Program } from "@dao-xyz/peerbit-program";
import { Ed25519Keypair } from "@dao-xyz/peerbit-crypto";
import { BORSH_ENCODING } from "@dao-xyz/peerbit-log";

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
export class Canvas extends Program {
    @field({ type: Documents<Rect> })
    rects: Documents<Rect>;

    @field({ type: PublicSignKey })
    key: PublicSignKey;

    @field({ type: "string" })
    name: string;

    constructor(properties: { rootTrust: PublicSignKey; name: string }) {
        super({ id: properties.rootTrust.hashcode() + "/" + properties.name });
        this.key = properties.rootTrust;
        this.rects = new Documents({
            index: new DocumentIndex({ indexBy: "id" }),
        });
        this.name = properties.name;
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
