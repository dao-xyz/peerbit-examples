// Test-only split-plane model. This is NOT a shared-fs wire format or migration.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { field, variant, vec } from "@dao-xyz/borsh";

export const digest = (bytes: Uint8Array | string) =>
    createHash("sha256").update(bytes).digest("hex");

@variant("shared-fs-placement-probe-chunk-v1")
export class PlacementChunk {
    @field({ type: "string" }) id: string;
    @field({ type: Uint8Array }) data: Uint8Array;
    constructor(data?: Uint8Array) {
        if (data) {
            this.id = digest(data);
            this.data = data;
        }
    }
}

@variant("shared-fs-placement-probe-chunk-row-v1")
export class PlacementChunkRow {
    @field({ type: "string" }) id: string;
    @field({ type: "u32" }) bytes: number;
    constructor(chunk?: PlacementChunk) {
        if (chunk) {
            this.id = chunk.id;
            this.bytes = chunk.data.length;
        }
    }
}

@variant("shared-fs-placement-probe-manifest-v1")
export class PlacementManifest {
    @field({ type: "string" }) id: string;
    @field({ type: vec("string") }) chunkIds: string[];
    @field({ type: vec("u32") }) chunkBytes: number[];
    @field({ type: "u32" }) bytes: number;
    @field({ type: "string" }) hash: string;
    constructor(id?: string, chunks?: PlacementChunk[]) {
        if (id && chunks) {
            this.id = id;
            this.chunkIds = chunks.map((chunk) => chunk.id);
            this.chunkBytes = chunks.map((chunk) => chunk.data.length);
            this.bytes = this.chunkBytes.reduce((a, b) => a + b, 0);
            this.hash = digest(
                Buffer.concat(chunks.map((chunk) => chunk.data))
            );
        }
    }
}

export const fixtureFile = (file: number, chunkBytes: number) => {
    assert(Number.isSafeInteger(file) && file >= 0 && file < 128);
    assert(
        Number.isSafeInteger(chunkBytes) &&
            chunkBytes >= 256 &&
            chunkBytes <= 65_536
    );
    // Mix single- and four-chunk files; each chunk has independent bytes.
    const chunks = Array.from({ length: file % 4 === 0 ? 4 : 1 }, (_, part) => {
        const bytes = Buffer.alloc(chunkBytes);
        for (let offset = 0; offset < bytes.length; offset += 32) {
            const block = createHash("sha256")
                .update(`shared-fs-placement-v1:${file}:${part}:${offset}`)
                .digest();
            bytes.set(
                block.subarray(0, Math.min(32, bytes.length - offset)),
                offset
            );
        }
        return new PlacementChunk(bytes);
    });
    return {
        chunks,
        manifest: new PlacementManifest(`/file-${file}.bin`, chunks),
    };
};

export const verifyChunk = (chunk: PlacementChunk) =>
    chunk instanceof PlacementChunk && digest(chunk.data) === chunk.id;

export const storeId = (run: string, plane: "metadata" | "chunks") =>
    new Uint8Array(createHash("sha256").update(`${run}:${plane}`).digest());

export type PlacementCommand =
    | { type: "dial"; addresses: string[][] }
    | { type: "write"; files: number[]; chunkBytes: number }
    | { type: "snapshot"; verify?: boolean }
    | { type: "read"; files: number[]; chunkBytes: number; remote: boolean }
    | { type: "budget"; bytes: number }
    | { type: "barrier" }
    | { type: "stop" };

export type PlacementConfig = {
    peer: number;
    directory: string;
    run: string;
    mode: "full" | "adaptive";
    capacityBytes: number | null;
    offline: boolean;
    minCopies: number;
};
