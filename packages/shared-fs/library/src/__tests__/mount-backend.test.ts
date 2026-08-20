import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    CONFLICTS_DIR,
    createSharedFsIpcClient,
    createSharedFsIpcServer,
    createSharedFsMountBackend,
    encodeConflictPathName,
    openSharedFs,
    parseFlags,
    type SharedFsHandle,
} from "../index.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

describe("shared fs mount backend", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "mount-test",
        });
    });

    afterEach(async () => {
        await peer.stop();
    });

    it("commits buffered writes on release", async () => {
        const backend = createSharedFsMountBackend(fs);
        await backend.mkdir("/docs");
        const handle = await backend.open("/docs/file.txt", {
            write: true,
            create: true,
            truncate: true,
        });

        expect(
            (await backend.readdir("/docs")).map((entry) => entry.name)
        ).toContain("file.txt");
        await backend.write(handle, encode("hello"), 0);
        expect((await backend.getattr("/docs/file.txt")).size).toBe(
            "hello".length
        );
        expect(await fs.readFile("/docs/file.txt")).toBeUndefined();

        await backend.release(handle);
        expect(decode(await fs.readFile("/docs/file.txt"))).toBe("hello");
    });

    it("exposes conflicts through the metadata namespace", async () => {
        const backend = createSharedFsMountBackend(fs);
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

        expect(
            (await backend.readdir("/")).map((entry) => entry.name)
        ).toContain(CONFLICTS_DIR);
        const conflictName = encodeConflictPathName("/note.txt");
        expect(
            (await backend.readdir(`/${CONFLICTS_DIR}`)).map(
                (entry) => entry.name
            )
        ).toEqual([conflictName]);
        expect(
            (await backend.readdir(`/${CONFLICTS_DIR}/${conflictName}`))
                .map((entry) => entry.name)
                .sort()
        ).toEqual([left.id, right.id].sort());

        const handle = await backend.open(
            `/${CONFLICTS_DIR}/${conflictName}/${right.id}`
        );
        expect(decode(await backend.read(handle, 1024, 0))).toBe("right");
        await backend.release(handle);
    });

    it("round-trips backend calls through local IPC", async () => {
        const backend = createSharedFsMountBackend(fs);
        const server = await createSharedFsIpcServer(backend);
        try {
            const client = createSharedFsIpcClient(server.endpoint);
            await client.mkdir("/ipc");
            const handle = await client.open("/ipc/file.txt", {
                write: true,
                create: true,
                truncate: true,
            });
            await client.write(handle, encode("over ipc"), 0);
            await client.release(handle);

            const stat = await client.getattr("/ipc/file.txt");
            expect(stat.kind).toBe("file");
            expect(stat.size).toBe("over ipc".length);
            expect(decode(await fs.readFile("/ipc/file.txt"))).toBe("over ipc");
        } finally {
            await server.close();
        }
    });

    it("truncates open handles and paths, shrinking and zero-fill growing", async () => {
        const backend = createSharedFsMountBackend(fs);
        await fs.writeFile("/trunc.txt", "long original content");

        // ftruncate-style: shrink via an open handle, then commit.
        const handle = await backend.open("/trunc.txt", {
            read: true,
            write: true,
        });
        await backend.truncate(handle, 4);
        await backend.release(handle);
        expect(decode(await fs.readFile("/trunc.txt"))).toBe("long");

        // truncate-style: grow by path; the tail must be zero-filled.
        await backend.truncate("/trunc.txt", 6);
        const grown = await fs.readFile("/trunc.txt");
        expect(grown).toBeDefined();
        expect(grown!.byteLength).toBe(6);
        expect(decode(grown!.subarray(0, 4))).toBe("long");
        expect([...grown!.subarray(4)]).toEqual([0, 0]);

        // Overwrite-shorter through open+truncate flags must not keep a stale tail.
        const rewrite = await backend.open("/trunc.txt", {
            write: true,
            truncate: true,
        });
        await backend.write(rewrite, encode("hi"), 0);
        await backend.release(rewrite);
        expect(decode(await fs.readFile("/trunc.txt"))).toBe("hi");
    });

    it("zero-fills sparse write gaps and bounds reads to the logical length", async () => {
        const backend = createSharedFsMountBackend(fs);
        const handle = await backend.open("/sparse.bin", {
            write: true,
            create: true,
            truncate: true,
        });
        await backend.write(handle, encode("ab"), 0);
        await backend.write(handle, encode("cd"), 6);
        const read = await backend.read(handle, 1024, 0);
        expect(read.byteLength).toBe(8);
        expect([...read]).toEqual([
            ..."ab".split("").map((c) => c.charCodeAt(0)),
            0,
            0,
            0,
            0,
            ..."cd".split("").map((c) => c.charCodeAt(0)),
        ]);
        await backend.release(handle);
        expect((await fs.readFile("/sparse.bin"))!.byteLength).toBe(8);
    });

    it("does not mint a new version when flushing unchanged content", async () => {
        const backend = createSharedFsMountBackend(fs);
        await fs.writeFile("/stable.txt", "same content");
        const versionsBefore = (await fs.versions("/stable.txt")).length;

        const handle = await backend.open("/stable.txt", {
            read: true,
            write: true,
        });
        await backend.flush(handle);
        await backend.fsync(handle);
        await backend.release(handle);
        expect((await fs.versions("/stable.txt")).length).toBe(versionsBefore);

        // A dirty handle with identical bytes is also a no-op save.
        const rewrite = await backend.open("/stable.txt", {
            read: true,
            write: true,
        });
        await backend.write(rewrite, encode("same content"), 0);
        await backend.flush(rewrite);
        await backend.release(rewrite);
        expect((await fs.versions("/stable.txt")).length).toBe(versionsBefore);

        // Changed bytes create exactly one new version across flush+release.
        const change = await backend.open("/stable.txt", {
            read: true,
            write: true,
        });
        await backend.write(change, encode("different!!!"), 0);
        await backend.flush(change);
        await backend.release(change);
        expect((await fs.versions("/stable.txt")).length).toBe(
            versionsBefore + 1
        );

        // O_TRUNC rewrite with identical content (shell `> file`, editors
        // that rewrite in place) is also a no-op save.
        const truncated = await backend.open("/stable.txt", {
            write: true,
            truncate: true,
        });
        await backend.write(truncated, encode("different!!!"), 0);
        await backend.release(truncated);
        expect((await fs.versions("/stable.txt")).length).toBe(
            versionsBefore + 1
        );
    });

    it("parses numeric open flags with per-platform constants", () => {
        // Darwin: O_WRONLY|O_CREAT|O_TRUNC = 0x1|0x200|0x400
        expect(parseFlags(0x601, "darwin")).toMatchObject({
            write: true,
            create: true,
            truncate: true,
            append: false,
        });
        // Darwin O_APPEND (0x8) must not read as Linux O_APPEND.
        expect(parseFlags(0x1 | 0x8, "darwin")).toMatchObject({
            write: true,
            append: true,
            truncate: false,
        });
        // Linux: O_WRONLY|O_CREAT|O_TRUNC = 0o1|0o100|0o1000
        expect(parseFlags(0o1101, "linux")).toMatchObject({
            write: true,
            create: true,
            truncate: true,
            append: false,
        });
        // Windows (MSVC/WinFsp): O_WRONLY|O_CREAT|O_TRUNC = 0x1|0x100|0x200
        expect(parseFlags(0x301, "win32")).toMatchObject({
            write: true,
            create: true,
            truncate: true,
            append: false,
        });
    });

    it("round-trips backend calls through TCP IPC for external adapters", async () => {
        const backend = createSharedFsMountBackend(fs);
        const server = await createSharedFsIpcServer(
            backend,
            "tcp://127.0.0.1:0"
        );
        try {
            expect(server.endpoint).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/);
            const client = createSharedFsIpcClient(server.endpoint);
            await client.mkdir("/tcp");
            const handle = await client.open("/tcp/file.txt", {
                write: true,
                create: true,
                truncate: true,
            });
            await client.write(handle, encode("over tcp"), 0);
            await client.release(handle);

            expect(decode(await fs.readFile("/tcp/file.txt"))).toBe("over tcp");
        } finally {
            await server.close();
        }
    });
});
