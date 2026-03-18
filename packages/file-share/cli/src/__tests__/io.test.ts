import crypto from "node:crypto";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createPathSource, createPathWriter } from "../io.js";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempDirs.splice(0).map((dir) =>
            rm(dir, { recursive: true, force: true })
        )
    );
});

describe("cli file io", () => {
    it("rereads a file in bounded chunks", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "please-cli-io-"));
        tempDirs.push(dir);
        const filePath = path.join(dir, "input.bin");
        const contents = crypto.randomBytes(1_100_321);
        await writeFile(filePath, contents);

        const source = await createPathSource(filePath);
        const read = async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of source.readChunks(256_000)) {
                expect(chunk.byteLength).toBeLessThanOrEqual(256_000);
                chunks.push(Buffer.from(chunk));
            }
            return Buffer.concat(chunks);
        };

        expect(source.size).toBe(BigInt(contents.byteLength));
        await expect(read()).resolves.toEqual(contents);
        await expect(read()).resolves.toEqual(contents);
    });

    it("writes streamed chunks to disk without joining them first", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "please-cli-io-"));
        tempDirs.push(dir);
        const filePath = path.join(dir, "output.bin");
        const parts = [
            crypto.randomBytes(17),
            crypto.randomBytes(512_000),
            crypto.randomBytes(31),
            crypto.randomBytes(768_123),
        ];
        const expected = Buffer.concat(parts);

        const writer = await createPathWriter(filePath);
        for (const part of parts) {
            await writer.write(part);
        }
        await writer.close();

        await expect(readFile(filePath)).resolves.toEqual(expected);
    });
});
