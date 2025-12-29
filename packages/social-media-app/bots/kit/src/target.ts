import type { ProgramClient } from "@peerbit/program";
import { Canvas, Scope, createRoot } from "@giga-app/interface";

export type BotTargetArgs = {
    replicate?: boolean;
    scopeAddress?: string;
    parentCanvasId?: string | Uint8Array;
};

const normalizeBase64 = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const base64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const padding =
        base64.length % 4 ? "=".repeat(4 - (base64.length % 4)) : "";
    return base64 + padding;
};

export const decodeCanvasId = (value: string | Uint8Array): Uint8Array => {
    if (value instanceof Uint8Array) return value;

    const normalized = normalizeBase64(value);
    if (!normalized) {
        throw new Error("Canvas id is empty");
    }

    const bytes = new Uint8Array(Buffer.from(normalized, "base64"));
    if (bytes.length !== 32) {
        throw new Error(
            `Canvas id must be 32 bytes, got ${bytes.length}. Provide the base64/base64url encoded canvas.id bytes.`
        );
    }
    return bytes;
};

async function openScopeByAddress(
    node: ProgramClient,
    scopeAddress: string,
    replicate: boolean
): Promise<Scope> {
    return await node.open<Scope>(scopeAddress, {
        existing: "reuse",
        args: {
            replicate: replicate ? { factor: 1 } : false,
        },
    });
}

async function openCanvasInScope(
    scope: Scope,
    canvasId: Uint8Array
): Promise<Canvas> {
    const raw = await scope.replies.index.get(canvasId, {
        waitFor: 5_000,
        resolve: true,
        local: true,
        remote: {
            reach: { eager: true },
            strategy: "fallback",
            timeout: 10_000,
        },
    });
    if (!raw) {
        throw new Error(`Canvas not found in scope ${scope.address}`);
    }
    return await scope.openWithSameSettings(raw);
}

export async function resolveBotTarget(
    node: ProgramClient,
    args: BotTargetArgs
): Promise<{ scope: Scope; parent: Canvas }> {
    const replicate = args.replicate ?? true;

    if (args.scopeAddress) {
        const scope = await openScopeByAddress(
            node,
            args.scopeAddress,
            replicate
        );
        if (args.parentCanvasId) {
            const parentId = decodeCanvasId(args.parentCanvasId);
            const parent = await openCanvasInScope(scope, parentId);
            return { scope, parent };
        }

        const { scope: rootScope, canvas } = await createRoot(node, {
            scope,
            persisted: replicate,
        });
        return { scope: rootScope, parent: canvas };
    }

    const { scope, canvas } = await createRoot(node, { persisted: replicate });
    if (args.parentCanvasId) {
        const parentId = decodeCanvasId(args.parentCanvasId);
        const parent = await openCanvasInScope(scope, parentId);
        return { scope, parent };
    }

    return { scope, parent: canvas };
}
