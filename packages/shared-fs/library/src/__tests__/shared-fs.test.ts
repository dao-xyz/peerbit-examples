import nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    DEFAULT_FILE_CHUNK_SIZE,
    encodePublicSignKey,
    openSharedFs,
    runSharedFsBenchmark,
    type SharedFsHandle,
} from "../index.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const stopPeer = async (peer: Peerbit) => {
    try {
        await peer.stop();
    } catch (error) {
        if (
            !(
                error instanceof TypeError &&
                error.message.includes("clearAll") &&
                error.stack?.includes("DocumentIndex.close")
            )
        ) {
            throw error;
        }
    }
};

const patternedBytes = (size: number) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.byteLength; i++) {
        bytes[i] = i % 251;
    }
    return bytes;
};

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const intervalMs = options.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    throw lastError;
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
        await stopPeer(peer);
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

    it("replaces destination files when renaming", async () => {
        await fs.writeFile("/source.txt", "source");
        await fs.writeFile("/target.txt", "target");

        await fs.rename("/source.txt", "/target.txt");

        expect(await fs.readFile("/source.txt")).toBeUndefined();
        expect(decode(await fs.readFile("/target.txt"))).toBe("source");
    });

    it("rejects renaming a directory into its own subtree", async () => {
        await fs.mkdir("/a");
        await fs.mkdir("/a/b");
        await fs.writeFile("/a/b/keep.txt", "keep");

        await expect(fs.rename("/a", "/a/b/c")).rejects.toThrow(/own subtree/);
        // The tree is untouched and still reachable.
        expect(decode(await fs.readFile("/a/b/keep.txt"))).toBe("keep");
    });

    it("stats paths without listing their parents", async () => {
        await fs.mkdir("/docs");
        await fs.writeFile("/docs/hello.txt", "hello");

        const file = await fs.stat("/docs/hello.txt");
        expect(file).toMatchObject({
            kind: "file",
            name: "hello.txt",
            size: BigInt("hello".length),
            conflict: false,
        });
        expect(file?.versionId).toBeDefined();
        expect(file?.headVersionIds).toHaveLength(1);

        const dir = await fs.stat("/docs");
        expect(dir).toMatchObject({ kind: "directory", name: "docs" });
        expect(await fs.stat("/missing")).toBeUndefined();
        expect((await fs.stat("/"))?.kind).toBe("directory");
    });

    it("serves metadata operations without scanning unrelated documents", async () => {
        // A directory full of files plus one small file elsewhere. Metadata
        // operations on /b must not resolve /a's records or chunk bytes.
        await fs.mkdir("/a");
        for (let i = 0; i < 40; i++) {
            await fs.writeFile(`/a/file-${i}.txt`, `content ${i}`);
        }
        await fs.mkdir("/b");
        await fs.writeFile("/b/one.txt", "one");

        const index = fs.program.entries.index;
        const originalIterate = index.iterate.bind(index);
        const originalGet = index.get.bind(index);
        let resolvedDocuments = 0;
        let resolvedChunkBytes = 0;
        index.iterate = ((request: unknown, options: any) => {
            const iterator = originalIterate(request as never, options);
            const all = iterator.all.bind(iterator);
            iterator.all = async () => {
                const results = await all();
                resolvedDocuments += results.length;
                return results;
            };
            return iterator;
        }) as typeof index.iterate;
        index.get = (async (key: unknown, options: any) => {
            const result = await originalGet(key as never, options);
            if (result != null && options?.resolve !== false) {
                resolvedDocuments += 1;
                if (String(key).startsWith("chunk:")) {
                    resolvedChunkBytes += 1;
                }
            }
            return result;
        }) as typeof index.get;

        resolvedDocuments = 0;
        expect((await fs.list("/b")).map((entry) => entry.name)).toEqual([
            "one.txt",
        ]);
        expect(resolvedDocuments).toBeLessThan(10);

        resolvedDocuments = 0;
        expect(decode(await fs.readFile("/b/one.txt"))).toBe("one");
        expect(resolvedDocuments).toBeLessThan(10);

        resolvedDocuments = 0;
        expect((await fs.stat("/b/one.txt"))?.kind).toBe("file");
        expect(resolvedDocuments).toBeLessThan(10);

        // Writing content whose chunks are already stored must not resolve
        // any chunk bytes: the dedup probe is index-only.
        resolvedChunkBytes = 0;
        await fs.writeFile("/b/two.txt", "one");
        expect(resolvedChunkBytes).toBe(0);
        expect(decode(await fs.readFile("/b/two.txt"))).toBe("one");
    });

    it("deduplicates content-addressed chunks across versions and files", async () => {
        const countChunkDocs = async () =>
            (
                await fs.program.entries.index
                    .iterate(
                        { query: { kind: "file-chunk" } },
                        { local: true, remote: false, resolve: false }
                    )
                    .all()
            ).length;

        const twoChunks = patternedBytes(DEFAULT_FILE_CHUNK_SIZE * 2);
        await fs.writeFile("/original.bin", twoChunks);
        const afterFirst = await countChunkDocs();
        expect(afterFirst).toBe(2);

        // Identical content under a different path shares every chunk.
        await fs.writeFile("/copy.bin", twoChunks);
        expect(await countChunkDocs()).toBe(afterFirst);
        expect(await fs.readFile("/copy.bin")).toEqual(twoChunks);

        // Changing one chunk of a version stores only the changed chunk.
        const edited = new Uint8Array(twoChunks);
        edited[0] = (edited[0] + 1) % 251;
        await fs.writeFile("/original.bin", edited);
        expect(await countChunkDocs()).toBe(afterFirst + 1);
        expect(await fs.readFile("/original.bin")).toEqual(edited);
        expect(await fs.readFile("/copy.bin")).toEqual(twoChunks);

        // A file of repeated identical blocks stores that block once.
        const repeated = new Uint8Array(DEFAULT_FILE_CHUNK_SIZE * 3); // zeros
        await fs.writeFile("/zeros.bin", repeated);
        expect(await countChunkDocs()).toBe(afterFirst + 2);
        expect(await fs.readFile("/zeros.bin")).toEqual(repeated);
    });

    it("treats saving identical content as a no-op", async () => {
        await fs.writeFile("/stable.txt", "same content");
        const [head] = await fs.versions("/stable.txt");

        const result = await fs.writeFile("/stable.txt", "same content");
        expect(result.id).toBe(head.id);
        expect(await fs.versions("/stable.txt")).toHaveLength(1);

        // Different content still creates a new version...
        await fs.writeFile("/stable.txt", "different content");
        expect(await fs.versions("/stable.txt")).toHaveLength(2);

        // ...and explicit baseVersionIds always publish (conflict flows).
        const heads = (await fs.versions("/stable.txt"))
            .filter((version) => version.head)
            .map((version) => version.id);
        await fs.writeFile("/stable.txt", "different content", {
            baseVersionIds: heads,
        });
        expect(await fs.versions("/stable.txt")).toHaveLength(3);
    });

    it("recreates deleted paths on fresh nodes and heals restore collisions", async () => {
        await fs.writeFile("/note.txt", "first life");
        const first = await fs.stat("/note.txt");
        await fs.rm("/note.txt");
        expect(await fs.stat("/note.txt")).toBeUndefined();

        // Writing over a deleted slot creates a brand-new node.
        await fs.writeFile("/note.txt", "second life");
        const second = await fs.stat("/note.txt");
        expect(second?.nodeId).not.toBe(first?.nodeId);
        expect(decode(await fs.readFile("/note.txt"))).toBe("second life");

        // Restoring the deleted node creates a duplicate-name conflict at
        // the slot, deterministically arbitrated and surfaced.
        await fs.program.resolveNamingConflict(first!.nodeId, {
            type: "restore",
        });
        const conflicts = await fs.namingConflicts();
        const duplicate = conflicts.find(
            (candidate) => candidate.type === "duplicate-name"
        );
        expect(duplicate).toBeDefined();
        expect(
            [duplicate!.nodeId, ...(duplicate!.shadowedNodeIds ?? [])].sort()
        ).toEqual([first!.nodeId, second!.nodeId].sort());

        // Moving the shadowed claimant heals the collision; both files are
        // visible afterwards.
        const shadowed = duplicate!.shadowedNodeIds![0];
        await fs.program.resolveNamingConflict(shadowed, {
            type: "move",
            to: "/note-restored.txt",
        });
        expect(
            (await fs.namingConflicts()).filter(
                (candidate) => candidate.type === "duplicate-name"
            )
        ).toEqual([]);
        const names = (await fs.list("/")).map((entry) => entry.name).sort();
        expect(names).toEqual(["note-restored.txt", "note.txt"]);
        const contents = new Set([
            decode(await fs.readFile("/note.txt")),
            decode(await fs.readFile("/note-restored.txt")),
        ]);
        expect(contents).toEqual(new Set(["first life", "second life"]));
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

    it("runs the baseline benchmark workload", async () => {
        const result = await runSharedFsBenchmark(fs, {
            root: "/benchmark",
            largeFileSize: 1024,
            smallFileCount: 3,
            smallFileSize: 16,
            cleanup: true,
        });

        expect(result.largeFile.bytes).toBe(1024);
        expect(result.smallFiles.count).toBe(3);
        expect(result.smallFiles.bytesPerFile).toBe(16);
    });

    it("keeps filesystem metadata reads local-only", async () => {
        const index = fs.program.entries.index;
        const originalIterate = index.iterate.bind(index);
        const originalGet = index.get.bind(index);
        const remoteOptions: unknown[] = [];
        index.iterate = ((request: unknown, options: any) => {
            remoteOptions.push(options?.remote);
            return originalIterate(request as never, options);
        }) as typeof index.iterate;
        index.get = ((key: unknown, options: any) => {
            remoteOptions.push(options?.remote);
            return originalGet(key as never, options);
        }) as typeof index.get;

        await fs.writeFile("/local.txt", "fast local write");
        expect(decode(await fs.readFile("/local.txt"))).toBe(
            "fast local write"
        );
        expect((await fs.list("/")).map((entry) => entry.name)).toEqual([
            "local.txt",
        ]);

        expect(remoteOptions.length).toBeGreaterThan(0);
        expect(remoteOptions.every((remote) => remote === false)).toBe(true);
    });

    it("reopens from a persisted state directory", async () => {
        const directory = await nodeFs.mkdtemp(
            path.join(os.tmpdir(), "peerbit-shared-fs-library-")
        );
        let address = "";

        try {
            const firstPeer = await Peerbit.create({ directory });
            try {
                const firstFs = await openSharedFs({
                    peerbit: firstPeer,
                    machineLabel: "persistent-writer",
                    replicate: false,
                });
                address = firstFs.address;
                await firstFs.mkdir("/docs");
                await firstFs.writeFile("/docs/hello.txt", "persisted");
            } finally {
                await stopPeer(firstPeer);
            }

            const secondPeer = await Peerbit.create({ directory });
            try {
                const secondFs = await openSharedFs({
                    peerbit: secondPeer,
                    address,
                    machineLabel: "persistent-reader",
                    replicate: false,
                });
                expect(decode(await secondFs.readFile("/docs/hello.txt"))).toBe(
                    "persisted"
                );
            } finally {
                await stopPeer(secondPeer);
            }
        } finally {
            await nodeFs.rm(directory, { recursive: true, force: true });
        }
    });
});

describe("shared fs replication", () => {
    const peers: Peerbit[] = [];

    const createPeer = async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return peer;
    };

    afterEach(async () => {
        await Promise.all(peers.splice(0).map((peer) => stopPeer(peer)));
    });

    it("syncs a local-first write after peers reconnect", async () => {
        const writerPeer = await createPeer();
        const readerPeer = await createPeer();
        const writer = await openSharedFs({
            peerbit: writerPeer,
            machineLabel: "writer-machine",
        });
        await writer.writeFile("/offline.txt", "local-first");
        expect(decode(await writer.readFile("/offline.txt"))).toBe(
            "local-first"
        );

        await writerPeer.dial(readerPeer);
        const reader = await openSharedFs({
            peerbit: readerPeer,
            address: writer.address,
            machineLabel: "reader-machine",
        });

        await waitUntil(async () => {
            expect(decode(await reader.readFile("/offline.txt"))).toBe(
                "local-first"
            );
        });
    });

    it("preserves signed conflict heads from two peers", async () => {
        const peerA = await createPeer();
        const peerB = await createPeer();
        await peerA.dial(peerB);

        const fsA = await openSharedFs({
            peerbit: peerA,
            machineLabel: "peer-a",
        });
        const fsB = await openSharedFs({
            peerbit: peerB,
            address: fsA.address,
            machineLabel: "peer-b",
        });

        await fsA.writeFile("/shared.txt", "base");
        await waitUntil(async () => {
            expect(decode(await fsB.readFile("/shared.txt"))).toBe("base");
        });
        await fsB.awaitWriteReady();

        const base = (await fsA.versions("/shared.txt"))
            .filter((version) => version.head)
            .map((version) => version.id);
        await fsA.writeFile("/shared.txt", "from-a", {
            baseVersionIds: base,
        });
        await fsB.writeFile("/shared.txt", "from-b", {
            baseVersionIds: base,
        });

        await waitUntil(async () => {
            const conflicts = await fsA.conflicts("/shared.txt");
            expect(conflicts).toHaveLength(1);
            expect(
                conflicts[0].versions
                    .map((version) => version.machineLabel)
                    .sort()
            ).toEqual(["peer-a", "peer-b"]);
        });
        await waitUntil(async () => {
            const conflicts = await fsB.conflicts("/shared.txt");
            expect(conflicts).toHaveLength(1);
            expect(
                conflicts[0].versions
                    .map((version) => version.machineLabel)
                    .sort()
            ).toEqual(["peer-a", "peer-b"]);
        });
    });

    it("requires trusted writer signatures for access-controlled filesystems", async () => {
        const ownerPeer = await createPeer();
        const writerPeer = await createPeer();
        await ownerPeer.dial(writerPeer);

        const ownerFs = await openSharedFs({
            peerbit: ownerPeer,
            machineLabel: "owner-machine",
            rootKey: ownerPeer.identity.publicKey,
        });
        const writerFs = await openSharedFs({
            peerbit: writerPeer,
            address: ownerFs.address,
            machineLabel: "writer-machine",
            // This fixture isolates signature authorization before any
            // namespace exists; readiness behavior is covered separately.
            allowPartialWrites: true,
        });

        expect(ownerFs.accessControlled).toBe(true);
        expect(writerFs.accessControlled).toBe(true);
        await expect(
            writerFs.writeFile("/blocked.txt", "untrusted")
        ).rejects.toThrow();
        expect(await ownerFs.readFile("/blocked.txt")).toBeUndefined();

        await ownerFs.authorizeWriter(writerPeer.identity.publicKey);
        await waitUntil(async () => {
            expect(
                await writerFs.isTrustedWriter(writerPeer.identity.publicKey)
            ).toBe(true);
        });

        const version = await writerFs.writeFile("/trusted.txt", "trusted");
        expect(version.authorKey).toBe(
            encodePublicSignKey(writerPeer.identity.publicKey)
        );

        await waitUntil(async () => {
            expect(decode(await ownerFs.readFile("/trusted.txt"))).toBe(
                "trusted"
            );
        });
    });
});
