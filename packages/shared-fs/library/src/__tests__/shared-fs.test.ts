import nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    DEFAULT_FILE_CHUNK_SIZE,
    FileVersion,
    NamingEvent,
    ROOT_NODE_ID,
    SHARED_FS_MOUNT_READ_SEMANTICS,
    SharedFsExpectedNamingConflictMismatchError,
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

const forkVersion = (parent: FileVersion, id: string) =>
    new FileVersion({
        id,
        nodeId: parent.nodeId,
        parentVersionIds: [parent.id],
        causalDepth: parent.causalDepth + 1n,
        contentHash: parent.contentHash,
        size: parent.size,
        chunkIds: parent.chunkIds,
        createdAt: parent.createdAt + 1n,
        authorKey: parent.authorKey,
        machineLabel: parent.machineLabel,
    });

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

    it("exposes the same target-verified allocation with exact mount metadata", async () => {
        const written = await fs.writeFile(
            "/verified-mount-read.txt",
            "verified snapshot"
        );
        expect(fs.mountReadSemantics()).toBe(SHARED_FS_MOUNT_READ_SEMANTICS);

        const snapshot = await fs.readVersionForMount(
            "/verified-mount-read.txt",
            written.id
        );
        expect(snapshot).toMatchObject({
            versionId: written.id,
            nodeId: written.nodeId,
            contentHash: written.contentHash,
            size: written.size,
        });
        expect(decode(snapshot?.bytes)).toBe("verified snapshot");

        // The assembled, verified allocation is mount-owned. Mutating it must
        // not mutate the immutable chunk documents behind a later exact read.
        snapshot!.bytes[0] ^= 0xff;
        expect(
            decode(await fs.readVersion("/verified-mount-read.txt", written.id))
        ).toBe("verified snapshot");
    });

    it("delegates mount hashing without weakening exact-head no-op semantics", async () => {
        const original = await fs.writeFile("/mount-stable.txt", "same");
        const unchanged = await fs.writeFile("/mount-stable.txt", "same", {
            baseVersionIds: [original.id],
            expectedNodeId: original.nodeId,
            noOpIfHeadVersionIds: [original.id],
        });
        expect(unchanged).toMatchObject({
            id: original.id,
            nodeId: original.nodeId,
            mountWriteOutcome: "unchanged",
        });
        expect(await fs.versions("/mount-stable.txt")).toHaveLength(1);

        const changed = await fs.writeFile("/mount-stable.txt", "next", {
            baseVersionIds: [original.id],
            expectedNodeId: original.nodeId,
            noOpIfHeadVersionIds: [original.id],
        });
        expect(changed.mountWriteOutcome).toBe("created");
        expect(changed.id).not.toBe(original.id);
        expect(await fs.versions("/mount-stable.txt")).toHaveLength(2);
    });

    it("publishes a delegated mount rewrite when the opened heads are stale", async () => {
        const original = await fs.writeFile("/mount-race.txt", "original");
        const concurrent = await fs.writeFile("/mount-race.txt", "concurrent");

        const mounted = await fs.writeFile("/mount-race.txt", "original", {
            baseVersionIds: [original.id],
            expectedNodeId: original.nodeId,
            noOpIfHeadVersionIds: [original.id],
        });

        expect(mounted.mountWriteOutcome).toBe("created");
        expect(mounted.parentVersionIds).toEqual([original.id]);
        const heads = (await fs.versions("/mount-race.txt")).filter(
            (version) => version.head
        );
        expect(heads.map((version) => version.id).sort()).toEqual(
            [concurrent.id, mounted.id].sort()
        );
    });

    it("accepts an exact multi-head mount snapshot without resolving it", async () => {
        const original = await fs.writeFile("/mount-conflict.txt", "base");
        await fs.writeFile("/mount-conflict.txt", "left", {
            baseVersionIds: [original.id],
        });
        await fs.writeFile("/mount-conflict.txt", "right", {
            baseVersionIds: [original.id],
        });
        const before = await fs.versions("/mount-conflict.txt");
        const heads = before.filter((version) => version.head);
        const visible = await fs.stat("/mount-conflict.txt");
        expect(visible?.kind).toBe("file");
        const visibleId = visible!.versionId!;
        const visibleBytes = await fs.readVersion(
            "/mount-conflict.txt",
            visibleId
        );

        const unchanged = await fs.writeFile(
            "/mount-conflict.txt",
            visibleBytes!,
            {
                baseVersionIds: [visibleId],
                expectedNodeId: visible!.nodeId,
                noOpIfHeadVersionIds: heads.map((version) => version.id),
            }
        );

        expect(unchanged).toMatchObject({
            id: visibleId,
            mountWriteOutcome: "unchanged",
        });
        expect(await fs.versions("/mount-conflict.txt")).toHaveLength(
            before.length
        );
        expect(
            (await fs.versions("/mount-conflict.txt"))
                .filter((version) => version.head)
                .map((version) => version.id)
                .sort()
        ).toEqual(heads.map((version) => version.id).sort());
    });

    it("does not trust malformed mount head sets or stale node ids", async () => {
        const original = await fs.writeFile("/mount-guard.txt", "same");
        await expect(
            fs.writeFile("/mount-guard.txt", "same", {
                baseVersionIds: [original.id],
                expectedNodeId: original.nodeId,
                noOpIfHeadVersionIds: [original.id, original.id],
            })
        ).rejects.toMatchObject({ code: "EINVAL" });

        await fs.rm("/mount-guard.txt");
        const replacement = await fs.writeFile("/mount-guard.txt", "same");
        expect(replacement.nodeId).not.toBe(original.nodeId);
        await expect(
            fs.writeFile("/mount-guard.txt", "same", {
                baseVersionIds: [original.id],
                expectedNodeId: original.nodeId,
                noOpIfHeadVersionIds: [original.id],
            })
        ).rejects.toMatchObject({ code: "EAGAIN" });
    });

    it("fails closed on malformed delegated mount write options", async () => {
        const original = await fs.writeFile("/mount-options.txt", "same");
        const validExisting = {
            baseVersionIds: [original.id],
            expectedNodeId: original.nodeId,
            noOpIfHeadVersionIds: [original.id],
        };
        await expect(
            fs.writeFile("/mount-options.txt", "same", {
                ...validExisting,
                expectedNodeId: undefined,
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            fs.writeFile("/mount-options.txt", "same", {
                ...validExisting,
                baseVersionIds: undefined,
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            fs.writeFile("/mount-options.txt", "same", {
                ...validExisting,
                baseVersionIds: original.id as unknown as string[],
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            fs.writeFile("/mount-options.txt", "same", {
                ...validExisting,
                noOpIfHeadVersionIds: Array.from(
                    { length: 8001 },
                    (_, index) => `version:${index}`
                ),
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            fs.writeFile("/mount-options.txt", "same", {
                ...validExisting,
                noOpIfHeadVersionIds: [original.id, 1] as unknown as string[],
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            fs.writeFile("/mount-options.txt", "same", {
                ...validExisting,
                chunkSize: 1,
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        expect(await fs.versions("/mount-options.txt")).toHaveLength(1);

        const created = await fs.writeFile("/mount-created.txt", "created", {
            expectedNodeId: null,
            noOpIfHeadVersionIds: [],
        });
        expect(created.mountWriteOutcome).toBe("created");
        expect(decode(await fs.readFile("/mount-created.txt"))).toBe("created");
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

    it("merges a shadowed directory while preserving child identities and collisions", async () => {
        await fs.mkdir("/shared");
        const targetDirectory = (await fs.stat("/shared"))!;
        await fs.writeFile("/shared/from-target.txt", "target");
        await fs.writeFile("/shared/collision.txt", "target collision");
        const targetCollision = (await fs.stat("/shared/collision.txt"))!;
        await fs.rename("/shared", "/held");

        await fs.mkdir("/shared");
        const sourceDirectory = (await fs.stat("/shared"))!;
        await fs.writeFile("/shared/from-source.txt", "source");
        const sourceFile = (await fs.stat("/shared/from-source.txt"))!;
        await fs.writeFile("/shared/collision.txt", "source collision");
        const sourceCollision = (await fs.stat("/shared/collision.txt"))!;
        await fs.mkdir("/shared/source-tree");
        const sourceTree = (await fs.stat("/shared/source-tree"))!;
        await fs.writeFile("/shared/source-tree/nested.txt", "nested");
        const nestedFile = (await fs.stat("/shared/source-tree/nested.txt"))!;

        // Reassert the older directory into the occupied slot. Its greater
        // causal depth makes it the visible claimant and leaves the newer
        // directory (with its own subtree) shadowed.
        await fs.resolveNamingConflict(targetDirectory.nodeId, {
            type: "move",
            to: "/shared",
        });
        const duplicate = (await fs.namingConflicts()).find(
            (conflict) =>
                conflict.type === "duplicate-name" &&
                conflict.path === "/shared"
        )!;
        expect(duplicate.nodeId).toBe(targetDirectory.nodeId);
        expect(duplicate.shadowedNodeIds).toEqual([sourceDirectory.nodeId]);
        const expectedConflicts = (await fs.namingConflicts()).filter(
            (conflict) =>
                conflict.nodeId === sourceDirectory.nodeId ||
                conflict.shadowedNodeIds?.includes(sourceDirectory.nodeId)
        );

        await expect(
            fs.resolveNamingConflict(sourceDirectory.nodeId, {
                type: "merge-directory",
            })
        ).rejects.toMatchObject({ code: "EINVAL" });

        const resolution = await fs.resolveNamingConflict(
            sourceDirectory.nodeId,
            { type: "merge-directory" },
            { expectedConflicts }
        );
        if (!resolution) {
            throw new Error("directory merge did not return its repair plan");
        }
        expect(resolution).toMatchObject({
            type: "directory-merged",
            sourceNodeId: sourceDirectory.nodeId,
            targetNodeId: targetDirectory.nodeId,
        });
        expect(new Set(resolution.movedNodeIds)).toEqual(
            new Set([
                sourceFile.nodeId,
                sourceCollision.nodeId,
                sourceTree.nodeId,
            ])
        );
        expect(resolution.movedNodeIds).not.toContain(nestedFile.nodeId);
        expect(resolution.eventIds).toHaveLength(
            resolution.movedNodeIds.length + 1
        );

        expect((await fs.stat("/shared"))?.nodeId).toBe(targetDirectory.nodeId);
        expect(decode(await fs.readFile("/shared/from-target.txt"))).toBe(
            "target"
        );
        expect(decode(await fs.readFile("/shared/from-source.txt"))).toBe(
            "source"
        );
        expect((await fs.stat("/shared/from-source.txt"))?.nodeId).toBe(
            sourceFile.nodeId
        );
        expect((await fs.stat("/shared/source-tree"))?.nodeId).toBe(
            sourceTree.nodeId
        );
        expect((await fs.stat("/shared/source-tree/nested.txt"))?.nodeId).toBe(
            nestedFile.nodeId
        );
        expect(
            decode(await fs.readFile("/shared/source-tree/nested.txt"))
        ).toBe("nested");

        const remaining = await fs.namingConflicts();
        expect(
            remaining.find(
                (conflict) =>
                    conflict.type === "duplicate-name" &&
                    conflict.path === "/shared"
            )
        ).toBeUndefined();
        const childCollision = remaining.find(
            (conflict) =>
                conflict.type === "duplicate-name" &&
                conflict.path === "/shared/collision.txt"
        )!;
        expect(
            new Set([
                childCollision.nodeId,
                ...(childCollision.shadowedNodeIds ?? []),
            ])
        ).toEqual(new Set([targetCollision.nodeId, sourceCollision.nodeId]));

        const lastEvent = await fs.program.entries.index.get(
            resolution.eventIds.at(-1)!,
            { local: true, remote: false, resolve: true }
        );
        expect(lastEvent).toBeInstanceOf(NamingEvent);
        expect(lastEvent).toMatchObject({
            nodeId: sourceDirectory.nodeId,
            deleted: true,
        });

        // A write not present in the operator's final local view is not
        // swallowed by the source tombstone. When that ordinary event later
        // arrives, the existing conflict surface exposes it as unreachable
        // so an operator can move it into the merged directory explicitly.
        const lateChild = new NamingEvent({
            id: "naming:late-directory-merge-child",
            nodeId: "dir:late-directory-merge-child",
            parentId: sourceDirectory.nodeId,
            name: "late-child",
            causalDepth: 1n,
            parentNamingIds: [],
            createdAt: BigInt(Date.now()),
            authorKey: encodePublicSignKey(peer.identity.publicKey),
            machineLabel: "late-remote-writer",
        });
        await fs.program.entries.put(lateChild, { unique: true });
        const unreachable = (await fs.namingConflicts()).find(
            (conflict) =>
                conflict.type === "unreachable" &&
                conflict.nodeId === lateChild.nodeId
        )!;
        expect(unreachable).toBeDefined();
        await fs.resolveNamingConflict(
            lateChild.nodeId,
            { type: "move", to: "/shared/late-child" },
            { expectedConflicts: [unreachable] }
        );
        expect((await fs.stat("/shared/late-child"))?.nodeId).toBe(
            lateChild.nodeId
        );
    });

    it("rejects invalid file-directory and multi-head directory merges", async () => {
        await fs.writeFile("/mixed", "file");
        const file = (await fs.stat("/mixed"))!;
        await fs.rename("/mixed", "/held-file");
        await fs.mkdir("/mixed");
        const directory = (await fs.stat("/mixed"))!;
        await fs.resolveNamingConflict(file.nodeId, {
            type: "move",
            to: "/mixed",
        });
        let expectedConflicts = (await fs.namingConflicts()).filter(
            (conflict) =>
                conflict.nodeId === directory.nodeId ||
                conflict.shadowedNodeIds?.includes(directory.nodeId)
        );
        await expect(
            fs.resolveNamingConflict(
                directory.nodeId,
                { type: "merge-directory" },
                { expectedConflicts }
            )
        ).rejects.toMatchObject({ code: "ENOTDIR" });

        await fs.mkdir("/directories");
        const target = (await fs.stat("/directories"))!;
        await fs.rename("/directories", "/held-directory");
        await fs.mkdir("/directories");
        const source = (await fs.stat("/directories"))!;
        await fs.resolveNamingConflict(target.nodeId, {
            type: "move",
            to: "/directories",
        });

        const sourceState = await (fs.program as any).namingStateForNode(
            source.nodeId
        );
        const base = sourceState.heads[0] as NamingEvent;
        const fork = new NamingEvent({
            id: "naming:~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~merge-fork",
            nodeId: source.nodeId,
            parentId: base.parentId,
            name: "directory-fork",
            causalDepth: base.causalDepth,
            parentNamingIds: base.parentNamingIds,
            createdAt: base.createdAt + 1n,
            authorKey: encodePublicSignKey(peer.identity.publicKey),
            machineLabel: "test-machine",
        });
        await fs.program.entries.put(fork, { unique: true });
        expectedConflicts = (await fs.namingConflicts()).filter(
            (conflict) =>
                conflict.nodeId === source.nodeId ||
                conflict.shadowedNodeIds?.includes(source.nodeId)
        );
        expect(
            expectedConflicts.some((conflict) => conflict.type === "multi-head")
        ).toBe(true);
        await expect(
            fs.resolveNamingConflict(
                source.nodeId,
                { type: "merge-directory" },
                { expectedConflicts }
            )
        ).rejects.toMatchObject({ code: "EINVAL" });
    });

    it("publishes nothing when a source child has independent naming heads", async () => {
        await fs.mkdir("/shared");
        const target = (await fs.stat("/shared"))!;
        await fs.rename("/shared", "/held");
        await fs.mkdir("/shared");
        const source = (await fs.stat("/shared"))!;
        await fs.mkdir("/shared/stable-child");
        const stableChild = (await fs.stat("/shared/stable-child"))!;
        await fs.mkdir("/shared/racing-child");
        const racingChild = (await fs.stat("/shared/racing-child"))!;
        await fs.resolveNamingConflict(target.nodeId, {
            type: "move",
            to: "/shared",
        });

        const racingState = await (fs.program as any).namingStateForNode(
            racingChild.nodeId
        );
        const base = racingState.heads[0] as NamingEvent;
        await fs.program.entries.put(
            new NamingEvent({
                id: "naming:~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~child-fork",
                nodeId: racingChild.nodeId,
                parentId: ROOT_NODE_ID,
                name: "racing-child-moved",
                causalDepth: base.causalDepth + 1n,
                parentNamingIds: base.parentNamingIds,
                createdAt: base.createdAt + 1n,
                authorKey: encodePublicSignKey(peer.identity.publicKey),
                machineLabel: "remote-child-writer",
            }),
            { unique: true }
        );
        const expectedConflicts = (await fs.namingConflicts()).filter(
            (conflict) =>
                conflict.nodeId === source.nodeId ||
                conflict.shadowedNodeIds?.includes(source.nodeId)
        );

        await expect(
            fs.resolveNamingConflict(
                source.nodeId,
                { type: "merge-directory" },
                { expectedConflicts }
            )
        ).rejects.toMatchObject({ code: "EINVAL" });

        const sourceState = await (fs.program as any).namingStateForNode(
            source.nodeId
        );
        const stableState = await (fs.program as any).namingStateForNode(
            stableChild.nodeId
        );
        const stillRacing = await (fs.program as any).namingStateForNode(
            racingChild.nodeId
        );
        expect(sourceState.winner.deleted).toBe(false);
        expect(stableState.winner.parentId).toBe(source.nodeId);
        expect(stillRacing.heads).toHaveLength(2);
        expect(stillRacing.winner.parentId).toBe(ROOT_NODE_ID);
        expect(
            (await fs.namingConflicts()).find(
                (conflict) =>
                    conflict.type === "duplicate-name" &&
                    conflict.shadowedNodeIds?.includes(source.nodeId)
            )
        ).toBeDefined();
    });

    it("rejects a directory merge when another shadow claimant moves during planning", async () => {
        await fs.mkdir("/shared");
        const first = (await fs.stat("/shared"))!;
        await fs.rename("/shared", "/held-first");
        await fs.mkdir("/shared");
        const second = (await fs.stat("/shared"))!;
        await fs.rename("/shared", "/held-second");
        await fs.mkdir("/shared");
        const source = (await fs.stat("/shared"))!;
        await fs.writeFile("/shared/kept.txt", "kept");
        const sourceChild = (await fs.stat("/shared/kept.txt"))!;
        await fs.resolveNamingConflict(first.nodeId, {
            type: "move",
            to: "/shared",
        });
        await fs.resolveNamingConflict(second.nodeId, {
            type: "move",
            to: "/shared",
        });

        const before = await fs.namingConflicts();
        const duplicate = before.find(
            (conflict) =>
                conflict.type === "duplicate-name" &&
                conflict.path === "/shared" &&
                conflict.shadowedNodeIds?.includes(source.nodeId)
        )!;
        const movingShadow = duplicate.shadowedNodeIds!.find(
            (nodeId) => nodeId !== source.nodeId
        )!;
        expect(movingShadow).toBeDefined();
        const movingState = await (fs.program as any).namingStateForNode(
            movingShadow
        );
        const movingHeads = movingState.heads as NamingEvent[];
        const moveAway = new NamingEvent({
            id: "naming:shadow-claimant-moved-during-merge",
            nodeId: movingShadow,
            parentId: movingState.winner.parentId,
            name: "departed-shadow",
            causalDepth:
                1n +
                movingHeads.reduce(
                    (maximum, head) =>
                        head.causalDepth > maximum ? head.causalDepth : maximum,
                    0n
                ),
            parentNamingIds: movingHeads.map((head) => head.id),
            createdAt: BigInt(Date.now()),
            authorKey: encodePublicSignKey(peer.identity.publicKey),
            machineLabel: "remote-shadow-writer",
        });
        const expectedConflicts = before.filter(
            (conflict) =>
                conflict.nodeId === source.nodeId ||
                conflict.shadowedNodeIds?.includes(source.nodeId)
        );

        const index = fs.program.entries.index;
        const originalIterate = index.iterate.bind(index);
        let injected = false;
        index.iterate = ((request: any, options: any) => {
            const iterator = originalIterate(request, options);
            const sourceChildScan = request?.query?.some(
                (query: any) =>
                    query?.value === source.nodeId &&
                    Array.isArray(query?.key) &&
                    query.key.includes("parentId")
            );
            if (sourceChildScan) {
                const originalClose = iterator.close.bind(iterator);
                iterator.close = async () => {
                    await originalClose();
                    if (!injected) {
                        injected = true;
                        await fs.program.entries.put(moveAway, {
                            unique: true,
                        });
                    }
                };
            }
            return iterator;
        }) as typeof index.iterate;
        try {
            await expect(
                fs.resolveNamingConflict(
                    source.nodeId,
                    { type: "merge-directory" },
                    { expectedConflicts }
                )
            ).rejects.toMatchObject({
                code: "EAGAIN",
                retryable: true,
                retrySafe: true,
            });
        } finally {
            index.iterate = originalIterate;
        }
        expect(injected).toBe(true);
        const sourceState = await (fs.program as any).namingStateForNode(
            source.nodeId
        );
        const childState = await (fs.program as any).namingStateForNode(
            sourceChild.nodeId
        );
        expect(sourceState.winner.deleted).toBe(false);
        expect(childState.winner.parentId).toBe(source.nodeId);
    });

    it("bounds supplied naming-conflict strings before canonicalization", async () => {
        const nodeId = "dir:bounded-conflict-input";
        const conflict = {
            type: "multi-head" as const,
            nodeId,
            path: "/" + "x".repeat(4_096),
            eventIds: ["naming:bounded-conflict-input"],
        };
        await expect(
            fs.resolveNamingConflict(
                nodeId,
                { type: "keep" },
                { expectedConflicts: [conflict] }
            )
        ).rejects.toMatchObject({ code: "EINVAL" });

        const aggregateConflict = {
            ...conflict,
            path: "x".repeat(4_096),
        };
        await expect(
            fs.resolveNamingConflict(
                nodeId,
                { type: "keep" },
                {
                    expectedConflicts: Array.from(
                        { length: 257 },
                        () => aggregateConflict
                    ),
                }
            )
        ).rejects.toMatchObject({ code: "EINVAL" });
    });

    it("rejects a stale duplicate-name action when the other claimant moved", async () => {
        await fs.writeFile("/topology.txt", "first life");
        const first = (await fs.stat("/topology.txt"))!;
        await fs.rm("/topology.txt");
        await fs.writeFile("/topology.txt", "second life");
        await fs.resolveNamingConflict(first.nodeId, { type: "restore" });

        const duplicate = (await fs.namingConflicts()).find(
            (candidate) => candidate.type === "duplicate-name"
        )!;
        const shadowedNodeId = duplicate.shadowedNodeIds![0];
        const targetHeadsBefore: string[] = [];
        for (const eventId of duplicate.eventIds) {
            const event = await fs.program.entries.index.get(eventId, {
                local: true,
                remote: false,
                resolve: true,
            });
            if (
                event instanceof NamingEvent &&
                event.nodeId === shadowedNodeId
            ) {
                targetHeadsBefore.push(event.id);
            }
        }
        targetHeadsBefore.sort();

        // The visible winner moves away. The shadowed target's own naming
        // heads do not change, but it is no longer conflicted and becomes the
        // sole visible file at the original path.
        await fs.resolveNamingConflict(duplicate.nodeId, {
            type: "move",
            to: "/topology-moved.txt",
        });
        expect(
            (await fs.namingConflicts()).filter(
                (conflict) =>
                    conflict.nodeId === shadowedNodeId ||
                    conflict.shadowedNodeIds?.includes(shadowedNodeId)
            )
        ).toEqual([]);

        await expect(
            fs.resolveNamingConflict(
                shadowedNodeId,
                { type: "delete" },
                { expectedConflicts: [duplicate] }
            )
        ).rejects.toMatchObject({
            code: "EAGAIN",
            retryable: true,
            retrySafe: true,
            expectedConflicts: [
                expect.objectContaining({
                    type: duplicate.type,
                    nodeId: duplicate.nodeId,
                    path: duplicate.path,
                    eventIds: [...duplicate.eventIds].sort(),
                    shadowedNodeIds: [
                        ...(duplicate.shadowedNodeIds ?? []),
                    ].sort(),
                }),
            ],
            actualConflicts: [],
            actualHeadEventIds: targetHeadsBefore,
        });
        expect(decode(await fs.readFile("/topology.txt"))).toMatch(/life$/);
        expect(decode(await fs.readFile("/topology-moved.txt"))).toMatch(
            /life$/
        );
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

    it("acknowledges delete-vs-edit heads and fences stale naming actions", async () => {
        await fs.writeFile("/deleted-race.txt", "recoverable");
        const entry = (await fs.stat("/deleted-race.txt"))!;
        const [baseInfo] = await fs.versions("/deleted-race.txt");
        const base = (await fs.program.entries.index.get(baseInfo.id, {
            local: true,
            remote: false,
            resolve: true,
        })) as FileVersion;

        await fs.rm("/deleted-race.txt");
        const concurrent = new FileVersion({
            id: "version:deterministic-delete-vs-edit",
            nodeId: entry.nodeId,
            parentVersionIds: [base.id],
            causalDepth: base.causalDepth + 1n,
            contentHash: base.contentHash,
            size: base.size,
            chunkIds: base.chunkIds,
            createdAt: base.createdAt + 1n,
            authorKey: base.authorKey,
            machineLabel: base.machineLabel,
        });
        await fs.program.entries.put(concurrent, { unique: true });

        const conflict = (await fs.namingConflicts()).find(
            (candidate) => candidate.type === "delete-vs-edit"
        );
        expect(conflict).toMatchObject({
            nodeId: entry.nodeId,
            recoverableVersionIds: [concurrent.id],
        });
        const expectedConflicts = [conflict!];

        await fs.resolveNamingConflict(
            entry.nodeId,
            { type: "delete" },
            { expectedConflicts }
        );
        expect(
            (await fs.namingConflicts()).filter(
                (candidate) => candidate.nodeId === entry.nodeId
            )
        ).toEqual([]);
        expect(await fs.stat("/deleted-race.txt")).toBeUndefined();

        await fs.resolveNamingConflict(entry.nodeId, { type: "restore" });
        expect(decode(await fs.readFile("/deleted-race.txt"))).toBe(
            "recoverable"
        );
        const staleDelete = fs.resolveNamingConflict(
            entry.nodeId,
            { type: "delete" },
            { expectedConflicts }
        );
        await expect(staleDelete).rejects.toBeInstanceOf(
            SharedFsExpectedNamingConflictMismatchError
        );
        await expect(staleDelete).rejects.toMatchObject({
            code: "EAGAIN",
            retryable: true,
            retrySafe: true,
            nodeId: entry.nodeId,
            expectedEventIds: [...conflict!.eventIds].sort(),
            expectedConflicts: [
                expect.objectContaining({
                    type: conflict!.type,
                    nodeId: conflict!.nodeId,
                    path: conflict!.path,
                    eventIds: [...conflict!.eventIds].sort(),
                    recoverableVersionIds: [
                        ...(conflict!.recoverableVersionIds ?? []),
                    ].sort(),
                }),
            ],
            actualHeadEventIds: expect.not.arrayContaining(conflict!.eventIds),
        });
        expect(decode(await fs.readFile("/deleted-race.txt"))).toBe(
            "recoverable"
        );
    });

    it("revalidates a guarded delete after snapshotting content heads", async () => {
        await fs.writeFile("/late-delete.txt", "base");
        const entry = (await fs.stat("/late-delete.txt"))!;
        const [baseInfo] = await fs.versions("/late-delete.txt");
        const base = (await fs.program.entries.index.get(baseInfo.id, {
            local: true,
            remote: false,
            resolve: true,
        })) as FileVersion;
        await fs.rm("/late-delete.txt");
        const concurrent = forkVersion(
            base,
            "version:delete-before-final-validation"
        );
        await fs.program.entries.put(concurrent, { unique: true });
        const expectedConflict = (await fs.namingConflicts()).find(
            (conflict) =>
                conflict.type === "delete-vs-edit" &&
                conflict.nodeId === entry.nodeId
        )!;
        const late = forkVersion(
            concurrent,
            "version:delete-during-content-snapshot"
        );

        const program = fs.program as any;
        const originalHeadsForNode = program.headsForNode;
        let injected = false;
        program.headsForNode = async (nodeId: string) => {
            if (nodeId === entry.nodeId && !injected) {
                injected = true;
                await fs.program.entries.put(late, { unique: true });
            }
            return originalHeadsForNode.call(program, nodeId);
        };
        try {
            await expect(
                fs.resolveNamingConflict(
                    entry.nodeId,
                    { type: "delete" },
                    { expectedConflicts: [expectedConflict] }
                )
            ).rejects.toMatchObject({
                code: "EAGAIN",
                retryable: true,
                retrySafe: true,
            });
        } finally {
            program.headsForNode = originalHeadsForNode;
        }
        expect(injected).toBe(true);
        expect(await fs.stat("/late-delete.txt")).toBeUndefined();
        expect(
            (await fs.namingConflicts()).find(
                (conflict) =>
                    conflict.type === "delete-vs-edit" &&
                    conflict.nodeId === entry.nodeId
            )
        ).toMatchObject({ recoverableVersionIds: [late.id] });
    });

    it("keeps content arriving after guarded restore validation concurrent", async () => {
        await fs.writeFile("/late-restore.txt", "base");
        const entry = (await fs.stat("/late-restore.txt"))!;
        const [baseInfo] = await fs.versions("/late-restore.txt");
        const base = (await fs.program.entries.index.get(baseInfo.id, {
            local: true,
            remote: false,
            resolve: true,
        })) as FileVersion;
        await fs.rm("/late-restore.txt");
        const concurrent = forkVersion(
            base,
            "version:restore-before-final-validation"
        );
        await fs.program.entries.put(concurrent, { unique: true });
        const expectedConflict = (await fs.namingConflicts()).find(
            (conflict) =>
                conflict.type === "delete-vs-edit" &&
                conflict.nodeId === entry.nodeId
        )!;
        const late = forkVersion(
            concurrent,
            "version:restore-after-final-validation"
        );

        const program = fs.program as any;
        const originalAppendNamingEvent = program.appendNamingEvent;
        let injected = false;
        program.appendNamingEvent = async (...args: unknown[]) => {
            if (!injected) {
                injected = true;
                await fs.program.entries.put(late, { unique: true });
            }
            return originalAppendNamingEvent.apply(program, args);
        };
        try {
            await fs.resolveNamingConflict(
                entry.nodeId,
                { type: "restore" },
                { expectedConflicts: [expectedConflict] }
            );
        } finally {
            program.appendNamingEvent = originalAppendNamingEvent;
        }
        expect(injected).toBe(true);
        expect(await fs.stat("/late-restore.txt")).toBeDefined();
        const contentConflict = (await fs.conflicts("/late-restore.txt"))[0];
        expect(contentConflict).toBeDefined();
        expect(contentConflict.versions.map((version) => version.id)).toContain(
            late.id
        );
        expect(
            (await fs.namingConflicts()).filter(
                (conflict) => conflict.nodeId === entry.nodeId
            )
        ).toEqual([]);
    });

    it("runs the baseline benchmark workload", async () => {
        const result = await runSharedFsBenchmark(fs, {
            root: "/benchmark",
            seed: "shared-fs-integration-test",
            largeFileSize: 1024,
            smallFileCount: 3,
            smallFileSize: 16,
            cleanup: true,
        });

        expect(result.largeFile.bytes).toBe(1024);
        expect(result.seed).toBe("shared-fs-integration-test");
        expect(result.smallFiles.count).toBe(3);
        expect(result.smallFiles.bytesPerFile).toBe(16);
        expect(await fs.stat("/benchmark")).toBeUndefined();
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
