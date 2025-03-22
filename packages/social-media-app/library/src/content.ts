import { field, variant, fixedArray, vec, option } from "@dao-xyz/borsh";
import {
    Compare,
    Documents,
    IntegerCompare,
    SearchRequest,
    StringMatch,
    StringMatchMethod,
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

    static zero(breakpoint: string = "md") {
        return new Layout({
            breakpoint,
            x: 0,
            y: 0,
            z: 0,
            w: 0,
            h: 0,
        });
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

    @field({ type: Layout })
    location: Layout;

    @field({ type: ElementContent })
    content: T;

    constructor(properties: {
        id?: Uint8Array;
        location: Layout;
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

    @field({ type: Layout })
    location: Layout;

    constructor(properties: {
        id: Uint8Array;
        publicKey: PublicSignKey;
        type: string;
        content: string;
        location: Layout;
    }) {
        this.id = properties.id;
        this.publicKey = properties.publicKey.bytes;
        this.content = properties.content;
        this.type = properties.type;
        this.location = properties.location;
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

    @field({ type: vec("string") })
    path: string[]; // address path

    @field({ type: "u32" })
    pathDepth: number;

    @field({ type: vec("string") })
    replyTo: string[]; // addresses

    constructor(properties: {
        id: Uint8Array;
        publicKey: PublicSignKey;
        content: string;
        replies: bigint;
        path: string[]; // address path
        replyTo: string[]; // addresses
    }) {
        this.id = properties.id;
        this.publicKey = properties.publicKey.bytes;
        this.content = properties.content;
        this.replies = properties.replies;
        this.path = properties.path;
        this.replyTo = properties.replyTo;
        this.pathDepth = properties.path.length;
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
            path: canvas.path.map((x) => x.address),
            replyTo: canvas.replyTo.map((x) => x.address),
        });
    }
}

abstract class CanvasReference {
    abstract get address(): string;
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

    get address() {
        return this.canvas;
    }
}

export const getRepliesQuery = (to: Canvas) => [
    new StringMatch({
        key: "path",
        value: to.address,
        caseInsensitive: true,
        method: StringMatchMethod.exact,
    }),
];

export const getImmediateRepliesQuery = (to: Canvas) => [
    new StringMatch({
        key: "path",
        value: to.address,
        caseInsensitive: true,
        method: StringMatchMethod.exact,
    }),
    new IntegerCompare({
        key: "pathDepth",
        value: to.path.length + 1,
        compare: Compare.Equal,
    }),
];

@variant("canvas")
export class Canvas extends Program {
    @field({ type: Documents })
    elements: Documents<Element, IndexableElement>; // Elements are either data points or sub-canvases (comments)

    @field({ type: Documents })
    private _replies: Documents<Canvas, IndexableCanvas>; // Replies or Sub Replies

    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: vec(CanvasReference) })
    path: CanvasReference[];

    @field({ type: vec(CanvasReference) })
    replyTo: CanvasReference[];

    constructor(
        properties: (
            | { path: CanvasReference[] }
            | { parent: Canvas }
            | { seed: Uint8Array }
        ) & {
            publicKey: PublicSignKey;
        } & { replyTo?: CanvasReference[] } & {
            topMostCanvasWithSameACL?: Canvas | null;
        }
    ) {
        super();
        this.publicKey = properties.publicKey;
        if ("parent" in properties) {
            this.path = [
                ...properties.parent.path,
                new CanvasAddressReference({
                    canvas: properties.parent.address,
                }),
            ];
        } else {
            this.path = properties["path"] ?? [];
        }
        this.replyTo = properties["replyTo"] ?? [];
        const elementsId = (properties as { seed: Uint8Array }).seed
            ? sha256Sync((properties as { seed: Uint8Array }).seed)
            : randomBytes(32);
        this.elements = new Documents({ id: elementsId });
        this._replies = new Documents({ id: sha256Sync(elementsId) });
        this._topMostCanvasWithSameACL = properties.topMostCanvasWithSameACL;
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
                        location: arg.location,
                    });
                },
            },
        });

        await this._replies.open({
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
        /*   this._repliesChangeListener = async () => {
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
          ); */
        await this.countReplies();
    }

    close(from?: Program): Promise<boolean> {
        /*    this._repliesChangeListener &&
               this.replies.events.removeEventListener(
                   "change",
                   this._repliesChangeListener
               ); */

        return super.close(from);
    }
    private _repliesCount: bigint | null = null;

    async loadPath(includeSelf?: boolean) {
        const path: Canvas[] = [];
        for (const element of this.path) {
            const next = await element.load(this.node);
            path.push(next);
        }
        if (includeSelf) {
            path.push(this);
        }
        return path;
    }
    get repliesCount(): bigint {
        return this._repliesCount || 0n;
    }

    async countReplies() {
        try {
            const replies = this.replies.index.closed
                ? 0n
                : BigInt(
                      await this.replies.count({
                          query: getRepliesQuery(this),
                          approximate: true,
                      })
                  );
            return (this._repliesCount = replies);
        } catch (error) {
            // TODO handle errors that arrise from the database being closed
            return 0n;
        }
    }
    async getCanvasPath() {
        const path: Canvas[] = [this];
        for (const element of this.path) {
            const next = await element.load(this.node);
            path.push(next);
        }
        return path.reverse();
    }

    async getCreateRoomByPath(path: string[]): Promise<Canvas[]> {
        const results = await this.findCanvasesByPath(path);
        let rooms = results.canvases;
        const existingPath = await results.canvases[0]?.loadPath(true);
        let createdPath: Canvas[] =
            existingPath?.length > 0 ? existingPath : [this];

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
            await currentCanvas.loadReplies();

            for (let i = results.path.length; i < path.length; i++) {
                const canvas = new Canvas({
                    path: createdPath.map(
                        (x) =>
                            new CanvasAddressReference({
                                canvas: x,
                            })
                    ),
                    publicKey: this.node.identity.publicKey,
                    topMostCanvasWithSameACL:
                        currentCanvas.topMostCanvasWithSameACLLoaded,
                });

                const nextCanvas = await this.node.open(canvas, {
                    existing: "reuse",
                });
                await nextCanvas.loadReplies();

                createdPath.push(canvas);

                const name = path[i];
                // TODO Dont put if already exists
                await nextCanvas.elements.put(
                    new Element({
                        content: new StaticContent<StaticMarkdownText>({
                            content: new StaticMarkdownText({ text: name }),
                        }),
                        location: Layout.zero(),
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
                    ...getImmediateRepliesQuery(this), // only descendants of this canvas
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
    private _topMostCanvasWithSameACL: Canvas | null | undefined = null;
    async loadReplies() {
        if (this._topMostCanvasWithSameACL) {
            return this._topMostCanvasWithSameACL;
        }

        // TODO use the rootmost canvas with same ACL
        // for now lets just use the root
        const root = this.path[0];
        if (root) {
            const rootLoaded = (this._topMostCanvasWithSameACL =
                await root.load(this.node));
            return rootLoaded;
        }
    }

    get loadedReplies() {
        return this._topMostCanvasWithSameACL != null || this.path.length === 0;
    }

    private get topMostCanvasWithSameACLLoaded() {
        if (!this._topMostCanvasWithSameACL && this.path.length > 0) {
            throw new Error("Root not found or loaded");
        }
        return this._topMostCanvasWithSameACL;
    }

    get replies(): Documents<Canvas, IndexableCanvas, any> {
        const root: Canvas = this.topMostCanvasWithSameACLLoaded ?? this;
        return root._replies;
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
export class StaticContent<
    T extends AbstractStaticContent = AbstractStaticContent
> extends ElementContent {
    @field({ type: AbstractStaticContent })
    content: T;

    constructor(properties: { content: T }) {
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
