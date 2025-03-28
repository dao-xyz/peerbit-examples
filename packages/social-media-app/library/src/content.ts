import { field, variant, fixedArray, vec, option } from "@dao-xyz/borsh";
import {
    Compare,
    Documents,
    DocumentsChange,
    IntegerCompare,
    Or,
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
import {
    NATIVE_IMAGE_APP_URL,
    NATIVE_PARTIAL_IMAGE_APP_URL,
    NATIVE_TEXT_APP_URL,
} from "./types";
import { RPC } from "@peerbit/rpc";
import { concat } from "uint8arrays";

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
    abstract equals(other: ElementContent): boolean;
}

abstract class CanvasReference {
    abstract get address(): string;
    abstract load(node: ProgramClient): Promise<Canvas> | Canvas;
}

const resolvePathFromProperties = (
    properties: PathProperties
): CanvasReference[] => {
    if ("parent" in properties) {
        return [
            ...properties.parent.path,
            new CanvasAddressReference({
                canvas: properties.parent.address,
            }),
        ];
    } else {
        return properties["path"] ?? [];
    }
};

type PathProperties =
    | {
          parent: Canvas;
      }
    | { path: CanvasReference[] }
    | {};

@variant(0)
export class Element<T extends ElementContent = ElementContent> {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: vec(CanvasReference) })
    path: CanvasReference[];

    @field({ type: Layout })
    location: Layout;

    @field({ type: ElementContent })
    content: T;

    constructor(
        properties: {
            id?: Uint8Array;
            location: Layout;
            publicKey: PublicSignKey;
            content: T;
        } & PathProperties
    ) {
        this.location = properties.location;
        this.publicKey = properties.publicKey;
        this.content = properties.content;
        this.id = properties.id || randomBytes(32);
        this.path = resolvePathFromProperties(properties);
    }

    private _idString: string;
    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
    }
}

export class IndexableElement {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: Uint8Array })
    publicKey: Uint8Array;

    @field({ type: "string" })
    type: string;

    @field({ type: vec("string") })
    path: string[]; // address path

    @field({ type: "u32" })
    pathDepth: number;

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
        path: string[];
    }) {
        this.id = properties.id;
        this.publicKey = properties.publicKey.bytes;
        this.content = properties.content;
        this.type = properties.type;
        this.location = properties.location;
        this.path = properties.path;
        this.pathDepth = properties.path.length;
    }

    private _idString: string;
    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
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
            canvas = await node.open(canvas, { existing: "reuse" });
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

export const getImmediateRepliesQuery = (to: {
    address: string;
    path: any[];
}) => [
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

export const getRepliesQuery = (to: { address: string }) => [
    new StringMatch({
        key: "path",
        value: to.address,
        caseInsensitive: true,
        method: StringMatchMethod.exact,
    }),
];

export const getOwnedElementsQuery = (to: { address: string; path: any[] }) => [
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

export const getOwnedAndSubownedElementsQuery = (to: { address: string }) => [
    new StringMatch({
        key: "path",
        value: to.address,
        caseInsensitive: true,
        method: StringMatchMethod.exact,
    }),
];

export const getSubownedElementsQuery = (to: {
    address: string;
    path: any[];
}) => [
    new StringMatch({
        key: "path",
        value: to.address,
        caseInsensitive: true,
        method: StringMatchMethod.exact,
    }),
    new IntegerCompare({
        key: "pathDepth",
        value: to.path.length + 1,
        compare: Compare.Greater,
    }),
];

export const getTextElementsQuery = () =>
    new StringMatch({
        key: "type",
        value: NATIVE_TEXT_APP_URL,
        caseInsensitive: true,
        method: StringMatchMethod.exact,
    });

export const getImagesQuery = () =>
    new Or([
        new StringMatch({
            key: "type",
            value: NATIVE_IMAGE_APP_URL,
            caseInsensitive: true,
            method: StringMatchMethod.exact,
        }),
        new StringMatch({
            key: "type",
            value: NATIVE_PARTIAL_IMAGE_APP_URL,
            caseInsensitive: true,
            method: StringMatchMethod.exact,
        }),
    ]);

export abstract class CanvasMessage {}

@variant(0)
export class ReplyingInProgresss extends CanvasMessage {
    @field({ type: CanvasReference })
    reference: CanvasReference;

    constructor(properties: { reference: CanvasReference | Canvas }) {
        super();
        this.reference =
            properties.reference instanceof CanvasReference
                ? properties.reference
                : new CanvasAddressReference({
                      canvas: properties.reference,
                  });
    }
}
type CanvasArgs = { debug?: boolean };
@variant("canvas")
export class Canvas extends Program<CanvasArgs> {
    @field({ type: Documents })
    private _elements: Documents<Element, IndexableElement>; // Elements are either data points or sub-canvases (comments)

    @field({ type: Documents })
    private _replies: Documents<Canvas, IndexableCanvas>; // Replies or Sub Replies

    @field({ type: RPC })
    private _messages: RPC<CanvasMessage, CanvasMessage>;

    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: vec(CanvasReference) })
    path: CanvasReference[];

    @field({ type: vec(CanvasReference) })
    replyTo: CanvasReference[];

    constructor(
        properties: { seed?: Uint8Array } & {
            publicKey: PublicSignKey;
        } & { replyTo?: CanvasReference[] } & {
            topMostCanvasWithSameACL?: Canvas | null;
        } & PathProperties
    ) {
        super();
        this.publicKey = properties.publicKey;
        this.path = resolvePathFromProperties(properties);

        this.replyTo = properties["replyTo"] ?? [];
        const elementsId = (properties as { seed: Uint8Array }).seed
            ? sha256Sync((properties as { seed: Uint8Array }).seed)
            : randomBytes(32);
        this._elements = new Documents({ id: elementsId });
        this._replies = new Documents({ id: sha256Sync(elementsId) });
        this._topMostCanvasWithSameACL = properties.topMostCanvasWithSameACL;
        this._messages = new RPC();
    }

    get id(): Uint8Array {
        return this._elements.log.log.id;
    }

    private _idString: string;
    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
    }

    private _repliesChangeListener: (
        evt: CustomEvent<DocumentsChange<Canvas>>
    ) => void;

    private getValueWithContext(value: string) {
        return this.address + ":" + value;
    }
    public debug: boolean = false;
    async open(args?: CanvasArgs): Promise<void> {
        this.debug = !!args?.debug;
        this.debug && console.time(this.getValueWithContext("openElements"));
        await this._elements.open({
            type: Element,
            replicate: { factor: 1 }, // TODO choose better
            canPerform: async (operation) => {
                /**
                 * Only allow updates if we created it
                 *  or from myself (this allows us to modifying someone elsecanvas locally)
                 */
                // TODO
                return true;
                /* 
                (
                    !this.publicKey ||
                    operation.entry.signatures.find(
                        (x) =>
                            x.publicKey.equals(this.publicKey!) ||
                            x.publicKey.equals(this.node.identity.publicKey)
                    ) != null
                );
                */
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
                        path: arg.path.map((x) => x.address),
                    });
                },
            },
        });
        this.debug && console.timeEnd(this.getValueWithContext("openElements"));

        this.debug && console.time(this.getValueWithContext("openReplies"));
        await this._replies.open({
            type: Canvas,
            replicate: { factor: 1 }, // TODO choose better
            canOpen: () => false,
            canPerform: async (_operation) => {
                /**
                 *  TODOD Only allow updates if we created it
                 *  or from myself (this allows us to modifying someone elsecanvas locally)
                 */
                return true;
            },
            index: {
                type: IndexableCanvas,
                transform: async (arg, _context) => {
                    return IndexableCanvas.from(arg, this.node);
                },
            },
        });
        this.debug && console.timeEnd(this.getValueWithContext("openReplies"));

        await this._messages.open({
            responseType: CanvasMessage,
            queryType: CanvasMessage,
            topic: sha256Base64Sync(
                concat([this.id, new TextEncoder().encode("messages")])
            ),
            responseHandler: async () => {}, // need an empty response handle to make response events to emit TODO fix this?
        });

        this._repliesChangeListener = async (
            evt: CustomEvent<DocumentsChange<Canvas>>
        ) => {
            // assume added/remove changed, in this case we want to update the parent so the parent indexed canvas knows that the reply count has changes

            const reIndex = async (canvas: Canvas, parent: Canvas) => {
                await parent.load();
                let indexedCanvas = await parent.replies.index.get(canvas.id, {
                    resolve: false,
                });
                await parent.replies.index.putWithContext(
                    canvas,
                    toId(canvas.id),
                    indexedCanvas.__context
                );
            };

            for (const added of evt.detail.added) {
                const loadedPath = await added.loadPath(true);
                for (let i = 1; i < loadedPath.length; i++) {
                    await reIndex(loadedPath[i], loadedPath[i - 1]);
                }
            }

            for (const removed of evt.detail.removed) {
                const loadedPath = await removed.loadPath(true);
                for (let i = 1; i < loadedPath.length; i++) {
                    await reIndex(loadedPath[i], loadedPath[i - 1]);
                }
            }
        };
        this._replies.events.addEventListener(
            "change",
            this._repliesChangeListener
        );
        this.debug && console.time(this.getValueWithContext("countReplies"));
        await this.countReplies();
        this.debug && console.timeEnd(this.getValueWithContext("countReplies"));
    }

    close(from?: Program): Promise<boolean> {
        this._repliesChangeListener &&
            this._replies.events.removeEventListener(
                "change",
                this._repliesChangeListener
            );

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

    loadParent() {
        let parent = this.path[this.path.length - 1];
        if (!parent) {
            throw new Error("Missing parent");
        }
        return parent.load(this.node);
    }

    get repliesCount(): bigint {
        return this._repliesCount || 0n;
    }

    async countReplies(options?: { onlyImmediate: boolean }): Promise<bigint> {
        try {
            const replies = this.replies.index.closed
                ? 0n
                : BigInt(
                      await this.replies.count({
                          query: options?.onlyImmediate
                              ? getImmediateRepliesQuery(this)
                              : getRepliesQuery(this),
                          approximate: true,
                      })
                  );
            return (this._repliesCount = replies);
        } catch (error) {
            // TODO handle errors that arrise from the database being closed
            return 0n;
        }
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
            await currentCanvas.load();

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
                await nextCanvas.load();

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
                        parent: nextCanvas,
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
        if (!this.loadedElements) {
            await this.load();
        }
        const elements = await this.elements.index.index
            .iterate({ query: getOwnedElementsQuery(this) })
            .all();
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
    async load() {
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

    get loadedElements() {
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

    get elements(): Documents<Element, IndexableElement, any> {
        const root: Canvas = this.topMostCanvasWithSameACLLoaded ?? this;
        return root._elements;
    }

    get messages(): RPC<CanvasMessage, CanvasMessage> {
        return this._messages;
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

    @field({ type: "string" })
    orgSrc: string; // the src before any navigation. This is used to determine if the src has changed to another origin for example

    @field({ type: "bool" })
    resizer: boolean; // if IFrameResizer is installed on the target site

    constructor(properties: { src: string; resizer: boolean }) {
        super();
        this.src = properties.src;
        this.orgSrc = properties.src;
        this.resizer = properties.resizer;
    }

    toIndex() {
        return {
            type: this.src,
            content: this.src, // TODO actually index the content
        };
    }

    get isEmpty(): boolean {
        return false;
    }

    equals(other: ElementContent): boolean {
        return other instanceof IFrameContent && other.src === this.src;
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
            type: this.content.nativeAddress,
            content: this.content.toString(),
        };
    }

    get isEmpty() {
        return this.content.isEmpty;
    }

    equals(other: ElementContent): boolean {
        return (
            other instanceof StaticContent && other.content.equals(this.content)
        );
    }
}
