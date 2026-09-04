import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
    BoundedIpcByteReader,
    IpcFrameTooLargeError,
    IpcUnexpectedEofError,
} from "../ipc-byte-reader.js";

const byteSource = (...chunks: Uint8Array[]): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
        yield* chunks;
    },
});

const oneByteSource = (bytes: Uint8Array): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
        for (const byte of bytes) {
            yield Buffer.from([byte]);
        }
    },
});

describe("bounded IPC byte reader", () => {
    it("reassembles a UTF-8 line fragmented at every byte", async () => {
        const payload = Buffer.from("before-😀-after", "utf8");
        const chunks = [...payload, 0x0a].map((byte) => Buffer.from([byte]));
        const reader = new BoundedIpcByteReader(
            byteSource(...chunks),
            payload.byteLength
        );

        const line = await reader.readLine();
        expect(line).toEqual(payload);
        expect(line?.toString("utf8")).toBe("before-😀-after");
        await expect(reader.readLine()).resolves.toBeUndefined();
    });

    it("retains coalesced lines and a binary tail", async () => {
        const reader = new BoundedIpcByteReader(
            byteSource(Buffer.from("one\ntwo\nabc")),
            16
        );

        await expect(reader.readLine()).resolves.toEqual(Buffer.from("one"));
        expect(reader.bufferedByteLength).toBe(7);
        await expect(reader.readLine()).resolves.toEqual(Buffer.from("two"));
        expect(reader.bufferedByteLength).toBe(3);
        await expect(reader.readExactly(3)).resolves.toEqual(
            Buffer.from("abc")
        );
        expect(reader.bufferedByteLength).toBe(0);
        await expect(reader.readLine()).resolves.toBeUndefined();
    });

    it("accepts an exact line bound with a separately fragmented LF", async () => {
        const reader = new BoundedIpcByteReader(
            byteSource(Buffer.from("1234"), Buffer.from("\n")),
            4
        );

        await expect(reader.readLine()).resolves.toEqual(Buffer.from("1234"));
    });

    it("rejects a line at the first byte beyond its bound", async () => {
        const reader = new BoundedIpcByteReader(
            byteSource(
                Buffer.from("12"),
                Buffer.from("34"),
                Buffer.from("5\n")
            ),
            4
        );

        await expect(reader.readLine()).rejects.toEqual(
            expect.objectContaining<IpcFrameTooLargeError>({
                name: "IpcFrameTooLargeError",
                actualBytes: 5,
                maxBytes: 4,
            })
        );
    });

    it("bounds bookkeeping for a large line fragmented one byte at a time", async () => {
        const payload = Buffer.alloc(128 * 1024, 0x61);
        const reader = new BoundedIpcByteReader(
            oneByteSource(Buffer.concat([payload, Buffer.from("\n")])),
            payload.byteLength
        );

        await expect(reader.readLine()).resolves.toEqual(payload);
        await expect(reader.readLine()).resolves.toBeUndefined();
    });

    it("reads an exact fragmented body and preserves the following frame", async () => {
        const reader = new BoundedIpcByteReader(
            byteSource(
                Buffer.from([0x00]),
                Buffer.from([0x0a, 0xff, 0x74, 0x61]),
                Buffer.from("il\n")
            ),
            8
        );

        await expect(reader.readExactly(3)).resolves.toEqual(
            Buffer.from([0x00, 0x0a, 0xff])
        );
        expect(reader.bufferedByteLength).toBe(2);
        await expect(reader.readLine()).resolves.toEqual(Buffer.from("tail"));
    });

    it("rejects an exact read over the cap without consuming input", async () => {
        const reader = new BoundedIpcByteReader(
            byteSource(Buffer.from("abc")),
            2
        );

        await expect(reader.readExactly(3)).rejects.toBeInstanceOf(
            IpcFrameTooLargeError
        );
        await expect(reader.readExactly(2)).resolves.toEqual(Buffer.from("ab"));
        expect(reader.bufferedByteLength).toBe(1);
    });

    it("copies an exact body fragmented one byte at a time", async () => {
        const payload = Buffer.allocUnsafe(128 * 1024);
        for (let index = 0; index < payload.byteLength; index++) {
            payload[index] = index % 251;
        }
        const reader = new BoundedIpcByteReader(
            oneByteSource(payload),
            payload.byteLength
        );

        await expect(reader.readExactly(payload.byteLength)).resolves.toEqual(
            payload
        );
        expect(reader.bufferedByteLength).toBe(0);
    });

    it("returns a contiguous exact body without copying and retains its tail", async () => {
        const chunk = Buffer.from("bodytail");
        const reader = new BoundedIpcByteReader(byteSource(chunk), 8);

        const body = await reader.readExactly(4);
        expect(body).toEqual(Buffer.from("body"));
        expect(body.buffer).toBe(chunk.buffer);
        expect(body.byteOffset).toBe(chunk.byteOffset);
        expect(reader.bufferedByteLength).toBe(4);
        await expect(reader.readExactly(4)).resolves.toEqual(
            Buffer.from("tail")
        );
    });

    it.each([31, 32, 33, 34])(
        "preserves a line across %i retained-fragment threshold chunks",
        async (fragmentCount) => {
            const chunks = Array.from({ length: fragmentCount }, () =>
                Buffer.from("x")
            );
            chunks.push(Buffer.from("\n"));
            const reader = new BoundedIpcByteReader(
                byteSource(...chunks),
                fragmentCount
            );

            await expect(reader.readLine()).resolves.toEqual(
                Buffer.alloc(fragmentCount, 0x78)
            );
            await expect(reader.readLine()).resolves.toBeUndefined();
        }
    );

    it("distinguishes clean EOF from partial line and exact-read EOF", async () => {
        const clean = new BoundedIpcByteReader(byteSource(), 8);
        await expect(clean.readLine()).resolves.toBeUndefined();

        const partialLine = new BoundedIpcByteReader(
            byteSource(Buffer.from("abc")),
            8
        );
        await expect(partialLine.readLine()).rejects.toBeInstanceOf(
            IpcUnexpectedEofError
        );

        const partialBody = new BoundedIpcByteReader(
            byteSource(Buffer.from("abc")),
            8
        );
        await expect(partialBody.readExactly(4)).rejects.toMatchObject({
            name: "IpcUnexpectedEofError",
            message: "IPC stream ended after 3 of 4 required byte(s)",
        });
    });

    it("skips empty chunks and permits a zero-byte exact read", async () => {
        const reader = new BoundedIpcByteReader(
            byteSource(Buffer.alloc(0), Buffer.from("x\n")),
            1
        );

        await expect(reader.readExactly(0)).resolves.toEqual(Buffer.alloc(0));
        await expect(reader.readLine()).resolves.toEqual(Buffer.from("x"));
    });

    it("rejects concurrent reads without corrupting the pending read", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const source: AsyncIterable<Uint8Array> = {
            async *[Symbol.asyncIterator]() {
                await gate;
                yield Buffer.from("ok\n");
            },
        };
        const reader = new BoundedIpcByteReader(source, 8);

        const pending = reader.readLine();
        await expect(reader.readLine()).rejects.toThrow(
            "Concurrent IPC byte reads are not supported"
        );
        release();
        await expect(pending).resolves.toEqual(Buffer.from("ok"));
    });

    it("propagates errors from the underlying byte source", async () => {
        const source: AsyncIterable<Uint8Array> = {
            async *[Symbol.asyncIterator]() {
                yield Buffer.from("partial");
                throw new Error("source failed");
            },
        };
        const reader = new BoundedIpcByteReader(source, 16);

        await expect(reader.readLine()).rejects.toThrow("source failed");
    });
});

describe("IPC v2 golden vectors", () => {
    it("reconstructs every normative byte sequence", async () => {
        const vectors = JSON.parse(
            await readFile(
                new URL(
                    "../../../protocol/ipc-v2-vectors.json",
                    import.meta.url
                ),
                "utf8"
            )
        ) as {
            constants: {
                magicAscii: string;
                version: number;
                headerBytes: number;
            };
            negotiation: {
                name: string;
                jsonLineUtf8: string;
                jsonLineHex: string;
            }[];
            frames: {
                kind: "request" | "response";
                kindCode: number;
                metadataUtf8: string;
                metadata: unknown;
                metadataBytes: number;
                bodyHex: string;
                bodyBytes: number;
                frameHex: string;
            }[];
        };

        for (const vector of vectors.negotiation) {
            expect(
                Buffer.from(vector.jsonLineUtf8, "utf8").toString("hex")
            ).toBe(vector.jsonLineHex);
            expect(vector.jsonLineUtf8.endsWith("\n")).toBe(true);
            expect(JSON.parse(vector.jsonLineUtf8.slice(0, -1))).toBeTypeOf(
                "object"
            );
        }

        for (const vector of vectors.frames) {
            const frame = Buffer.from(vector.frameHex, "hex");
            expect(vector.kindCode).toBe(vector.kind === "request" ? 1 : 2);
            expect(frame.subarray(0, 4).toString("ascii")).toBe(
                vectors.constants.magicAscii
            );
            expect(frame[4]).toBe(vectors.constants.version);
            expect(frame[5]).toBe(vector.kindCode);
            expect(frame.readUInt16BE(6)).toBe(0);

            const metadataBytes = frame.readUInt32BE(8);
            const bodyBytes = frame.readUInt32BE(12);
            expect(metadataBytes).toBe(vector.metadataBytes);
            expect(bodyBytes).toBe(vector.bodyBytes);
            expect(frame.byteLength).toBe(
                vectors.constants.headerBytes + metadataBytes + bodyBytes
            );

            const metadataStart = vectors.constants.headerBytes;
            const bodyStart = metadataStart + metadataBytes;
            const metadata = frame.subarray(metadataStart, bodyStart);
            const body = frame.subarray(bodyStart);
            expect(metadata.toString("utf8")).toBe(vector.metadataUtf8);
            expect(JSON.parse(metadata.toString("utf8"))).toEqual(
                vector.metadata
            );
            expect(body.toString("hex")).toBe(vector.bodyHex);
        }
    });
});
