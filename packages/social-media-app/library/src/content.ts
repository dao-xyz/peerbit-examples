import { field, variant, fixedArray, vec, option } from "@dao-xyz/borsh";
import {
    Documents,
    SearchRequest,
    StringMatch,
    StringMatchMethod,
    toId,
} from "@peerbit/document";
import {
    PublicSignKey,
    randomBytes,
    sha256Base64Sync,
    sha256Sync,
} from "@peerbit/crypto";
import { Program, ProgramClient } from "@peerbit/program";
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

    abstract get isEmpty(): boolean;
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

export class IndexableElement {
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

export class IndexableCanvas {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: Uint8Array })
    publicKey: Uint8Array;

    @field({ type: "string" })
    content: string;

    @field({ type: "u64" })
    replies: bigint;

    constructor(properties: {
        id: Uint8Array;
        publicKey: PublicSignKey;
        content: string;
        replies: bigint;
    }) {
        this.id = properties.id;
        this.publicKey = properties.publicKey.bytes;
        this.content = properties.content;
        this.replies = properties.replies;
    }

    static async from(canvas: Canvas, node: ProgramClient) {
        if (canvas.closed) {
            await node.open(canvas, { existing: "reuse" });
        }
        const indexable = await canvas.createTitle();

        const replies = await canvas.countReplies();
        return new IndexableCanvas({
            id: canvas.id,
            publicKey: canvas.publicKey,
            content: indexable,
            replies,
        });
    }
}

abstract class CanvasReference {
    abstract load(node: ProgramClient): Promise<Canvas> | Canvas;
}

@variant(0)
export class CanvasAddressReference extends CanvasReference {
    @field({ type: "string" })
    canvas: string;

    private _reference: Canvas | null;
    constructor(properties: { canvas: Canvas | string }) {
        super();
        this.canvas =
            typeof properties.canvas === "string"
                ? properties.canvas
                : properties.canvas.address;
        this._reference =
            typeof properties.canvas === "string" ? null : properties.canvas;
    }

    // TODO add args
    async load(node: ProgramClient) {
        return (
            this._reference ||
            (this._reference = await node.open<Canvas>(this.canvas, {
                existing: "reuse",
            }))
        );
    }
}

@variant("canvas")
export class Canvas extends Program {
    @field({ type: Documents })
    elements: Documents<Element, IndexableElement>; // Elements are either data points or sub-canvases (comments)

    @field({ type: Documents })
    replies: Documents<Canvas, IndexableCanvas>; // Replies are subcanvases

    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: option(CanvasReference) })
    parent?: CanvasReference;

    constructor(
        properties: (
            | { parent: CanvasAddressReference }
            | { seed: Uint8Array }
        ) & {
            publicKey: PublicSignKey;
        }
    ) {
        super();
        this.publicKey = properties.publicKey;
        this.parent = properties["parent"];
        const elementsId = (properties as { seed: Uint8Array }).seed
            ? sha256Sync((properties as { seed: Uint8Array }).seed)
            : randomBytes(32);
        this.elements = new Documents({ id: elementsId });
        this.replies = new Documents({ id: sha256Sync(elementsId) });
    }

    get id(): Uint8Array {
        return this.elements.log.log.id;
    }

    private _idString: string;
    private _repliesChangeListener: () => void;

    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
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
            replicate: { factor: 1 }, // TODO choose better
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
            replicate: { factor: 1 }, // TODO choose better
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
                    return IndexableCanvas.from(arg, this.node);
                },
            },
        });
        this._repliesChangeListener = async () => {
            // assume added/remove changed, in this case we want to update the parent so the parent indexed canvas knows that the reply count has changes

            const parent = await this.parent?.load(this.node);
            if (parent) {
                let indexedParent = await parent.replies.index.get(this.id, {
                    resolve: false,
                });
                await parent.replies.index.putWithContext(
                    this,
                    toId(this.id),
                    indexedParent.__context
                );
            }
        };
        this.replies.events.addEventListener(
            "change",
            this._repliesChangeListener
        );
        await this.countReplies();
    }

    close(from?: Program): Promise<boolean> {
        this._repliesChangeListener &&
            this.replies.events.removeEventListener(
                "change",
                this._repliesChangeListener
            );

        return super.close(from);
    }
    private _repliesCount: bigint | null = null;
    get repliesCount(): bigint {
        return this._repliesCount || 0n;
    }

    async countReplies() {
        try {
            const replies = this.replies.index.closed
                ? 0n
                : BigInt(await this.replies.count({ approximate: true }));
            return (this._repliesCount = replies);
        } catch (error) {
            // TODO handle errors that arrise from the database being closed
            return 0n;
        }
    }
    async getCanvasPath() {
        const path: Canvas[] = [this];
        let currentParent = path[path.length - 1].parent;
        while (currentParent) {
            const next = await currentParent.load(this.node);
            path.push(next);
            currentParent = path[path.length - 1].parent;
        }
        return path.reverse();
    }

    async getCreateRoomByPath(path: string[]): Promise<Canvas[]> {
        const results = await this.findCanvasesByPath(path);
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
                    parent: new CanvasAddressReference({
                        canvas: currentCanvas,
                    }),
                    publicKey: this.node.identity.publicKey,
                });

                const nextCanvas = await this.node.open(canvas, {
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

    async findCanvasesByPath(
        path: string[]
    ): Promise<{ path: string[]; canvases: Canvas[] }> {
        let canvases: Canvas[] = [this];
        const visitedPath: string[] = [];
        for (const name of path) {
            const newRooms: Canvas[] = [];
            for (let parent of canvases) {
                if (parent.closed) {
                    parent = await this.node.open(parent, {
                        existing: "reuse",
                    });
                }

                newRooms.push(...(await parent.findCanvasesByName(name)));
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

    async findCanvasesByName(name: string): Promise<Canvas[]> {
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
                if (concat.length > 0) {
                    concat += "\n";
                }
                concat += element.value.content;
            }
        }
        return concat;
    }
}

/*
 WE CAN NOT USE BELOW YET BECAUSE WE CAN NOT HAVE CIRCULAR DEPENDENCIE
 client.open( canvas, { resuse: true } )
 does not correctly respect cirdcular references
 */

/*
@variant(1)
export class CanvasValueReference extends CanvasReference {
   @field({ type: Canvas })
   canvas: Canvas;

   constructor(properties: { canvas: Canvas }) {

       super();
       this.canvas = properties.canvas;

   }

   // TODO add args
   async load(_node: ProgramClient) {
       return this.canvas
   }
}

*/

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

    get isEmpty(): boolean {
        return false;
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

    get isEmpty() {
        return this.content.isEmpty;
    }
}
