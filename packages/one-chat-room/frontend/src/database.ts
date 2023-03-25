import { field, variant } from "@dao-xyz/borsh";
import { Program } from "@dao-xyz/peerbit-program";
import {
    Documents,
    DocumentIndex,
    PutOperation,
    DeleteOperation,
} from "@dao-xyz/peerbit-document";
import { v4 as uuid } from "uuid";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";

@variant(0) // for versioning purposes, we can do @variant(1) when we create a new post type version
export class Post {
    @field({ type: "string" })
    id: string;

    @field({ type: PublicSignKey })
    from: PublicSignKey;

    @field({ type: "string" })
    message: string;

    constructor(properties: { message: string; from: PublicSignKey }) {
        this.id = uuid();
        this.from = properties.from;
        this.message = properties.message;
    }
}

@variant("room")
export class Room extends Program {
    @field({ type: PublicSignKey })
    creator: PublicSignKey;

    @field({ type: Documents })
    messages: Documents<Post>;

    constructor(properties: {
        creator: PublicSignKey;
        messages?: Documents<Post>;
    }) {
        super({ id: properties.creator.hashcode() });
        this.creator = properties.creator;
        this.messages =
            properties.messages ||
            new Documents({
                immutable: false,
                index: new DocumentIndex({ indexBy: "id" }),
            });
    }

    // Setup lifecycle, will be invoked on 'open'
    async setup(): Promise<void> {
        await this.messages.setup({
            type: Post,
            canAppend: async (entry) => {
                await entry.verifySignatures();
                try {
                    const payload = await entry.getPayloadValue();
                    if (payload instanceof PutOperation) {
                        const post = payload.getValue(
                            this.messages.index.valueEncoding
                        );
                        if (
                            !entry.signatures.find((x) =>
                                x.publicKey.equals(post.from)
                            )
                        ) {
                            return false;
                        }
                    } else if (payload instanceof DeleteOperation) {
                        const get = await this.messages.index.get(payload.key);
                        if (
                            !get ||
                            !entry.signatures.find((x) =>
                                x.publicKey.equals(get.results[0].value.from)
                            )
                        ) {
                            return false;
                        }
                    }
                } catch (error) {
                    console.error(error);
                    throw error;
                }
                return true; // no verification as of now
            },
            canRead: async (identity) => {
                return true; // Anyone can query
            },
        });
    }
}
