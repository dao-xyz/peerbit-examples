import { field, variant } from "@dao-xyz/borsh";
import { Program } from "@peerbit/program";
import {
    Documents,
    DocumentIndex,
    PutOperation,
    DeleteOperation,
    Role,
} from "@peerbit/document";
import { v4 as uuid } from "uuid";
import { Entry } from "@peerbit/log";
import { PublicSignKey, sha256Sync } from "@peerbit/crypto";
import { randomBytes } from "@peerbit/crypto";
import { SyncFilter } from "@peerbit/shared-log";
import { concat } from "uint8arrays";

@variant(0) // for versioning purposes, we can do @variant(1) when we create a new post type version
export class Post {
    @field({ type: "string" })
    id: string;

    @field({ type: PublicSignKey })
    from: PublicSignKey;

    @field({ type: "string" })
    message: string;

    constructor(properties: { from: PublicSignKey; message: string }) {
        this.id = uuid();
        this.from = properties.from;
        this.message = properties.message;
    }
}
type Args = { role?: Role; sync?: SyncFilter };

@variant("room")
export class Room extends Program<Args> {
    @field({ type: "string" })
    name: string;

    @field({ type: Documents })
    messages: Documents<Post>;

    constructor(properties: { name: string; messages?: Documents<Post> }) {
        super();
        this.name = properties.name;
        this.messages =
            properties.messages ||
            new Documents({
                id: sha256Sync(
                    concat([
                        new TextEncoder().encode("room"),
                        new TextEncoder().encode(this.name),
                    ])
                ),
            });
    }

    get id() {
        return this.name;
    }

    // Setup lifecycle, will be invoked on 'open'
    async open(args?: Args): Promise<void> {
        await this.messages.open({
            type: Post,
            canPerform: async (operation, context) => {
                if (operation instanceof PutOperation) {
                    const post = operation.value;
                    if (
                        !context.entry.signatures.find((x) =>
                            x.publicKey.equals(post!.from)
                        )
                    ) {
                        return false;
                    }
                    return true;
                } else if (operation instanceof DeleteOperation) {
                    const get = await this.messages.index.get(operation.key);
                    if (
                        !get ||
                        !context.entry.signatures.find((x) =>
                            x.publicKey.equals(get.from)
                        )
                    ) {
                        return false;
                    }
                    return true;
                }
                return false;
            },
            index: {
                canRead: async (identity) => {
                    return true; // Anyone can query
                },
            },
            role: args?.role,
            sync: args?.sync,
        });
    }
}

@variant("lobby")
export class Lobby extends Program<Args> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: Documents })
    rooms: Documents<Room>;

    constructor(properties: { id?: Uint8Array }) {
        super();
        this.id = properties.id || randomBytes(32);
        this.rooms = new Documents<Room>({ id: this.id });
    }

    // Setup lifecycle, will be invoked on 'open'
    async open(args?: Args): Promise<void> {
        await this.rooms.open({
            type: Room,

            canPerform: (entry) => {
                return Promise.resolve(true); // Anyone can create rooms
            },

            index: {
                key: "name",

                canRead: (post, publicKey) => {
                    return Promise.resolve(true); // Anyone can search for rooms
                },
            },
            canOpen: (program) => {
                // Control whether someone can create a "room", which itself is a program with replication
                // Even if anyone could do "rooms.put(new Room())", that new entry has to be analyzed. And if it turns out that new entry represents a program
                // this means it should be handled in a special way (replication etc). This extra functionality needs requires peers to consider this additional security
                // boundary
                return Promise.resolve(true);
            },
            role: args?.role,
            sync: args?.sync,
        });
    }
}
