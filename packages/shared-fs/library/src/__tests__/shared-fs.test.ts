import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    DEFAULT_FILE_CHUNK_SIZE,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const patternedBytes = (size: number) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.byteLength; i++) {
        bytes[i] = i % 251;
    }
    return bytes;
};

describe("shared fs library", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "test-machine",
        });
    });

    afterEach(async () => {
        await peer.stop();
    });

    it("creates, lists, reads, renames, deletes directories and files", async () => {
        await fs.mkdir("/docs");
        await fs.writeFile("/docs/hello.txt", "hello");

        expect(decode(await fs.readFile("/docs/hello.txt"))).toBe("hello");
        expect((await fs.list("/docs")).map((entry) => entry.name)).toEqual([
            "hello.txt",
        ]);

        await fs.rename("/docs/hello.txt", "/docs/greeting.txt");
        expect(await fs.readFile("/docs/hello.txt")).toBeUndefined();
        expect(decode(await fs.readFile("/docs/greeting.txt"))).toBe("hello");

        await fs.rm("/docs/greeting.txt");
        expect(await fs.readFile("/docs/greeting.txt")).toBeUndefined();

        await fs.rm("/docs");
        expect((await fs.list("/")).map((entry) => entry.name)).toEqual([]);
    });

    it("chunks and reads large files", async () => {
        const bytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE * 2 + 17);
        await fs.writeFile("/large.bin", bytes);

        expect(await fs.readFile("/large.bin")).toEqual(bytes);
        const [version] = await fs.versions("/large.bin");
        expect(version.size).toBe(BigInt(bytes.byteLength));
        expect(version.machineLabel).toBe("test-machine");
        expect(version.authorKey.length).toBeGreaterThan(0);
    });

    it("preserves concurrent versions and resolves conflicts explicitly", async () => {
        await fs.writeFile("/note.txt", "base");
        const base = (await fs.versions("/note.txt"))
            .filter((version) => version.head)
            .map((version) => version.id);

        const left = await fs.writeFile("/note.txt", "left", {
            baseVersionIds: base,
        });
        const right = await fs.writeFile("/note.txt", "right", {
            baseVersionIds: base,
        });

        const conflicts = await fs.conflicts();
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].path).toBe("/note.txt");
        expect(
            conflicts[0].versions.map((version) => version.id).sort()
        ).toEqual([left.id, right.id].sort());
        expect(decode(await fs.readVersion("/note.txt", right.id))).toBe(
            "right"
        );

        await fs.resolveConflict("/note.txt", left.id);

        expect(await fs.conflicts()).toEqual([]);
        expect(decode(await fs.readFile("/note.txt"))).toBe("left");
        expect(decode(await fs.readVersion("/note.txt", right.id))).toBe(
            "right"
        );
    });
});
