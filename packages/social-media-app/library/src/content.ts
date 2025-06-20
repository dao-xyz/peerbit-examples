import { field, variant, fixedArray, vec, option } from "@dao-xyz/borsh";
import {
    ByteMatchQuery,
    coerceWithContext,
    Compare,
    Context,
    Documents,
    DocumentsChange,
    id,
    IntegerCompare,
    Or,
    Query,
    SearchRequest,
    StringMatch,
    StringMatchMethod,
    toId,
    WithContext,
    WithIndexedContext,
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
import { EntryType } from "@peerbit/log";
import { ModedThemePalette } from "./colors.js";

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

    @field({ type: fixedArray("u8", 32) })
    canvasId: Uint8Array; // we don't use AddressReference here because if the canvas address might change when its property change, but we still want to associate elements with the right canvas

    @field({ type: Layout })
    location: Layout;

    @field({ type: ElementContent })
    content: T;

    constructor(properties: {
        id?: Uint8Array;
        location: Layout;
        publicKey: PublicSignKey;
        content: T;
        canvasId: Uint8Array;
    }) {
        this.location = properties.location;
        this.publicKey = properties.publicKey;
        this.content = properties.content;
        this.id = properties.id || randomBytes(32);
        this.canvasId = properties.canvasId;
    }

    set parent(canvas: Canvas) {
        this.canvasId = canvas.id;
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

    @field({ type: fixedArray("u8", 32) })
    canvasId: Uint8Array; // we don't use AddressReference here because if the canvas address might change when its property change, but we still want to associate elements with the right canvas

    @field({ type: "string" })
    content: string;

    @field({ type: Layout })
    location: Layout;

    @field({ type: "u32" })
    quality: number; // the higher the number, the better the quality

    @field({ type: vec("f32") })
    vector: number[]; // vector representation of the element, e.g. for search

    constructor(properties: {
        id: Uint8Array;
        publicKey: PublicSignKey;
        type: string;
        content: string;
        location: Layout;
        canvasId: Uint8Array;
        quality: number;
    }) {
        this.id = properties.id;
        this.publicKey = properties.publicKey.bytes;
        this.content = properties.content;
        this.type = properties.type;
        this.location = properties.location;
        this.canvasId = properties.canvasId;
        if (properties.quality == null) {
            throw new Error("Quality is required");
        }
        this.quality = properties.quality;
        this.vector = [];
    }

    private _idString: string;
    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
    }
}

export class IndexableCanvas {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: "string" })
    address: string;

    @field({ type: Uint8Array })
    publicKey: Uint8Array;

    @field({ type: "string" })
    context: string; // string context for searching, e.g. title or description, or a summary of the canvas

    @field({ type: vec("f32") })
    vector: number[]; // vector representation of the canvas, e.g. for search

    @field({ type: "u64" })
    replies: bigint;

    @field({ type: vec("string") })
    path: string[]; // address path

    @field({ type: "u32" })
    pathDepth: number;

    @field({ type: vec("string") })
    replyTo: string[]; // addresses

    @field({ type: vec("string") })
    types: string[]; // types of elements in the canvas, e.g. text, image, etc.

    constructor(properties: {
        id: Uint8Array;
        address: string; // used for indexing
        publicKey: PublicSignKey;
        context: string;
        replies: bigint;
        path: string[]; // address path
        replyTo: string[]; // addresses
        types: string[];
    }) {
        this.id = properties.id;
        this.address = properties.address;
        this.publicKey = properties.publicKey.bytes;
        this.context = properties.context;
        this.replies = properties.replies;
        this.path = properties.path;
        this.replyTo = properties.replyTo;
        this.pathDepth = properties.path.length;
        this.types = properties.types;
        this.vector = [];
    }

    static async from(
        canvas: Canvas,
        node: ProgramClient,
        args: {
            replicate?: boolean;
            replicas?: { min?: number };
        }
    ) {
        if (canvas.closed) {
            canvas = await node.open(canvas, { existing: "reuse", args });
        }
        const context = await canvas.createContext();
        const replies = await canvas.countReplies();
        const elements = await canvas.elements.index
            .iterate(
                { query: getOwnedElementsQuery(canvas) },
                { resolve: false }
            )
            .all();

        return new IndexableCanvas({
            id: canvas.id,
            publicKey: canvas.publicKey,
            address: canvas.address,
            context,
            replies,
            path: canvas.path.map((x) => x.address),
            replyTo: canvas.replyTo.map((x) => x.address),
            types: elements.map((x) => x.type),
        });
    }

    private _idString: string;
    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
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

export const getOwnedVisualizationQuery = (to: { id: Uint8Array }) => {
    return [
        new ByteMatchQuery({
            key: "canvasId",
            value: to.id,
        }),
    ];
};

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

export const getRepliesQuery = (to: { address: string }) => {
    return [
        new StringMatch({
            key: "path",
            value: to.address,
            caseInsensitive: true,
            method: StringMatchMethod.exact,
        }),
    ];
};

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

export const getOwnedElementsQuery = (to: { id: Uint8Array }) => {
    return [
        new ByteMatchQuery({
            key: "canvasId",
            value: to.id,
        }),
    ];
};

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

export const getTimeQuery = (ageMilliseconds: number) =>
    new IntegerCompare({
        key: ["__context", "created"],
        value: BigInt(+new Date() - ageMilliseconds),
        compare: Compare.GreaterOrEqual,
    });

export const getCanvasWithContentTypesQuery = (source: string[]) => {
    if (source.length === 0) {
        throw new Error("No types provided for canvas content query");
    }
    let query: Query[] = [];
    for (const type of source) {
        query.push(
            new StringMatch({
                key: "types",
                value: type,
                caseInsensitive: true,
                method: StringMatchMethod.exact,
            })
        );
    }
    return new Or(query);
};

export const getCanvasWithContentQuery = (source: string) => {
    if (source.length === 0) {
        throw new Error("No types provided for canvas content query");
    }
    return new StringMatch({
        key: "context",
        value: source,
        caseInsensitive: true,
        method: StringMatchMethod.contains,
    });
};

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

/* -------------- STYLING ------------------ */

export abstract class AbstractBackground {}

@variant(0)
export class ModedBackground {
    @field({ type: AbstractBackground })
    light: BackGroundTypes;

    @field({ type: option(AbstractBackground) })
    dark?: BackGroundTypes;

    constructor(props?: { light?: BackGroundTypes; dark?: BackGroundTypes }) {
        this.light = props?.light ?? new StyledBackground({ css: "" });
        this.dark = props?.dark;
    }
}

@variant(0)
export class StyledBackground extends AbstractBackground {
    @field({ type: "string" })
    css: string;

    constructor(props: { css: string }) {
        super();
        this.css = props.css;
    }
}

@variant(1)
export class CanvasBackground extends AbstractBackground {
    @field({ type: CanvasAddressReference })
    ref: CanvasAddressReference;

    constructor(props: CanvasBackground) {
        super();
        this.ref = props.ref;
    }
}

export type BackGroundTypes = StyledBackground | CanvasBackground;

export abstract class Visualization {
    id: Uint8Array;
    canvasId: Uint8Array;
}

export class IndexedVisualization {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: fixedArray("u8", 32) })
    canvasId: Uint8Array;

    constructor(props: { id: Uint8Array; canvasId: Uint8Array }) {
        this.id = props.id;
        this.canvasId = props.canvasId;
    }
}

@variant(0)
export class BasicVisualization {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: fixedArray("u8", 32) })
    canvasId: Uint8Array;

    @field({ type: option(ModedBackground) })
    background?: ModedBackground;

    @field({ type: option(ModedThemePalette) })
    palette?: ModedThemePalette;

    @field({ type: "bool" })
    showAuthorInfo: boolean;

    @field({ type: option("string") })
    previewHeight?: string;

    @field({ type: option("string") })
    font?: string;

    constructor(props: {
        id?: Uint8Array;
        canvasId: Uint8Array;
        background?: ModedBackground;
        palette?: ModedThemePalette;
        showAuthorInfo?: boolean;
        previewHeight?: string;
        font?: string;
    }) {
        this.id = props?.id || randomBytes(32);
        this.canvasId = props.canvasId;
        this.background = props?.background;
        this.palette = props?.palette;
        this.showAuthorInfo = props?.showAuthorInfo ?? true;
        this.previewHeight = props?.previewHeight;
        this.font = props?.font;
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

    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: Documents })
    private _elements: Documents<Element, IndexableElement>; // Elements are either data points or sub-canvases (comments)

    @field({ type: Documents })
    private _replies: Documents<Canvas, IndexableCanvas>; // Replies or Sub Replies

    @field({ type: Documents })
    private _visualizations: Documents<Visualization, IndexedVisualization>;

    @field({ type: RPC })
    private _messages: RPC<CanvasMessage, CanvasMessage>;

    @field({ type: vec(CanvasReference) })
    path: CanvasReference[];

    @field({ type: vec(CanvasReference) })
    replyTo: CanvasReference[];

    @field({ type: "u8" })
    acl: 0; // TODO

    constructor(
        properties: { seed?: Uint8Array } & {
            publicKey: PublicSignKey;
        } & { replyTo?: CanvasReference[] } & {
            topMostCanvasWithSameACL?: Canvas | null;
        } & PathProperties & {
                id?: Uint8Array;
            }
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
        this._visualizations = new Documents({
            id: sha256Sync(sha256Sync(elementsId)),
        });
        this._topMostCanvasWithSameACL = properties.topMostCanvasWithSameACL;
        this._messages = new RPC();
        this.acl = 0;
    }

    private async maybeSave() {
        // update address
        let addressBefore = this.address;
        await this.save(this.node.services.blocks, { reset: true });
        if (addressBefore === this.address) {
            return; // no change
        }

        // TODO things if address changed
    }

    async setParent(canvas: Canvas) {
        await waitFor(() => !this.closed).catch((error) => {
            console.error("Failed to wait for canvas to open", error);
            throw error;
        });

        this.path = [
            ...canvas.path,
            new CanvasAddressReference({
                canvas,
            }),
        ];

        await this.maybeSave();
    }

    private _idString: string;
    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
    }

    private _repliesChangeListener: (
        evt: CustomEvent<DocumentsChange<Canvas, IndexableCanvas>>
    ) => void;

    private getValueWithContext(value: string) {
        return this.address + ":" + value;
    }
    public debug: boolean = false;
    private closeController: AbortController | null = null;
    private reIndexDebouncer: ReturnType<
        typeof debouncedAccumulatorMap<{
            canvas: Canvas;
            options?: { onlyReplies?: boolean };
        }>
    >;

    async open(args?: CanvasArgs): Promise<void> {
        this.reIndexDebouncer = debouncedAccumulatorMap<{
            canvas: Canvas;
            options?: { onlyReplies?: boolean };
        }>(
            async (map) => {
                for (const indexArgs of map.values()) {
                    await this.reIndex(indexArgs.canvas, indexArgs.options);
                }
            },
            123,
            (into, from) => {
                if (into.options?.onlyReplies && !from.options?.onlyReplies) {
                    into.options = from.options;
                }
                into.canvas = from.canvas;
                return into;
            }
        );

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
            this._visualizations.closed = true;
            this._visualizations.allPrograms.map((x) => (x.closed = true));
            return;
        } else {
            this.debug &&
                console.time(this.getValueWithContext("openElements"));
            await this._elements.open({
                type: Element,
                replicas: args?.replicas,
                timeUntilRoleMaturity: 6e4,
                keep: "self",
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
                    includeIndexed: true, // because the transformation from value to indexed value is expensive, so we want to emit and also expect results with indexed values emitted
                    type: IndexableElement,
                    prefetch: {
                        strict: false,
                    },
                    cache: {
                        query: {
                            strategy: "auto",
                            maxSize: 50,
                            maxTotalSize: 1e4,
                            keepAlive: 1e4,
                            prefetchThreshold: 3,
                        },
                    },
                    transform: async (arg, _context) => {
                        const indexable = await arg.content.toIndex();
                        return new IndexableElement({
                            id: arg.id,
                            publicKey: arg.publicKey,
                            type: indexable.type,
                            content: indexable.content,
                            location: arg.location,
                            canvasId: arg.canvasId,
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
                keep: "self",
                index: {
                    includeIndexed: true, // because the transformation from value to indexed value is expensive, so we want to emit and also expect results with indexed values emitted
                    prefetch: {
                        strict: false,
                    },
                    cache: {
                        query: {
                            strategy: "auto",
                            maxSize: 50,
                            maxTotalSize: 1e4,
                            keepAlive: 1e4,
                            prefetchThreshold: 3,
                        },
                    },
                    type: IndexableCanvas,
                    transform: async (arg, _context) => {
                        return IndexableCanvas.from(arg, this.node, {
                            replicate: args?.replicate,
                            replicas: args?.replicas,
                        });
                    },
                },
            });

            await this._visualizations.open({
                type: BasicVisualization,
                replicas: args?.replicas,
                replicate:
                    args?.replicate != null
                        ? args?.replicate
                            ? { factor: 1 }
                            : false
                        : { factor: 1 }, // TODO choose better
                timeUntilRoleMaturity: 6e4,
                keep: "self",
                index: {
                    type: IndexedVisualization,
                },
                canPerform: async (operation) => {
                    /**
                     * Only allow updates if we created it
                     *  or from myself (this allows us to modifying someone elsecanvas locally)
                     */
                    return true;
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

    private async reIndex(
        from: Canvas | WithIndexedContext<Canvas, IndexableCanvas>,
        options?: { onlyReplies?: boolean }
    ) {
        if (options?.onlyReplies) {
            await this.updateIndexedReplyCounter(from);
            return;
        }

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
                remote: {
                    strategy: "fallback",
                    timeout: 1e4,
                },
            });
            if (!indexedCanvas) {
                console.trace("MISSING INDEXED CANVAS", canvas.idString);
                // because we might index children before parents, this might be undefined
                // but it is fine, since when the parent is to be re-indexed, its children will be considered
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

        this._repliesChangeListener &&
            this._replies.events.removeEventListener(
                "change",
                this._repliesChangeListener
            );
        this._repliesChangeListener = async (
            evt: CustomEvent<DocumentsChange<Canvas, IndexableCanvas>>
        ) => {
            // assume added/remove changed, in this case we want to update the parent so the parent indexed canvas knows that the reply count has changes

            for (let added of evt.detail.added) {
                if (added.closed) {
                    added = await this.openWithSameSettings(added);
                }
                const loadedPath = await added.loadPath(true);
                // i = 1 start to skip the root, -1 to skip the current canvas
                // (we only want to-re-index parents)
                for (let i = 1; i < loadedPath.length; i++) {
                    loadedPath[i] = await this.node.open(loadedPath[i], {
                        existing: "reuse",
                    });
                    await loadedPath[i].load();
                    this.reIndexDebouncer.add({
                        key: loadedPath[i].idString,
                        value: {
                            canvas: loadedPath[i],
                            options: {
                                onlyReplies: true,
                            },
                        },
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
                // i = 1 start to skip the root, -1 to skip the current canvas
                // (we only want to-re-index parents)
                for (let i = 1; i < loadedPath.length; i++) {
                    this.reIndexDebouncer.add({
                        key: loadedPath[i].idString,
                        value: {
                            canvas: loadedPath[i],
                            options: {
                                onlyReplies: true,
                            },
                        },
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

    async getCreateRoomByPath(
        path: string[]
    ): Promise<WithIndexedContext<Canvas, IndexableCanvas>[]> {
        const results = await this.findCanvasesByPath(path);
        let end = results.canvases[0];
        if (end.closed) {
            end = await this.openWithSameSettings(end);
        }
        const existingPath = await end.loadPath(true);
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

                createdPath.push(nextCanvas);

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
                        canvasId: nextCanvas.id,
                    })
                );
                await currentCanvas.createReply(nextCanvas);
                currentCanvas = nextCanvas;
            }
        }
        return createdPath.slice(1) as WithIndexedContext<
            Canvas,
            IndexableCanvas
        >[];
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
                await parent.load();

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
                        key: ["context"],
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

    async createContext(): Promise<string> {
        if (!this.loadedElements) {
            await this.load();
        }

        const elements = await this.elements.index
            .iterate(
                { query: getOwnedElementsQuery(this) },
                {
                    resolve: false,
                    local: true,
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

    get visualizations(): Documents<Visualization, IndexedVisualization, any> {
        const root: Canvas = this.origin ?? this;
        return root._visualizations;
    }

    async setVisualization(
        visualization: BasicVisualization | null
    ): Promise<void> {
        const origin = this.origin;
        if (!origin) {
            throw new Error("Cannot set visualization on non-origin canvas");
        }
        const visualizations = await this.visualizations.index
            .iterate(
                {
                    query: {
                        canvasId: this.id,
                    },
                },
                { resolve: false }
            )
            .all();
        for (const visualization of visualizations) {
            await this.visualizations.del(visualization.id);
        }

        if (visualization) {
            await this.visualizations.put(visualization);
        } else {
            // previous visualization was removed
        }
    }

    async getVisualization(): Promise<WithIndexedContext<
        Visualization,
        IndexedVisualization
    > | null> {
        const origin = this.origin;
        if (!origin) {
            throw new Error("Cannot get visualization on non-origin canvas");
        }
        const visualizations = await this.visualizations.index
            .iterate({
                query: {
                    canvasId: this.id,
                },
            })
            .all();
        if (visualizations.length === 0) {
            return null;
        }
        if (visualizations.length > 1) {
            throw new Error(
                `Multiple visualizations found for canvas ${this.idString}`
            );
        }
        return visualizations[0];
    }

    private async updateIndexedReplyCounter(
        canvas: Canvas | WithIndexedContext<Canvas, IndexableCanvas>,
        amount?: bigint
    ) {
        let indexed: IndexableCanvas;
        let context: Context;
        if ((canvas as WithIndexedContext<Canvas, IndexableCanvas>).__indexed) {
            indexed = (canvas as WithIndexedContext<Canvas, IndexableCanvas>)
                .__indexed;
            context = (canvas as WithIndexedContext<Canvas, IndexableCanvas>)
                .__context;
        } else {
            let parent = canvas.origin;

            if (!parent) {
                throw new Error("Missing parent for re-indexing");
            }

            let indexedCanvas = await parent.replies.index.get(canvas.id, {
                resolve: false,
                local: true,
                remote: {
                    strategy: "fallback",
                    timeout: 1e4,
                },
            });

            indexed = indexedCanvas;
            context = indexedCanvas.__context;
        }

        if (amount) {
            indexed.replies += amount;
        } else {
            indexed.replies = await canvas.countReplies();
        }

        const wrappedValueToIndex = new this.replies.index.wrappedIndexedType(
            indexed,
            context
        );
        await this.replies.index.index.put(wrappedValueToIndex);
    }

    async createReply(canvas: Canvas) {
        if (!this.origin!.replies.log.isReplicating()) {
            await this.origin!.replies.log.waitForReplicators();
        }

        await this.origin!.replies.put(canvas);
        const path = await canvas.loadPath(true);
        for (let i = 1; i < path.length; i++) {
            const loadedPathElement = await this.node.open(path[i], {
                existing: "reuse",
            });
            await loadedPathElement.load();

            // we only need to bump the reply counters of the parent
            await this.updateIndexedReplyCounter(loadedPathElement);
        }
    }

    createElement(element: Element) {
        return this.origin!.elements.put(element);
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
        return equals(element.canvasId, this.id);
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
