import { field, fixedArray, variant } from "@dao-xyz/borsh";
import { ProgramClient } from "@peerbit/program";
import { WithIndexedContext } from "@peerbit/document";
import { AddressReference, Canvas, IndexableCanvas, Scope } from "./content";

/** Options for opening the underlying Scope/Canvas */
export type ScopeOpenOpts = {
    /** How to handle existing scope instances (default 'reuse') */
    existing?: "reuse" | undefined;
    /** Whatever your Scope open args are (e.g. { replicate: boolean }) */
    args?: any;
};

type IndexedReturn<Indexed extends boolean | undefined> = Indexed extends true
    ? WithIndexedContext<Canvas, IndexableCanvas>
    : Canvas;

type IndexedOpt<Indexed extends boolean | undefined> = ScopeOpenOpts & {
    indexed?: Indexed;
};

/** Open a scope by address with optional args */
async function openScopeByAddress(
    node: ProgramClient,
    address: string,
    opts?: ScopeOpenOpts
): Promise<Scope> {
    return node.open<Scope>(address, {
        existing: opts?.existing ?? "reuse",
        args: opts?.args,
    });
}

/** Open a Canvas in its home scope, optionally returning the indexed wrapper */
// overloads for better inference
async function openInHome(
    node: ProgramClient,
    canvas: Canvas,
    opts: IndexedOpt<true>
): Promise<WithIndexedContext<Canvas, IndexableCanvas>>;
async function openInHome(
    node: ProgramClient,
    canvas: Canvas,
    opts?: IndexedOpt<false | undefined>
): Promise<Canvas>;
async function openInHome<Idx extends boolean | undefined>(
    node: ProgramClient,
    canvas: Canvas,
    opts?: IndexedOpt<Idx>
): Promise<IndexedReturn<Idx>> {
    if (!canvas.selfScope) throw new Error("Canvas has no selfScope set");
    const home = await openScopeByAddress(node, canvas.selfScope.address, opts);
    const opened = await home.openWithSameSettings(canvas);

    if (opts?.indexed) {
        const indexed = await opened.getSelfIndexedCoerced();
        if (!indexed) {
            throw new Error(
                "Failed to get indexed Canvas after opening in home scope"
            );
        }
        if (!indexed.initialized) {
            throw new Error("Indexed Canvas not initialized");
        }
        return indexed as IndexedReturn<Idx>;
    }

    return opened as IndexedReturn<Idx>;
}

/** Base class for references that can resolve themselves. */
export abstract class CanvasReference {
    /** Resolve into an OPEN Canvas; set indexed:true to get indexed wrapper. */
    // overloads for precise typing
    abstract resolve(
        node: ProgramClient,
        opts: IndexedOpt<true>
    ): Promise<WithIndexedContext<Canvas, IndexableCanvas>>;
    abstract resolve(
        node: ProgramClient,
        opts?: IndexedOpt<false | undefined>
    ): Promise<Canvas>;
    abstract resolve<Idx extends boolean | undefined>(
        node: ProgramClient,
        opts?: IndexedOpt<Idx>
    ): Promise<IndexedReturn<Idx>>;

    /** Batch convenience with per-call options. */
    static resolveAll(
        node: ProgramClient,
        refs: (Canvas | CanvasReference)[],
        opts: IndexedOpt<true>
    ): Promise<WithIndexedContext<Canvas, IndexableCanvas>[]>;
    static resolveAll(
        node: ProgramClient,
        refs: (Canvas | CanvasReference)[],
        opts?: IndexedOpt<false | undefined>
    ): Promise<Canvas[]>;
    static async resolveAll<Idx extends boolean | undefined>(
        node: ProgramClient,
        refs: (Canvas | CanvasReference)[],
        opts?: IndexedOpt<Idx>
    ): Promise<IndexedReturn<Idx>[]> {
        return Promise.all(
            refs.map((r) =>
                r instanceof Canvas
                    ? openInHome(node, r, opts as any)
                    : r.resolve(node, opts as any)
            )
        );
    }

    abstract get id(): Uint8Array;
}

@variant(0)
export class CanvasAddressReference extends CanvasReference {
    @field({ type: fixedArray("u8", 32) })
    id: Uint8Array;

    @field({ type: AddressReference })
    scope: AddressReference;

    constructor(p: { id: Uint8Array; scope: AddressReference }) {
        super();
        this.id = p.id;
        this.scope = p.scope;
    }

    // overloads
    async resolve(
        node: ProgramClient,
        opts: IndexedOpt<true>
    ): Promise<WithIndexedContext<Canvas, IndexableCanvas>>;
    async resolve(
        node: ProgramClient,
        opts?: IndexedOpt<false | undefined>
    ): Promise<Canvas>;
    async resolve<Idx extends boolean | undefined>(
        node: ProgramClient,
        opts?: IndexedOpt<Idx>
    ): Promise<IndexedReturn<Idx>> {
        const home = await openScopeByAddress(node, this.scope.address, opts);

        // Minimal stub is enough; openWithSameSettings hydrates it.
        const stub = new Canvas({
            id: this.id,
            publicKey: home.node.identity.publicKey,
            selfScope: this.scope, // keep canonical home info
        });

        const opened = await home.openWithSameSettings(stub);

        if (opts?.indexed) {
            const indexed = await opened.getSelfIndexedCoerced();
            if (!indexed)
                throw new Error(
                    "Failed to get indexed Canvas after opening in home scope"
                );
            if (!indexed.initialized)
                throw new Error("Indexed Canvas not initialized");
            return indexed as IndexedReturn<Idx>;
        }

        return opened as IndexedReturn<Idx>;
    }
}

@variant(1)
export class CanvasValueReference extends CanvasReference {
    @field({ type: Canvas })
    value: Canvas;

    constructor(p: { value: Canvas }) {
        super();
        this.value = p.value;
    }

    // overloads
    async resolve(
        node: ProgramClient,
        opts: IndexedOpt<true>
    ): Promise<WithIndexedContext<Canvas, IndexableCanvas>>;
    async resolve(
        node: ProgramClient,
        opts?: IndexedOpt<false | undefined>
    ): Promise<Canvas>;
    async resolve<Idx extends boolean | undefined>(
        node: ProgramClient,
        opts?: IndexedOpt<Idx>
    ): Promise<IndexedReturn<Idx>> {
        return openInHome(node, this.value, opts as any);
    }

    get id() {
        return this.value.id;
    }
}

/* ---------- Ergonomic helpers on Canvas itself ---------- */

export function toValueReference(canvas: Canvas): CanvasValueReference {
    return new CanvasValueReference({ value: canvas });
}

export function toAddressReference(canvas: Canvas): CanvasAddressReference {
    if (!canvas.selfScope) throw new Error("Canvas has no selfScope set");
    return new CanvasAddressReference({
        id: canvas.id,
        scope: canvas.selfScope,
    });
}

/** Fallback resolver for mixed inputs (Canvas | CanvasReference) */
// overloads
export function resolveCanvas(
    node: ProgramClient,
    input: Canvas | CanvasReference,
    opts: IndexedOpt<true>
): Promise<WithIndexedContext<Canvas, IndexableCanvas>>;
export function resolveCanvas(
    node: ProgramClient,
    input: Canvas | CanvasReference,
    opts?: IndexedOpt<false | undefined>
): Promise<Canvas>;
export async function resolveCanvas<Idx extends boolean | undefined>(
    node: ProgramClient,
    input: Canvas | CanvasReference,
    opts?: IndexedOpt<Idx>
): Promise<IndexedReturn<Idx>> {
    return input instanceof Canvas
        ? openInHome(node, input, opts as any)
        : (input.resolve(node, opts as any) as Promise<IndexedReturn<Idx>>);
}
