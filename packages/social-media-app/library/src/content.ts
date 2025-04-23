import { field, variant, fixedArray, vec, option } from "@dao-xyz/borsh";
import {
    coerceWithContext,
    Compare,
    Context,
    Documents,
    DocumentsChange,
    id,
    IntegerCompare,
    Or,
    SearchRequest,
    StringMatch,
    StringMatchMethod,
    toId,
    WithContext,
} from "@peerbit/document";
import {
    PublicSignKey,
    randomBytes,
    sha256Base64Sync,
    sha256Sync,
    toBase64,
} from "@peerbit/crypto";
import { Program, ProgramClient } from "@peerbit/program";
import { AbstractStaticContent } from "./static/content.js";
import { StaticMarkdownText } from "./static/text.js";
import {
    NATIVE_IMAGE_APP_URL,
    NATIVE_PARTIAL_IMAGE_APP_URL,
    NATIVE_TEXT_APP_URL,
} from "./types.js";
import { RPC } from "@peerbit/rpc";
import { concat, equals } from "uint8arrays";
import { AbortError, waitFor } from "@peerbit/time";
import { debouncedAccumulatorMap } from "./utils.js";

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
    abstract get contentId(): Uint8Array;

    private _contentIdString: string;
    get contentIdString(): string {
        return (
            this._contentIdString ||
            (this._contentIdString = toBase64(this.contentId))
        );
    }

    abstract get quality(): Quality;
}

export abstract class CanvasReference {
    reference: Canvas | null = null;
    constructor(properties?: { reference?: Canvas | null }) {
        if (properties?.reference) {
            this.reference = properties.reference;
        }
    }
    abstract get address(): string;
    abstract load(node: ProgramClient): Promise<Canvas> | Canvas;
}

const resolvePathFromProperties = (
    properties: PathProperties
): CanvasReference[] => {
    if ("parent" in properties && properties.parent) {
        return [
            ...properties.parent.path,
            new CanvasAddressReference({
                canvas: properties.parent.address,
            }),
        ];
    } else {
        return properties?.["path"] ?? [];
    }
};

type PathProperties =
    | {
          parent: Canvas;
      }
    | { path: CanvasReference[] }
    | {};

export const LOWEST_QUALITY: 0 = 0;
export const MEDIUM_QUALITY: 1431655765 = 1431655765; // 33% of max u32
export const HIGH_QUALITY: 2863311530 = 2863311530; // max u32
export const HIGHEST_QUALITY: 4294967295 = 4294967295; // max u32

export type Quality =
    | typeof LOWEST_QUALITY
    | typeof MEDIUM_QUALITY
    | typeof HIGH_QUALITY
    | typeof HIGHEST_QUALITY;

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

    set parent(canvas: Canvas) {
        this.path = [
            ...canvas.path,
            new CanvasAddressReference({
                canvas,
            }),
        ];
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

    @field({ type: "u32" })
    quality: number; // the higher the number, the better the quality

    constructor(properties: {
        id: Uint8Array;
        publicKey: PublicSignKey;
        type: string;
        content: string;
        location: Layout;
        path: string[];
        quality: number;
    }) {
        this.id = properties.id;
        this.publicKey = properties.publicKey.bytes;
        this.content = properties.content;
        this.type = properties.type;
        this.location = properties.location;
        this.path = properties.path;
        this.pathDepth = properties.path.length;
        if (properties.quality == null) {
            throw new Error("Quality is required");
        }
        this.quality = properties.quality;
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

    static async from(
        canvas: Canvas,
        node: ProgramClient,
        args: { replicate?: boolean; replicas?: { min?: number } }
    ) {
        if (canvas.closed) {
            canvas = await node.open(canvas, { existing: "reuse", args });
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

    constructor(properties: { canvas: Canvas | string }) {
        super({
            reference:
                properties.canvas instanceof Canvas ? properties.canvas : null,
        });
        this.canvas =
            typeof properties.canvas === "string"
                ? properties.canvas
                : properties.canvas.address;
    }

    // TODO add args
    async load(node: ProgramClient) {
        return this.reference && !this.reference.closed
            ? this.reference
            : (this.reference = await node.open<Canvas>(this.canvas, {
                  existing: "reuse",
              }));
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

export const getQualityLessThanOrEqualQuery = (quality: number) => {
    return [
        new IntegerCompare({
            key: "quality",
            value: quality,
            compare: Compare.LessOrEqual,
        }),
    ];
};

export const getQualityEqualsQuery = (quality: number) => {
    return [
        new IntegerCompare({
            key: "quality",
            value: quality,
            compare: Compare.Equal,
        }),
    ];
};

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

@variant(1)
export class ReplyingNoLongerInProgresss extends CanvasMessage {
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

type CanvasArgs = {
    debug?: boolean;
    replicate?: boolean;
    replicas?: { min?: number };
};
@variant("canvas")
export class Canvas extends Program<CanvasArgs> {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

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
        } & PathProperties & { id?: Uint8Array }
    ) {
        super();
        this.publicKey = properties.publicKey;
        this.path = resolvePathFromProperties(properties);

        this.replyTo = properties["replyTo"] ?? [];
        const elementsId =
            properties.id ||
            ((properties as { seed: Uint8Array }).seed
                ? sha256Sync((properties as { seed: Uint8Array }).seed)
                : randomBytes(32));
        this.id = elementsId;
        this._elements = new Documents({ id: elementsId });
        this._replies = new Documents({ id: sha256Sync(elementsId) });
        this._topMostCanvasWithSameACL = properties.topMostCanvasWithSameACL;
        this._messages = new RPC();
    }

    async setParent(canvas: Canvas) {
        await waitFor(() => !this.closed).catch((error) => {
            console.error("Failed to wait for canvas to open", error);
            throw error;
        });

        // fetch elements before updating address and apth
        const elements = await this.elements.index
            .iterate({ query: getOwnedElementsQuery(this) })
            .all();
        const elementsWithSubElements = await this.elements.index
            .iterate({ query: getOwnedAndSubownedElementsQuery(this) })
            .all();
        if (elementsWithSubElements.length !== elements.length) {
            throw new Error("Cannot move canvas with sub-elements");
        }

        this.path = [
            ...canvas.path,
            new CanvasAddressReference({
                canvas,
            }),
        ];

        // update address
        let addressBefore = this.address;
        await this.save(this.node.services.blocks, { reset: true });
        if (addressBefore === this.address) {
            return; // no change
        }

        const newElementPath = [
            ...this.path,
            new CanvasAddressReference({
                canvas: this,
            }),
        ];
        // move all elements
        // TODO what if the origin has changed?
        // TODO implement sub canvases movements?
        for (const element of elements) {
            element.path = newElementPath;
            await this.elements.put(element);
        }
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
    private closeController: AbortController | null = null;
    private reIndexDebouncer: ReturnType<
        typeof debouncedAccumulatorMap<Canvas | WithContext<Canvas>>
    >;

    async open(args?: CanvasArgs): Promise<void> {
        this.reIndexDebouncer = debouncedAccumulatorMap<Canvas>(async (map) => {
            for (const canvas of map.values()) {
                await this.reIndex(canvas);
            }
        }, 123);

        this.closeController = new AbortController();
        this.debug = !!args?.debug;
        if (!this.isOrigin) {
            // dont open if we are not the origin, TODO unless we want private canvases
            this._replies.closed = true;
            this._replies.allPrograms.map((x) => (x.closed = true));
            this._elements.closed = true;
            this._elements.allPrograms.map((x) => (x.closed = true));
            this._messages.closed = true;
            this._messages.allPrograms.map((x) => (x.closed = true));
            return;
        } else {
            this.debug &&
                console.time(this.getValueWithContext("openElements"));
            await this._elements.open({
                type: Element,
                replicas: args?.replicas,
                timeUntilRoleMaturity: 6e4,
                replicate:
                    args?.replicate != null
                        ? args?.replicate
                            ? { factor: 1 }
                            : false
                        : { factor: 1 }, // TODO choose better
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
                            quality:
                                arg.content instanceof StaticContent
                                    ? arg.content.quality
                                    : LOWEST_QUALITY,
                        });
                    },
                },
            });
            this.debug &&
                console.timeEnd(this.getValueWithContext("openElements"));
            this.debug && console.time(this.getValueWithContext("openReplies"));

            await this._replies.open({
                type: Canvas,
                timeUntilRoleMaturity: 6e4,
                replicas: args?.replicas,
                replicate:
                    args?.replicate != null
                        ? args?.replicate
                            ? { factor: 1 }
                            : false
                        : { factor: 1 }, // TODO choose better
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
                        return IndexableCanvas.from(arg, this.node, {
                            replicate: args?.replicate,
                            replicas: args?.replicas,
                        });
                    },
                },
            });
            this.debug &&
                console.timeEnd(this.getValueWithContext("openReplies"));

            await this._messages.open({
                responseType: CanvasMessage,
                queryType: CanvasMessage,
                topic: sha256Base64Sync(
                    concat([this.id, new TextEncoder().encode("messages")])
                ),
                responseHandler: async () => {}, // need an empty response handle to make response events to emit TODO fix this?
            });
        }
    }

    private async reIndex(from: Canvas | WithContext<Canvas>) {
        const canvas = await this.openWithSameSettings(from);
        if (canvas.closed) {
            console.warn("indexable canvas not open, skipping re-index");
            return;
        }
        /* const canvas = await this.node.open(maybeOpenCanvas, { existing: 'reuse' });
        await canvas.load(); */
        if (!canvas.loadedReplies || !canvas.origin) {
            console.error("Missing parent");
            return;
        }
        if (this.closed || canvas.origin.closed) {
            console.error("Canvas closed, skipping re-index");
            return;
        }

        const parent = await this.openWithSameSettings(canvas.origin);

        let context = (canvas as WithContext<Canvas>).__context;
        if (!context) {
            if (this.closed || parent.closed) {
                console.error("Canvas closed, skipping re-index");
                return;
            }
            let indexedCanvas = await parent.replies.index.get(canvas.id, {
                resolve: false,
                local: true,
                remote: false,
            });
            if (!indexedCanvas) {
                console.log("MISSING INDEXED CANVAS", canvas.idString);
                // because we might index children before parents, this might be undefined
                // but it is fine, since when the parent is to be re-indexed, its children will be considered
                /*  try {
                     let context = await canvas.loadContext();
                     indexedCanvas = coerceWithContext(
                         await IndexableCanvas.from(canvas, this.node),
                         context
                     );
                 } catch (error) {
                     const fff222 = [toId(canvas.id).primitive, parent.replies.index.closed, parent.replies.index["putSet"]?.size, parent.replies.index["putSet"]?.has(toId(canvas.id).primitive), parent.replies.index.index["_index"].has(toId(canvas.id).primitive)]
    
                     console.error("Failed to load context", fff, fff222, error);
                     throw error;
                 } */
                return;
            }
            context = indexedCanvas.__context;
        }

        try {
            await parent.replies.index.putWithContext(
                canvas,
                toId(canvas.id),
                context
            );
        } catch (error) {
            if (parent.replies.index.closed) {
                console.warn(
                    `Index ${parent.replies.address} closed, skipping re-index"`
                );
                return;
            }
            throw error;
        }
    }

    async afterOpen(): Promise<void> {
        await super.afterOpen();

        // re-index all canvases since the reply counter might have changed
        /*  if (this._replies.closed === false) { // dont puss this block in the after open because renderers might invoke sort directly after open but before afterOpen
             // TODO why do we even need this??? onChange listener will index the wrong thing
             let promises: Promise<void>[] = [];
             for (let canvas of await this._replies.index
                 .iterate({}, { local: true, remote: false })
                 .all()) {
 
                 canvas = await this.node.open(canvas, { existing: "reuse" });
                 await canvas.load();
 
                 promises.push(
                     this.reIndexDebouncer.add({
                         key: canvas.idString,
                         value: canvas,
                     })
                 );
             }
             await Promise.all(promises);
         } */

        this._repliesChangeListener = async (
            evt: CustomEvent<DocumentsChange<Canvas>>
        ) => {
            // assume added/remove changed, in this case we want to update the parent so the parent indexed canvas knows that the reply count has changes

            for (let added of evt.detail.added) {
                if (added.closed) {
                    const context = added.__context;
                    added = await this.openWithSameSettings(added);
                }
                const loadedPath = await added.loadPath(true);
                for (let i = 1; i < loadedPath.length; i++) {
                    loadedPath[i] = await this.node.open(loadedPath[i], {
                        existing: "reuse",
                    });
                    await loadedPath[i].load();
                    this.reIndexDebouncer.add({
                        key: loadedPath[i].idString,
                        value: loadedPath[i],
                    });
                }
            }

            for (let removed of evt.detail.removed) {
                if (removed.closed) {
                    removed = await this.node.open(removed, {
                        existing: "reuse",
                    });
                }

                const loadedPath = await removed.loadPath(true);
                for (let i = 1; i < loadedPath.length; i++) {
                    this.reIndexDebouncer.add({
                        key: loadedPath[i].idString,
                        value: loadedPath[i],
                    });
                }
                await removed.close();
            }
        };
        this._replies?.events.addEventListener(
            "change",
            this._repliesChangeListener
        );
        // Dont await this one!!! because this.load might load self
        this.load();
    }

    close(from?: Program): Promise<boolean> {
        this.closeController?.abort();
        this._repliesChangeListener &&
            this._replies.events.removeEventListener(
                "change",
                this._repliesChangeListener
            );
        this.reIndexDebouncer.close();
        return super.close(from);
    }

    async loadPath(includeSelf?: boolean) {
        const path: Canvas[] = [];
        for (const canvas of this.path) {
            const next = await canvas.load(this.node);
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

    getCountQuery(options?: {
        onlyImmediate: boolean;
    }): (StringMatch | IntegerCompare)[] {
        return options?.onlyImmediate
            ? getImmediateRepliesQuery(this)
            : getRepliesQuery(this);
    }

    async countReplies(options?: { onlyImmediate: boolean }): Promise<bigint> {
        try {
            const replies = this.replies.index.closed
                ? 0n
                : BigInt(
                      await this.replies.count({
                          query: this.getCountQuery(options),
                          approximate: true,
                      })
                  );
            return replies;
        } catch (error) {
            // TODO handle errors that arrise from the database being closed
            return 0n;
        }
    }

    async getText(): Promise<string> {
        if (!this.loadedElements) {
            await this.load();
        }
        const elements = await this.elements.index.index
            .iterate({
                query: [getTextElementsQuery(), ...getOwnedElementsQuery(this)],
            })
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
                    topMostCanvasWithSameACL: currentCanvas.origin,
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
                            quality: LOWEST_QUALITY,
                            contentId: sha256Sync(
                                new TextEncoder().encode(name)
                            ),
                        }),
                        location: Layout.zero(),
                        publicKey: this.node.identity.publicKey,
                        parent: nextCanvas,
                    })
                );
                await currentCanvas.createReply(nextCanvas);
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
        try {
            const elements = await this.elements.index
                .iterate(
                    { query: getOwnedElementsQuery(this) },
                    {
                        resolve: false,
                        remote: { strategy: "fallback", timeout: 2e4 },
                    }
                )
                .all();
            let concat = "";
            for (const element of elements) {
                if (element.type !== "canvas") {
                    if (concat.length > 0) {
                        concat += "\n";
                    }
                    concat += element.content;
                }
            }
            return concat;
        } catch (error) {
            throw error;
        }
    }
    private _topMostCanvasWithSameACL: Canvas | null | undefined = null;
    async load() {
        if (
            this._topMostCanvasWithSameACL &&
            !this._topMostCanvasWithSameACL.closed
        ) {
            return this._topMostCanvasWithSameACL;
        }

        // TODO use the rootmost canvas with same ACL
        // for now lets just use the root
        this.node
            ? Promise.resolve(this.node)
            : await waitFor(() => this.node, {
                  signal: this.closeController?.signal,
              }).catch((error) => {
                  if (error instanceof AbortError) {
                      return;
                  }
                  throw new Error("Failed to load, canvas was never opened");
              });
        if (!this.node && this.closed) {
            // return silently if closed
            return;
        }
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

    get isOrigin(): boolean {
        return this.path.length === 0;
    }

    get origin(): Canvas | null | undefined {
        if (this.isOrigin) {
            return this;
        }

        if (!this._topMostCanvasWithSameACL && this.path.length > 0) {
            throw new Error("Root not found or loaded");
        }
        return this._topMostCanvasWithSameACL;
    }

    get replies(): Documents<Canvas, IndexableCanvas, any> {
        const root: Canvas = this.origin ?? this;
        return root._replies;
    }

    async createReply(canvas: Canvas) {
        if (!this.origin!.replies.log.isReplicating()) {
            await this.origin!.replies.log.waitForReplicators();
        }

        await this.origin!.replies.put(canvas);
        const path = await canvas.loadPath(true);
        for (let i = 1; i < path.length; i++) {
            path[i] = await this.node.open(path[i], { existing: "reuse" });
            await path[i].load();
            await this.reIndexDebouncer.add({
                key: path[i].idString,
                value: path[i],
            });
        }
    }

    get elements(): Documents<Element, IndexableElement, any> {
        const root: Canvas = this.origin ?? this;
        return root._elements;
    }

    get messages(): RPC<CanvasMessage, CanvasMessage> {
        const root: Canvas = this.origin ?? this;
        return root._messages;
    }

    async loadContext(options?: {
        reload?: boolean;
        waitFor?: boolean;
    }): Promise<Context> {
        if ((this as WithContext<any>).__context && !options?.reload) {
            return (this as WithContext<any>).__context;
        }

        await this.load();
        if (!this.origin) {
            throw new Error("Missing origin when loading context");
        }
        const withContext =
            (
                await this.origin.replies.index.index.get(toId(this.id), {
                    shape: {
                        id: true,
                        __context: true,
                    },
                })
            )?.value.__context ||
            (
                await this.origin.replies.index.get(toId(this.id), {
                    local: true,
                    remote: true,
                    resolve: false,
                })
            )?.__context;

        if (!withContext) {
            throw new Error("No context found");
        }
        return ((this as WithContext<any>).__context = withContext);
    }

    get loadedContext(): boolean {
        return (this as WithContext<any>).__context != null;
    }

    get context(): Context | null {
        if ((this as WithContext<any>).__context) {
            return (this as WithContext<any>).__context;
        }
        return null;
    }

    isInScope(element: Element) {
        return element.path[element.path.length - 1].address === this.address;
    }

    async openWithSameSettings<T extends Canvas | WithContext<Canvas>>(
        other: T
    ): Promise<T> {
        let context = (other as WithContext<any>).__context;
        const replies = this._replies.closed ? this.replies : this._replies;
        let replicating = await replies.log.isReplicating();
        let minReplicas = replies.log.replicas.min.getValue(replies.log);
        const out = await this.node.open<Canvas>(other, {
            existing: "reuse",
            args: {
                replicate: replicating,
                replicas: {
                    min: minReplicas,
                },
            },
        });
        return (context ? coerceWithContext(out, context) : out) as T;
    }
}

/*
 WE CAN NOT USE BELOW YET BECAUSE WE CAN NOT HAVE CIRCULAR DEPENDENCIE
 client.open( canvas, { resuse: true } )
 does not correctly respect cirdcular references
 */

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
        return this.canvas;
    }

    get address(): string {
        return this.canvas.address;
    }
}

@variant(0)
export class IFrameContent extends ElementContent {
    @field({ type: "string" })
    src: string; // https://a.cool.thing.com/abc123

    @field({ type: "string" })
    orgSrc: string; // the src before any navigation. This is used to determine if the src has changed to another origin for example

    @field({ type: "bool" })
    resizer: boolean; // if IFrameResizer is installed on the target site

    // A source id can be used ot group content together. For example PartialImages, or figuring out if we have two elements with different quality but the same content, we can use the sourceId to determine if they are the same
    @field({ type: Uint8Array })
    contentId: Uint8Array;

    @field({ type: "u32" })
    quality: Quality;

    constructor(properties: { src: string; resizer: boolean }) {
        super();
        this.src = properties.src;
        this.orgSrc = properties.src;
        this.resizer = properties.resizer;
        this.contentId = sha256Sync(new TextEncoder().encode(this.src));
        this.quality = LOWEST_QUALITY;
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

    @field({ type: "u32" })
    quality: Quality;

    // A source id can be used ot group content together. For example PartialImages, or figuring out if we have two elements with different quality but the same content, we can use the sourceId to determine if they are the same
    @field({ type: Uint8Array })
    contentId: Uint8Array;

    constructor(properties: {
        content: T;
        quality: Quality;
        contentId: Uint8Array;
    }) {
        super();
        this.content = properties.content;
        this.quality = properties.quality;
        this.contentId = properties.contentId;
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
            other instanceof StaticContent &&
            other.content.equals(this.content) &&
            other.quality === this.quality &&
            equals(other.contentId, this.contentId)
        );
    }
}
