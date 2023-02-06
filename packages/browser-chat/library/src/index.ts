import { field, variant } from "@dao-xyz/borsh";
import { Program } from "@dao-xyz/peerbit-program";
import { Documents, DocumentIndex } from "@dao-xyz/peerbit-document";
import { v4 as uuid } from "uuid";
import { Entry } from "@dao-xyz/peerbit-log";

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
    @field({ type: "string" })
    name: string;

    @field({ type: Documents })
    messages: Documents<Post>;

    constructor(properties?: { name: string; messages?: Documents<Post> }) {
        super();
        if (properties) {
            this.name = properties.name;
            this.messages =
                properties.messages ||
                new Documents({
                    immutable: false,
                    index: new DocumentIndex({ indexBy: "id" }),
                });
        }
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

@variant("lobby")
export class Lobby extends Program {
    @field({ type: Documents })
    rooms: Documents<Room>;

    constructor(properties?: { rooms?: Documents<Room> }) {
        super();
        if (properties) {
            this.rooms =
                properties.rooms ||
                new Documents<Room>({
                    index: new DocumentIndex({ indexBy: "id" }),
                });
        }
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
