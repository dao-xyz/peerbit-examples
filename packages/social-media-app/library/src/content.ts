import { field, variant, fixedArray, vec, option } from "@dao-xyz/borsh";
import {
    Documents,
    SearchRequest,
    StringMatch,
    StringMatchMethod,
} from "@peerbit/document";
import { PublicSignKey, randomBytes, sha256Sync } from "@peerbit/crypto";
import { Program } from "@peerbit/program";
import { AbstractStaticContent } from "./static/content";
import { StaticMarkdownText } from "./static";

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
    abstract toIndex():
        | Promise<{ type: string; content: string }>
        | { type: string; content: string };
}

@variant(0)
export class Element<T extends ElementContent = ElementContent> {
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
    type: string;

    @field({ type: "string" })
    content: string;

    constructor(properties: {
        id: Uint8Array;
        publicKey: PublicSignKey;
        type: string;
        content: string;
    }) {
        this.id = properties.id;
        this.publicKey = properties.publicKey.bytes;
        this.content = properties.content;
        this.type = properties.type;
    }
}

class IndexableCanvas {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: Uint8Array })
    publicKey: Uint8Array;

    @field({ type: "string" })
    content: string;

    constructor(properties: {
        id: Uint8Array;
        publicKey: PublicSignKey;
        content: string;
    }) {
        this.id = properties.id;
        this.publicKey = properties.publicKey.bytes;
        this.content = properties.content;
    }
}

@variant("canvas")
export class Canvas extends Program {
    @field({ type: Documents })
    elements: Documents<Element, IndexableElement>; // Elements are either data points or sub-canvases (comments)

    @field({ type: Documents })
    replies: Documents<Canvas, IndexableCanvas>; // Elements are either data points or sub-canvases (comments)

    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: option(fixedArray("u8", 32)) })
    parentId?: Uint8Array;

    constructor(
        properties: ({ parentId: Uint8Array } | { seed: Uint8Array }) & {
            publicKey: PublicSignKey;
        }
    ) {
        super();
        this.publicKey = properties.publicKey;
        this.parentId = properties["parentId"];
        let elementsId = (properties as { seed: Uint8Array }).seed
            ? sha256Sync((properties as { seed: Uint8Array }).seed)
            : randomBytes(32);
        this.elements = new Documents({ id: elementsId });
        this.replies = new Documents({ id: sha256Sync(elementsId) });
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
        await this.elements.open({
            type: Element,
            replicate: { factor: 1 },
            canPerform: async (operation) => {
                /**
                 * Only allow updates if we created it
                 *  or from myself (this allows us to modifying someone elsecanvas locally)
                 */
                return (
                    !this.publicKey ||
                    operation.entry.signatures.find(
                        (x) =>
                            x.publicKey.equals(this.publicKey!) ||
                            x.publicKey.equals(this.node.identity.publicKey)
                    ) != null
                );
            },
            index: {
                type: IndexableElement,
                transform: async (arg, _context) => {
                    const indexable = await arg.content.toIndex();
                    return new IndexableElement({
                        id: arg.id,
                        publicKey: arg.publicKey,
                        type: indexable.type,
                        content: indexable.content,
                    });
                },
            },
        });

        await this.replies.open({
            type: Canvas,
            replicate: { factor: 1 },
            canOpen: () => false,
            canPerform: async (operation) => {
                /**
                 * Only allow updates if we created it
                 *  or from myself (this allows us to modifying someone elsecanvas locally)
                 */
                return (
                    !this.publicKey ||
                    operation.entry.signatures.find(
                        (x) =>
                            x.publicKey.equals(this.publicKey!) ||
                            x.publicKey.equals(this.node.identity.publicKey)
                    ) != null
                );
            },
            index: {
                type: IndexableCanvas,
                transform: async (arg, _context) => {
                    const indexable = await arg.createTitle();
                    return new IndexableCanvas({
                        id: arg.id,
                        publicKey: arg.publicKey,
                        content: indexable,
                    });
                },
            },
        });
    }

    async getCreateRoomByPath(path: string[]): Promise<Canvas[]> {
        const results = await this.findRoomsByPath(path);
        let rooms = results.canvases;

        if (path.length !== results.path.length) {
            if (results.canvases?.length > 1) {
                throw new Error("More than 1 room to choose from");
            }
            let currentCanvas = results.canvases[0] || this;

            if (currentCanvas.closed) {
                currentCanvas = await this.node.open(currentCanvas, {
                    existing: "reuse",
                });
            }

            for (let i = results.path.length; i < path.length; i++) {
                const canvas = new Canvas({
                    parentId: this.id,
                    publicKey: this.node.identity.publicKey,
                });

                let nextCanvas = await this.node.open(canvas, {
                    existing: "reuse",
                });
                const name = path[i];
                // TODO Dont put if already exists
                await nextCanvas.elements.put(
                    new Element({
                        content: new StaticContent({
                            content: new StaticMarkdownText({ text: name }),
                        }),
                        location: [],
                        publicKey: this.node.identity.publicKey,
                    })
                );
                await currentCanvas.replies.put(nextCanvas);
                currentCanvas = nextCanvas;
            }
            rooms = [currentCanvas];
        }
        return rooms;
    }

    async findRoomsByPath(
        path: string[]
    ): Promise<{ path: string[]; canvases: Canvas[] }> {
        let canvases: Canvas[] = [this];
        const visitedPath: string[] = [];
        for (const name of path) {
            const newRooms: Canvas[] = [];
            for (let parent of canvases) {
                if (parent.closed) {
                    console.log("OPEN PARENT", parent);
                    parent = await this.node.open(parent, {
                        existing: "reuse",
                    });
                }

                newRooms.push(...(await parent.findRoomsByName(name)));
            }
            if (newRooms.length > 0) {
                visitedPath.push(name);
                canvases = newRooms;
            } else {
                break;
            }
        }
        return { path: visitedPath, canvases };
    }

    async findRoomsByName(name: string): Promise<Canvas[]> {
        const results = await this.replies.index.search(
            new SearchRequest({
                query: [
                    new StringMatch({
                        key: ["content"],
                        value: name,
                        caseInsensitive: true,
                        method: StringMatchMethod.exact,
                    }),
                ],
            })
        );
        return results as Canvas[];
    }

    async createTitle(): Promise<string> {
        if (this.elements.index.closed) {
            throw new Error("Can not create title because database is closed");
        }
        const elements = await this.elements.index.index.iterate().all();
        let concat = "";
        for (const element of elements) {
            if (element.value.type !== "canvas") {
                concat += element.value.content;
            }
        }
        return concat;
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

    toIndex() {
        return {
            type: "app",
            content: this.src,
        };
    }
}

@variant(1)
export class StaticContent extends ElementContent {
    @field({ type: AbstractStaticContent })
    content: AbstractStaticContent; // https://a.cool.thing.com/abc123

    constructor(properties: { content: AbstractStaticContent }) {
        super();
        this.content = properties.content;
    }

    toIndex() {
        return {
            type: "static",
            content: this.content.toString(),
        };
    }
}

/* 

@variant(2)
export class SubCanvas extends ElementContent {

    @field({ type: Canvas })
    canvas: Canvas;

    constructor(properties: { canvas: Canvas }) {
        super();
        this.canvas = properties.canvas;
    }






    async toIndex() {
        // fetch a few elements and build a stringify version of the canvas

        return {
            type: "canvas",
            content: await this.canvas.createTitle()
        };
    }
} */
