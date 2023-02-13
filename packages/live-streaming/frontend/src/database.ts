import { Program } from "@dao-xyz/peerbit-program";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { Documents, DocumentIndex } from "@dao-xyz/peerbit-document";
import { variant, field } from "@dao-xyz/borsh";
import { v4 as uuid } from "uuid";

@variant(0)
export class Chunk {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    type: string; // video format

    @field({ type: "u64" })
    ts: bigint;

    @field({ type: Uint8Array })
    header: Uint8Array;

    @field({ type: Uint8Array })
    chunk: Uint8Array;

    constructor(
        type: string,
        header: Uint8Array,
        chunk: Uint8Array,
        ts?: bigint
    ) {
        this.id = uuid();
        this.type = type;
        this.header = header;
        this.chunk = chunk;
        this.ts = ts || BigInt(+new Date());
    }
}

@variant("video_stream")
export class VideoStream extends Program {
    @field({ type: PublicSignKey })
    sender: PublicSignKey;

    @field({ type: Documents })
    chunks: Documents<Chunk>;

    constructor(sender: PublicSignKey) {
        // force the id of the program to be the same for all stream
        // so that we can repopen the same stream without knowing the db address
        super({ id: sender.hashcode() });
        this.sender = sender;
        this.chunks = new Documents({
            index: new DocumentIndex({ indexBy: "id" }),
        });
    }

    async setup(): Promise<void> {
        await this.chunks.setup({
            type: Chunk,
            canAppend: async (entry) => {
                const keys = await entry.getPublicKeys();
                // Only append if chunks are signed by sender/streamer
                for (const key of keys) {
                    if (key.equals(this.sender)) {
                        return true;
                    }
                }
                return false;
            },
        });
    }
}
