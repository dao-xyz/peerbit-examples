import {
    field,
    variant,
    fixedArray,
    vec,
    option,
    deserialize,
    serialize,
    Constructor,
} from "@dao-xyz/borsh";
import {
    BoolQuery,
    ByteMatchQuery,
    Compare,
    Context,
    Documents,
    DocumentsChange,
    id,
    IntegerCompare,
    NotStartedError,
    Or,
    Query,
    QueryOptions,
    SearchRequest,
    StringMatch,
    StringMatchMethod,
    toId,
    WithContext,
    WithIndexedContext,
} from "@peerbit/document";
import {
    fromBase64URL,
    PublicSignKey,
    randomBytes,
    sha256Base64Sync,
    sha256Sync,
    toBase64,
    toBase64URL,
} from "@peerbit/crypto";
import { ClosedError, Program, ProgramClient } from "@peerbit/program";
import { AbstractStaticContent } from "./static/content.js";
import { StaticMarkdownText } from "./static/text.js";
import {
    NATIVE_IMAGE_APP_URL,
    NATIVE_PARTIAL_IMAGE_APP_URL,
    NATIVE_TEXT_APP_URL,
} from "./types.js";
import { RPC } from "@peerbit/rpc";
import { compare, concat, equals } from "uint8arrays";
import { createHierarchicalReindexManager } from "./utils.js"; // per-key & hierarchical variants
import { ModedThemePalette } from "./colors.js";
import { type ReplicationOptions } from "@peerbit/shared-log";
import { orderKeyBetween } from "./order-key.js";
import { coerceWithContext, coerceWithIndexed } from "@peerbit/document";
import {
    /* TODO later BoardViewKind, */ Layout,
    LinkKind,
    ReplyKind,
    ViewKind,
} from "./link.js";

const isClosedError = (error: any) => {
    if (error instanceof NotStartedError || error instanceof ClosedError) {
        return true;
    }
    return false;
};
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

@variant(0)
export class AddressReference {
    @field({ type: "string" })
    address: string;
    constructor(properties: { address: string }) {
        this.address = properties.address;
    }
}

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

    clone(): Element<T> {
        return deserialize(serialize(this), Element) as Element<T>;
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

@variant(0)
export class IndexableCanvas {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: Uint8Array })
    publicKey: Uint8Array;

    @field({ type: "string" })
    context: string; // string context for searching, e.g. title or description, or a summary of the canvas

    @field({ type: vec("f32") })
    vector: number[]; // vector representation of the canvas, e.g. for search

    @field({ type: "u64" })
    replies: bigint;

    @field({ type: "u64" })
    elements: bigint; // number of elements owned by this canvas

    @field({ type: vec(Uint8Array) })
    path: Uint8Array[]; // address path

    @field({ type: "u32" })
    pathDepth: number;

    /*     @field({ type: vec(Uint8Array) })
        replyTo: Uint8Array[]; // addresses
     */
    @field({ type: "u8" })
    view?: ChildVisualization;

    @field({ type: vec(LinkKind) })
    kind?: LinkKind[]; // ReplyKind, e.g. chat, feed, etc.

    @field({ type: vec("string") })
    contents: string[]; // types of elements in the canvas, e.g. text, image, etc.

    constructor(properties: {
        id: Uint8Array;
        publicKey: PublicSignKey;
        context: string;
        replies: bigint;
        elements: bigint;
        path: Uint8Array[]; // address path
        kind?: LinkKind[]; // ReplyKind, e.g. chat, feed, etc.
        view?: ChildVisualization;
        contents: string[];
    }) {
        this.id = properties.id;
        this.publicKey = properties.publicKey.bytes;
        this.context = properties.context;
        this.replies = properties.replies;
        this.elements = properties.elements;
        this.path = properties.path;
        this.pathDepth = properties.path.length;
        this.kind = properties.kind;
        this.view = properties.view;
        this.contents = properties.contents;
        this.vector = [];
    }

    /*  static async from(
         canvas: Canvas,
         node: ProgramClient,
         args: {
             replicate?: ReplicationOptions;
             replicas?: { min?: number };
         }
     ) {
 
         await canvas.load(node, args)
         const context = await canvas.createContext();
         const replies = await canvas.countReplies();
 
         const elements = await canvas.elements.index
             .iterate(
                 { query: getOwnedElementsQuery(canvas) },
                 { resolve: false }
             )
             .all();
         const visualization = await canvas.getVisualization();
         const hasLayout = await canvas.hasParentLinks();
         const path = canvas.path.map(x => x.path).flat()
         return new IndexableCanvas(
             {
                 id: canvas.id,
                 publicKey: canvas.publicKey,
                 context,
                 replies,
                 hasLayout,
                 path,
                 childrenVisualization:
                     visualization?.view ??
                     ChildVisualization.FEED,
                 contents: elements.map((x) => x.type),
             }
         );
     } */

    static async from(canvas: Canvas): Promise<IndexableCanvas> {
        // Build ancestry via ReplyKind edges (same-scope)
        const pathIds = await getPathIdsForIndex(canvas);

        // Text context
        const context = await canvas.createContext();

        const replies = await countRepliesFast(canvas);

        // Child experience + hasLayout
        const vis = await canvas.getVisualization();
        const childrenVisualization =
            (vis instanceof BasicVisualization ? vis.view : undefined) ??
            ChildVisualization.FEED;

        const allKinds = (await canvas.getParentLinks()).map((x) => x.kind);

        // Content types present on this canvas
        const owned = await canvas.elements.index
            .iterate(
                { query: getOwnedElementsQuery(canvas) },
                { resolve: false }
            )
            .all();

        return new IndexableCanvas({
            id: canvas.id,
            publicKey: canvas.publicKey,
            context,
            replies,
            elements: BigInt(owned.length),
            path: pathIds,
            kind: allKinds,
            view: childrenVisualization,
            contents: [...new Set(owned.map((e) => e.type))],
        });
    }

    private _idString: string;
    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
    }
}
/* 
@variant(0)
export class CanvasAddressReference extends AddressReference {

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
    async load(node: ProgramClient, settingsFrom: Canvas | CanvasArgs | undefined) {
        return this.reference && !this.reference.closed
            ? this.reference
            : (this.reference = settingsFrom && settingsFrom instanceof Canvas ? await settingsFrom.openWithSameSettings(this.canvas) : await node.open<Canvas>(this.canvas, {
                existing: "reuse",
                args: settingsFrom || {
                    replicate: false
                }
            }));
    }

    get address() {
        return this.canvas;
    }
} */

export const getOwnedByCanvasQuery = (to: { id: Uint8Array }) => {
    return [
        new ByteMatchQuery({
            key: "canvasId",
            value: to.id,
        }),
    ];
};

async function getPathIdsForIndex(canvas: Canvas): Promise<Uint8Array[]> {
    const chain = await canvas.loadPath({ includeSelf: false }); // ROOT…PARENT
    return chain.map((c) => c.id);
}

export const getChildrenLinksQuery = (parentId: Uint8Array) =>
    new ByteMatchQuery({ key: ["parent", "canvasId"], value: parentId });
export const getParentLinksQuery = (parentId: Uint8Array) =>
    new ByteMatchQuery({ key: ["child", "canvasId"], value: parentId });

async function ensureOpenedInScope(
    scope: Scope,
    canvas: Canvas
): Promise<Canvas> {
    // Fast path: already initialized against some scope
    if (canvas instanceof Canvas && canvas.initialized) {
        return canvas;
    }
    return scope.openWithSameSettings(canvas);
}

/** Fast deep count: prefer indexed direct count (path), then children aggregate, then BFS. */
async function countRepliesFast(canvas: Canvas): Promise<bigint> {
    // Try direct path-based count (O(1) on index)
    try {
        const n = await canvas.nearestScope.replies.count({
            query: [new ByteMatchQuery({ key: "path", value: canvas.id })],
            approximate: true,
        });
        return BigInt(n);
    } catch {}

    // Fallback: aggregate children’s cached totals (Σ (1 + childDeep))
    try {
        const scope = canvas.nearestScope;
        const edges = await scope.links.index
            .iterate({
                query: [
                    getChildrenLinksQuery(canvas.id),
                    new IntegerCompare({
                        key: ["kind", "tag"],
                        value: 0,
                        compare: Compare.Equal,
                    }), // ReplyKind
                ],
            })
            .all();

        let total = 0n;
        for (const l of edges as Link[]) {
            // Resolve the child canvas across scopes so we can read its own indexed row
            let deep: bigint | number | undefined;
            try {
                const child = await resolveChild(l, scope, {
                    // allow remote resolution with a small timeout to warm non-replicators
                    waitFor: 2000,
                });
                if (child) {
                    const childIndexed = await child.getSelfIndexed();
                    deep = (childIndexed as any)?.__indexed?.replies as
                        | bigint
                        | number
                        | undefined;
                }
            } catch {}

            if (typeof deep === "bigint") total += 1n + deep;
            else if (typeof deep === "number") total += 1n + BigInt(deep);
            else {
                // As a last attempt, count using the current scope’s replies index (may be partial for non-replicators)
                const n = await scope.replies.count({
                    query: [
                        new ByteMatchQuery({
                            key: "path",
                            value: l.child.canvasId,
                        }),
                    ],
                    approximate: true,
                });
                total += 1n + BigInt(n);
            }
        }
        return total;
    } catch {}

    // Last resort: BFS traversal (with loop guards)
    return await canvas.countRepliesBFS({ immediate: false });
}

export const getRepliesQuery = (to: { id: Uint8Array }) => [
    new ByteMatchQuery({ key: "path", value: to.id }),
];

export const getReplyKindQuery = (kind: Constructor<LinkKind>) => {
    let tag = 0;
    if (kind === ReplyKind) {
        tag = 0; // default ReplyKind
    } else if (kind === ViewKind) {
        tag = 1; // ViewKind
    } else {
        /* TODO later else if (kind === BoardViewKind) {
         tag = 2; // BoardViewKind
     } */
        throw new Error(`Unknown kind: ${kind.name}`);
    }
    return new IntegerCompare({
        key: ["kind", "tag"],
        value: tag,
        compare: Compare.Equal,
    });
};

export const getImmediateRepliesQueryByDepth = (
    parentId: Uint8Array,
    parentDepth: number
) => [
    new ByteMatchQuery({ key: "path", value: parentId }),
    new IntegerCompare({
        key: "pathDepth",
        value: parentDepth + 1,
        compare: Compare.Equal,
    }),
];

// If you already fetched the parent indexed doc, you can write:
export const getImmediateRepliesQuery = (
    parentIndexed: WithIndexedContext<Canvas, IndexableCanvas> | IndexableCanvas
) =>
    getImmediateRepliesQueryByDepth(
        parentIndexed.id,
        parentIndexed instanceof IndexableCanvas
            ? parentIndexed.pathDepth
            : parentIndexed.__indexed.pathDepth
    );

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

/** Refresh only the cached replies total on a single canvas’ indexed row. */
async function updateIndexedRepliesOnly(
    scope: Scope,
    canvas: Canvas
): Promise<void> {
    const indexed = await scope.replies.index.get(canvas.id, {
        resolve: false,
        local: true,
        remote: { strategy: "fallback", timeout: 5_000 },
    });
    if (!indexed) return; // not in index yet (e.g. parent still building); skip

    const total = await countRepliesFast(canvas);
    (indexed as IndexableCanvas).replies = total;

    // write through the index (keep __context)
    const wrapped = new scope.replies.index.wrappedIndexedType(
        indexed,
        indexed.__context
    );
    await scope.replies.index.index.put(wrapped);
}

export const loadCanvasFromScopes = async (
    id: Uint8Array,
    scopes: Scope[],
    options?: { local?: boolean }
): Promise<Canvas | undefined> => {
    let first = await Promise.any(
        scopes.map((scope) =>
            scope.replies.index
                .get(id, {
                    waitFor: 5e3,
                    resolve: true,
                    local: options?.local ?? true,
                    remote: { eager: true, strategy: "fallback", timeout: 1e4 },
                })
                .then((x) => {
                    return { canvas: x, scope };
                })
        )
    );

    if (first) {
        return first.scope.openWithSameSettings(first.canvas);
    }
    return undefined;
};

/** Ensure a canvas is registered in target scope's replies. */
async function ensureInReplies(scope: Scope, c: Canvas): Promise<boolean> {
    const existed = await scope.replies.index.get(c.id, {
        resolve: false,
        local: true,
        remote: false,
    });
    if (!existed) {
        await scope.replies.put(c);
        return true;
    }
    return false;
}

type Visibility = "child" | "both";

type PublishBase = {
    visibility?: Visibility; // default "both"
    kind?: LinkKind; // default new ReplyKind()
    view?: ChildVisualization; // optional child experience
    parent?: Canvas; // if provided, we will link under this parent
    debug?: boolean; // default: false
};

type LinkOnly = { type: "link-only" } & PublishBase;
type Sync = {
    type: "sync";
    targetScope?: Scope; // default: parent.nearestScope or this scope
    updateHome?: "keep" | "set"; // default: "keep"
    deferCleanup?: boolean; // if true, old-home cleanup runs after finalize instead of inline
} & PublishBase;
type Fork = {
    type: "fork";
    targetScope?: Scope; // default: parent.nearestScope or this scope
    id?: "preserve" | "new"; // default: "new"
    updateHome?: "keep" | "set"; // default: "keep"
} & PublishBase;

type Publish = LinkOnly | Sync | Fork;

/** Extract scope addresses referenced by a NodeRef; LocalRef belongs to `fallback`. */
const refScopes = (r: NodeRef, fallback: string): string[] =>
    r instanceof ScopedRef ? [r.scope.address] : [fallback];

/** BFS over scopes to collect *every scope that stores* the (parent → child) link. */
export async function collectLinkScopesBFS(
    parent: Canvas,
    child: Canvas,
    extraSeeds?: Scope[]
): Promise<Scope[]> {
    const client = parent.nearestScope.node;
    const seeds = new Set<string>();
    seeds.add(parent.nearestScope.address);
    if (child.selfScope) seeds.add(child.selfScope.address);
    (extraSeeds ?? []).forEach((s) => seeds.add(s.address));

    const visited = new Set<string>();
    const q: string[] = [...seeds];
    const out: Scope[] = [];

    while (q.length) {
        const addr = q.shift()!;
        if (visited.has(addr)) continue;
        visited.add(addr);

        const scope = await client.open<Scope>(addr, {
            existing: "reuse",
            args: parent.nearestScope.openingArgs,
        });

        const links = (await scope.links.index
            .iterate({
                query: [
                    getChildrenLinksQuery(parent.id),
                    getParentLinksQuery(child.id),
                ],
            })
            .all()) as Link[];

        if (links.length) {
            out.push(scope);
            for (const l of links) {
                for (const next of [
                    ...refScopes(l.parent, addr),
                    ...refScopes(l.child, addr),
                ]) {
                    if (!visited.has(next)) q.push(next);
                }
            }
        }
    }

    const seen = new Set<string>();
    return out.filter((s) =>
        seen.has(s.address) ? false : (seen.add(s.address), true)
    );
}

/** Discover *all parents* of `child` by scanning reachable scopes (BFS on NodeRefs). */
export async function collectParentsBFS(
    child: Canvas,
    extraSeeds?: Scope[]
): Promise<Canvas[]> {
    const client = child.nearestScope.node;
    const seeds = new Set<string>();
    seeds.add(child.nearestScope.address);
    if (extraSeeds) extraSeeds.forEach((s) => seeds.add(s.address));

    const visited = new Set<string>();
    const q: string[] = [...seeds];
    const parents: Canvas[] = [];

    while (q.length) {
        const addr = q.shift()!;
        if (visited.has(addr)) continue;
        visited.add(addr);

        const scope = await client.open<Scope>(addr, {
            existing: "reuse",
            args: child.nearestScope.openingArgs,
        });

        // Links where this child appears as the child end
        const links = (await scope.links.index
            .iterate({
                query: [getParentLinksQuery(child.id)],
            })
            .all()) as Link[];

        for (const l of links) {
            const parent = await resolveParent(l, scope);
            if (parent) parents.push(parent);
            // Follow NodeRef scopes so we converge
            for (const next of [
                ...refScopes(l.parent, addr),
                ...refScopes(l.child, addr),
            ]) {
                if (!visited.has(next)) q.push(next);
            }
        }
    }

    // de-dupe parents
    const seen = new Set<string>();
    return parents.filter((p) =>
        seen.has(p.idString) ? false : (seen.add(p.idString), true)
    );
}

type LinkVisibility = "both" | "child";

async function addReply(
    this: Canvas,
    child: Canvas,
    kind: LinkKind = new ReplyKind(),
    visibility: LinkVisibility = "both"
): Promise<void> {
    const parentScope = this.nearestScope;
    const childScope = child.nearestScope;

    const { child: childRef, parent: parentRef } = buildRefLink(this, child);
    const linkId = Link.createId(parentRef, childRef, kind.tag);

    // ground truth in CHILD scope
    if (
        !(await childScope.links.index.get(linkId, {
            resolve: false,
            local: true,
        }))
    ) {
        await childScope.links.put(
            new Link({ id: linkId, parent: parentRef, child: childRef, kind })
        );
    }

    // optional mirror in PARENT scope
    if (visibility === "both") {
        if (
            !(await parentScope.links.index.get(linkId, {
                resolve: false,
                local: true,
            }))
        ) {
            await parentScope.links.put(
                new Link({
                    id: linkId,
                    parent: parentRef,
                    child: childRef,
                    kind,
                })
            );
        }
    }
}

async function* iterLinksOverScopes(
    scopes: Scope[],
    q: Query[]
): AsyncGenerator<Link> {
    for (const s of scopes) {
        const links = (await s.links.index
            .iterate({ query: q })
            .all()) as Link[];
        for (const l of links) yield l;
    }
}

async function* iterLinksWithOrigin(
    scopes: Scope[],
    query: Query[]
): AsyncGenerator<{ link: Link; scope: Scope }> {
    for (const s of scopes) {
        const links = (await s.links.index.iterate({ query }).all()) as Link[];
        for (const l of links) yield { link: l, scope: s };
    }
}

async function deleteLinksInScope(
    scope: Scope,
    parentId: Uint8Array,
    childId: Uint8Array,
    shouldDelete: (l: Link) => boolean
): Promise<void> {
    const links = (await scope.links.index
        .iterate({
            query: [
                getChildrenLinksQuery(parentId),
                getParentLinksQuery(childId),
            ],
        })
        .all()) as Link[];

    for (const l of links) {
        if (shouldDelete(l)) {
            await scope.links.del(l.id);
        }
    }
}

// --- unified remover ---
type UnlinkKind = "reply" | "view" | "all";
const isReply = (l: Link) => l.kind instanceof ReplyKind;
const isView = (l: Link) => l.kind instanceof ViewKind;
const anyKind = (_: Link) => true;

async function unlink(
    this: Canvas,
    childId: Uint8Array,
    options?: {
        kinds?: UnlinkKind | UnlinkKind[]; // default: "all"
        scopes?: Scope[]; // mirrors to clean (default: [parentScope])
        strict?: boolean; // if true, don't fallback to parentScope.replies
    }
): Promise<void> {
    const parentScope = this.nearestScope;
    const mirrorScopes = options?.scopes?.length
        ? options.scopes
        : [parentScope];

    // normalize kinds → predicate
    const ks = Array.isArray(options?.kinds)
        ? options!.kinds
        : [options?.kinds ?? "all"];
    const shouldDelete: (l: Link) => boolean = ks.includes("all")
        ? anyKind
        : (l) =>
              (ks.includes("reply") && isReply(l)) ||
              (ks.includes("view") && isView(l));

    // 1) remove mirrors first (parent + any extra scopes)
    for (const s of mirrorScopes) {
        await deleteLinksInScope(s, this.id, childId, shouldDelete);
    }

    // 2) remove canonical link(s) in CHILD's scope
    // Try to resolve child via any mirror link (ScopedRef-aware)
    let childCanvas: Canvas | undefined;
    for await (const { link, scope } of iterLinksWithOrigin(mirrorScopes, [
        getChildrenLinksQuery(this.id),
        getParentLinksQuery(childId),
    ])) {
        const maybeChild = await resolveChild(link, scope);
        if (maybeChild) {
            childCanvas = maybeChild;
            break;
        }
    }

    // Optional fallback if no mirrors present or strict privacy
    if (!childCanvas && options?.strict !== true) {
        const fallback = await parentScope.replies.index.get(childId, {
            resolve: true,
        });
        if (fallback) childCanvas = fallback;
    }

    if (childCanvas) {
        const childScope = childCanvas.nearestScope;
        await deleteLinksInScope(childScope, this.id, childId, shouldDelete);
    }
}

/** Copy ALL owned elements from src→dst (across scopes), preserving IDs. */
async function copyElementsBetweenScopes(
    from: Scope,
    to: Scope,
    src: Canvas,
    dst: Canvas,
    opts?: { debug?: boolean }
): Promise<void> {
    const debug = !!opts?.debug;
    const dlog = (...args: any[]) => {
        if (debug) console.debug("[copyElementsBetweenScopes]", ...args);
    };
    const collect = globalThis.__COLLECT_REINDEX;
    const perf = globalThis.__PERF_EVENTS__;
    const t0 = collect ? Date.now() : 0;

    // gather source elements
    const srcEls = await from.elements.index
        .iterate({ query: getOwnedByCanvasQuery(src) }, { resolve: true })
        .all();

    // existing owned elements in destination (by idString)
    const existingAtDest = await to.elements.index
        .iterate({ query: getOwnedByCanvasQuery(dst) }, { resolve: false })
        .all();
    const existingIds = new Set(existingAtDest.map((e) => e.idString));

    dlog("begin", {
        from: from.address,
        to: to.address,
        src: src.idString,
        dst: dst.idString,
        srcCount: srcEls.length,
        destOwnedPre: existingAtDest.length,
    });

    let created = 0;
    let updated = 0;

    await Promise.all(
        srcEls.map(async (e) => {
            const existed = existingIds.has(e.idString);
            if (existed) updated++;
            else created++;
            const elStart = collect ? Date.now() : 0;
            await to.elements.put(
                new Element({
                    id: e.id, // preserve id for "sync"
                    publicKey: to.node.identity.publicKey,
                    canvasId: dst.id,
                    location: e.location,
                    content: e.content,
                })
            );
            if (collect && perf) {
                perf.push({
                    type: "copy:element",
                    canvas: dst.idString,
                    ms: Date.now() - elStart,
                });
            }
        })
    );

    if (debug) {
        const after = await to.elements.index
            .iterate({ query: getOwnedByCanvasQuery(dst) }, { resolve: false })
            .all();
        dlog("end", {
            destOwnedPost: after.length,
            created,
            updated,
            delta: after.length - existingAtDest.length,
        });
    }
    if (collect && perf) {
        perf.push({
            type: "copy:summary",
            canvas: dst.idString,
            created,
            updated,
            total: srcEls.length,
            ms: Date.now() - t0,
        });
    }
}

/** Copy visualization (if any) from src→dst (across scopes). */
async function copyVisualizationBetweenScopes(
    from: Scope,
    to: Scope,
    src: Canvas,
    dst: Canvas,
    opts?: { debug?: boolean }
): Promise<void> {
    const debug = !!opts?.debug;
    const dlog = (...args: any[]) => {
        if (debug) console.debug("[copyVisualizationBetweenScopes]", ...args);
    };

    const viz = await from.getVisualization(src).catch(() => null);
    dlog("begin", {
        from: from.address,
        to: to.address,
        src: src.idString,
        dst: dst.idString,
        hasViz: !!viz,
    });
    if (!viz) return;

    await to.setVisualization(
        dst,
        new BasicVisualization({
            canvasId: dst.id,
            background: viz.background,
            palette: viz.palette,
            showAuthorInfo: viz.showAuthorInfo,
            previewHeight: viz.previewHeight,
            font: viz.font,
            view: viz.view,
        })
    );

    dlog("end: visualization upserted in dest");
}

// helpers (drop these near copyElementsBetweenScopes)
async function deleteOwnedElementsInScope(scope: Scope, canvas: Canvas) {
    const collect = globalThis.__COLLECT_REINDEX;
    const perf = globalThis.__PERF_EVENTS__;
    const t0 = collect ? Date.now() : 0;
    const els = await scope.elements.index
        .iterate({ query: getOwnedElementsQuery(canvas) }, { resolve: false })
        .all();
    await Promise.all(els.map((e) => scope.elements.del(e.id)));
    if (collect && perf) {
        perf.push({
            type: "cleanup:elements",
            canvas: canvas.idString,
            count: els.length,
            ms: Date.now() - t0,
        });
    }
}

async function deleteVisualizationsInScope(scope: Scope, canvas: Canvas) {
    const collect = globalThis.__COLLECT_REINDEX;
    const perf = globalThis.__PERF_EVENTS__;
    const t0 = collect ? Date.now() : 0;
    const vizz = await scope.visualizations.index
        .iterate({ query: { canvasId: canvas.id } }, { resolve: false })
        .all();
    await Promise.all(vizz.map((v) => scope.visualizations.del(v.id)));
    if (collect && perf) {
        perf.push({
            type: "cleanup:visualizations",
            canvas: canvas.idString,
            count: vizz.length,
            ms: Date.now() - t0,
        });
    }
}

/** Remove any links that reference `canvas` as a child inside `scope`. */
async function deleteChildLinksForCanvasInScope(scope: Scope, canvas: Canvas) {
    const collect = globalThis.__COLLECT_REINDEX;
    const perf = globalThis.__PERF_EVENTS__;
    const t0 = collect ? Date.now() : 0;
    const links = (await scope.links.index
        .iterate({ query: [getParentLinksQuery(canvas.id)] })
        .all()) as Link[];
    await Promise.all(links.map((l) => scope.links.del(l.id)));
    if (collect && perf) {
        perf.push({
            type: "cleanup:childLinks",
            canvas: canvas.idString,
            count: links.length,
            ms: Date.now() - t0,
        });
    }
}

export abstract class CanvasMessage {}

@variant(0)
export class ReplyingInProgresss extends CanvasMessage {
    @field({ type: Uint8Array })
    reference: Uint8Array;

    constructor(properties: { reference: Uint8Array | Canvas }) {
        super();
        this.reference =
            properties.reference instanceof Uint8Array
                ? properties.reference
                : properties.reference.id;
    }
}

@variant(1)
export class ReplyingNoLongerInProgresss extends CanvasMessage {
    @field({ type: Uint8Array })
    reference: Uint8Array;

    constructor(properties: { reference: Uint8Array | Canvas }) {
        super();
        this.reference =
            properties.reference instanceof Uint8Array
                ? properties.reference
                : properties.reference.id;
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
    @field({ type: AddressReference })
    ref: AddressReference;

    constructor(props: CanvasBackground) {
        super();
        this.ref = props.ref;
    }
}

/* @variant(0)
export class Mode {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: fixedArray("u8", 32) })
    canvasId: Uint8Array;

    @field({ type: ModeType })
    type: ModeType;

    constructor(props: {
        id?: Uint8Array;
        canvasId: Uint8Array;
        type: ModeType;
    }) {
        this.id = props.id || randomBytes(32);
        this.canvasId = props.canvasId;
        this.type = props.type;
        if (
            !(this.type instanceof Narrative) &&
            !(this.type instanceof Page)
        ) {
            throw new Error("Invalid purpose type");
        }
    }
}

@variant(0)
export class IndexedPurpose {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: fixedArray("u8", 32) })
    canvasId: Uint8Array;

    @field({ type: "u8" })
    type: PurposeTypeEnum;

    constructor(props: Mode) {
        this.id = props.id;
        this.canvasId = props.canvasId;
        this.type =
            props.type instanceof Narrative
                ? PurposeTypeEnum.NARRATIVE
                : PurposeTypeEnum.PAGE;
    }
} */

export type BackGroundTypes = StyledBackground | CanvasBackground;

export abstract class Visualization {
    id: Uint8Array;
    canvasId: Uint8Array;
}

@variant(0)
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

export enum ChildVisualization {
    FEED = 0,
    OUTLINE = 1,
    EXPLORE = 2,
    CHAT = 3,
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

    @field({ type: option("u8") })
    view?: ChildVisualization;

    constructor(props: {
        id?: Uint8Array;
        canvasId: Uint8Array;
        background?: ModedBackground;
        palette?: ModedThemePalette;
        showAuthorInfo?: boolean;
        previewHeight?: string;
        font?: string;
        view?: ChildVisualization;
    }) {
        this.id = props?.id || randomBytes(32);
        this.canvasId = props.canvasId;
        this.background = props?.background;
        this.palette = props?.palette;
        this.showAuthorInfo = props?.showAuthorInfo ?? true;
        this.previewHeight = props?.previewHeight;
        this.font = props?.font;
        this.view = props?.view;
    }
}

export type ScopeArgs = {
    debug?: boolean;
    replicate?: ReplicationOptions;
    replicas?: { min?: number };
    experimentalHierarchicalReindex?: boolean; // feature flag
};

/* ---------------------------------------------------------
 * The edge that lives * inside the parent * and describes
 * how one child should appear under that parent.
 * --------------------------------------------------------- */

export abstract class NodeRef {
    abstract get canvasId(): Uint8Array;
}

@variant(0)
export class LocalRef extends NodeRef {
    @field({ type: fixedArray("u8", 32) }) canvasId: Uint8Array; // same scope as the link store
    constructor(p: { canvasId: Uint8Array }) {
        super();
        this.canvasId = p.canvasId;
    }
}

@variant(1)
export class ScopedRef extends NodeRef {
    @field({ type: AddressReference }) scope: AddressReference;
    @field({ type: fixedArray("u8", 32) }) canvasId: Uint8Array;
    constructor(p: { scope: string | Scope; id: Uint8Array }) {
        super();
        this.scope =
            p.scope instanceof Scope
                ? new AddressReference({ address: p.scope.address })
                : new AddressReference({ address: p.scope });
        this.canvasId = p.id;
    }
}

async function resolveRef(
    ref: NodeRef,
    defaultScope: Scope,
    args?: ScopeArgs,
    resolveOptions?: ResolveOptions
): Promise<WithIndexedContext<Canvas, IndexableCanvas> | null> {
    if (ref instanceof LocalRef) {
        return defaultScope.replies.index.get(ref.canvasId, {
            resolve: true,
            waitFor: 5e3,
            ...resolveOptions,
        });
    } else if (ref instanceof ScopedRef) {
        const scope = await defaultScope.node.open<Scope>(ref.scope.address, {
            existing: "reuse",
            args,
        });
        return scope.replies.index.get(ref.canvasId, {
            resolve: true,
            waitFor: 5e3,
            ...resolveOptions,
        });
    } else {
        throw new Error("Unknown NodeRef type: " + ref?.constructor.name);
    }
}

type ResolveOptions = { local?: boolean; remote?: boolean; waitFor?: number };
export async function resolveParent(
    link: Link,
    baseScope: Scope,
    options?: ResolveOptions
) {
    return resolveRef(link.parent, baseScope, baseScope.openingArgs, options);
}

export async function resolveChild(
    link: Link,
    baseScope: Scope,
    options?: ResolveOptions
) {
    return resolveRef(link.child, baseScope, baseScope.openingArgs, options);
}

const buildRefLink = (parent: Canvas, child: Canvas) => {
    const parentScope = parent.nearestScope;
    const childScope = child.nearestScope;
    const sameScope = parentScope.address === childScope.address;
    const parentRef: NodeRef = sameScope
        ? new LocalRef({ canvasId: parent.id })
        : new ScopedRef({ id: parent.id, scope: parentScope.address });

    const childRef: NodeRef = sameScope
        ? new LocalRef({ canvasId: child.id })
        : new ScopedRef({ id: child.id, scope: childScope.address });

    return {
        parent: parentRef,
        child: childRef,
    };
};

@variant(0)
export class Link<TKind extends LinkKind = LinkKind> {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: NodeRef })
    parent: NodeRef;

    @field({ type: NodeRef })
    child: NodeRef;

    @field({ type: LinkKind })
    kind: TKind;

    constructor(props: {
        id?: Uint8Array;
        parent: NodeRef;
        child: NodeRef;
        kind: TKind;
    }) {
        this.id =
            props.id ||
            Link.createId(props.parent, props.child, props.kind.tag);
        this.parent = props.parent;
        this.child = props.child;
        this.kind = props.kind;
    }

    static createId(parent: NodeRef, child: NodeRef, tag: number) {
        const enc = (r: NodeRef) =>
            r instanceof ScopedRef
                ? concat([
                      new TextEncoder().encode(r.scope.address),
                      r.canvasId,
                  ])
                : (r as LocalRef).canvasId;
        return sha256Sync(
            concat([new Uint8Array([tag]), enc(parent), enc(child)])
        );
    }

    private _idString: string;
    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
    }
}

const reIndexRepliesInParents = async (scope: Scope, canvas: Canvas) => {
    const opened = await ensureOpenedInScope(scope, canvas);

    const loadedPath = await opened.loadPath({ includeSelf: false });
    // Reindex only the immediate parent replies, and defer it out of the current frame
    const parent = loadedPath.length
        ? loadedPath[loadedPath.length - 1]
        : undefined;
    if (parent) {
        globalThis.setTimeout?.(() => {
            scope
                ._hierarchicalReindex!.add({
                    canvas: parent,
                    options: { onlyReplies: true, skipAncestors: true },
                    propagateParents: false,
                })
                .catch(() => {});
        }, 0);
    }
};

/** Generic “change → reindex” listener.
 *  - resolveIds: which canvas IDs are affected by a changed doc
 *  - mode: whether to reindex full rows or only replies (cached totals)
 *  - alsoParents: whether to propagate onlyReplies up the ancestor chain
 */
function makeReindexListener<T, I>(
    scope: Scope,
    resolveIds: (doc: T) => Uint8Array[],
    opts?: {
        onlyReplies?: boolean;
        alsoParents?: boolean;
        skipAncestors?: boolean;
    }
) {
    return async (evt: CustomEvent<DocumentsChange<T, I>>) => {
        // handle added + removed symmetrically
        const changed = [...evt.detail.added, ...evt.detail.removed];

        for (const doc of changed) {
            const ids = resolveIds(doc);
            for (const id of ids) {
                const canvas = await scope.replies.index.get(id);
                if (!canvas) continue;

                // 1) reindex the canvas itself; reIndex will update ancestors
                await scope._hierarchicalReindex!.add({
                    canvas,
                    options: opts?.onlyReplies
                        ? {
                              onlyReplies: true,
                              skipAncestors: opts?.skipAncestors,
                          }
                        : { skipAncestors: opts?.skipAncestors },
                    propagateParents: false,
                });
            }
        }
    };
}

/* export async function assignNewParent(
    child: Canvas,
    parent: Canvas
): Promise<void> {

    const parentPath = [...parent.path]
    let last = parentPath[parentPath.length - 1];
    if (last && last.scope.address === parent.forwardScope.address) {
        last.path.push(child.id);
    } else {
        parentPath.push(new PathWithScope({ path: [child.id], scope: parent.forwardScope }))
    }
    child.path = parentPath;
    await child.loadScopes(parent.node, parent.forwardScope.openingArgs)
    // `maybeSave` is protected/private; call the public save directly.
}

export function cloneSkeletonForParent(
    src: Canvas,
    intoParent: Canvas,
    opts?: { id?: Uint8Array }
): Canvas {
    // 1️⃣ use the forced / pre-reserved id if provided
    const forcedId = opts?.id;

    // 2️⃣ nothing to change if src already sits under the intended parent
    if (
        !forcedId &&
        src.lastPathCanvas && equals(src.lastPathCanvas, intoParent.id)
    ) {
        return deserialize(serialize(src), Canvas);
    }

    // 3️⃣ decide which id to stamp on the clone
    const newId = forcedId ?? randomBytes(32);

    return new Canvas({
        id: newId,
        parent: intoParent,
        publicKey: src.publicKey,
    });
} */

@variant("scope")
export class Scope extends Program<ScopeArgs> {
    @id({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: Documents })
    elements: Documents<Element, IndexableElement>; // Elements are either data points or sub-canvases (comments)

    @field({ type: Documents })
    replies: Documents<Canvas, IndexableCanvas>; // Replies or Sub Replies

    /* @field({ type: Documents }) // TODO don't make this affeect the address?
    private _types: Documents<Mode, IndexedPurpose>; */

    @field({ type: Documents })
    links!: Documents<Link, Link>;

    @field({ type: Documents }) // TODO don't make this affeect the address?
    visualizations: Documents<Visualization, IndexedVisualization>;

    @field({ type: RPC })
    messages: RPC<CanvasMessage, CanvasMessage>;

    @field({ type: "u8" })
    acl: 0; // TODO

    constructor(properties: {
        publicKey: PublicSignKey;
        id?: Uint8Array;
        seed?: Uint8Array;
    }) {
        super();
        this.publicKey = properties.publicKey;
        const elementsId =
            properties.id ||
            ((properties as { seed: Uint8Array }).seed
                ? sha256Sync((properties as { seed: Uint8Array }).seed)
                : randomBytes(32));
        this.id = elementsId;
        this.elements = new Documents({ id: elementsId });
        this.replies = new Documents({ id: sha256Sync(elementsId) });

        this.visualizations = new Documents({
            id: sha256Sync(sha256Sync(elementsId)),
        });

        this.links = new Documents({
            id: sha256Sync(sha256Sync(sha256Sync(elementsId))),
        });

        /*  this._types = new Documents({
             id: sha256Sync(sha256Sync(sha256Sync(elementsId))),
         }); */

        this.messages = new RPC();
        this.acl = 0;
        this._suppressReindexCount = 0;
    }

    private _idString: string;
    get idString() {
        return this._idString || (this._idString = sha256Base64Sync(this.id));
    }

    private _repliesChangeListener: (
        evt: CustomEvent<DocumentsChange<Canvas, IndexableCanvas>>
    ) => void;

    private _visalizationChangeListener: (
        evt: CustomEvent<DocumentsChange<Visualization, IndexedVisualization>>
    ) => void;

    private _linksChangeListener: (
        evt: CustomEvent<DocumentsChange<Link, Link>>
    ) => void;

    private _elementsChangeListener: (
        evt: CustomEvent<DocumentsChange<Element, IndexableElement>>
    ) => void;
    /*  private _typeChangeListener: (
         evt: CustomEvent<DocumentsChange<Mode, IndexedPurpose>>
     ) => void; */

    private getValueWithContext(value: string) {
        return this.address + ":" + value;
    }

    // Reindex suppression to coalesce heavy operations (e.g., during publish)
    private _suppressReindexCount: number;
    get isReindexSuppressed(): boolean {
        return (this._suppressReindexCount || 0) > 0;
    }
    async suppressReindex<T>(fn: () => Promise<T>): Promise<T> {
        this._suppressReindexCount++;
        try {
            try {
                globalThis.window?.dispatchEvent?.(
                    new CustomEvent("reindex:debug", {
                        detail: {
                            phase: "suppress:enter",
                            scope: this.address,
                        },
                    })
                );
            } catch {}
            return await fn();
        } finally {
            this._suppressReindexCount = Math.max(
                0,
                this._suppressReindexCount - 1
            );
            try {
                globalThis.window?.dispatchEvent?.(
                    new CustomEvent("reindex:debug", {
                        detail: { phase: "suppress:exit", scope: this.address },
                    })
                );
            } catch {}
        }
    }

    public debug: boolean = false;
    private closeController: AbortController | null = null;
    // Deduplicate transient missing-resolution logs per link/side
    private _missingResolveOnce = new Set<string>();
    // reIndexDebouncer removed; replaced by per-canvas hierarchical scheduler
    _hierarchicalReindex?: ReturnType<
        typeof createHierarchicalReindexManager<Canvas>
    >; // experimental feature flag

    openingArgs?: ScopeArgs;
    async open(args?: ScopeArgs): Promise<void> {
        this.openingArgs = args;
        // Lightweight dispatcher accessible for run-level instrumentation
        const _dispatchReindexDebug = (detail: any) => {
            try {
                globalThis.window?.dispatchEvent?.(
                    new CustomEvent("reindex:debug", { detail })
                );
            } catch {}
        };
        this._hierarchicalReindex = createHierarchicalReindexManager<Canvas>({
            // Allow test-mode with virtually no debounce/cooldown (REINDEX_NO_DELAY=1)
            // Use a function so tests can opt-in (REINDEX_NO_DELAY or VITEST/NODE_ENV=test)
            delay: () => {
                // Slightly larger delay to further fuse bursts
                return 120;
            },
            reindex: async (canvas, opts) => {
                try {
                    await this.reIndex(canvas, opts);
                } catch (error) {
                    if (isClosedError(error)) {
                        // swallow
                    } else {
                        throw error;
                    }
                }
            },
            propagateParentsDefault: true,
            onDebug: (evt) => _dispatchReindexDebug(evt),
            // Add a small cooldown to coalesce rapid consecutive schedules
            cooldownMs: 150,
            adaptiveCooldownMinMs: 50,
        });

        this.closeController = new AbortController();
        this.debug = !!args?.debug;
        this.debug && console.time(this.getValueWithContext("openElements"));

        await this.elements.open({
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
                    // Use real content for indexing (previous stub returned constant 'x')
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
        this.debug && console.timeEnd(this.getValueWithContext("openElements"));
        this.debug && console.time(this.getValueWithContext("openReplies"));

        /*  await this._types.open({
             type: Mode,
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
                 type: IndexedPurpose,
             },
             canPerform: async (operation) => {
              
                 return true;
             },
         }); */

        await this.visualizations.open({
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

        await this.links.open({
            type: Link,
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
                type: Link,
            },
            canPerform: async (operation) => {
                /**
                 * Only allow updates if we created it
                 *  or from myself (this allows us to modifying someone elsecanvas locally)
                 */
                return true;
            },
        });
        await this.replies.open({
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
                    if (!arg.initialized) {
                        await arg.load(this.node, {
                            args: {
                                replicate: args?.replicate,
                                replicas: args?.replicas,
                            },
                        });
                    }

                    return IndexableCanvas.from(arg);
                },
            },
        });
        this.debug && console.timeEnd(this.getValueWithContext("openReplies"));

        await this.messages.open({
            responseType: CanvasMessage,
            queryType: CanvasMessage,
            topic: sha256Base64Sync(
                concat([this.id, new TextEncoder().encode("messages")])
            ),
            responseHandler: async () => {}, // need an empty response handle to make response events to emit TODO fix this?
        });
    }

    async getVisualization(canvas: {
        id: Uint8Array;
    }): Promise<WithIndexedContext<
        BasicVisualization,
        IndexedVisualization
    > | null> {
        // Tolerant read: if multiple rows exist (from older clients), prefer the canonical id and GC extras.
        const list = (await this.visualizations.index
            .iterate({
                query: {
                    canvasId: canvas.id,
                },
            })
            .all()) as WithIndexedContext<
            BasicVisualization,
            IndexedVisualization
        >[];

        if (!list.length) return null;

        const canonicalId = sha256Sync(
            concat([new Uint8Array([0x56, 0x49, 0x5a]), canvas.id]) // "VIZ" prefix
        );

        // Prefer the one that matches our canonical scheme
        let preferred = list.find((v) => equals(v.id, canonicalId)) ?? list[0];

        // Best-effort cleanup of duplicates
        if (list.length > 1) {
            for (const v of list) {
                if (!equals(v.id, preferred.id)) {
                    try {
                        await this.visualizations.del(v.id);
                    } catch {}
                }
            }
        }

        return preferred;
    }

    /* 
    // Tolerant read: if multiple rows exist (from older clients), prefer the canonical id and GC extras.
        const list = (await this.visualizations.index
            .iterate({
                query: {
                    canvasId: canvas.id,
                },
            })
            .all()) as WithIndexedContext<
            BasicVisualization,
            IndexedVisualization
        >[];

        if (!list.length) return null;

        const canonicalId = sha256Sync(
            concat([new Uint8Array([0x56, 0x49, 0x5a]), canvas.id]) // "VIZ" prefix
        );

        // Prefer the one that matches our canonical scheme
        let preferred = list.find((v) => equals(v.id, canonicalId)) ?? list[0];

        // Best-effort cleanup of duplicates
        if (list.length > 1) {
            for (const v of list) {
                if (!equals(v.id, preferred.id)) {
                    try {
                        await this.visualizations.del(v.id);
                    } catch {}
                }
            }
        }

        return preferred;
        */

    async publish(
        this: Scope,
        child: Canvas,
        publish: Publish = { type: "link-only" }
    ): Promise<[created: boolean, result: Canvas]> {
        const debug = !!publish.debug;
        const dlog = (...args: any[]) => {
            if (debug) console.debug("[Scope.publish]", ...args);
        };
        // Inline perf markers (only when debug flag passed)
        type PerfMark = { name: string; t: number };
        const perfMarks: PerfMark[] | null = debug ? [] : null;
        const perfZero = debug ? Date.now() : 0;
        const mark = (label: string) => {
            if (!perfMarks) return;
            // If debug adds a trailing time suffix like ":123ms", strip only that suffix.
            // Preserve semantic prefixes like "sync:lookupExisting".
            const base = String(label).replace(/:\d+ms$/, "");
            perfMarks.push({ name: base, t: Date.now() - perfZero });
        };
        mark("start");

        // Ensure every canvas has a home
        if (!child.selfScope) {
            dlog("assigning selfScope to caller scope", {
                scope: this.address,
                child: child.idString,
            });
            child.selfScope = new AddressReference({ address: this.address });
        }

        // Load the source in its own home settings
        const src = child.initialized
            ? child
            : await this.openWithSameSettings(child);
        const srcHome = src.nearestScope;

        dlog("start", {
            srcId: src.idString,
            srcHome: srcHome.address,
            callerScope: this.address,
            parentProvided: !!publish.parent,
            type: publish.type,
        });

        // Defaults
        const visibility: Visibility = publish.visibility ?? "both";
        const kind: LinkKind = publish.kind ?? new ReplyKind();

        // Used for defaults when a targetScope isn’t passed
        const defaultDestScope: Scope = publish.parent?.nearestScope ?? this;

        // Finalize: optional link under parent, optional set view, flush
        const finalize = async (dst: Canvas) => {
            if (publish.parent) {
                dlog("finalize: addReply", {
                    parent: publish.parent.idString,
                    parentScope: publish.parent.nearestScope.address,
                    child: dst.idString,
                    childScope: dst.nearestScope.address,
                    visibility,
                    kind: (kind as any).constructor?.name,
                    view: publish.view,
                });
                const parentScope = publish.parent!.nearestScope;
                await parentScope.suppressReindex(async () => {
                    await publish.parent!.addReply(dst, kind, visibility);
                });
                // Note: do not add a replies row in the parent's scope; the canonical row
                // lives in the child's home scope. Parent-side visibility is derived via links.

                if (publish.view != null) {
                    dlog("finalize: setExperience", {
                        child: dst.idString,
                        view: publish.view,
                    });
                    await dst.nearestScope.suppressReindex(async () => {
                        await dst.setExperience(publish.view!, {
                            scope: dst.nearestScope,
                        });
                    });
                }

                // Targeted flush: only ensure the child's indexes are current.
                // Do not force a reindex flush inline; allow manager to coalesce
                // Parent-side indexes will converge via link listeners; no explicit flush needed here.

                // Schedule child full reindex without ancestor refresh
                // Defer child full reindex so content can appear before heavy work
                try {
                    const child = dst;
                    const scopeRef = dst.nearestScope; // capture now while loaded
                    const ms =
                        typeof process !== "undefined" && process?.env?.VITEST
                            ? 0
                            : 300;
                    globalThis.setTimeout?.(() => {
                        try {
                            scopeRef
                                ._hierarchicalReindex!.add({
                                    canvas: child,
                                    options: {
                                        onlyReplies: false,
                                        skipAncestors: true,
                                    },
                                })
                                .catch(() => {});
                        } catch {}
                    }, ms);
                } catch {}

                // Defer parent replies-only refresh
                try {
                    const parent = publish.parent!;
                    globalThis.setTimeout?.(() => {
                        parent.nearestScope
                            ._hierarchicalReindex!.add({
                                canvas: parent,
                                options: {
                                    onlyReplies: true,
                                    skipAncestors: true,
                                },
                            })
                            .catch(() => {});
                    }, 0);
                } catch {}
            } else {
                if (publish.view != null) {
                    dlog("finalize: top-level setExperience", {
                        child: dst.idString,
                        view: publish.view,
                    });
                    await dst.nearestScope.suppressReindex(async () => {
                        await dst.setExperience(publish.view!, {
                            scope: dst.nearestScope,
                        });
                    });
                    // Targeted flush for the child only
                    // Do not force a reindex flush inline; allow manager to coalesce
                    try {
                        const child = dst;
                        const scopeRef = dst.nearestScope;
                        const ms =
                            typeof process !== "undefined" &&
                            process?.env?.VITEST
                                ? 0
                                : 300;
                        globalThis.setTimeout?.(() => {
                            try {
                                scopeRef
                                    ._hierarchicalReindex!.add({
                                        canvas: child,
                                        options: {
                                            onlyReplies: false,
                                            skipAncestors: true,
                                        },
                                    })
                                    .catch(() => {});
                            } catch {}
                        }, ms);
                    } catch {}
                }
            }
        };

        // --------- link-only (no data movement) ----------
        if (publish.type === "link-only") {
            dlog("mode=link-only: ensure home row, then finalize");
            await ensureInReplies(srcHome, src);
            await srcHome.openWithSameSettings(src);
            mark("link-only:ensure+open");
            await finalize(src);
            dlog("done: link-only");
            mark("end");
            if (perfMarks) {
                globalThis?.dispatchEvent?.(
                    new CustomEvent("perf:scope.publish", {
                        detail: { mode: "link-only", marks: perfMarks },
                    })
                );
            }
            return [false, src];
        }

        // Where are we materializing the node?
        const dest = publish.targetScope ?? defaultDestScope;
        dlog("dest resolution", {
            dest: dest.address,
            defaultFrom: defaultDestScope.address,
        });

        // --------- sync (same id at dest) ----------
        if (publish.type === "sync") {
            const updateHome = publish.updateHome ?? "keep";
            // Heuristic: if caller didn't specify deferCleanup and we're migrating a canvas with many elements,
            // defer cleanup to after finalize to reduce perceived publish latency.
            let deferCleanup = !!publish.deferCleanup;
            let autoDeferred = false;
            if (
                !deferCleanup &&
                publish.deferCleanup == null &&
                updateHome === "set" &&
                srcHome.address !==
                    (publish.targetScope ?? defaultDestScope).address
            ) {
                try {
                    const ownedAtSource = await srcHome.elements.index
                        .iterate(
                            { query: getOwnedByCanvasQuery(src) },
                            { resolve: true }
                        )
                        .all();
                    if (ownedAtSource.length > 10) {
                        deferCleanup = true;
                        autoDeferred = true;
                    }
                } catch {}
            }
            const existing = await dest.replies.index.get(src.id, {
                resolve: true,
            });
            dlog("mode=sync", { updateHome, existingAtDest: !!existing });
            mark("sync:lookupExisting");

            const dst = existing
                ? await dest.openWithSameSettings(existing)
                : new Canvas({
                      id: src.id,
                      publicKey: dest.node.identity.publicKey,
                      selfScope:
                          updateHome === "set"
                              ? new AddressReference({ address: dest.address })
                              : src.selfScope,
                  });

            const created = !existing;
            if (!existing) {
                dlog("sync: ensureInReplies(dest) for dst", {
                    dest: dest.address,
                    dst: dst.idString,
                });
                await ensureInReplies(dest, dst);
                await dest.openWithSameSettings(dst);
                mark("sync:ensure+openDest");
            }

            // (debug) count elements owned by dst in dest scope before copy
            const preIds = debug
                ? (
                      await dest.elements.index
                          .iterate(
                              { query: getOwnedByCanvasQuery(dst) },
                              { resolve: false }
                          )
                          .all()
                  )
                      .map((e) => e.idString)
                      .sort()
                : undefined;

            // Copy payload over
            const copyStart = debug ? Date.now() : 0;
            await dest.suppressReindex(async () => {
                await Promise.all([
                    copyElementsBetweenScopes(
                        srcHome,
                        dest,
                        src,
                        dst /* , { debug } */
                    ),
                    copyVisualizationBetweenScopes(
                        srcHome,
                        dest,
                        src,
                        dst /* , { debug } */
                    ),
                ]);
            });
            mark(
                "sync:copyPayload" +
                    (debug ? `:${Date.now() - copyStart}ms` : "")
            );

            // If we are *moving* the home, flip selfScope and clean up old home payload & child-links
            if (
                updateHome === "set" &&
                srcHome.address !== dest.address &&
                !deferCleanup
            ) {
                dlog("sync: update home of src → dest", {
                    from: srcHome.address,
                    to: dest.address,
                });
                src.selfScope = new AddressReference({ address: dest.address });

                dlog("sync: cleanup old home payload", {
                    oldHome: srcHome.address,
                    canvas: src.idString,
                });
                await deleteOwnedElementsInScope(srcHome, src);
                await deleteVisualizationsInScope(srcHome, src);
                await deleteChildLinksForCanvasInScope(srcHome, src);

                // Optional: remove the replies row in the old home to avoid ghosts
                const hadRow = await srcHome.replies.index.get(src.id, {
                    resolve: false,
                    local: true,
                });
                if (hadRow) {
                    await srcHome.replies.del(src.id);
                    dlog("sync: removed old replies row", {
                        oldHome: srcHome.address,
                    });
                }

                // Flush both sides so indexes converge deterministically
                await srcHome._hierarchicalReindex!.flush();
                mark("sync:cleanupOldHome");
            }

            // (debug) count elements owned by dst in dest scope after copy
            const postIds = debug
                ? (
                      await dest.elements.index
                          .iterate(
                              { query: getOwnedByCanvasQuery(dst) },
                              { resolve: false }
                          )
                          .all()
                  )
                      .map((e) => e.idString)
                      .sort()
                : undefined;

            if (debug) {
                dlog("sync: element ids per-canvas@dest", {
                    dst: dst.idString,
                    preCount: preIds?.length ?? 0,
                    postCount: postIds?.length ?? 0,
                    createdDelta:
                        (postIds?.length ?? 0) - (preIds?.length ?? 0),
                });
            }

            // finalize (link, view, reindex)
            await finalize(dst);
            mark("sync:finalize");
            dlog("done: sync", { createdAtDest: created, autoDeferred });
            if (
                updateHome === "set" &&
                srcHome.address !== dest.address &&
                deferCleanup
            ) {
                dlog("sync: deferred cleanup old home payload", {
                    from: srcHome.address,
                    canvas: src.idString,
                });
                const cleanupStart = debug ? Date.now() : 0;
                src.selfScope = new AddressReference({ address: dest.address });
                await deleteOwnedElementsInScope(srcHome, src);
                await deleteVisualizationsInScope(srcHome, src);
                await deleteChildLinksForCanvasInScope(srcHome, src);
                const hadRow = await srcHome.replies.index.get(src.id, {
                    resolve: false,
                    local: true,
                });
                if (hadRow) await srcHome.replies.del(src.id);
                await srcHome._hierarchicalReindex!.flush();
                mark(
                    "sync:deferredCleanup" +
                        (debug ? `:${Date.now() - cleanupStart}ms` : "")
                );
                if (autoDeferred) {
                    mark("sync:autoDeferred");
                }
                dlog("sync: deferred cleanup complete");
            }
            mark("end");
            if (perfMarks) {
                globalThis?.dispatchEvent?.(
                    new CustomEvent("perf:scope.publish", {
                        detail: { mode: "sync", created, marks: perfMarks },
                    })
                );
            }
            return [created, dst];
        }

        // --------- fork (new id at dest unless 'preserve') ----------
        {
            const updateHome = publish.updateHome ?? "keep";
            const idMode = publish.id ?? "new";
            const newId = idMode === "preserve" ? src.id : randomBytes(32);

            dlog("mode=fork", {
                updateHome,
                idMode,
                newId: sha256Base64Sync(newId),
            });

            const dst = new Canvas({
                id: newId,
                publicKey: dest.node.identity.publicKey,
                selfScope:
                    updateHome === "set"
                        ? new AddressReference({ address: dest.address })
                        : src.selfScope,
            });

            await ensureInReplies(dest, dst);
            await dest.openWithSameSettings(dst);
            mark("fork:ensure+openDest");

            await dest.suppressReindex(async () => {
                await Promise.all([
                    copyElementsBetweenScopes(
                        srcHome,
                        dest,
                        src,
                        dst /* , { debug } */
                    ),
                    copyVisualizationBetweenScopes(
                        srcHome,
                        dest,
                        src,
                        dst /* , { debug } */
                    ),
                ]);
            });
            mark("fork:copyPayload");

            await finalize(dst);
            mark("fork:finalize");
            dlog("done: fork", { dst: dst.idString });
            mark("end");
            if (perfMarks) {
                globalThis?.dispatchEvent?.(
                    new CustomEvent("perf:scope.publish", {
                        detail: { mode: "fork", marks: perfMarks },
                    })
                );
            }
            return [true, dst];
        }
    }

    async upsertRoot(
        draft: Canvas,
        publish: Omit<Publish, "parent"> = { type: "sync" }
    ) {
        return this.publish(draft, publish);
    }

    /**
     * Register `draft` in THIS scope if needed, then (optionally) link it under `parent`.
     * - Never migrates data across scopes (use Canvas.upsertReply for that).
     * - Honors child-owned links with optional parent mirror via `visibility`.
     *
     * Returns { createdCanvas, createdLink, canvas }.
     */
    async getOrCreateReply(
        parent: Canvas | undefined | null,
        draft: Canvas,
        opts?: {
            kind?: LinkKind;
            type?: ChildVisualization;
            visibility?: Visibility;
        }
    ): Promise<[boolean, Canvas]> {
        // Ensure draft has a home; adopt into *this* scope if missing
        if (!draft.selfScope) {
            draft.selfScope = new AddressReference({ address: this.address });
        }

        if (!parent) {
            // ── ROOT CASE ─────────────────────────────────────────────
            // Only register in the child's HOME scope, do NOT mirror into caller.
            const home: Scope = await this.node.open<Scope>(
                draft.selfScope.address,
                {
                    existing: "reuse",
                    args: {
                        replicate: {
                            factor: 1,
                        },
                    },
                }
            );

            // 2) Open the draft with the home scope’s settings (gives an opened Canvas).
            const child = await home.openWithSameSettings(draft);

            // 3) Ensure it has a row in the home replies index.
            const existsAtHome = await home.replies.index.get(child.id, {
                resolve: false,
                local: true,
            });

            let created = false;
            if (!existsAtHome) {
                await home.replies.put(child);
                created = true;
            }

            // 4) Make immediately visible & indexable (avoid test races) — targeted flush.
            await home._hierarchicalReindex!.flush(child.idString);
            await child.getSelfIndexedCoerced();

            return [created, child];
        }

        // ── REPLY CASE ──────────────────────────────────────────────
        // Let the parent perform a link-only publish:
        return parent.upsertReply(draft, {
            type: "link-only",
            visibility: opts?.visibility ?? "both",
            kind: opts?.kind,
            view: opts?.type,
        });
    }

    async setExperience(canvas: { id: Uint8Array }, type: ChildVisualization) {
        let visualization: BasicVisualization | null =
            (await this.getVisualization(canvas)) as BasicVisualization | null;
        if (!visualization) {
            visualization = new BasicVisualization({
                canvasId: canvas.id,
                view: type,
            });
        } else {
            if (visualization.view !== type) {
                visualization.view = type;
            } else {
                return;
            }
        }
        await this.setVisualization(canvas, visualization);
    }

    async setVisualization(
        canvas: { id: Uint8Array },
        visualization: BasicVisualization | null
    ): Promise<void> {
        const canonicalId = sha256Sync(
            concat([new Uint8Array([0x56, 0x49, 0x5a]), canvas.id])
        );

        // If clearing, remove any rows
        if (!visualization) {
            const list = await this.visualizations.index
                .iterate({ query: { canvasId: canvas.id } }, { resolve: false })
                .all();
            for (const v of list) await this.visualizations.del(v.id);
            return;
        }

        // Upsert single row under canonical id
        visualization.id = canonicalId;
        visualization.canvasId = canvas.id;

        const existing = await this.visualizations.index.get(canonicalId, {
            resolve: true,
            local: true,
        });

        if (!existing) {
            await this.visualizations.put(visualization);
        } else {
            // Update in place if any field differs
            const current = existing as unknown as BasicVisualization;
            let changed = false;
            if (
                (current.view ?? undefined) !==
                (visualization.view ?? undefined)
            ) {
                current.view = visualization.view;
                changed = true;
            }
            if (
                (current.previewHeight ?? undefined) !==
                (visualization.previewHeight ?? undefined)
            ) {
                current.previewHeight = visualization.previewHeight;
                changed = true;
            }
            if (
                (current.font ?? undefined) !==
                (visualization.font ?? undefined)
            ) {
                current.font = visualization.font;
                changed = true;
            }
            if (
                (current.showAuthorInfo ?? true) !==
                (visualization.showAuthorInfo ?? true)
            ) {
                current.showAuthorInfo = visualization.showAuthorInfo ?? true;
                changed = true;
            }
            if (
                (current.background ? serialize(current.background) : null) !==
                (visualization.background
                    ? serialize(visualization.background)
                    : null)
            ) {
                current.background = visualization.background;
                changed = true;
            }
            if (
                (current.palette ? serialize(current.palette) : null) !==
                (visualization.palette
                    ? serialize(visualization.palette)
                    : null)
            ) {
                current.palette = visualization.palette;
                changed = true;
            }

            if (changed) await this.visualizations.put(current);

            // Remove any duplicates with non-canonical ids
            const list = await this.visualizations.index
                .iterate({ query: { canvasId: canvas.id } }, { resolve: false })
                .all();
            for (const v of list) {
                if (!equals(v.id, canonicalId)) {
                    try {
                        await this.visualizations.del(v.id);
                    } catch {}
                }
            }
        }
    }

    async createContext(
        canvas:
            | Canvas
            | WithIndexedContext<Canvas, IndexableCanvas>
            | IndexableCanvas,
        opts?: { localOnly?: boolean; timeoutMs?: number }
    ): Promise<string> {
        // Helper: get expected element count from an indexed row if available
        const expectedCount = (() => {
            const anyCanvas = canvas as any;
            if (anyCanvas instanceof IndexableCanvas) {
                return Number(anyCanvas.elements);
            }
            if (anyCanvas && anyCanvas.__indexed instanceof IndexableCanvas) {
                return Number(anyCanvas.__indexed.elements);
            }
            return undefined;
        })();

        const iterateOptsBase: QueryOptions<false, any, false> = {
            resolve: false,
            local: true,
            remote: false,
        };

        // First pass: local-only for performance
        let elements = await this.elements.index
            .iterate({ query: getOwnedElementsQuery(canvas) }, iterateOptsBase)
            .all();

        // If caller requires completeness and we know the expected count, optionally try a bounded remote fallback
        if (
            !opts?.localOnly &&
            expectedCount != null &&
            elements.length < expectedCount
        ) {
            // Try a bounded remote fallback fetch once
            const iterateWithRemote: QueryOptions<false, any, false> = {
                resolve: false,
                local: true,
                remote: {
                    strategy: "fallback",
                    timeout: opts?.timeoutMs ?? 2000,
                },
            };
            elements = await this.elements.index
                .iterate(
                    { query: getOwnedElementsQuery(canvas) },
                    iterateWithRemote
                )
                .all();

            // If still incomplete, poll until background prefetch warms up or timeout
            const deadline = Date.now() + (opts?.timeoutMs ?? 3000);
            while (elements.length < expectedCount && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 100));
                if (this.closed) {
                    throw new ClosedError();
                }
                elements = await this.elements.index
                    .iterate(
                        { query: getOwnedElementsQuery(canvas) },
                        iterateWithRemote
                    )
                    .all();
            }
        }

        // Build string context from available elements
        let concat = "";
        for (const element of elements) {
            if (concat.length > 0) {
                concat += "\n";
            }
            concat += element.content;
        }
        return concat;
    }

    async getText(canvas: Canvas): Promise<string> {
        const elements = await this.elements.index.index
            .iterate({
                query: [
                    getTextElementsQuery(),
                    ...getOwnedElementsQuery(canvas),
                ],
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

    async getOwnedElements(
        canvas: Canvas
    ): Promise<WithIndexedContext<Element, IndexableElement>[]> {
        // Local-only to avoid remote fallback delays on non-replicating clients.
        return this.elements.index
            .iterate(
                { query: getOwnedElementsQuery(canvas) },
                {
                    resolve: true,
                    local: true,
                    remote: false,
                }
            )
            .all();
    }

    async countOwnedElements(canvas: Canvas): Promise<number> {
        return this.elements.count({
            query: getOwnedElementsQuery(canvas),
            approximate: true,
        });
    }

    async reIndex(
        from: Canvas | WithIndexedContext<Canvas, IndexableCanvas>,
        options?: { onlyReplies?: boolean }
    ): Promise<void> {
        // Ensure the canvas is opened in this scope so helpers work
        if (this.closed) {
            return;
        }
        const canvas: Canvas = await this.openWithSameSettings(
            (from as WithContext<Canvas>).__context
                ? (from as any)
                : (from as Canvas)
        );

        const _dispatchReindexDebug = (detail: any) => {
            try {
                globalThis.window?.dispatchEvent?.(
                    new CustomEvent("reindex:debug", { detail })
                );
            } catch {}
        };
        const tStart = globalThis.performance?.now?.() || Date.now();

        if ((options as any)?.onlyReplies) {
            const tRepliesStart = globalThis.performance?.now?.() || Date.now();
            _dispatchReindexDebug({
                phase: "replies:update:start",
                id: canvas.idString,
            });
            // 1) update this node's replies total
            await updateIndexedRepliesOnly(this, canvas);
            const tRepliesSelf = globalThis.performance?.now?.() || Date.now();
            _dispatchReindexDebug({
                phase: "replies:update:self",
                id: canvas.idString,
                dt: tRepliesSelf - tRepliesStart,
            });

            // 2) propagate to ancestors (their deep totals depend on children)
            const ancestors = (options as any)?.skipAncestors
                ? []
                : await canvas.loadPath({ includeSelf: false });

            // walk from nearest parent up to root
            const tAncestorsStart =
                globalThis.performance?.now?.() || Date.now();
            for (let i = ancestors.length - 1; i >= 0; i--) {
                await updateIndexedRepliesOnly(this, ancestors[i]);
            }
            const tAncestorsEnd = globalThis.performance?.now?.() || Date.now();
            _dispatchReindexDebug({
                phase: "replies:update:ancestors",
                id: canvas.idString,
                dt: tAncestorsEnd - tAncestorsStart,
                count: ancestors.length,
            });
            const tRepliesEnd = globalThis.performance?.now?.() || Date.now();
            _dispatchReindexDebug({
                phase: "replies:update:end",
                id: canvas.idString,
                dt: tRepliesEnd - tRepliesStart,
            });
            return;
        }

        // ---------- FULL rebuild of IndexableCanvas ----------
        _dispatchReindexDebug({
            phase: "full:lookup:start",
            id: canvas.idString,
        });
        const existing = await this.replies.index.get(canvas.id, {
            resolve: false,
            local: true,
            remote: false,
        });
        if (!existing) {
            // This scope does not own/index this canvas → do not create a ghost row
            _dispatchReindexDebug({
                phase: "full:lookup:skip",
                id: canvas.idString,
            });
            return;
        }
        const tLookupDone = globalThis.performance?.now?.() || Date.now();
        _dispatchReindexDebug({
            phase: "full:lookup:end",
            id: canvas.idString,
            dt: tLookupDone - tStart,
        });

        // Build fresh index row
        const tBuildStart = globalThis.performance?.now?.() || Date.now();
        _dispatchReindexDebug({
            phase: "full:build:start",
            id: canvas.idString,
        });
        const fresh = await IndexableCanvas.from(canvas);
        const tBuildEnd = globalThis.performance?.now?.() || Date.now();
        _dispatchReindexDebug({
            phase: "full:build:end",
            id: canvas.idString,
            dt: tBuildEnd - tBuildStart,
        });

        // Reuse existing context; never synthesize a new one for a foreign canvas
        const ctx = existing.__context;

        // Write through with the existing context
        const tPutStart = globalThis.performance?.now?.() || Date.now();
        _dispatchReindexDebug({ phase: "full:put:start", id: canvas.idString });
        // Collect static meta about the fresh row once
        const _meta = () => ({
            id: canvas.idString,
            elements: Number(fresh.elements || 0n),
            replies: Number(fresh.replies || 0n),
            pathDepth: fresh.pathDepth,
            contents: fresh.contents?.length || 0,
            contextLen: fresh.context?.length || 0,
        });
        let serialized: Uint8Array | undefined;
        try {
            // Best-effort serialization size (can throw if deps not loaded)
            serialized = serialize(fresh) as Uint8Array;
        } catch {}
        const bytes = serialized?.length;

        // 1) putWithContext (context row)
        const tCtxStart = globalThis.performance?.now?.() || Date.now();
        await this.replies.index.putWithContext(canvas, toId(canvas.id), ctx);
        const tCtxEnd = globalThis.performance?.now?.() || Date.now();
        _dispatchReindexDebug({
            phase: "full:put:batch",
            batch: "ctx",
            dt: tCtxEnd - tCtxStart,
            bytes,
            ..._meta(),
        });

        // 2) index.put (indexed document)
        const wrapped = new this.replies.index.wrappedIndexedType(fresh, ctx);
        const tIdxStart = globalThis.performance?.now?.() || Date.now();
        await this.replies.index.index.put(wrapped);
        const tIdxEnd = globalThis.performance?.now?.() || Date.now();
        _dispatchReindexDebug({
            phase: "full:put:batch",
            batch: "index",
            dt: tIdxEnd - tIdxStart,
            bytes,
            ..._meta(),
        });
        const tPutEnd = globalThis.performance?.now?.() || Date.now();
        _dispatchReindexDebug({
            phase: "full:put:end",
            id: canvas.idString,
            dt: tPutEnd - tPutStart,
        });

        // After committing this canvas, refresh ancestors' replies totals unless skipped
        if (!(options as any)?.skipAncestors) {
            try {
                const ancestors = await canvas.loadPath({ includeSelf: false });
                const tAncStart = globalThis.performance?.now?.() || Date.now();
                for (let i = ancestors.length - 1; i >= 0; i--) {
                    await updateIndexedRepliesOnly(this, ancestors[i]);
                }
                const tAncEnd = globalThis.performance?.now?.() || Date.now();
                _dispatchReindexDebug({
                    phase: "replies:update:ancestors",
                    id: canvas.idString,
                    dt: tAncEnd - tAncStart,
                    count: ancestors.length,
                });
            } catch {}
        }
        // Test hook: expose timing breakdown for Node tests (no window events)
        if (
            typeof process !== "undefined" &&
            process?.env?.FULL_PUT_TEST_HOOK
        ) {
            try {
                globalThis.__LAST_FULL_PUT = {
                    id: canvas.idString,
                    ctxMs: tCtxEnd - tCtxStart,
                    indexMs: tIdxEnd - tIdxStart,
                    totalMs: tPutEnd - tPutStart,
                    elements: Number(fresh.elements || 0n),
                    replies: Number(fresh.replies || 0n),
                    bytes: bytes ?? null,
                };
            } catch {}
        }
        const tEnd = globalThis.performance?.now?.() || Date.now();
        _dispatchReindexDebug({
            phase: "full:end",
            id: canvas.idString,
            dt: tEnd - tStart,
        });
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
     
                 // scheduling replaced by hierarchical manager; intentionally omitted
             }
             await Promise.all(promises);
         } */

        this._repliesChangeListener &&
            this.replies.events.removeEventListener(
                "change",
                this._repliesChangeListener
            );

        this._visalizationChangeListener &&
            this.visualizations.events.removeEventListener(
                "change",
                this._visalizationChangeListener
            );

        this._linksChangeListener &&
            this.links.events.removeEventListener(
                "change",
                this._linksChangeListener
            );

        /*  this._typeChangeListener &&
             this._types.events.removeEventListener(
                 "change",
                 this._typeChangeListener
             );
    */

        this._repliesChangeListener = async (
            evt: CustomEvent<DocumentsChange<Canvas, IndexableCanvas>>
        ) => {
            if (this.isReindexSuppressed) return;
            // assume added/remove changed, in this case we want to update the parent so the parent indexed canvas knows that the reply count has changes

            for (let added of evt.detail.added) {
                await reIndexRepliesInParents(this, added);
            }

            for (let removed of evt.detail.removed) {
                await reIndexRepliesInParents(this, removed);
                //  await removed.close();
            }
        };

        this.replies?.events.addEventListener(
            "change",
            this._repliesChangeListener
        );

        // Defer child full reindex from visualization changes to avoid blocking initial paint
        const onVisualizationChange = async (
            evt: CustomEvent<
                DocumentsChange<Visualization, IndexedVisualization>
            >
        ) => {
            const changed = [...evt.detail.added, ...evt.detail.removed];
            for (const v of changed as any[]) {
                const ids = [(v as any).canvasId] as Uint8Array[];
                for (const id of ids) {
                    const canvas = await this.replies.index.get(id);
                    if (!canvas) continue;
                    const c = canvas;
                    const scopeRef = this; // we are already in the right Scope context
                    const ms =
                        typeof process !== "undefined" && process?.env?.VITEST
                            ? 0
                            : 300;
                    globalThis.setTimeout?.(() => {
                        try {
                            scopeRef
                                ._hierarchicalReindex!.add({
                                    canvas: c,
                                    options: {
                                        onlyReplies: false,
                                        skipAncestors: true,
                                    },
                                    propagateParents: false,
                                })
                                .catch(() => {});
                        } catch {}
                    }, ms);
                }
            }
        };
        this.visualizations.events.addEventListener(
            "change",
            onVisualizationChange
        );

        // One small discriminator
        const isReplyKind = (l: Link) => (l.kind as any).tag === 0;

        // Child-only full reindex for view placements (deferred)
        const onViewLinkChange = async (
            evt: CustomEvent<DocumentsChange<Link, Link>>
        ) => {
            const changed = [
                ...evt.detail.added,
                ...evt.detail.removed,
            ] as Link[];
            for (const l of changed) {
                const ids = [l.child.canvasId];
                for (const id of ids) {
                    const canvas = await this.replies.index.get(id);
                    if (!canvas) continue;
                    const c = canvas;
                    const scopeRef = this;
                    const ms =
                        typeof process !== "undefined" && process?.env?.VITEST
                            ? 0
                            : 300;
                    globalThis.setTimeout?.(() => {
                        try {
                            scopeRef
                                ._hierarchicalReindex!.add({
                                    canvas: c,
                                    options: {
                                        onlyReplies: false,
                                        skipAncestors: true,
                                    },
                                    propagateParents: false,
                                })
                                .catch(() => {});
                        } catch {}
                    }, ms);
                }
            }
        };

        // Child full + parent/ancestors onlyReplies
        const onSemanticLinkChange = async (
            evt: CustomEvent<DocumentsChange<Link, Link>>
        ) => {
            if (this.isReindexSuppressed) return;
            const changed = [
                ...evt.detail.added,
                ...evt.detail.removed,
            ] as Link[];

            for (const l of changed) {
                // Identify if this link row is a mirror (stored in the parent's scope)
                const childScopeAddr =
                    l.child instanceof ScopedRef
                        ? l.child.scope.address
                        : this.address;
                const isMirrorRow = childScopeAddr !== this.address;

                // Resolve parent locally (should be local for mirror rows)
                const parent = await resolveParent(l, this, {
                    local: true,
                    remote: false,
                    waitFor: 0,
                });

                // Only resolve child when we are on the canonical child scope; for mirror rows skip and avoid transient warnings
                const child = isMirrorRow
                    ? null
                    : await resolveChild(l, this, {
                          local: true,
                          remote: false,
                          waitFor: 0,
                      });

                const warnOnce = (side: "child" | "parent", msg: string) => {
                    const key = (l.idString || "?") + ":" + side;
                    if (!this._missingResolveOnce.has(key)) {
                        this._missingResolveOnce.add(key);
                        console.warn(msg, l.idString || "?");
                    } else {
                        console.debug(msg, l.idString || "?");
                    }
                };

                if (!child && !isMirrorRow) {
                    // Only warn about missing child when handling the canonical row
                    warnOnce("child", "Child not found for link");
                }
                if (!parent) {
                    warnOnce("parent", "Parent not found for link");
                }

                if (child) {
                    try {
                        globalThis.window?.dispatchEvent?.(
                            new CustomEvent("reindex:debug", {
                                detail: {
                                    phase: "queue:add",
                                    id: child.idString,
                                    source: "link:child(deferred)",
                                    onlyReplies: false,
                                    skipAncestors: true,
                                },
                            })
                        );
                    } catch {}
                    // Defer child full to avoid blocking initial content paint
                    const c = child;
                    const scopeRef = this; // use current Scope
                    globalThis.setTimeout?.(() => {
                        try {
                            scopeRef
                                ._hierarchicalReindex!.add({
                                    canvas: c,
                                    options: {
                                        onlyReplies: false,
                                        skipAncestors: true,
                                    },
                                })
                                .catch(() => {});
                        } catch {}
                    }, 300);
                }
                if (parent) {
                    // Defer parent replies-only refresh out of the current frame
                    const p = parent;
                    globalThis.setTimeout?.(() => {
                        try {
                            globalThis.window?.dispatchEvent?.(
                                new CustomEvent("reindex:debug", {
                                    detail: {
                                        phase: "queue:add",
                                        id: p.idString,
                                        source: "link:parent(deferred)",
                                        onlyReplies: true,
                                        skipAncestors: true,
                                    },
                                })
                            );
                        } catch {}
                        p.nearestScope
                            ._hierarchicalReindex!.add({
                                canvas: p,
                                options: {
                                    onlyReplies: true,
                                    skipAncestors: true,
                                },
                            })
                            .catch(() => {});
                    }, 0);
                }
            }
        };

        this._linksChangeListener = async (evt) => {
            if (this.isReindexSuppressed) return;
            // Fast path: split by kind once to avoid redundant fetches
            const added = evt.detail.added;
            const removed = evt.detail.removed;

            const hasViewsChange =
                added.some((l) => l.kind.tag === 1) ||
                removed.some((l) => l.kind.tag === 1);
            const hasSemanticsChange =
                added.some(isReplyKind) || removed.some(isReplyKind);

            if (hasViewsChange)
                await onViewLinkChange(
                    new CustomEvent("change", {
                        detail: {
                            added: added.filter((l) => !isReplyKind(l)),
                            removed: removed.filter((l) => !isReplyKind(l)),
                        },
                    })
                );
            if (hasSemanticsChange)
                await onSemanticLinkChange(
                    new CustomEvent("change", {
                        detail: {
                            added: added.filter(isReplyKind),
                            removed: removed.filter(isReplyKind),
                        },
                    })
                );
        };

        this.links?.events.addEventListener(
            "change",
            this._linksChangeListener
        );

        // Defer full reindex from element changes (child-only) to avoid blocking paint
        this._elementsChangeListener = async (
            evt: CustomEvent<DocumentsChange<Element, IndexableElement>>
        ) => {
            const changed = [...evt.detail.added, ...evt.detail.removed];
            for (const e of changed as any[]) {
                const ids = [(e as any).canvasId] as Uint8Array[];
                for (const id of ids) {
                    const canvas = await this.replies.index.get(id);
                    if (!canvas) continue;
                    const c = canvas;
                    const scopeRef = this;
                    globalThis.setTimeout?.(() => {
                        try {
                            scopeRef
                                ._hierarchicalReindex!.add({
                                    canvas: c,
                                    options: {
                                        onlyReplies: false,
                                        skipAncestors: true,
                                    },
                                    propagateParents: false,
                                })
                                .catch(() => {});
                        } catch {}
                    }, 300);
                }
            }
        };
        const _elementsHandler = this._elementsChangeListener;
        this.elements.events.addEventListener("change", (e: any) => {
            if (this.isReindexSuppressed) return;
            return _elementsHandler(e);
        });
    }

    close(from?: Program): Promise<boolean> {
        this.closeController?.abort();
        this._repliesChangeListener &&
            this.replies.events.removeEventListener(
                "change",
                this._repliesChangeListener
            );
        this._visalizationChangeListener &&
            this.visualizations.events.removeEventListener(
                "change",
                this._visalizationChangeListener
            );

        this._linksChangeListener &&
            this.links.events.removeEventListener(
                "change",
                this._linksChangeListener
            );

        this._elementsChangeListener &&
            this.elements.events.removeEventListener(
                "change",
                this._elementsChangeListener
            );

        /* this._typeChangeListener &&
            this._types.events.removeEventListener(
                "change",
                this._typeChangeListener
            ); */

        this._hierarchicalReindex?.close();
        return super.close(from);
    }

    /* private async updateIndexedReplyCounter(
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
            let parent = canvas.nearestUpScope;

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

            if (!indexedCanvas) {
                // we could end up because the parent has not indexed the child yet
                return; // TODO warning message?
            }

            indexed = indexedCanvas;
            context = indexedCanvas.__context;
        }

        if (amount) {
            indexed.replies += amount;
        } else {
            indexed.replies = await canvas.countReplies();
            console.log("UPDATE REPLIES", { replies: Number(indexed.replies), context: indexed.context });
        }
        const wrappedValueToIndex = new this.replies.index.wrappedIndexedType(
            indexed,
            context
        );
        await this.replies.index.index.put(wrappedValueToIndex);
    }
 */
    /* async getOrCreateReply(reply: Canvas): Promise<[boolean, Canvas]> {

        let existing = await this.replies.index.get(reply.id);
        if (existing) {
            // merge
            await existing.load(this, this.openingArgs)
            return [false, existing];
        }
        await reply.load(this, this.openingArgs)
        await this.replies.put(reply);
        return [true, reply];
    } */

    async openWithSameSettings(
        target: Canvas | Uint8Array | NodeRef
    ): Promise<Canvas> {
        if (!this.node) throw new Error("Scope has no ProgramClient bound");
        const client = this.node as ProgramClient;
        const args = this.openingArgs;

        let owningScope: Scope;
        let canvas: Canvas | undefined;

        if (target instanceof Canvas) {
            // Prefer canvas’ own bound scope if it’s initialized; otherwise fall back to “this”
            owningScope = target.tryNearestScope() ?? this;
            canvas = target;
        } else if (target instanceof Uint8Array) {
            owningScope = this;
            canvas = await owningScope.replies.index.get(target, {
                resolve: true,
            });
            if (!canvas) {
                throw new Error(
                    `Canvas ${sha256Base64Sync(target)} not found in scope ${
                        this.address
                    }`
                );
            }
        } else if (target instanceof LocalRef) {
            owningScope = this;
            canvas = await owningScope.replies.index.get(target.canvasId, {
                resolve: true,
            });
            if (!canvas)
                throw new Error(`LocalRef not found in scope ${this.address}`);
        } else if (target instanceof ScopedRef) {
            owningScope = await client.open<Scope>(target.scope.address, {
                existing: "reuse",
                args,
            });
            canvas = await owningScope.replies.index.get(target.canvasId, {
                resolve: true,
            });
            if (!canvas) {
                throw new Error(
                    `ScopedRef not found: ${sha256Base64Sync(
                        target.canvasId
                    )} in ${target.scope.address}`
                );
            }
        } else {
            throw new Error("Unsupported target for openWithSameSettings");
        }

        // Ensure the Canvas is bound & ready (idempotent if already initialized)
        await canvas.load(client, { args, candidates: [owningScope] });
        return canvas;
    }

    async remove(
        this: Scope,
        canvas: Canvas,
        options?: {
            drop?: boolean;
            seedScopes?: Scope[]; // optional: extra scopes to help discover mirrors
            ignore?: Set<string>; // recursion guard
        }
    ): Promise<boolean> {
        // Open the handle with this scope's settings (no-op if already opened)
        const target = await this.openWithSameSettings(canvas);

        // If we're not the target's home, delegate to its home scope.
        const home = target.nearestScope;
        if (home.address !== this.address) {
            return home.remove(target, {
                drop: options?.drop,
                seedScopes: options?.seedScopes,
                ignore: options?.ignore,
            });
        }

        // ---- recursion/loop guard on the canonical node id ----
        const ignore = options?.ignore ?? new Set<string>();
        if (ignore.has(target.idString)) return true;
        ignore.add(target.idString);

        // ---- 1) Unlink incoming edges (parents) across all scopes, then recurse into children ----
        // Discover all parents that point to this target (BFS over NodeRef scopes).
        const parents = await collectParentsBFS(target, options?.seedScopes);

        for (const parent of parents) {
            await parent.load(this.node, { args: this.openingArgs }); // ensure parent is opened

            // For each (parent -> target) pair, find *all* scopes that store that link (canonical + mirrors).
            const linkScopes = await collectLinkScopesBFS(
                parent,
                target,
                options?.seedScopes
            );
            // Remove links of any kind (Reply/View/BoardView) in those scopes.
            await unlink.call(parent, target.id, {
                kinds: "all",
                scopes: linkScopes,
            });
        }

        // ---- 2) Enumerate children canonically (child links are stored in the child's/home scope) ----
        const children = await target.getChildren({ scopes: [home] });

        // ---- 3) Recurse into subtree; each child’s home scope will handle its own data ----
        for (const child of children) {
            await child.nearestScope.remove(child, {
                drop: options?.drop,
                seedScopes: options?.seedScopes,
                ignore,
            });
        }

        // ---- 4) Delete local rows for THIS canvas in ITS HOME SCOPE (this === home) ----

        // Elements owned here
        const els = await home.elements.index
            .iterate({ query: getOwnedElementsQuery(target) })
            .all();
        for (const e of els) await home.elements.del(e.id);

        // Visualizations here
        const vizz = await home.visualizations.index
            .iterate({ query: { canvasId: target.id } }, { resolve: false })
            .all();
        for (const v of vizz) await home.visualizations.del(v.id);

        // Replies row here (correct store)
        if (
            await home.replies.index.get(target.id, {
                resolve: false,
                local: true,
            })
        ) {
            await home.replies.del(target.id);
        }

        // Defensive sweeps for any leftover links in THIS scope that reference the target
        const byParent = (await home.links.index
            .iterate({ query: [getChildrenLinksQuery(target.id)] })
            .all()) as Link[];
        for (const l of byParent) await home.links.del(l.id);

        const byChild = (await home.links.index
            .iterate({ query: [getParentLinksQuery(target.id)] })
            .all()) as Link[];
        for (const l of byChild) await home.links.del(l.id);

        // ---- 5) Optional block GC (TODO when supported) ----
        if (options?.drop) {
            // ...
        }

        return true;
    }
}

/* @variant(0) */
export class Canvas {
    // we choose to make Canvas into program so it can have an address and we can look up, itself or its path using a block store

    @field({ type: fixedArray("u8", 32) }) // don't use @id() here because Canvas is also used as a nested Document within Template class
    id: Uint8Array;

    @field({ type: PublicSignKey })
    publicKey: PublicSignKey;

    @field({ type: AddressReference })
    selfScope: AddressReference;

    @field({ type: "u8" })
    acl: 0;

    constructor(
        p: {
            publicKey: PublicSignKey;
            selfScope?: AddressReference | Scope;
        } & ({ id?: Uint8Array } | { seed?: Uint8Array })
    ) {
        this.publicKey = p.publicKey;
        this.id =
            (p as { id: Uint8Array }).id ||
            ((p as { seed: Uint8Array }).seed
                ? sha256Sync((p as { seed: Uint8Array }).seed)
                : randomBytes(32));
        this.selfScope = (
            p.selfScope instanceof Scope
                ? new AddressReference({ address: p.selfScope.address })
                : p.selfScope
        ) as AddressReference; // TODO types
        this.acl = 0;
    }

    // ---- optional tiny cache (not a “bound scope”, just an open handle) ----
    private _scope?: Scope; // resolved & opened scope
    private _client?: ProgramClient; // last client used to open

    /** True if this canvas has a bound scope and it isn’t closed. */
    get initialized(): boolean {
        return !!this._scope && !this._scope.closed;
    }

    /** Return the bound scope if available/open; otherwise undefined. */
    tryNearestScope(): Scope | undefined {
        return this.initialized ? this._scope! : undefined;
    }

    /** Resolve and cache the usable scope once; after this, nearestScope is sync. */
    async load(
        client: ProgramClient,
        options?: {
            candidates?: Scope[]; // optional fallback scopes to search if selfScope is missing
            args?: ScopeArgs;
        }
    ): Promise<this> {
        this._client = client;

        // Fast path: already opened and alive
        if (this._scope && !this._scope.closed) return this;

        // 1) have a home? open it
        if (this.selfScope) {
            this._scope = await client.open<Scope>(this.selfScope.address, {
                existing: "reuse",
                args: options?.args,
            });
            return this;
        }

        // 2) discover via candidate scopes (if provided)
        if (options?.candidates?.length) {
            const found = await loadCanvasFromScopes(
                this.id,
                options.candidates,
                { local: true }
            );
            if (found) {
                // grab the scope used by the found instance
                const scopeAddr = found.nearestScope?.address;
                if (!scopeAddr)
                    throw new Error(
                        "Located canvas but could not resolve its scope address"
                    );
                this._scope = await client.open<Scope>(scopeAddr, {
                    existing: "reuse",
                    args: options?.args,
                });
                // optionally “learn” the home so future reloads skip discovery
                this.selfScope = this._scope;
                return this;
            }
        }

        throw new Error(
            "Canvas.load(): cannot resolve scope (no selfScope and no candidates matched)."
        );
    }

    /** Forget cached handles (e.g., when client disconnects). */
    unload() {
        this._scope = undefined;
    }

    /** After load(), this is synchronous. Throws if not loaded. */
    get nearestScope(): Scope {
        if (!this._scope || this._scope.closed) {
            throw new Error(
                "Canvas.nearestScope: not loaded — call await canvas.load(client, ...) first."
            );
        }
        return this._scope;
    }

    /** Program client used in the last load (optional helper). */
    get client(): ProgramClient | undefined {
        return this._client;
    }

    // ---- sync store accessors (safe after load) ----
    get elements(): Documents<Element, IndexableElement, any> {
        return this.nearestScope.elements;
    }
    get links(): Documents<Link, Link, any> {
        return this.nearestScope.links as unknown as Documents<Link, Link, any>;
    }
    get replies(): Documents<Canvas, IndexableCanvas, any> {
        return this.nearestScope.replies;
    }
    get visualizations(): Documents<Visualization, IndexedVisualization, any> {
        return this.nearestScope.visualizations;
    }

    async addReply(
        child: Canvas,
        kind: LinkKind = new ReplyKind(),
        visibility: LinkVisibility = "both"
    ): Promise<void> {
        return addReply.call(this, child, kind, visibility);
    }

    async getParent(): Promise<Canvas | null> {
        const scope = this.nearestScope;
        const edge = await scope.links.index
            .iterate({
                query: [
                    getParentLinksQuery(this.id),
                    new IntegerCompare({
                        key: ["kind", "tag"],
                        value: 0,
                        compare: Compare.Equal,
                    }),
                ],
            })
            .first();
        if (!edge) return null;
        return resolveParent(edge, scope);
    }

    async getChildren(options?: {
        scopes?: Scope[];
    }): Promise<WithIndexedContext<Canvas, IndexableCanvas>[]> {
        const parentScope = this.nearestScope;
        const scopes = options?.scopes?.length ? options.scopes : [parentScope];

        const out: WithIndexedContext<Canvas, IndexableCanvas>[] = [];
        const seen = new Set<string>();

        for await (const { link, scope } of iterLinksWithOrigin(scopes, [
            getChildrenLinksQuery(this.id),
        ])) {
            const child = await resolveChild(link, scope);
            if (!child) continue;
            const key = child.idString;
            if (!seen.has(key)) {
                seen.add(key);
                out.push(child);
            }
        }
        return out;
    }

    async loadPath(options?: {
        includeSelf?: boolean;
        length?: number;
    }): Promise<WithIndexedContext<Canvas, IndexableCanvas>[]> {
        const max = options?.length ?? Number.MAX_SAFE_INTEGER;
        const result: WithIndexedContext<Canvas, IndexableCanvas>[] = [];

        // Start at this canvas + its scope
        let current: Canvas = this;
        let currentScope: Scope = this.nearestScope;

        for (let steps = 0; steps < max; steps++) {
            // Find the (unique) semantic parent edge stored in the CHILD's scope
            const edge = await currentScope.links.index
                .iterate({
                    query: [
                        getParentLinksQuery(current.id), // NodeRef.child.id
                        /* new IntegerCompare({ key: ["kind", "tag"], value: 0, compare: Compare.Equal }), */ // ReplyKind
                    ],
                })
                .first();

            if (!edge) break;

            // Resolve parent NodeRef → (parentId, parentScope)
            const l = edge;

            const parent = await resolveParent(l, currentScope);
            if (!parent) break;

            await parent.load(currentScope.node, {
                args: currentScope.openingArgs,
            });

            // Keep walking from the parent
            result.push(parent);
            current = parent;
            currentScope = parent.nearestScope;
        }

        result.reverse();
        if (options?.includeSelf) {
            const selfIndexed = await this.getSelfIndexedCoerced();
            if (!selfIndexed) {
                throw new Error("Failed to get self indexed canvas");
            }
            result.push(selfIndexed);
        }
        return result;
    }

    private _idString: string;
    get idString() {
        return (
            this._idString || (this._idString = Canvas.createIdString(this.id))
        );
    }

    static createIdString(id: Uint8Array) {
        return sha256Base64Sync(id);
    }

    async loadParent() {
        const path = await this.loadPath({ includeSelf: false, length: 1 });
        return path[0];
    }

    async countRepliesIndexedDirect(): Promise<bigint> {
        const scope = this.nearestScope;
        const n = await scope.replies.count({
            query: [
                new ByteMatchQuery({ key: "path", value: this.id }), // descendants have this.id in their path
            ],
            approximate: true,
        });
        return BigInt(n);
    }

    /** O(1) index count of IMMEDIATE children using materialized path + depth. */
    async countImmediateIndexedDirect(
        parentPathDepth: number
    ): Promise<bigint> {
        const scope = this.nearestScope;
        const n = await scope.replies.count({
            query: [
                new ByteMatchQuery({ key: "path", value: this.id }),
                new IntegerCompare({
                    key: "pathDepth",
                    value: parentPathDepth + 1,
                    compare: Compare.Equal,
                }),
            ],
            approximate: true,
        });
        return BigInt(n);
    }

    /** O(n) count of replies using BFS traversal with loop & duplicate protection, across scopes. */
    async countRepliesBFS(options?: {
        immediate?: boolean;
        maxNodes?: number;
        scopes?: Scope[]; // mirrors/candidate scopes to read links from; default = [nearestScope]
    }): Promise<bigint> {
        const immediate = options?.immediate ?? true;
        const maxNodes = options?.maxNodes ?? Number.POSITIVE_INFINITY;

        const parentScope = this.nearestScope;
        const scopes = options?.scopes?.length ? options.scopes : [parentScope];

        const key = (id: Uint8Array) => toBase64(id);

        if (immediate) {
            // Count unique immediate children across all provided scopes without resolving.
            const seenChildren = new Set<string>();
            for await (const link of iterLinksOverScopes(scopes, [
                getChildrenLinksQuery(this.id),
            ])) {
                const k = key(link.child.canvasId);
                if (!seenChildren.has(k)) {
                    seenChildren.add(k);
                    if (seenChildren.size > maxNodes) break;
                }
            }
            return BigInt(seenChildren.size);
        }

        // BFS across scopes
        let total = 0n;
        const q: Uint8Array[] = [this.id];

        const expanded = new Set<string>(); // parents we already expanded
        const counted = new Set<string>(); // children we've counted (unique across scopes)

        while (q.length) {
            const parentId = q.shift()!;
            const pKey = key(parentId);
            if (expanded.has(pKey)) continue;
            expanded.add(pKey);

            // Gather all edges for this parent from all scopes (mirrors + canonical child scopes)
            for await (const e of iterLinksOverScopes(scopes, [
                getChildrenLinksQuery(parentId),
            ])) {
                const cKey = key(e.child.canvasId);

                if (!counted.has(cKey)) {
                    counted.add(cKey);
                    total += 1n;
                    if (counted.size > maxNodes) return total;
                }

                if (!expanded.has(cKey)) q.push(e.child.canvasId);
            }
        }

        return total;
    }

    async getText(options?: { scope: Scope }): Promise<string> {
        return (options?.scope || this.nearestScope).getText(this);
    }

    async getOwnedElements(options?: {
        scope: Scope;
    }): Promise<WithIndexedContext<Element, IndexableElement>[]> {
        return (options?.scope || this.nearestScope).getOwnedElements(this);
    }

    async countOwnedElements(options?: { scope: Scope }): Promise<number> {
        return (options?.scope || this.nearestScope).countOwnedElements(this);
    }

    /*  async getCreateCanvasByPath(
         path: string[],
         options?: {
             id?: Uint8Array;            // leaf id
             layout?: Layout;            // layout for all created children
             type?: ChildVisualization;  // experience for all created children
         }
     ): Promise<WithIndexedContext<Canvas, IndexableCanvas>[]> {
         const activeScope = this.nearestScope;
 
         const results = await this.findCanvasesByPath(path);
         let end = results.canvases[0] || this;
 
         const existingPath = await end.loadPath({ includeSelf: true });
         let createdPath: Canvas[] = existingPath?.length > 0 ? existingPath : [this];
 
         if (path.length !== results.path.length) {
             if (results.canvases?.length > 1) {
                 throw new Error("More than 1 room to choose from");
             }
             let currentCanvas = results.canvases[0] || this;
 
             await activeScope.openWithSameSettings(currentCanvas);
 
             for (let i = results.path.length; i < path.length; i++) {
                 const nextCanvas = new Canvas({
                     id: i === path.length - 1 ? options?.id : undefined,
                     path: createdPath.map((x) => x.id),
                     publicKey: this.node.identity.publicKey,
                     scope: currentCanvas.scopes,
                     topMostScope: (currentCanvas as any).nearestScope ?? currentCanvas.scope,
                 });
 
                 createdPath.push(nextCanvas);
                 await activeScope.openWithSameSettings(nextCanvas);
 
                 const name = path[i];
                 await nextCanvas.addTextElement(name, {
                     id: sha256Sync(concat([nextCanvas.id, new TextEncoder().encode(name)])),
                     skipReindex: true,
                 });
 
                 await currentCanvas.createReply(nextCanvas, {
                     layout: options?.layout,
                     type: options?.type,
                     unique: true,
                 });
 
                 currentCanvas = nextCanvas;
             }
         }
 
    await activeScope._hierarchicalReindex!.flush();
         return createdPath.slice(1) as WithIndexedContext<Canvas, IndexableCanvas>[];
     } */

    async findCanvasesByPath(
        path: string[]
    ): Promise<{ path: string[]; canvases: Canvas[] }> {
        try {
            let canvases: Canvas[] = [this];
            const visitedPath: string[] = [];
            for (const name of path) {
                const newCanvases: Canvas[] = [];
                for (let parent of canvases) {
                    newCanvases.push(
                        ...(await parent.findCanvasesByName(name))
                    );
                }
                if (newCanvases.length > 0) {
                    visitedPath.push(name);
                    canvases = newCanvases;
                } else {
                    break;
                }
            }
            return { path: visitedPath, canvases };
        } catch (error) {
            throw error;
        }
    }

    async findCanvasesByName(
        name: string
    ): Promise<WithIndexedContext<Canvas, IndexableCanvas>[]> {
        const scope = this.nearestScope;

        // 1) Fast path: use materialized path + depth (immediate children only)
        const selfIdx = await this.getSelfIndexed();
        if (selfIdx) {
            const results = (await scope.replies.index.search(
                new SearchRequest({
                    query: [
                        new StringMatch({
                            key: "context",
                            value: name,
                            caseInsensitive: true,
                            method: StringMatchMethod.exact,
                        }),
                        // immediate children of `this` via pathDepth
                        ...getImmediateRepliesQueryByDepth(
                            this.id,
                            selfIdx.pathDepth
                        ),
                    ],
                })
            )) as WithIndexedContext<Canvas, IndexableCanvas>[];
            if (results.length > 0) {
                return results;
            }
            // Fall through to link-scan fallback when index isn't warm yet
        }

        // 2) Fallback: traverse *all* outgoing links from this parent (no kind filter),
        //    resolve each child via `resolveChild`, then match by context.
        const links = await scope.links.index
            .iterate({
                query: [getChildrenLinksQuery(this.id)],
            })
            .all();

        const out: WithIndexedContext<Canvas, IndexableCanvas>[] = [];
        for (const link of links as Link[]) {
            const child = await resolveChild(link, scope);
            if (!child) continue;

            // Prefer indexed context; compute on miss
            const idxRow = await scope.replies.index.get(child.id, {
                resolve: false,
                local: true,
            });
            const ctx = idxRow?.context as string | undefined;
            const matches = ctx
                ? ctx.localeCompare(name, undefined, {
                      sensitivity: "accent",
                  }) === 0
                : (await child.createContext()) === name;

            if (matches) out.push(child);
        }

        return out;
    }

    async removeAllReplies() {
        for (const link of await this.getChildrenLinks()) {
            let reply = await resolveChild(link, this.nearestScope);
            // we can not use reply.drop() because it would delete the reply itself
            // but we want to delete the reply from the index
            reply && (await this.nearestScope.remove(reply, { drop: true }));
        }
    }

    async createContext(): Promise<string> {
        return this.nearestScope.createContext(this);
    }

    async setVisualization(
        visualization: BasicVisualization | null
    ): Promise<void> {
        const db = this.nearestScope;
        return db.setVisualization(this, visualization);
    }

    async getVisualization(): Promise<WithIndexedContext<
        BasicVisualization,
        IndexedVisualization
    > | null> {
        return this.nearestScope.getVisualization(this);
    }

    async createPath(
        this: Canvas,
        segments: string[],
        options?: {
            id?: Uint8Array; // id for the last node (optional)
            kind?: LinkKind; // kind to apply for each new link
            type?: ChildVisualization; // experience to set on each created node
        }
    ): Promise<Canvas[]> {
        if (segments.length === 0) return [];

        const scope = this.nearestScope;

        // Try to find as much of the path as already exists
        const found = await this.findCanvasesByPath(segments);
        let current: Canvas = found.canvases[0] || this;

        // Ambiguous branch
        if (found.canvases?.length > 1) {
            throw new Error("More than one branch matches the given path.");
        }

        // If fully matched, we’re done (walk to get the tail for return shape)
        const existingPath = (
            await found.canvases[0].loadPath({ includeSelf: true })
        ).slice(1);
        if (found.path.length === segments.length) {
            return existingPath;
        }

        // Ensure current is opened under this scope’s settings
        await scope.openWithSameSettings(current);

        const created: Canvas[] = [];

        // Build the missing tail *in the same scope* as the parent canvas
        for (let i = found.path.length; i < segments.length; i++) {
            const name = segments[i];

            // Create node; by default, new id per node, or use provided id for leaf
            const node = new Canvas({
                id:
                    i === segments.length - 1 && options?.id
                        ? options.id
                        : undefined,
                publicKey: scope.node.identity.publicKey,
                selfScope: new AddressReference({ address: scope.address }),
            });

            await ensureInReplies(scope, node);
            await scope.openWithSameSettings(node);

            // Give it a title/name element (deterministic id)
            await node.addTextElement(name, {
                id: sha256Sync(
                    concat([node.id, new TextEncoder().encode(name)])
                ),
                skipReindex: true,
            });

            // Link parent→child & set experience (batched)
            const ops: Promise<any>[] = [
                this.addReply.call(current, node, options?.kind),
            ];
            if (options?.type)
                ops.push(node.setExperience(options.type, { scope }));
            await Promise.all(ops);

            // Update parent and ancestors replies-only totals after linking
            await scope._hierarchicalReindex!.add({
                canvas: current,
                options: { onlyReplies: true, skipAncestors: false },
            });

            // Ensure the new node gets indexed (context, counts) even when element put skipped reindex
            await scope._hierarchicalReindex!.add({
                canvas: node,
                options: { onlyReplies: false, skipAncestors: true },
            });
            await scope._hierarchicalReindex!.add({
                canvas: node,
                options: { onlyReplies: true, skipAncestors: false },
            });

            created.push(node);
            current = node;
        }

        await scope._hierarchicalReindex!.flush();
        return [...existingPath, ...created];
    }

    async upsertReply(child: Canvas, publish: Publish = { type: "link-only" }) {
        return this.nearestScope.publish(child, { ...publish, parent: this });
    }

    /*  TODO later async getChildPosition(child: Uint8Array): Promise<Layout | undefined> {
         const links = await this.links.index
             .iterate({
                 query: [
                     getChildrenLinksQuery(this.id),
                     getParentLinksQuery(child),
                     new IntegerCompare({ key: ["kind", "tag"], value: 2, compare: Compare.Equal }) // BoardViewKind.tag === 2
                 ],
             })
             .all() as Link[];
 
         const board = links.find(l => l.kind instanceof BoardViewKind);
         return board ? (board.kind as BoardViewKind).layout : undefined;
     } */

    /** Create or update a View link (ordering/placement) stored in the PARENT's scope. */
    async upsertViewPlacement(child: Canvas, orderKey: string): Promise<void> {
        const childScope = child.nearestScope;
        const { child: childRef, parent: parentRef } = buildRefLink(
            this,
            child
        );
        const kind = new ViewKind({ orderKey });
        const linkId = Link.createId(parentRef, childRef, kind.tag);

        const existing = await childScope.links.index.get(linkId);
        if (!existing) {
            await childScope.links.put(
                new Link({
                    id: linkId,
                    parent: parentRef,
                    child: childRef,
                    kind,
                })
            );
        } else {
            // update orderKey if changed
            const l = existing;
            if (l.kind instanceof ViewKind && l.kind.orderKey !== orderKey) {
                l.kind.orderKey = orderKey;
                await childScope.links.put(l);
            }
        }
    }

    /** Remove any View placement(s) for the given child under this parent (keep semantic Reply). */
    async removeViewPlacement(
        childId: Uint8Array,
        o?: { scopes?: Scope[]; strict?: boolean }
    ) {
        return unlink.call(this, childId, {
            kinds: "view",
            scopes: o?.scopes,
            strict: o?.strict,
        });
    }

    async unlinkSemantic(
        childId: Uint8Array,
        o?: { scopes?: Scope[]; strict?: boolean }
    ) {
        return unlink.call(this, childId, {
            kinds: "reply",
            scopes: o?.scopes,
            strict: o?.strict,
        });
    }

    /** Return children *with* their order key (if any). */
    async listChildrenWithOrder(options?: {
        scopes?: Scope[];
    }): Promise<Array<{ child: Canvas; orderKey?: string }>> {
        const parentScope = this.nearestScope;
        const scopes = options?.scopes?.length ? options.scopes : [parentScope];

        // De-dupe by child; if multiple links exist, prefer one that carries a ViewKind orderKey
        const byChild = new Map<string, { child: Canvas; orderKey?: string }>();

        for await (const { link, scope } of iterLinksWithOrigin(scopes, [
            getChildrenLinksQuery(this.id),
        ])) {
            const child = await resolveChild(link, scope);
            if (!child) continue;

            const k = child.idString;
            const current = byChild.get(k);

            // only ViewKind carries orderKey; others (ReplyKind/BoardViewKind/etc.) contribute presence only
            const maybeOrder =
                (link.kind as any).tag === 1
                    ? (link.kind as ViewKind).orderKey
                    : undefined;

            if (!current || maybeOrder !== undefined) {
                byChild.set(k, { child, orderKey: maybeOrder });
            }
        }

        return Array.from(byChild.values());
    }

    /** Ordered children: sort by ViewKind.orderKey (ascending). Children without a View are appended (stable by id). */
    async getOrderedChildren(options?: {
        scopes?: Scope[];
    }): Promise<Canvas[]> {
        const withOrder = await this.listChildrenWithOrder(options);

        const withK = withOrder.filter((x) => typeof x.orderKey === "string");
        const withoutK = withOrder.filter(
            (x) => typeof x.orderKey !== "string"
        );

        withK.sort((a, b) =>
            a.orderKey! < b.orderKey! ? -1 : a.orderKey! > b.orderKey! ? 1 : 0
        );
        withoutK.sort((a, b) => compare(a.child.id, b.child.id));

        return [...withK, ...withoutK].map((x) => x.child);
    }

    /** Move/insert child at an index by computing a new orderKey between neighbors. */
    async moveChildTo(child: Canvas, index: number): Promise<string> {
        const ordered = await this.getOrderedChildren();
        const ids = ordered.map((c) => toBase64(c.id));

        const already = ids.indexOf(toBase64(child.id));
        if (already >= 0) ordered.splice(already, 1);

        const i = Math.max(0, Math.min(index, ordered.length));

        const beforeKey =
            i > 0 ? await this.getChildOrderKey(ordered[i - 1].id) : undefined;
        const afterKey =
            i < ordered.length
                ? await this.getChildOrderKey(ordered[i].id)
                : undefined;

        const newKey =
            i === 0
                ? orderKeyBetween(undefined, afterKey) // strictly before first
                : i === ordered.length
                ? orderKeyBetween(beforeKey, undefined) // strictly after last
                : orderKeyBetween(beforeKey, afterKey); // strictly between neighbors

        await this.upsertViewPlacement(child, newKey);
        return newKey;
    }

    /** Read a child's current orderKey (if any). */
    async getChildOrderKey(
        childId: Uint8Array,
        options?: { scopes?: Scope[] }
    ): Promise<string | undefined> {
        const parentScope = this.nearestScope;
        const scopes = options?.scopes?.length ? options.scopes : [parentScope];

        for await (const { link } of iterLinksWithOrigin(scopes, [
            getChildrenLinksQuery(this.id),
            getParentLinksQuery(childId),
        ])) {
            if ((link.kind as any).tag === 1)
                return (link.kind as ViewKind).orderKey;
        }
        return undefined;
    }

    async getParentLinks(): Promise<Link[]> {
        const links = await this.links.index
            .iterate({
                query: getParentLinksQuery(this.id),
            })
            .all();
        return links;
    }

    async getChildrenLinks(): Promise<Link[]> {
        const links = await this.links.index
            .iterate({
                query: getChildrenLinksQuery(this.id),
            })
            .all();
        return links;
    }

    async getChildrenReplies(): Promise<
        WithIndexedContext<Canvas, IndexableCanvas>[]
    > {
        const links = await this.getChildrenLinks();
        const children: WithIndexedContext<Canvas, IndexableCanvas>[] = [];
        for (const link of links) {
            const child = await resolveChild(link, this.nearestScope);
            if (child) {
                children.push(child);
            }
        }
        return children;
    }

    async hasParentLinks(): Promise<boolean> {
        const links = await this.getParentLinks();
        return links.length > 0;
    }

    async setExperience(type: ChildVisualization, options?: { scope?: Scope }) {
        return (options?.scope ?? this.nearestScope).setExperience(this, type);
    }

    async getExperience(): Promise<ChildVisualization | undefined> {
        const visualization = await this.getVisualization();
        if (visualization instanceof BasicVisualization) {
            return visualization.view;
        } else {
            return undefined; // no experience set
        }
    }

    /*     async getStandaloneParent(): Promise<WithIndexedContext<Canvas, IndexableCanvas>[] | null> {
            let current: WithIndexedContext<Canvas, IndexableCanvas> | undefined = await this.getSelfIndexedCoerced();
            const chain: WithIndexedContext<Canvas, IndexableCanvas>[] = [];
            while (current) {
                chain.push(current);
                const parent = await current.loadParent();
                if (!parent) break;
                current = parent;
            }
            return chain.reverse();
        } */

    async getSelfIndexed(): Promise<WithContext<IndexableCanvas> | undefined> {
        const scope = this.nearestScope;
        const indexed = await scope.replies.index.get(this.id, {
            resolve: false,
            waitFor: 1e4, // wait for 10 seconds, this cover cases where we have pending syncs, TODO why is this really needed?
            local: true,
            remote: { strategy: "fallback", timeout: 1e4 },
        });
        return indexed as WithContext<IndexableCanvas> | undefined;
    }

    async getSelfIndexedCoerced(): Promise<
        WithIndexedContext<Canvas, IndexableCanvas> | undefined
    > {
        const indexed = await this.getSelfIndexed();
        if (!indexed) {
            return undefined;
        }
        return coerceWithContext(
            coerceWithIndexed(this as Canvas, indexed),
            indexed.__context
        );
    }

    async createElement(
        element: Element,
        options?: {
            skipReindex?: boolean;
            unique?: boolean;
        }
    ): Promise<void> {
        // Central implicit bulk logic (applies to all element creations)
        const now = Date.now();
        if (!this._implicitBulk) {
            this._implicitBulk = { count: 0, windowStart: now };
        }
        if (now - this._implicitBulk.windowStart > 150) {
            this._implicitBulk.windowStart = now;
            this._implicitBulk.count = 0;
            this._implicitBulk.active = false;
        }
        this._implicitBulk.count++;
        if (this._implicitBulk.count === 1) {
            this._implicitBulkTimer && clearTimeout(this._implicitBulkTimer);
            this._implicitBulkTimer = setTimeout(() => {
                if (this._bulkInsertDepth > 0 && this._implicitBulk?.active) {
                    this.endBulk().catch(() => {});
                }
                this._implicitBulk = undefined;
            }, 160);
        }
        if (!this._implicitBulk.active && this._implicitBulk.count >= 5) {
            this._implicitBulk.active = true;
            this.beginBulk();
        }

        const scope = this.nearestScope;
        await scope.elements.put(element, { unique: options?.unique });
        const suppress =
            options?.skipReindex ||
            this._bulkInsertDepth > 0 ||
            scope.isReindexSuppressed;
        if (!suppress) {
            await scope._hierarchicalReindex!.add({
                canvas: this,
                options: { onlyReplies: false, skipAncestors: true },
            });
        }
    }

    get messages(): RPC<CanvasMessage, CanvasMessage> {
        return this.nearestScope.messages;
    }

    async loadContext(options?: {
        reload?: boolean;
        waitFor?: boolean;
    }): Promise<Context> {
        if ((this as WithContext<any>).__context && !options?.reload) {
            return (this as WithContext<any>).__context;
        }

        /*    await this.load(); */
        if (!this.nearestScope) {
            throw new Error("Missing origin when loading context");
        }

        const withContext =
            (
                await this.nearestScope.replies.index.index.get(toId(this.id), {
                    shape: {
                        id: true,
                        __context: true,
                    },
                })
            )?.value.__context ||
            (
                await this.nearestScope.replies.index.get(toId(this.id), {
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

    isOwning(element: Element) {
        return equals(element.canvasId, this.id);
    }

    /* async openWithSameSettings<T extends Canvas | WithContext<Canvas>>(
        toOpen: T | string
    ): Promise<T> {
        return this.nearestScope.openWithSameSettings(toOpen);
    } */

    async addTextElement(
        text: string,
        options?: {
            id?: Uint8Array;
            skipReindex?: boolean;
        }
    ): Promise<void> {
        /*   await this.load(); */

        let elementId = options?.id || randomBytes(32);
        if (
            options?.id &&
            (await this.elements.index.get(toId(elementId), {
                local: true,
                remote: false /* {
                    strategy: "fallback",
                }, */,
            }))
        ) {
            return;
        }
        return this.createElement(
            new Element({
                location: Layout.zero(),
                id: elementId,
                publicKey: this.nearestScope.node.identity.publicKey,
                content: new StaticContent({
                    content: new StaticMarkdownText({
                        text,
                    }),
                    quality: LOWEST_QUALITY,
                    contentId: sha256Sync(new TextEncoder().encode(text)),
                }),
                canvasId: this.id,
            }),
            { ...options, unique: options?.id == null }
        );
    }

    /**
     * Batch insert many text elements with a single reindex flush.
     * - Uses beginBulk/endBulk to suppress intermediate reindexes.
     * - Pre-generates random IDs in a single buffer to reduce crypto overhead.
     */
    async addTextElements(texts: string[]): Promise<void> {
        if (!texts.length) return;
        this.beginBulk();
        try {
            // Pre-generate ids (concatenate into one buffer for fewer syscalls)
            const buf = randomBytes(32 * texts.length);
            const scope = this.nearestScope;
            const puts: Promise<any>[] = [];
            for (let i = 0; i < texts.length; i++) {
                const id = buf.slice(i * 32, (i + 1) * 32);
                const element = new Element({
                    location: Layout.zero(),
                    id,
                    publicKey: scope.node.identity.publicKey,
                    content: new StaticContent({
                        content: new StaticMarkdownText({ text: texts[i] }),
                        quality: LOWEST_QUALITY,
                        contentId: sha256Sync(
                            new TextEncoder().encode(texts[i])
                        ),
                    }),
                    canvasId: this.id,
                });
                // Directly use elements.put to avoid per-element implicit bulk bookkeeping in createElement
                puts.push(scope.elements.put(element));
            }
            await Promise.all(puts);
        } finally {
            await this.endBulk();
        }
    }

    // -------- BULK INSERT OPTIMIZATION ---------
    private _bulkInsertDepth: number = 0;
    private _implicitBulk?: {
        count: number;
        windowStart: number;
        active?: boolean;
    };
    private _implicitBulkTimer: any;
    /**
     * Wrap many element mutations to coalesce reindex work.
     * Usage:
     *   canvas.beginBulk();
     *   for (...) await canvas.addTextElement(...);
     *   await canvas.endBulk();
     */
    beginBulk() {
        this._bulkInsertDepth++;
    }
    async endBulk(options?: { forceReindex?: boolean }) {
        if (this._bulkInsertDepth > 0) this._bulkInsertDepth--;
        if (this._bulkInsertDepth === 0) {
            if (options?.forceReindex !== false) {
                // Schedule a single reindex now
                await this.nearestScope._hierarchicalReindex!.add({
                    canvas: this,
                    options: { onlyReplies: false, skipAncestors: true },
                });
            }
        }
    }

    /*   async copyInto(
          dst: Canvas 
      ): Promise<Canvas> {
          return copyCanvasInto(this, dst);
     
      } */

    /*  async cloneInto(
         dstParent: Canvas,
         options?: { skipFlush?: boolean, id?: Uint8Array, debug?: boolean }
     ): Promise<Canvas> {
         const linkTranslationMap = new Map<string, Canvas>();
         this.lastPathCanvas && linkTranslationMap.set(toBase64(this.lastPathCanvas), dstParent);
         return cloneCanvasInto(this, dstParent, {
             ...options,
             linkTranslationMap: linkTranslationMap,
         });
     } */

    clone(): Canvas {
        return deserialize(serialize(this), Canvas);
    }

    toBase64Url() {
        // Convert to a base64 URL-safe string representation
        return toBase64URL(serialize(this));
    }

    static fromBase64Url(base64Url: string) {
        return deserialize(fromBase64URL(base64Url), Canvas);
    }

    async isEmpty(): Promise<boolean> {
        const count = await this.elements.count({
            query: getOwnedElementsQuery(this),
            approximate: true,
        });
        if (count > 0) {
            return false;
        }
        if (count === 1) {
            const first = await this.elements.index
                .iterate({ query: getOwnedElementsQuery(this) })
                .first();
            if (first && first.content.isEmpty) {
                // only one element and it is empty
                return true;
            }
            return false;
        }
        return true;
    }
}
/* export const openCanvasWithAddress = async (root: Canvas | Scope, address: string, scopes?: Scope[]): Promise<Canvas> => {
    const rootScope = root instanceof Canvas ? root.nearestScope : root;
    if (rootScope && !scopes?.find(scope => scope.address === rootScope.address)) {
        scopes = [...scopes || [], rootScope];
    }

    if (scopes) {
        for (const scope of scopes) {
            const iteration = scope.replies.index.iterate({ query: { address: address } }, { resolve: true, local: true, remote: { strategy: "fallback", timeout: 1e4 } });
            const first = (await iteration.next(1))[0];
            await iteration.close();
            if (first) {
                return scope.openWithSameSettings<Canvas>(first);
            }
        }
    }
    return root.openWithSameSettings(address);
} */

/*
 WE CAN NOT USE BELOW YET BECAUSE WE CAN NOT HAVE CIRCULAR DEPENDENCIE
 client.open( canvas, { resuse: true } )
 does not correctly respect cirdcular references
 */

/* @variant(1)
export class CanvasValueReference extends AddressReference {
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
} */

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

/**
 * Options that control how the diff is performed
 */
export interface CanvasDiffOptions {
    /** When true we walk the whole reply-tree; otherwise only the two roots are compared */
    recursive?: boolean;
    /**
     * If true we treat the *order* of children as significant when comparing links
     * (useful when layouts have a z-index that matters); defaults to false.
     */
    orderSensitiveLinks?: boolean;
}

/**
 * A minimal, structural diff result.  Expand it with more detail if you wish
 * (e.g. lists of added / removed IDs, hashes, etc.)
 */
export interface CanvasDiffResult {
    elementsChanged: boolean;
    linksChanged: boolean;
    visualisationChanged: boolean;
    /** Only filled when `recursive === true` */
    children?: Record<string /* child-id in base64 */, CanvasDiffResult>;
    /** Convenience flag: *any* difference at this node or below? */
    different: boolean;
}

/**
 * Async helper that loads all owned elements for a canvas and
 * returns a *stable* hash you can compare cheaply.
 * Here we hash: id ‖ quality ‖ contentId ‖ location.(x,y,z,w,h,breakpoint)
 */
async function getElementHash(
    canvas: Canvas,
    scope: Scope
): Promise<Uint8Array> {
    const els = await (scope || canvas).elements.index
        .iterate({ query: getOwnedElementsQuery(canvas) }, { resolve: false })
        .all();

    // Build a deterministic byte buffer
    const buf: Uint8Array[] = [];
    els.sort((a, b) => compare(a.id, b.id)).forEach((e) => {
        buf.push(serialize(e));
    });

    return sha256Sync(concat(buf));
}

/** Similar helper for LinkPlacement */
async function getLinkHash(
    canvas: Canvas,
    scope: Scope,
    orderSensitive = false
): Promise<Uint8Array> {
    const links = (await scope.links.index
        .iterate({ query: [getChildrenLinksQuery(canvas.id)] })
        .all()) as Link[];

    const sorted = orderSensitive
        ? links
        : links.sort((a, b) => compare(a.child.canvasId, b.child.canvasId));
    const buf: Uint8Array[] = [];
    sorted.forEach((l) => buf.push(serialize(l)));
    return sha256Sync(concat(buf));
}

/** Hash for BasicVisualization (or any subclass) */
async function getVisualisationHash(
    canvas: Canvas,
    scope?: Scope
): Promise<Uint8Array> {
    const v = await (scope || canvas.nearestScope).getVisualization(canvas);
    return v ? sha256Sync(serialize(v)) : new Uint8Array(32); // zero-hash when none
}

/**
 * Compare two canvases.  The algorithm is *O(n)* over the reply tree
 * and uses SHA-256 digests so large canvases are compared quickly.
 */
export async function diffCanvases(
    a: { canvas: Canvas; scope?: Scope },
    b: { canvas: Canvas; scope?: Scope },
    opts: CanvasDiffOptions = {}
): Promise<boolean> {
    /* 0️⃣ open with identical replication settings */
    const [ca, cb] = await Promise.all([
        (a.scope || a.canvas.nearestScope).openWithSameSettings(a.canvas),
        (b.scope || b.canvas.nearestScope).openWithSameSettings(b.canvas),
    ]);

    /* 1️⃣ elements ---------------------------------------------------------- */
    if (
        !equals(
            await getElementHash(ca, a.scope || a.canvas.nearestScope),
            await getElementHash(cb, b.scope || b.canvas.nearestScope)
        )
    ) {
        return true;
    }

    /* 2️⃣ visualisation ----------------------------------------------------- */
    if (
        !equals(
            await getVisualisationHash(ca, a.scope || a.canvas.nearestScope),
            await getVisualisationHash(cb, b.scope || b.canvas.nearestScope)
        )
    ) {
        return true;
    }

    /* 3️⃣ links ------------------------------------------------------------- */
    if (
        !equals(
            await getLinkHash(
                ca,
                a.scope || a.canvas.nearestScope,
                opts.orderSensitiveLinks
            ),
            await getLinkHash(
                cb,
                b.scope || b.canvas.nearestScope,
                opts.orderSensitiveLinks
            )
        )
    ) {
        return true;
    }

    /* 4️⃣ recurse into direct replies (only if requested) ------------------ */
    if (opts.recursive) {
        const [kidsA, kidsB] = await Promise.all([
            ca.getChildren(),
            cb.getChildren(),
        ]);

        /* quick set-difference test – if #children differs we can stop here */
        if (kidsA.length !== kidsB.length) return true;

        const byId = (c: Canvas) => toBase64(c.id);
        const mapB = new Map(kidsB.map((k) => [byId(k), k]));

        for (const childA of kidsA) {
            const childB = mapB.get(byId(childA));
            if (!childB) return true; // missing counterpart

            /* recurse; bail as soon as any subtree differs */
            if (
                await diffCanvases(
                    { canvas: childA, scope: a.scope },
                    { canvas: childB, scope: b.scope },
                    opts
                )
            ) {
                return true;
            }
        }
    }

    /* identical */
    return false;
}
