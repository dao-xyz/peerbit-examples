import { useEffect, useState } from "react";
import { usePeer } from "@peerbit/react";
import {
    Canvas,
    CanvasReference,
    IndexableCanvas,
    ScopeArgs,
} from "@giga-app/interface";
import { WithIndexedContext } from "@peerbit/document";
import { sha256Base64Sync } from "@peerbit/crypto";

/** Type guard: checks if the Canvas is already a WithIndexedContext */
function isIndexedCanvas(
    c: Canvas | WithIndexedContext<Canvas, IndexableCanvas> | CanvasReference
): c is WithIndexedContext<Canvas, IndexableCanvas> {
    return !!(c as any)?.__indexed;
}

/** Best-effort stable key for effect deps */
function stableKey(
    input?:
        | Canvas
        | WithIndexedContext<Canvas, IndexableCanvas>
        | CanvasReference
): string | undefined {
    if (!input) return undefined;

    // Raw Canvas → idString if available, else base64 of id
    if (input instanceof Canvas) {
        return `canvas:${(input as Canvas).idString}`;
    }

    // CanvasReference → prefer toBase64Url if implemented, else hex of .id
    const ref = input as CanvasReference;
    return sha256Base64Sync(ref.id);
}

/**
 * Returns a WithIndexedContext<Canvas, IndexableCanvas> for the given canvas/ref.
 * - If already indexed, returns it immediately.
 * - If CanvasReference, resolves via ref.resolve(node, { existing:'reuse', args }).
 * - If raw Canvas, loads it, opens with its home scope, then coerces to indexed.
 * - Defensively guards against stale async updates when inputs change.
 */
export const useInitializeCanvas = (
    canvasLike?:
        | Canvas
        | WithIndexedContext<Canvas, IndexableCanvas>
        | CanvasReference,
    args?: ScopeArgs
) => {
    const { peer } = usePeer();
    const [indexed, setIndexed] = useState<
        WithIndexedContext<Canvas, IndexableCanvas> | undefined
    >();

    useEffect(() => {
        if (!peer || !canvasLike) {
            setIndexed(undefined);
            return;
        }

        let alive = true;

        (async () => {
            // 1) Fast path: already indexed
            if (isIndexedCanvas(canvasLike)) {
                await canvasLike.load(peer, { args });
                if (alive)
                    setIndexed(
                        canvasLike as WithIndexedContext<
                            Canvas,
                            IndexableCanvas
                        >
                    );
                return;
            }

            // 2) CanvasReference path (has .resolve)
            if (canvasLike instanceof CanvasReference) {
                const opened = await canvasLike.resolve(peer, {
                    existing: "reuse",
                    args,
                });
                await opened.load(peer, { args });
                if (alive) setIndexed(opened);
                return;
            }

            // 3) Raw Canvas path
            const raw = canvasLike as Canvas;

            // Ensure the Canvas is loaded so nearestScope is available
            await raw.load(peer, { args });

            // Open with its home scope (nearestScope) if not already initialized
            const opened = raw.initialized
                ? raw
                : await raw.nearestScope.openWithSameSettings(raw);

            // Coerce to indexed wrapper
            const coerced = await opened.getSelfIndexedCoerced();
            if (alive) setIndexed(coerced);
        })().catch((err) => {
            console.error(
                "useInitializedCanvas: failed to open/index canvas",
                err
            );
            if (alive) setIndexed(undefined);
        });

        return () => {
            alive = false;
        };
        // Re-run when identity changes or the logical input changes
    }, [peer?.identity?.publicKey?.hashcode?.(), stableKey(canvasLike), args]);

    return indexed;
};
