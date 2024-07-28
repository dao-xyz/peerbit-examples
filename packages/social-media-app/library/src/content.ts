import { field, variant, fixedArray, vec, option } from "@dao-xyz/borsh";
import {
    Documents,
    SearchRequest,
    StringMatch,
    StringMatchMethod,
} from "@peerbit/document";
import { PublicSignKey, randomBytes } from "@peerbit/crypto";
import { Program } from "@peerbit/program";
import { sha256Sync } from "@peerbit/crypto";
import { concat } from "uint8arrays";
import { ReplicationOptions } from "@peerbit/shared-log";

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

export abstract class ElementContent {
    abstract toIndex(): Record<string, any>;
}

@variant(0)
export class Element<T extends ElementContent = any> {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: vec(Layout) })
    location: Layout[];

    @field({ type: ElementContent })
    content: T;

    constructor(properties: {
        id?: Uint8Array;
        location: Layout[];
        publicKey: PublicSignKey;
        content: T;
    }) {
        this.location = properties.location;
        this.publicKey = properties.publicKey;
        this.content = properties.content;
        this.id = properties.id || randomBytes(32);
    }
}

class IndexableElement {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: Uint8Array })
    publicKey: Uint8Array;

    @field({ type: "string" })
    content: string;

    constructor(properties: {
        id: Uint8Array;
        publicKey: Uint8Array;
        content: string;
    }) {
        this.id = properties.id;
        this.publicKey = properties.publicKey;
        this.content = properties.content;
    }
}

@variant("room")
export class Room extends Program {
    @field({ type: Documents })
    elements: Documents<Element, IndexableElement>;

    @field({ type: option(PublicSignKey) })
    key?: PublicSignKey;

    @field({ type: "string" })
    name: string;

    @field({ type: option(fixedArray("u8", 32)) })
    parentId?: Uint8Array;

    constructor(
        properties: ({ parentId: Uint8Array } | { seed: Uint8Array }) & {
            rootTrust: PublicSignKey;
            name?: string;
        }
    ) {
        super();
        this.key = properties.rootTrust;
        this.name = properties.name ?? "";
        this.parentId = properties["parentId"];
        const elementsId = sha256Sync(
            concat([
                new TextEncoder().encode("room"),
                new TextEncoder().encode(this.name),
                this.key?.bytes || [],
                properties["parentId"] || properties["seed"],
            ])
        );
        this.elements = new Documents({ id: elementsId });
    }

    get id(): Uint8Array {
        return this.elements.log.log.id;
    }

    async open(): Promise<void> {
        /*  await this.name.open({
             canPerform: async (operation, { entry }) => {
                 // Only allow updates from the creator
                 return (
                     entry.signatures.find(
                         (x) =>
                             x.publicKey.equals(this.key)
                     ) != null
                 );
             }
         })
     */
        return this.elements.open({
            type: Element,
            canPerform: async (operation) => {
                /**
                 * Only allow updates if we created it
                 *  or from myself (this allows us to modifying someone elsecanvas locally)
                 */
                return (
                    !this.key ||
                    operation.entry.signatures.find(
                        (x) =>
                            x.publicKey.equals(this.key!) ||
                            x.publicKey.equals(this.node.identity.publicKey)
                    ) != null
                );
            },
            index: {
                type: IndexableElement,
                transform: async (obj) => {
                    return new IndexableElement({
                        id: obj.id,
                        publicKey: obj.publicKey.bytes,
                        content: obj.content.toIndex(),
                    });
                },
            },
        });
    }

    async getCreateRoomByPath(path: string[]): Promise<Room[]> {
        const results = await this.findRoomsByPath(path);
        let rooms = results.rooms;

        if (path.length !== results.path.length) {
            if (results.rooms?.length > 1) {
                throw new Error("More than 1 room to choose from");
            }
            let room = results.rooms[0] || this;

            if (room.closed) {
                room = await this.node.open(room, { existing: "reuse" });
            }

            for (let i = results.path.length; i < path.length; i++) {
                const newRoom = new Room({
                    parentId: this.id,
                    rootTrust: this.node.identity.publicKey,
                    name: path[i],
                });

                await room.elements.put(
                    new Element<RoomContent>({
                        location: [],
                        publicKey: this.node.identity.publicKey,
                        content: new RoomContent({ room: newRoom }),
                    })
                );
                room = await this.node.open(newRoom, { existing: "reuse" });
            }
            rooms = [room];
        }
        return rooms;
    }

    async findRoomsByPath(
        path: string[]
    ): Promise<{ path: string[]; rooms: Room[] }> {
        let rooms: Room[] = [this];
        const visitedPath: string[] = [];
        for (const name of path) {
            const newRooms: Room[] = [];
            for (let parent of rooms) {
                if (parent.closed) {
                    console.log("OPEN PARENT", parent.name);
                    parent = await this.node.open(parent, {
                        existing: "reuse",
                    });
                }

                newRooms.push(
                    ...(await parent.findRoomsByName(name)).map(
                        (x) => x.content.room
                    )
                );
            }
            if (newRooms.length > 0) {
                visitedPath.push(name);
                rooms = newRooms;
            } else {
                break;
            }
        }
        return { path: visitedPath, rooms };
    }

    async findRoomsByName(name: string): Promise<Element<RoomContent>[]> {
        const results = await this.elements.index.search(
            new SearchRequest({
                query: [
                    new StringMatch({
                        key: ["content", "type"],
                        value: "room",
                    }),
                    new StringMatch({
                        key: ["content", "name"],
                        value: name,
                        caseInsensitive: true,
                        method: StringMatchMethod.exact,
                    }),
                ],
            })
        );
        return results as Element<RoomContent>[];
    }
}

@variant(0)
export class IFrameContent extends ElementContent {
    @field({ type: "string" })
    src: string; // https://a.cool.thing.com/abc123

    @field({ type: "bool" })
    resizer: boolean; // if IFrameResizer is installed on the target site

    constructor(properties: { src: string; resizer: boolean }) {
        super();
        this.src = properties.src;
        this.resizer = properties.resizer;
    }

    toIndex(): Record<string, any> {
        return {
            type: "app",
            src: this.src,
        };
    }
}

@variant(1)
export class RoomContent extends ElementContent {
    @field({ type: Room })
    room: Room;

    constructor(properties: { room: Room }) {
        super();
        this.room = properties.room;
    }

    toIndex(): Record<string, any> {
        return {
            type: "room",
            name: this.room.name,
        };
    }
}

/* 
type Args = { replicate?: ReplicationOptions };

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
            canPerform: async (operation, { entry }) => {
                // Only allow modifications from author
                const payload = await entry.getPayloadValue();
                if (payload instanceof PutOperation) {
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
        });
    }
}
 */
