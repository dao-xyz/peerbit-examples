import { field, variant } from "@dao-xyz/borsh";
import { Program } from "@dao-xyz/peerbit-program";
import { Documents, DocumentIndex } from "@dao-xyz/peerbit-document";
import { v4 as uuid } from "uuid";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";

@variant(0) // for versioning purposes, we can do @variant(1) when we create a new post type version
export class Post {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    message: string;

    constructor(properties?: { message: string }) {
        if (properties) {
            this.id = uuid();
            this.message = properties.message;
        }
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
                return true; // no verification as of now
            },
            canRead: async (identity) => {
                return true; // Anyone can query
            },
        });
    }
}
