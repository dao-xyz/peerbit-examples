import { createHash } from "node:crypto";
import type { ProcessSoakContentExpectation } from "./process-isolated-soak.bench.protocol.js";

export const processSoakPayloadSeed = (value: string) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0 || 0x9e3779b9;
};

export const materializeProcessSoakContent = (
    content: ProcessSoakContentExpectation
) => {
    if (typeof content === "string") return content;
    let state = content.seed >>> 0 || 0x9e3779b9;
    const bytes = Buffer.allocUnsafe(content.bytes);
    for (let index = 0; index < bytes.byteLength; index++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        bytes[index] = 33 + ((state >>> 0) % 94);
    }
    return `${content.prefix}${bytes.toString("ascii")}`;
};

export const processSoakContentHash = (content: string | Uint8Array) =>
    createHash("sha256").update(content).digest("hex");

export const createProcessSoakGeneratedContent = (
    prefix: string,
    key: string,
    bytes: number
) => {
    const descriptor = {
        generator: "xorshift32-ascii-v1",
        prefix,
        seed: processSoakPayloadSeed(key),
        bytes,
        sha256: "",
    } satisfies Exclude<ProcessSoakContentExpectation, string>;
    const content = materializeProcessSoakContent(descriptor);
    return {
        content,
        expectation: {
            ...descriptor,
            sha256: processSoakContentHash(content),
        } satisfies Exclude<ProcessSoakContentExpectation, string>,
    };
};
