import fs from "node:fs";
import { open as openFile, stat as statFile } from "node:fs/promises";
import type { ReReadableChunkSource } from "@peerbit/please-lib";

export const createPathSource = async (
    filePath: string
): Promise<ReReadableChunkSource> => {
    const stats = await statFile(filePath);
    return {
        size: BigInt(stats.size),
        async *readChunks(chunkSize: number) {
            for await (const chunk of fs.createReadStream(filePath, {
                highWaterMark: chunkSize,
            })) {
                yield chunk instanceof Uint8Array
                    ? chunk
                    : new Uint8Array(chunk);
            }
        },
    };
};

export const createPathWriter = async (filePath: string) => {
    const handle = await openFile(filePath, "w");
    let position = 0;
    let closed = false;

    const close = async () => {
        if (!closed) {
            closed = true;
            await handle.close();
        }
    };

    return {
        write: async (chunk: Uint8Array) => {
            const buffer = Buffer.from(
                chunk.buffer,
                chunk.byteOffset,
                chunk.byteLength
            );
            await handle.write(buffer, 0, buffer.byteLength, position);
            position += buffer.byteLength;
        },
        close,
        abort: async () => {
            await close();
        },
    };
};
