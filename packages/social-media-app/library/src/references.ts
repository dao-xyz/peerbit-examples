import { deserialize, field, fixedArray, serialize, variant } from "@dao-xyz/borsh";
import { ProgramClient } from "@peerbit/program";
import { WithIndexedContext } from "@peerbit/document";
import { AddressReference, Canvas, IndexableCanvas, Scope } from "./content";

/** Optional knobs for opening the underlying Scope */
export type ScopeOpenOpts = {
    existing?: "reuse" | "error" | "new";
    args?: any; // whatever your Scope open args are (e.g. { replicate: boolean } )
};

/** Common helper: open a scope by address with optional args */
async function openScopeByAddress(
    node: ProgramClient,
    address: string,
    opts?: ScopeOpenOpts
): Promise<Scope> {
    // If your Scope takes different ctor params, adapt here
    return node.open<Scope>(address, {
        existing: "reuse",
        args: opts?.args,
    });
}

/** Common helper: open a Canvas in *its* home scope, then return indexed wrapper */
async function openInHomeAndIndex(
    node: ProgramClient,
    canvas: Canvas
): Promise<WithIndexedContext<Canvas, IndexableCanvas>> {
    if (!canvas.selfScope) throw new Error("Canvas has no selfScope set");
    const home = await openScopeByAddress(node, canvas.selfScope.address);
    const opened = await home.openWithSameSettings(canvas);
    const indexed = await opened.getSelfIndexedCoerced();
    if (!indexed) {
        throw new Error("Failed to index Canvas after opening in home scope");
    }

    if (!indexed.initialized) {
        throw new Error("Unexpected");
    }

    return indexed;
}

/** Base class for references that can resolve themselves. */
export abstract class CanvasReference {
    /** Resolve into an OPEN + INDEXED Canvas, using the reference’s home scope. */
    abstract resolve(
        node: ProgramClient,
        opts?: ScopeOpenOpts
    ): Promise<WithIndexedContext<Canvas, IndexableCanvas>>;

    /** Batch convenience. */
    static async resolveAll(
        node: ProgramClient,
        refs: (Canvas | CanvasReference)[],
        opts?: ScopeOpenOpts
    ): Promise<WithIndexedContext<Canvas, IndexableCanvas>[]> {
        return Promise.all(
            refs.map((r) =>
                r instanceof Canvas ? openInHomeAndIndex(node, r) : r.resolve(node, opts)
            )
        );
    }

    abstract get id();


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

    /** Open the referenced scope, construct a stub Canvas, open & index it. */
    async resolve(
        node: ProgramClient,
        opts?: ScopeOpenOpts
    ): Promise<WithIndexedContext<Canvas, IndexableCanvas>> {
        const home = await openScopeByAddress(node, this.scope.address, opts);

        // Minimal stub is enough; openWithSameSettings hydrates it.
        const stub = new Canvas({
            id: this.id,
            publicKey: home.node.identity.publicKey,
            selfScope: this.scope, // keep canonical home info
        });

        const opened = await home.openWithSameSettings(stub);
        const indexed = await opened.getSelfIndexedCoerced();
        if (!indexed) {
            throw new Error("Failed to index Canvas after opening in home scope");
        }
        if (!indexed.initialized) {
            throw new Error("Unexpected");
        }
        return indexed;
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

    /** Use the value’s selfScope to open & index. */
    async resolve(
        node: ProgramClient,
        _opts?: ScopeOpenOpts
    ): Promise<WithIndexedContext<Canvas, IndexableCanvas>> {
        return openInHomeAndIndex(node, this.value);
    }

    get id() {
        return this.value.id;
    }
}

/* ---------- Optional ergonomic helpers on Canvas itself ---------- */

/** Convert a loaded Canvas into a value ref. */
export function toValueReference(canvas: Canvas): CanvasValueReference {
    return new CanvasValueReference({ value: canvas });
}

/** Convert to an address ref (requires selfScope to be present). */
export function toAddressReference(canvas: Canvas): CanvasAddressReference {
    if (!canvas.selfScope) throw new Error("Canvas has no selfScope set");
    return new CanvasAddressReference({ id: canvas.id, scope: canvas.selfScope });
}

/** Fallback resolver for mixed inputs (Canvas | CanvasReference). */
export async function resolveCanvas(
    node: ProgramClient,
    input: Canvas | CanvasReference,
    opts?: ScopeOpenOpts
): Promise<WithIndexedContext<Canvas, IndexableCanvas>> {
    return input instanceof Canvas
        ? openInHomeAndIndex(node, input)
        : input.resolve(node, opts);
}