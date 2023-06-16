import { field, variant } from "@dao-xyz/borsh";
import { Program } from "@dao-xyz/peerbit-program";
import {
    Documents,
    DocumentIndex,
    PutOperation,
    DeleteOperation,
} from "@dao-xyz/peerbit-document";
import { v4 as uuid } from "uuid";
import { Entry } from "@dao-xyz/peerbit-log";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { randomBytes } from "@dao-xyz/peerbit-crypto";

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
    @field({ type: "string" })
    name: string;

    @field({ type: Documents })
    messages: Documents<Post>;

    constructor(properties: { name: string; messages?: Documents<Post> }) {
        super();
        this.name = properties.name;
        this.messages = properties.messages || new Documents();
    }

    get id() {
        return this.name;
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
                                x.publicKey.equals(get.from)
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

@variant("lobby")
export class Lobby extends Program {
    @field({ type: Uint8Array })
    id: Uint8Array;
    @field({ type: Documents })
    rooms: Documents<Room>;

    constructor(properties: { id?: Uint8Array; rooms?: Documents<Room> }) {
        super();
        this.id = properties.id || randomBytes(32);
        this.rooms = properties.rooms || new Documents<Room>();
    }

    // Setup lifecycle, will be invoked on 'open'
    async setup(): Promise<void> {
        await this.rooms.setup({
            type: Room,

            canAppend: (entry) => {
                return Promise.resolve(true); // Anyone can create rooms
            },

            canRead: (identity) => {
                return Promise.resolve(true); // Anyone can search for rooms
            },
            canOpen: (program) => {
                return Promise.resolve(true);
            },
            index: {
                key: "name",
            },
        });
    }

    // Control whether someone can create a "room", which itself is a program with replication
    // Even if anyone could do "rooms.put(new Room())", that new entry has to be analyzed. And if it turns out that new entry represents a program
    // this means it should be handled in a special way (replication etc). This extra functionality needs requires peers to consider this additional security
    // boundary
    async canOpen(
        programToOpen: Program,
        fromEntry: Entry<any>
    ): Promise<boolean> {
        // Can someone create a room?
        if (programToOpen instanceof Room) {
            return true;
        }

        console.warn(
            "Recieved an unexpected type: " + programToOpen.constructor.name
        );
        return false;
    }
}
