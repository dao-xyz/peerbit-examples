import { deserialize, serialize } from "@dao-xyz/borsh";
import {
    AbstractFile,
    LargeFileWithChunkHeads,
    isLargeFileLike,
} from "@peerbit/please-lib";

export const roundtripReadyManifest = () => {
    const readyManifest = new LargeFileWithChunkHeads({
        id: "ready-manifest-browser-roundtrip",
        name: "ready-manifest-browser-roundtrip.bin",
        size: 10n * 1024n * 1024n,
        chunkCount: 20,
        ready: true,
        finalHash: "final-hash",
        chunkEntryHeads: Array.from(
            { length: 20 },
            (_, index) => `chunk-entry-head-${index}`
        ),
    });
    const encoded = serialize(readyManifest);
    const decoded = deserialize(encoded, AbstractFile);
    return {
        encodedLength: encoded.byteLength,
        firstByte: encoded[0],
        constructor: decoded.constructor.name,
        largeFileLike: isLargeFileLike(decoded),
        instanceOfLargeFileWithChunkHeads:
            decoded instanceof LargeFileWithChunkHeads,
        chunkEntryHeadCount:
            (decoded as { chunkEntryHeads?: unknown[] }).chunkEntryHeads
                ?.length ?? 0,
    };
};
