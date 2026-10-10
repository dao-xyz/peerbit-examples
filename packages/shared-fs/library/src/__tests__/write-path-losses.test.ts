import { randomBytes } from "node:crypto";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    createSharedFsMountBackend,
    FileChunk,
    FileVersion,
    openSharedFs,
    SHARED_FS_MODE,
    type SharedFsHandle,
} from "../index.js";

const { file: FILE, executable: EXEC } = SHARED_FS_MODE;

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const WAIT_MS = process.env.CI ? 90_000 : 30_000;

const waitUntil = async (assertion: () => Promise<void> | void) => {
    const deadline = Date.now() + WAIT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
    throw lastError;
};

const text = async (fs: SharedFsHandle, path: string) =>
    decode(await fs.readFile(path));

const depthOf = async (fs: SharedFsHandle, id: string) =>
    (
        (await fs.program.entries.index.get(id, {
            local: true,
            remote: false,
        })) as unknown as FileVersion
    ).causalDepth;

/** The bytes of every version conflicts() lists for `path`, sorted. */
const conflictBytes = async (fs: SharedFsHandle, path: string) => {
    const conflict = (await fs.conflicts()).find((c) => c.path === path);
    return (
        await Promise.all(
            (conflict?.versions ?? []).map(async (version) =>
                decode(await fs.readVersion(path, version.id))
            )
        )
    ).sort();
};

/**
 * Saves and merges that must not lose a change: replica pairs whose link is
 * cut and restored, meshes with per-link partitions, and single-replica
 * mount, GC and merge cases.
 */
describe("write-path losses", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        await Promise.allSettled(peers.splice(0).map((peer) => peer.stop()));
    });

    /**
     * Dials until `x` and `y` are connected and each given handle sees the
     * other peer subscribed to the filesystem. Under load a single dial can
     * fail, and a replica left cut off would only surface as a sync timeout.
     * A dial records the address as a fanout bootstrap, which is cleared
     * again: no provider-announcement redials while a link is cut (see the
     * partition case in multi-peer.test.ts).
     */
    const connect = (
        x: Peerbit,
        y: Peerbit,
        fsX?: SharedFsHandle,
        fsY?: SharedFsHandle
    ) =>
        waitUntil(async () => {
            if (x.libp2p.getConnections(y.peerId).length === 0) {
                try {
                    await x.dial(y);
                } finally {
                    x.services.fanout.setBootstraps([]);
                }
            }
            await fsX?.program.entries.waitFor(y.identity.publicKey, {
                timeout: 15_000,
            });
            await fsY?.program.entries.waitFor(x.identity.publicKey, {
                timeout: 15_000,
            });
        });

    /**
     * Two replicas of one filesystem whose link can be cut and restored.
     * While cut, each replica keeps writing on its own view, as an offline
     * or partitioned machine does.
     */
    const pair = async (
        seed: (A: SharedFsHandle) => Promise<void>,
        paths: string[],
        options: { dedupSkipHorizonMs?: number; clock?: () => number } = {}
    ) => {
        let cut = false;
        const gater = {
            denyDialPeer: () => cut,
            denyDialMultiaddr: () => cut,
            denyInboundConnection: () => cut,
            denyOutboundConnection: () => cut,
            denyInboundEncryptedConnection: () => cut,
            denyOutboundEncryptedConnection: () => cut,
            denyInboundUpgradedConnection: () => cut,
            denyOutboundUpgradedConnection: () => cut,
        };
        const a = await Peerbit.create({ libp2p: { connectionGater: gater } });
        const b = await Peerbit.create({ libp2p: { connectionGater: gater } });
        peers.push(a, b);
        await connect(b, a);
        const A = await openSharedFs({ peerbit: a, machineLabel: "A" });
        await seed(A);
        let B: SharedFsHandle | undefined;
        await waitUntil(async () => {
            B ??= await openSharedFs({
                peerbit: b,
                address: A.address!,
                machineLabel: "B",
                ...options,
            } as any);
        });
        await B!.awaitWriteReady({ timeout: WAIT_MS });
        const synced = () =>
            waitUntil(async () => {
                for (const path of paths) {
                    expect((await B!.stat(path))?.versionId).toBe(
                        (await A.stat(path))!.versionId
                    );
                }
            });
        await synced();
        return {
            A,
            B: B!,
            synced,
            cut: async () => {
                cut = true;
                await b.hangUp(a.peerId);
                await waitUntil(() => {
                    expect(a.libp2p.getConnections()).toHaveLength(0);
                    expect(b.libp2p.getConnections()).toHaveLength(0);
                });
            },
            restore: async () => {
                cut = false;
                await connect(b, a, B, A);
            },
        };
    };

    /**
     * Replicas of one filesystem (index 0 creates it) with per-link
     * partitions: partition([0], [1, 2]) cuts every link between the groups
     * and restores every link inside a group.
     */
    const mesh = async (
        count: number,
        seed: (A: SharedFsHandle) => Promise<void>
    ) => {
        const denied: Set<string>[] = [];
        const nodes: Peerbit[] = [];
        for (let i = 0; i < count; i++) {
            const deny = new Set<string>();
            denied.push(deny);
            const gate = (peerId?: { toString(): string }) =>
                peerId !== undefined && deny.has(peerId.toString());
            const node = await Peerbit.create({
                libp2p: {
                    connectionGater: {
                        denyDialPeer: gate,
                        denyOutboundConnection: gate,
                        denyInboundEncryptedConnection: gate,
                        denyOutboundEncryptedConnection: gate,
                        denyInboundUpgradedConnection: gate,
                        denyOutboundUpgradedConnection: gate,
                    },
                },
            });
            peers.push(node);
            nodes.push(node);
        }
        for (let i = 0; i < count; i++) {
            for (let j = i + 1; j < count; j++) {
                await connect(nodes[j], nodes[i]);
            }
        }
        const A = await openSharedFs({ peerbit: nodes[0], machineLabel: "A" });
        await seed(A);
        const handles = [A];
        for (let i = 1; i < count; i++) {
            let fs: SharedFsHandle | undefined;
            await waitUntil(async () => {
                fs ??= await openSharedFs({
                    peerbit: nodes[i],
                    address: A.address!,
                    machineLabel: String.fromCharCode(65 + i),
                    // No test here checks bootstrap: a joiner's manifest
                    // discovery would wait out its timeout on the replicas
                    // that open after it.
                    bootstrap: false,
                } as any);
            });
            await fs!.awaitWriteReady({ timeout: WAIT_MS });
            handles.push(fs!);
        }
        const partition = async (...groups: number[][]) => {
            const group = new Map<number, number>();
            groups.forEach((members, g) =>
                members.forEach((i) => group.set(i, g))
            );
            for (let i = 0; i < count; i++) {
                for (let j = i + 1; j < count; j++) {
                    const apart = group.get(i) !== group.get(j);
                    for (const [x, y] of [
                        [i, j],
                        [j, i],
                    ]) {
                        const id = nodes[y].peerId.toString();
                        if (apart) denied[x].add(id);
                        else denied[x].delete(id);
                    }
                    if (apart) {
                        await nodes[i].hangUp(nodes[j].peerId);
                    } else {
                        await connect(
                            nodes[j],
                            nodes[i],
                            handles[j],
                            handles[i]
                        );
                    }
                }
            }
            await waitUntil(() => {
                for (let i = 0; i < count; i++) {
                    for (let j = 0; j < count; j++) {
                        if (i !== j && group.get(i) !== group.get(j)) {
                            expect(
                                nodes[i].libp2p.getConnections(nodes[j].peerId)
                            ).toHaveLength(0);
                        }
                    }
                }
            });
        };
        /** Waits until `fss` show the same heads for every path. */
        const synced = (fss: SharedFsHandle[], paths: string[]) =>
            waitUntil(async () => {
                for (const path of paths) {
                    const [first, ...rest] = await Promise.all(
                        fss.map(async (fs) =>
                            [...((await fs.stat(path))?.headVersionIds ?? [])]
                                .sort()
                                .join(",")
                        )
                    );
                    expect(first).not.toBe("");
                    for (const other of rest) expect(other).toBe(first);
                }
            });
        return { fs: handles, partition, synced };
    };

    it("lists an unchanged save made on a stale view as a conflict", async () => {
        const paths = [
            "/same.txt",
            "/twice.txt",
            "/mount.txt",
            "/batch.txt",
            "/del.txt",
        ];
        const { A, B, cut, restore, synced } = await pair(
            async (fs) => {
                await fs.writeFile("/same.txt", "X");
                await fs.writeFile("/twice.txt", "T");
                await fs.writeFile("/mount.txt", "M");
                await fs.writeFile("/batch.txt", "Q");
                await fs.writeFile("/del.txt", "D");
            },
            paths,
            // B's clock runs past the shortest skip horizon (5 min), so every
            // chunk counts as old: only reuse avoids re-putting it.
            { dedupSkipHorizonMs: 0, clock: () => Date.now() + 10 * 60_000 }
        );
        // A file B wrote, which A (the creator) re-saves below.
        await B.writeFile("/from-b.txt", "F");
        paths.push("/from-b.txt");
        await synced();

        // B's saves below reuse only chunks B holds locally. Write
        // readiness proves the namespace, not chunk bytes (design 2.3), and
        // since PR-3 commit 4 it no longer waits for the synchronizer, so B
        // can be ready while the seed's chunks still sync: wait for them
        // before the cut, as this case pins chunk reuse, not readiness.
        await waitUntil(async () => {
            for (const path of paths) {
                const versionId = (await B.stat(path))!.versionId!;
                const version = (await B.program.entries.index.get(versionId, {
                    local: true,
                    remote: false,
                })) as unknown as FileVersion;
                for (const chunkId of version.chunkIds) {
                    expect(
                        await B.program.entries.index.get(chunkId, {
                            local: true,
                            remote: false,
                        }),
                        `${path}: chunk ${chunkId} local on B`
                    ).toBeDefined();
                }
            }
        });
        const mount = (await B.stat("/mount.txt"))!;
        await cut();
        await A.writeFile("/same.txt", "Y");
        await A.writeFile("/twice.txt", "T2");
        await A.writeFile("/mount.txt", "M2");
        await A.writeFile("/batch.txt", "Q2");
        await A.rm("/del.txt");
        await B.writeFile("/from-b.txt", "F2");

        // Each side saves the bytes it sees, written by the other side. The
        // heads' chunks are reused, never re-put.
        const chunkPuts: string[] = [];
        const entries = B.program.entries;
        const put = entries.put;
        const putMany = entries.putMany;
        entries.put = function (this: unknown, doc: unknown, ...rest: any[]) {
            if (doc instanceof FileChunk) chunkPuts.push(doc.id);
            return (put as any).call(this, doc, ...rest);
        } as typeof put;
        entries.putMany = function (
            this: unknown,
            docs: unknown[],
            ...rest: any[]
        ) {
            for (const doc of docs) {
                if (doc instanceof FileChunk) chunkPuts.push(doc.id);
            }
            return (putMany as any).call(this, docs, ...rest);
        } as typeof putMany;
        let batched;
        try {
            const sameBefore = (await B.stat("/same.txt"))!;
            const same = await B.writeFile("/same.txt", "X");
            expect(same.id).not.toBe(sameBefore.versionId);
            expect(same.parentVersionIds).toEqual([sameBefore.versionId]);
            // It keeps its parent's depth, so it cannot outrank a real
            // change.
            expect(await depthOf(B, same.id)).toBe(
                await depthOf(B, sameBefore.versionId!)
            );
            // Recorded once: the next save is over this replica's own
            // version.
            const twice = await B.writeFile("/twice.txt", "T");
            expect(twice.parentVersionIds).toHaveLength(1);
            expect((await B.writeFile("/twice.txt", "T")).id).toBe(twice.id);
            const mounted = await B.writeFile("/mount.txt", "M", {
                baseVersionIds: [mount.versionId!],
                expectedNodeId: mount.nodeId,
                noOpIfHeadVersionIds: [mount.versionId!],
            });
            expect(mounted.mountWriteOutcome).toBe("created");
            batched = await B.writeBatch([
                { path: "/batch.txt", content: "Q" },
                { path: "/del.txt", content: "D" },
            ]);
        } finally {
            entries.put = put;
            entries.putMany = putMany;
        }
        expect(batched.results.every(Boolean)).toBe(true);
        expect(chunkPuts).toEqual([]);
        const fromB = await A.writeFile("/from-b.txt", "F");
        expect(fromB.parentVersionIds).toHaveLength(1);

        await restore();
        // Both sides list the conflict, and the real change stays visible.
        const expected = {
            "/same.txt": ["X", "Y"],
            "/twice.txt": ["T", "T2"],
            "/mount.txt": ["M", "M2"],
            "/batch.txt": ["Q", "Q2"],
            "/from-b.txt": ["F", "F2"],
        };
        for (const fs of [A, B]) {
            await waitUntil(async () => {
                for (const [path, contents] of Object.entries(expected)) {
                    expect(await conflictBytes(fs, path)).toEqual(contents);
                    expect(await text(fs, path)).toBe(contents[1]);
                }
                // The delete stays visible; the save is recoverable.
                expect(await fs.stat("/del.txt")).toBeUndefined();
                expect(
                    (await fs.namingConflicts()).find(
                        (c) => c.path === "/del.txt"
                    )?.type
                ).toBe("delete-vs-edit");
            });
        }
    }, 240_000);

    it("keeps a save of this replica's own head free", async () => {
        const paths = ["/x.sh", "/a.txt"];
        const { A, B, cut, restore, synced } = await pair(async (fs) => {
            await fs.writeFile("/x.sh", "old", { mode: EXEC });
            await fs.writeFile("/a.txt", "a");
        }, paths);
        // The creator saving its own file: free.
        const alone = (await A.stat("/a.txt"))!;
        expect((await A.writeFile("/a.txt", "a")).id).toBe(alone.versionId);

        const own = await B.writeFile("/own.txt", "O");
        paths.push("/own.txt");
        await synced();
        const versionsBefore = (await A.versions("/own.txt")).length;
        expect((await B.writeFile("/own.txt", "O")).id).toBe(own.id);
        const mounted = await B.writeFile("/own.txt", "O", {
            baseVersionIds: [own.id],
            expectedNodeId: own.nodeId,
            noOpIfHeadVersionIds: [own.id],
        });
        expect(mounted.mountWriteOutcome).toBe("unchanged");
        expect(
            (await B.writeBatch([{ path: "/own.txt", content: "O" }]))
                .results[0]
        ).toBeUndefined();
        expect((await B.stat("/own.txt"))!.headVersionIds).toEqual([own.id]);
        expect(await B.versions("/own.txt")).toHaveLength(versionsBefore);

        // Accepted: a change made after seeing B's version wins over B's
        // later unchanged save, as in a three-way merge. An equal metadata
        // patch is a no-op too: it could not win a merge.
        await cut();
        await A.writeFile("/own.txt", "after-O");
        await A.writeFile("/x.sh", "new");
        expect((await B.writeFile("/own.txt", "O")).id).toBe(own.id);
        const x = (await B.stat("/x.sh"))!;
        const patched = await B.setMetadata("/x.sh", {
            mode: EXEC,
            mtime: Number(x.updatedAt),
        });
        expect(patched.id).toBe(x.versionId);
        await restore();
        for (const fs of [A, B]) {
            await waitUntil(async () => {
                expect(await text(fs, "/own.txt")).toBe("after-O");
                expect(await text(fs, "/x.sh")).toBe("new");
                expect(await fs.conflicts()).toEqual([]);
            });
        }
    }, 240_000);

    it("ranks every native-mount save of unchanged bytes where the saved-over version ranked", async () => {
        // A write through the mount advances mtime, so the mount publishes
        // even a save of unchanged bytes. No such save may outrank a change
        // it has not received: neither the first nor a repeated one (git
        // checkout, formatters, generators), whoever wrote the bytes. o*:
        // bytes B wrote.
        const stale = Array.from({ length: 6 }, (_, i) => `/s${i}.txt`);
        const ownStale = Array.from({ length: 6 }, (_, i) => `/o${i}.txt`);
        const paths = [...stale, "/t.txt"];
        const { A, B, cut, restore, synced } = await pair(async (fs) => {
            for (const path of paths) {
                await fs.writeFile(path, "S", { mtime: 1_000 });
            }
        }, paths);
        const backend = createSharedFsMountBackend(B);
        /** open, write the shown bytes, optionally utimens, close. */
        const save = async (path: string, mtimeMs?: number) => {
            const handle = await backend.open(path, {
                read: true,
                write: true,
            });
            await backend.write(handle, encode("S"), 0);
            if (mtimeMs !== undefined) {
                await backend.setattr(path, { mtimeMs });
            }
            await backend.release(handle);
            return (await B.stat(path))!;
        };
        try {
            // Over A's version: a copy that keeps its depth and rank prefix
            // and carries the write's mtime. So is a later save over that
            // copy, a utimens included: B's own copy does not make A's bytes
            // B's. A commit that restores the shown mtime (cp -p) changes
            // nothing: free.
            const original = (await B.stat("/t.txt"))!;
            const copy = await save("/t.txt");
            expect(copy.headVersionIds).toEqual([copy.versionId]);
            expect(copy.updatedAt).toBeGreaterThan(1_000n);
            const again = await save("/t.txt", Number(copy.updatedAt) + 1);
            expect(again.headVersionIds).toEqual([again.versionId]);
            expect(again.updatedAt).toBe(copy.updatedAt + 1n);
            for (const saved of [copy, again]) {
                expect(saved.versionId!.slice(0, 32)).toBe(
                    original.versionId!.slice(0, 32)
                );
                expect(await depthOf(B, saved.versionId!)).toBe(
                    await depthOf(B, original.versionId!)
                );
            }
            const versions = (await B.versions("/t.txt")).length;
            expect(
                (await save("/t.txt", Number(again.updatedAt))).versionId
            ).toBe(again.versionId);
            expect(await B.versions("/t.txt")).toHaveLength(versions);
            // A utimens over bytes B wrote is a touch: an ordinary version.
            // So it is over A's copy of them: the copy does not make B's
            // bytes A's.
            const own = await B.writeFile("/own.txt", "S", { mtime: 1_000 });
            const touch = await save("/own.txt", 5_000);
            expect(await depthOf(B, touch.versionId!)).toBe(
                (await depthOf(B, own.id)) + 1n
            );
            paths.push("/own.txt");
            await synced();
            const copyOfOwn = await A.writeFile("/own.txt", "S");
            expect(copyOfOwn.id.slice(0, 32)).toBe(
                touch.versionId!.slice(0, 32)
            );
            await synced();
            const retouch = await save("/own.txt", 6_000);
            expect(retouch.versionId!.slice(0, 32)).not.toBe(
                copyOfOwn.id.slice(0, 32)
            );
            expect(await depthOf(B, retouch.versionId!)).toBe(
                (await depthOf(B, copyOfOwn.id)) + 1n
            );
            for (const path of ownStale) {
                await B.writeFile(path, "S", { mtime: 1_000 });
                paths.push(path);
            }
            await synced();

            // B saves what it shows, twice, while A's newer change has not
            // reached it.
            await cut();
            for (const path of [...stale, ...ownStale]) {
                await A.writeFile(path, "S2");
            }
            for (const path of stale) {
                const before = (await B.stat(path))!;
                const first = await save(path);
                const second = await save(path, Number(first.updatedAt) + 1);
                expect(second.versionId).not.toBe(first.versionId);
                for (const saved of [first, second]) {
                    expect(saved.versionId!.slice(0, 32)).toBe(
                        before.versionId!.slice(0, 32)
                    );
                    expect(await depthOf(B, saved.versionId!)).toBe(
                        await depthOf(B, before.versionId!)
                    );
                }
            }
            // Over bytes B wrote, a save that changes only the write's clock
            // is a copy too (an editor's :w).
            for (const path of ownStale) {
                const before = (await B.stat(path))!;
                for (const saved of [await save(path), await save(path)]) {
                    expect(saved.versionId!.slice(0, 32)).toBe(
                        before.versionId!.slice(0, 32)
                    );
                    expect(await depthOf(B, saved.versionId!)).toBe(
                        await depthOf(B, before.versionId!)
                    );
                }
            }
            await restore();
            // Both versions are listed, and A's change stays visible on
            // every file instead of an id tie deciding.
            for (const fs of [A, B]) {
                await waitUntil(async () => {
                    for (const path of [...stale, ...ownStale]) {
                        expect(await conflictBytes(fs, path)).toEqual([
                            "S",
                            "S2",
                        ]);
                        expect(await text(fs, path)).toBe("S2");
                    }
                });
            }
        } finally {
            backend.dispose();
        }
    }, 240_000);

    it("ranks a shell redirect of unchanged bytes where the saved-over version ranked", async () => {
        // `cmd > file` on Linux: open with O_TRUNC, dup the descriptor onto
        // stdout and close the original (a flush before any write), then
        // write and close. That first flush must not publish an empty
        // version, which would make the save of unchanged bytes an ordinary
        // version two deeper than the one the file was opened on. r.txt:
        // bytes A wrote; own.txt: bytes B wrote.
        const paths = ["/r.txt"];
        const { A, B, cut, restore, synced } = await pair(async (fs) => {
            await fs.writeFile("/r.txt", "S\n", { mtime: 1_000 });
        }, paths);
        await B.writeFile("/own.txt", "S\n", { mtime: 1_000 });
        paths.push("/own.txt");
        await synced();
        await cut();
        for (const path of paths) await A.writeFile(path, "S2\n");
        const backend = createSharedFsMountBackend(B);
        try {
            for (const path of paths) {
                const before = (await B.stat(path))!;
                const versions = (await B.versions(path)).length;
                const handle = await backend.open(path, {
                    write: true,
                    truncate: true,
                });
                await backend.flush(handle);
                await backend.write(handle, encode("S\n"), 0);
                await backend.flush(handle);
                await backend.release(handle);
                const saved = (await B.stat(path))!;
                expect(await B.versions(path)).toHaveLength(versions + 1);
                expect(saved.versionId!.slice(0, 32)).toBe(
                    before.versionId!.slice(0, 32)
                );
                expect(await depthOf(B, saved.versionId!)).toBe(
                    await depthOf(B, before.versionId!)
                );
            }
            // `: > file` still publishes the empty file on close.
            await B.writeFile("/empty.txt", "E");
            const handle = await backend.open("/empty.txt", {
                write: true,
                truncate: true,
            });
            await backend.flush(handle);
            expect(await text(B, "/empty.txt")).toBe("E");
            await backend.release(handle);
            expect(await text(B, "/empty.txt")).toBe("");
        } finally {
            backend.dispose();
        }
        await restore();
        for (const fs of [A, B]) {
            await waitUntil(async () => {
                for (const path of paths) {
                    expect(await conflictBytes(fs, path)).toEqual([
                        "S\n",
                        "S2\n",
                    ]);
                    expect(await text(fs, path)).toBe("S2\n");
                }
            });
        }
    }, 240_000);

    it("ranks a mount save of the bytes an open file shows where its base ranked", async () => {
        // A's change reaches B while B holds the file open, so the open
        // file still shows the bytes it opened on. Writing those back must
        // not tie with A's change: it saves over the open file's base, not
        // over the heads that arrived since. h*: a held read/write
        // descriptor; r*: a held read-only one, whose snapshot a later
        // write-only open shares.
        const held = Array.from({ length: 3 }, (_, i) => `/h${i}.txt`);
        const shared = Array.from({ length: 3 }, (_, i) => `/r${i}.txt`);
        const paths = [...held, ...shared];
        const { A, B, synced } = await pair(async (fs) => {
            for (const path of paths) {
                await fs.writeFile(path, "S", { mtime: 1_000 });
            }
        }, paths);
        const backend = createSharedFsMountBackend(B);
        try {
            const base = new Map<string, string>();
            const handles = new Map<string, number>();
            for (const path of paths) {
                base.set(path, (await B.stat(path))!.versionId!);
                handles.set(
                    path,
                    await backend.open(path, {
                        read: true,
                        write: held.includes(path),
                    })
                );
            }
            for (const path of paths) await A.writeFile(path, "S2");
            await synced();
            const changed = new Map<string, string>();
            for (const path of paths) {
                changed.set(path, (await B.stat(path))!.versionId!);
                expect(
                    decode(await backend.read(handles.get(path)!, 8, 0))
                ).toBe("S");
            }
            for (const path of held) {
                await backend.write(handles.get(path)!, encode("S"), 0);
                await backend.release(handles.get(path)!);
            }
            for (const path of shared) {
                const handle = await backend.open(path, {
                    write: true,
                    truncate: true,
                });
                await backend.write(handle, encode("S"), 0);
                await backend.release(handle);
                await backend.release(handles.get(path)!);
            }
            // Each save is a copy of the base: its depth, its rank prefix,
            // next to A's change instead of over it.
            for (const path of paths) {
                const heads = (await B.stat(path))!.headVersionIds!;
                expect(heads).toHaveLength(2);
                expect(heads).toContain(changed.get(path));
                const saved = heads.find((id) => id !== changed.get(path))!;
                expect(saved.slice(0, 32)).toBe(base.get(path)!.slice(0, 32));
                expect(await depthOf(B, saved)).toBe(
                    await depthOf(B, base.get(path)!)
                );
            }
        } finally {
            backend.dispose();
        }
        for (const fs of [A, B]) {
            await waitUntil(async () => {
                for (const path of paths) {
                    expect(await conflictBytes(fs, path)).toEqual(["S", "S2"]);
                    expect(await text(fs, path)).toBe("S2");
                }
            });
        }
    }, 240_000);

    it("records a copy for a mount commit of unchanged metadata over heads that changed since the open", async () => {
        // B opens bytes it wrote; A's copy of them becomes the only head
        // while the file is open; B writes the same bytes and sets the mtime
        // back (cp -p). Every head shows those bytes and that mtime, but the
        // commit is not over the heads it opened, so it cannot report
        // "unchanged" (the mount rejects that with EIO): it records a copy.
        const paths: string[] = [];
        const { A, B, synced } = await pair(async () => {}, paths);
        const own = await B.writeFile("/g.txt", "X", { mtime: 1_000 });
        paths.push("/g.txt");
        await synced();
        const backend = createSharedFsMountBackend(B);
        try {
            const handle = await backend.open("/g.txt", {
                read: true,
                write: true,
            });
            const copy = await A.writeFile("/g.txt", "X");
            expect(copy.id.slice(0, 32)).toBe(own.id.slice(0, 32));
            await waitUntil(async () => {
                expect((await B.stat("/g.txt"))!.headVersionIds).toEqual([
                    copy.id,
                ]);
            });
            await backend.write(handle, encode("X"), 0);
            await backend.setattr("/g.txt", { mtimeMs: 1_000 });
            await backend.release(handle);
        } finally {
            backend.dispose();
        }
        const saved = (await B.stat("/g.txt"))!;
        expect(saved.headVersionIds).toEqual([saved.versionId]);
        expect(saved.versionId!.slice(0, 32)).toBe(own.id.slice(0, 32));
        expect(saved.updatedAt).toBe(1_000n);
        expect(await B.versions("/g.txt")).toHaveLength(3);
    }, 240_000);

    it("merges a concurrent chmod and touch instead of dropping one", async () => {
        // Each file ends with two heads holding the same bytes. The side that
        // changed it twice is deeper, so its head ranks first whatever the
        // ids, and that head's own mode and mtime are never the merged ones:
        // each check below fails every time if its merge is dropped.
        const paths = ["/up.sh", "/down.sh", "/later.txt", "/mount.sh"];
        const { A, B, cut, restore } = await pair(async (fs) => {
            await fs.writeFile("/up.sh", "up", { mtime: 1_000 });
            await fs.writeFile("/down.sh", "down", {
                mode: EXEC,
                mtime: 1_000,
            });
            await fs.writeFile("/later.txt", "l", { mtime: 1_000 });
            await fs.writeFile("/mount.sh", "m", { mtime: 1_000 });
        }, paths);

        await cut();
        // up: A chmods in two steps that end on the base's mtime; B touches.
        await A.setMetadata("/up.sh", { mtime: 1_500 });
        await A.setMetadata("/up.sh", { mode: EXEC, mtime: 1_000 });
        await B.setMetadata("/up.sh", { mtime: 2_000 });
        // down, mount: A chmods; B touches twice. later: both touch, and the
        // later mtime is on the head that ranks second.
        await A.setMetadata("/down.sh", { mode: FILE });
        await A.setMetadata("/mount.sh", { mode: EXEC });
        await A.setMetadata("/later.txt", { mtime: 3_000 });
        for (const path of ["/down.sh", "/later.txt", "/mount.sh"]) {
            await B.setMetadata(path, { mtime: 1_500 });
            await B.setMetadata(path, { mtime: 2_000 });
        }
        const first = new Map<string, string>();
        for (const path of paths) {
            const deeper = path === "/up.sh" ? A : B;
            first.set(path, (await deeper.stat(path))!.versionId!);
        }
        await restore();

        // Each change survives on both replicas: the mode one side changed,
        // the mtime the other side changed, and the later of two mtimes.
        const merged: Record<string, [number, bigint]> = {
            "/up.sh": [EXEC, 2_000n],
            "/down.sh": [FILE, 2_000n],
            "/later.txt": [FILE, 3_000n],
            "/mount.sh": [EXEC, 2_000n],
        };
        for (const fs of [A, B]) {
            await waitUntil(async () => {
                const listed = new Map(
                    (await fs.list("/")).map((entry) => [entry.path, entry])
                );
                for (const [path, [mode, mtime]] of Object.entries(merged)) {
                    const entry = (await fs.stat(path))!;
                    expect(entry.headVersionIds).toHaveLength(2);
                    expect(entry.versionId).toBe(first.get(path));
                    expect(entry.conflict).toBe(false);
                    expect([entry.mode, entry.updatedAt]).toEqual([
                        mode,
                        mtime,
                    ]);
                    expect([
                        listed.get(path)?.mode,
                        listed.get(path)?.updatedAt,
                    ]).toEqual([mode, mtime]);
                }
            });
        }

        // Saving what the file shows changes nothing: B wrote one of the
        // heads, so the save and an equal metadata patch are no-ops. Each
        // reports the merged metadata stat shows, not the visible head's.
        const upHeads = (await B.stat("/up.sh"))!.headVersionIds;
        for (const unchanged of [
            await B.writeFile("/up.sh", "up"),
            await B.setMetadata("/up.sh", { mode: EXEC, mtime: 2_000 }),
            await B.setMetadata("/up.sh", { mode: EXEC }),
        ]) {
            expect(upHeads).toContain(unchanged.id);
            expect([unchanged.mode, unchanged.mtime]).toEqual([EXEC, 2_000n]);
        }
        expect(
            (await B.writeBatch([{ path: "/up.sh", content: "up" }])).results[0]
        ).toBeUndefined();
        expect((await B.stat("/up.sh"))!.headVersionIds).toEqual(upHeads);
        // A native-mount edit keeps the merged mode as well.
        const backend = createSharedFsMountBackend(B);
        try {
            const handle = await backend.open("/mount.sh", {
                read: true,
                write: true,
            });
            await backend.write(handle, encode("m2"), 0);
            await backend.release(handle);
        } finally {
            backend.dispose();
        }
        const mounted = (await B.stat("/mount.sh"))!;
        expect(mounted.headVersionIds).toHaveLength(1);
        expect([mounted.mode, await text(B, "/mount.sh")]).toEqual([
            EXEC,
            "m2",
        ]);
        // The next write keeps the merged field it does not set.
        const up = await B.writeFile("/up.sh", "up", { mode: FILE });
        expect([up.mode, up.mtime, up.parentVersionIds.length]).toEqual([
            FILE,
            2_000n,
            2,
        ]);
        const [down] = (
            await B.writeBatch([{ path: "/down.sh", content: "down2" }])
        ).results;
        expect([down?.mode, down?.parentVersionIds.length]).toEqual([FILE, 2]);
        const later = await A.setMetadata("/later.txt", { mode: EXEC });
        expect([later.mode, later.mtime]).toEqual([EXEC, 3_000n]);
    }, 240_000);

    it("keeps a concurrent chmod and touch through resolveConflict and restore", async () => {
        // A chmods and B touches the same bytes. On r*, A also forks other
        // bytes from an older version, so those heads conflict while the
        // chmod/touch bytes stay visible; on d*, A deletes after its chmod,
        // which leaves B's touch as a delete-vs-edit conflict.
        const forked = Array.from({ length: 4 }, (_, i) => `/r${i}.sh`);
        const deleted = Array.from({ length: 2 }, (_, i) => `/d${i}.sh`);
        const paths = [...forked, ...deleted];
        const older = new Map<string, string>();
        const { A, B, cut, restore } = await pair(async (fs) => {
            for (const path of paths) {
                older.set(path, (await fs.writeFile(path, "p")).id);
                await fs.writeFile(path, "x", { mtime: 1_000 });
            }
        }, paths);
        await cut();
        for (const path of paths) {
            await A.setMetadata(path, { mode: EXEC });
            await B.setMetadata(path, { mtime: 2_000 });
        }
        for (const path of forked) {
            await A.writeFile(path, "y", {
                baseVersionIds: [older.get(path)!],
            });
        }
        for (const path of deleted) await A.rm(path);
        await restore();
        await waitUntil(async () => {
            for (const path of forked) {
                expect(await B.stat(path)).toMatchObject({
                    conflict: true,
                    mode: EXEC,
                    updatedAt: 2_000n,
                });
                expect((await B.stat(path))!.headVersionIds).toHaveLength(3);
            }
            const types = new Map(
                (await B.namingConflicts()).map((c) => [c.path, c.type])
            );
            for (const path of deleted) {
                expect(types.get(path)).toBe("delete-vs-edit");
            }
        });

        // Resolving to the visible bytes keeps what stat showed, through
        // the listed head or the other head holding those bytes.
        for (const [i, path] of forked.entries()) {
            const [listed] = (await B.conflicts(path))[0].versions;
            const other = (await B.versions(path)).find(
                (version) =>
                    version.head &&
                    version.contentHash === listed.contentHash &&
                    version.id !== listed.id
            )!;
            const resolution = await B.resolveConflict(
                path,
                (i % 2 === 0 ? listed : other).id
            );
            expect([resolution.mode, resolution.mtime]).toEqual([EXEC, 2_000n]);
        }
        for (const path of deleted) {
            const conflict = (await B.namingConflicts()).find(
                (c) => c.path === path
            )!;
            await B.resolveNamingConflict(conflict.nodeId, { type: "restore" });
        }
        for (const fs of [A, B]) {
            await waitUntil(async () => {
                for (const path of paths) {
                    expect(await fs.stat(path)).toMatchObject({
                        conflict: false,
                        mode: EXEC,
                        updatedAt: 2_000n,
                    });
                    expect(await text(fs, path)).toBe("x");
                }
            });
        }
    }, 240_000);

    it("keeps concurrent unchanged saves depth-neutral and free", async () => {
        // x: A edits while B and C, cut off from A and from each other, each
        // save the bytes A wrote. y: the same saves, then a real edit made
        // after seeing both, raced by another unchanged save.
        const xs = ["/x0.txt", "/x1.txt"];
        const ys = ["/y0.txt", "/y1.txt"];
        const paths = [...xs, ...ys];
        const {
            fs: [A, B, C],
            partition,
            synced,
        } = await mesh(3, async (fs) => {
            for (const path of paths) await fs.writeFile(path, "p");
        });
        await synced([A, B, C], paths);
        await partition([0], [1], [2]);
        for (const path of xs) await A.writeFile(path, "A-edit");
        for (const path of paths) {
            for (const fs of [B, C]) {
                const saved = await fs.writeFile(path, "p");
                expect(saved.parentVersionIds).toHaveLength(1);
            }
        }
        await partition([0], [1, 2]);
        await synced([B, C], paths);
        for (const path of paths) {
            const heads = (await B.stat(path))!.headVersionIds!;
            expect(heads).toHaveLength(2);
            // Over two same-bytes heads, one its own, each save is free.
            expect(heads).toContain((await B.writeFile(path, "p")).id);
            expect(
                (await C.writeBatch([{ path, content: "p" }])).results[0]
            ).toBeUndefined();
            const mounted = await C.writeFile(path, "p", {
                baseVersionIds: [heads[0]],
                expectedNodeId: (await C.stat(path))!.nodeId,
                noOpIfHeadVersionIds: (await C.stat(path))!.headVersionIds,
            });
            expect(mounted.mountWriteOutcome).toBe("unchanged");
            expect(await B.versions(path)).toHaveLength(3);
            expect(await depthOf(B, heads[0])).toBe(await depthOf(B, heads[1]));
        }
        await partition([0, 1, 2]);
        await synced([A, B, C], paths);
        for (const fs of [A, B, C]) {
            for (const path of xs) {
                // The real edit stays visible over the unchanged bytes.
                expect(await text(fs, path)).toBe("A-edit");
                expect(await conflictBytes(fs, path)).toEqual(["A-edit", "p"]);
            }
        }
        await partition([0], [1, 2]);
        for (const path of ys) await A.writeFile(path, "real-edit");
        for (const path of ys) {
            const heads = (await B.stat(path))!.headVersionIds!;
            expect(heads).toContain((await B.writeFile(path, "p")).id);
        }
        await partition([0, 1, 2]);
        await synced([A, B, C], ys);
        for (const fs of [A, B, C]) {
            for (const path of ys) {
                expect(await text(fs, path)).toBe("real-edit");
                expect(await conflictBytes(fs, path)).toEqual([]);
            }
        }
    }, 300_000);

    it("ranks a recorded save exactly where the version it copies ranked", async () => {
        // A and C make concurrent edits of one version; B receives only
        // A's and saves it unchanged. The visible choice between the two
        // edits must not depend on B's save.
        const paths = Array.from({ length: 8 }, (_, i) => `/s${i}.txt`);
        const {
            fs: [A, B, C],
            partition,
            synced,
        } = await mesh(3, async (fs) => {
            for (const path of paths) await fs.writeFile(path, "p");
        });
        await synced([A, B, C], paths);
        await partition([0], [1], [2]);
        const one = new Map<string, string>();
        const two = new Map<string, string>();
        for (const path of paths) {
            two.set(path, (await C.writeFile(path, "two")).id);
            one.set(path, (await A.writeFile(path, "one")).id);
        }
        await partition([0, 1], [2]);
        await synced([A, B], paths);
        for (const [i, path] of paths.entries()) {
            // writeFile and writeBatch build the copy separately.
            const saved =
                i % 2 === 0
                    ? await B.writeFile(path, "one")
                    : (await B.writeBatch([{ path, content: "one" }]))
                          .results[0]!;
            expect(saved.parentVersionIds).toEqual([one.get(path)]);
            expect(saved.id.slice(0, 32)).toBe(one.get(path)!.slice(0, 32));
            expect(await depthOf(B, saved.id)).toBe(
                await depthOf(B, one.get(path)!)
            );
        }
        await partition([0, 1, 2]);
        await synced([A, B, C], paths);
        for (const fs of [A, B, C]) {
            for (const path of paths) {
                expect(await conflictBytes(fs, path)).toEqual(["one", "two"]);
                // The tie between the two edits breaks as it did before.
                expect(await text(fs, path)).toBe(
                    one.get(path)! < two.get(path)! ? "one" : "two"
                );
            }
        }
    }, 300_000);

    it("ranks a mount write that takes in a third replica's chmod as a change made after it", async () => {
        // B wrote S and holds each file open. Meanwhile C chmods it, on top
        // of B's version, and A edits most files to X, also on top of B's
        // version; both reach B before B's save. The save takes in C's
        // chmod. Of unchanged bytes (plain) it is a copy of the chmod and
        // ties with A's edit where the chmod did; otherwise (touch: a
        // utimens; edit and copied: other bytes) it is an ordinary version
        // one deeper than the chmod, so it outranks A's edit (both listed)
        // and a copy of the chmod that A records before B's save reaches it
        // can never tie with it (copied).
        const groups = {
            plain: ["/p0.txt", "/p1.txt"],
            touch: ["/t0.txt", "/t1.txt"],
            edit: ["/e0.txt", "/e1.txt"],
            copied: ["/c0.txt", "/c1.txt"],
        };
        const paths = Object.values(groups).flat();
        const {
            fs: [A, B, C],
            partition,
            synced,
        } = await mesh(3, async () => {});
        const base = new Map<string, string>();
        for (const path of paths) {
            base.set(path, (await B.writeFile(path, "S", { mtime: 1_000 })).id);
        }
        await synced([A, B, C], paths);
        const backend = createSharedFsMountBackend(B);
        const saved = new Map<string, [string, string]>();
        const edits = new Map<string, string>();
        const chmods = new Map<string, string>();
        try {
            const handles = new Map<string, number>();
            for (const path of paths) {
                handles.set(
                    path,
                    await backend.open(path, { read: true, write: true })
                );
            }
            await partition([0], [1], [2]);
            for (const path of paths) {
                if (!groups.copied.includes(path)) {
                    edits.set(path, (await A.writeFile(path, "X")).id);
                }
                chmods.set(
                    path,
                    (await C.setMetadata(path, { mode: EXEC })).id
                );
            }
            await partition([0, 1, 2]);
            await synced([A, B, C], paths);
            // A holds the chmod but receives none of B's saves until the
            // end.
            await partition([0], [1, 2]);
            for (const [group, members] of Object.entries(groups)) {
                for (const path of members) {
                    const handle = handles.get(path)!;
                    expect(decode(await backend.read(handle, 8, 0))).toBe("S");
                    const bytes =
                        group === "edit" || group === "copied" ? "Y" : "S";
                    await backend.write(handle, encode(bytes), 0);
                    if (group === "touch") {
                        await backend.setattr(path, { mtimeMs: 5_000 });
                    }
                    await backend.release(handle);
                    const heads = (await B.stat(path))!.headVersionIds!;
                    const edit = edits.get(path);
                    expect(heads).toHaveLength(edit ? 2 : 1);
                    const id = heads.find((head) => head !== edit)!;
                    saved.set(path, [id, bytes]);
                    const version = (await B.program.entries.index.get(id, {
                        local: true,
                        remote: false,
                    })) as unknown as FileVersion;
                    expect([...version.parentVersionIds].sort()).toEqual(
                        [base.get(path)!, chmods.get(path)!].sort()
                    );
                    // The chmod survives.
                    expect(version.mode).toBe(EXEC);
                    const chmodDepth = await depthOf(B, chmods.get(path)!);
                    if (group === "plain") {
                        // A copy of the chmod, the better-ranked parent.
                        expect(id.slice(0, 32)).toBe(
                            chmods.get(path)!.slice(0, 32)
                        );
                        expect(version.causalDepth).toBe(chmodDepth);
                    } else {
                        // Deeper than every parent, as any change is.
                        expect(
                            version.parentVersionIds.map((parent) =>
                                parent.slice(0, 32)
                            )
                        ).not.toContain(id.slice(0, 32));
                        expect(version.causalDepth).toBe(chmodDepth + 1n);
                    }
                }
            }
        } finally {
            backend.dispose();
        }
        // A saves what it shows, the chmod, before B's edit reaches it: a
        // copy of the chmod at its depth.
        for (const path of groups.copied) {
            const copy = await A.writeFile(path, "S");
            expect(copy.id.slice(0, 32)).toBe(chmods.get(path)!.slice(0, 32));
            expect(await depthOf(A, copy.id)).toBe(
                await depthOf(A, chmods.get(path)!)
            );
        }
        await partition([0, 1, 2]);
        await synced([A, B, C], paths);
        for (const fs of [A, B, C]) {
            for (const path of paths) {
                const [id, bytes] = saved.get(path)!;
                const edit = edits.get(path);
                expect(await conflictBytes(fs, path)).toEqual(
                    [bytes, edit ? "X" : "S"].sort()
                );
                expect(await text(fs, path)).toBe(
                    path.startsWith("/p") && id > edit! ? "X" : bytes
                );
            }
        }
    }, 300_000);

    it("keeps saves free for replicas taking turns", async () => {
        const paths = ["/t0.txt", "/t1.txt"];
        const {
            fs: [A, B, C],
            synced,
        } = await mesh(3, async (fs) => {
            for (const path of paths) await fs.writeFile(path, "X");
        });
        await synced([A, B, C], paths);
        const original = await Promise.all(
            paths.map(async (path) => (await A.stat(path))!.versionId!)
        );
        // B, C, A, B, C, A, B: one recorded copy each for B and C, then
        // every save is over a chain this replica already wrote into.
        for (const [turn, fs] of [B, C, A, B, C, A, B].entries()) {
            const saved = [
                await fs.writeFile(paths[0], "X"),
                (await fs.writeBatch([{ path: paths[1], content: "X" }]))
                    .results[0],
            ];
            if (turn === 1) {
                // C's copy of B's copy also references A's version, so GC
                // can retire B's copy (writeFile and writeBatch build the
                // parents separately).
                for (const [i, version] of saved.entries()) {
                    expect(version!.parentVersionIds).toHaveLength(2);
                    expect(version!.parentVersionIds).toContain(original[i]);
                }
            }
            await synced([A, B, C], paths);
        }
        for (const fs of [A, B, C]) {
            for (const path of paths) {
                expect(await fs.versions(path)).toHaveLength(3);
                expect((await fs.stat(path))!.headVersionIds).toHaveLength(1);
            }
        }
    }, 300_000);

    it("keeps the metadata merge base through GC, and counts mount copies toward keepVersions", async () => {
        // m*: A chmods while B touches twice, so B's head ranks first and
        // only the merge base shows that A changed the mode. run, capped:
        // repeated mount saves of A's bytes (capped then edited) are copies
        // with a new mtime, which count toward keepVersions like any version,
        // as those saves' ordinary versions did on master. k: B's unchanged
        // save of A's newest version (a copy with that version's mtime, which
        // master did not record) stays without pushing an older distinct
        // version out of keepVersions.
        const merged = ["/m0.sh", "/m1.sh"];
        const runs = ["/run.txt", "/capped.txt"];
        const paths = [...merged, "/k.txt", ...runs];
        const { A, B, cut, restore, synced } = await pair(async (fs) => {
            for (const path of merged) {
                await fs.writeFile(path, "m", { mtime: 1_000 });
            }
            await fs.writeFile("/k.txt", "k1");
            for (const path of runs) {
                await fs.writeFile(path, "S", { mtime: 1_000 });
            }
        }, paths);
        // Written after pair() synced, so strictly newer than k1:
        // keepVersions orders the two without a tie-break.
        const k1 = (await A.stat("/k.txt"))!.versionId!;
        const k2 = (await A.writeFile("/k.txt", "k2")).id;
        await synced();
        const kCopy = (await B.writeFile("/k.txt", "k2")).id;
        const saves = new Map<string, string[]>();
        const backend = createSharedFsMountBackend(B);
        // keepVersions orders by creation time: no two saves share a ms.
        const nextMs = async () => {
            const saved = Date.now();
            await waitUntil(() => expect(Date.now()).toBeGreaterThan(saved));
        };
        try {
            for (const path of runs) {
                const ids = [(await B.stat(path))!.versionId!];
                for (const mtimeMs of [2_000, 3_000, 4_000]) {
                    const handle = await backend.open(path, {
                        read: true,
                        write: true,
                    });
                    await backend.write(handle, encode("S"), 0);
                    await backend.setattr(path, { mtimeMs });
                    await backend.release(handle);
                    ids.push((await B.stat(path))!.versionId!);
                    await nextMs();
                }
                // A's version and three copies of it.
                expect(new Set(ids).size).toBe(4);
                for (const id of ids) {
                    expect(id.slice(0, 32)).toBe(ids[0].slice(0, 32));
                }
                saves.set(path, ids);
            }
            const handle = await backend.open("/capped.txt", {
                read: true,
                write: true,
            });
            await backend.write(handle, encode("S3"), 0);
            await backend.release(handle);
            saves
                .get("/capped.txt")!
                .push((await B.stat("/capped.txt"))!.versionId!);
        } finally {
            backend.dispose();
        }
        await cut();
        for (const path of merged) {
            await A.setMetadata(path, { mode: EXEC });
            await B.setMetadata(path, { mtime: 1_500 });
            await B.setMetadata(path, { mtime: 2_000 });
        }
        await restore();
        await synced();
        await waitUntil(async () => {
            for (const path of merged) {
                expect((await A.stat(path))!.headVersionIds).toHaveLength(2);
            }
            // Every copy reached A; versions() would pin them against GC.
            for (const id of [kCopy, ...[...saves.values()].flat()]) {
                expect(
                    await A.program.entries.index.get(id, {
                        local: true,
                        remote: false,
                    })
                ).toBeTruthy();
            }
        });
        const report = await A.collectGarbage({
            keepVersions: 2,
            retentionMs: 0,
            graceMs: 0,
            settleMs: 0,
            nowMs: Date.now() + 40 * 24 * 3_600_000,
        });
        expect(report.retiredVersions).toBeGreaterThan(0);
        for (const path of merged) {
            expect(await A.stat(path)).toMatchObject({
                mode: EXEC,
                updatedAt: 2_000n,
            });
        }
        const written = await A.writeFile(merged[0], "m", { mtime: 3_000 });
        expect(written.mode).toBe(EXEC);
        // The newest two of each file stay; on k the copy is not counted.
        const ids = async (path: string) =>
            (await A.versions(path)).map((version) => version.id).sort();
        expect(await ids("/k.txt")).toEqual([k1, k2, kCopy].sort());
        const run = saves.get("/run.txt")!;
        const capped = saves.get("/capped.txt")!;
        expect(await ids("/run.txt")).toEqual([run[2], run[3]].sort());
        expect(await ids("/capped.txt")).toEqual([capped[3], capped[4]].sort());
        expect((await A.stat("/run.txt"))!.headVersionIds).toEqual([run[3]]);
        expect((await A.stat("/capped.txt"))!.headVersionIds).toEqual([
            capped[4],
        ]);
        expect(await text(A, "/run.txt")).toBe("S");
        expect(await text(A, "/capped.txt")).toBe("S3");
    }, 300_000);

    it("records an ordinary version over a head without a canonical id", async () => {
        // Only a writer outside shared-fs mints such an id. A save of its
        // bytes cannot share its rank prefix, so it must not keep its depth
        // either: it is an ordinary version over it.
        const peer = await Peerbit.create();
        peers.push(peer);
        const A = await openSharedFs({ peerbit: peer, machineLabel: "A" });
        for (const [path, id] of [
            ["/plain.txt", "version:x"], // not base64url
            ["/short.txt", "version:AAAA"], // 3 bytes
            ["/plain-batch.txt", "version:y"],
            ["/short-batch.txt", "version:BBBB"],
        ]) {
            const written = await A.writeFile(path, "x");
            const base = (await A.program.entries.index.get(written.id, {
                local: true,
                remote: false,
            })) as unknown as FileVersion;
            await A.program.entries.put(
                new FileVersion({
                    id,
                    nodeId: base.nodeId,
                    parentVersionIds: [base.id],
                    causalDepth: base.causalDepth + 1n,
                    contentHash: base.contentHash,
                    size: base.size,
                    mode: base.mode,
                    mtime: base.mtime,
                    chunkIds: base.chunkIds,
                    createdAt: base.createdAt,
                    authorKey: "another-writer",
                    machineLabel: "M",
                }),
                { unique: true }
            );
            expect((await A.stat(path))!.versionId).toBe(id);
            const saved = path.includes("batch")
                ? (await A.writeBatch([{ path, content: "x" }])).results[0]!
                : await A.writeFile(path, "x");
            expect(saved.parentVersionIds).toEqual([id]);
            expect(await depthOf(A, saved.id)).toBe(base.causalDepth + 2n);
            expect((await A.stat(path))!.headVersionIds).toEqual([saved.id]);
            expect(await text(A, path)).toBe("x");
        }
    });

    it("records a save of the same bytes with a new mode as an ordinary version", async () => {
        // Unchanged means the bytes and the mode: rewriting a script with
        // its exec bit set is a chmod, never a copy that keeps its parent's
        // depth and so loses to a concurrent edit of that parent.
        const peer = await Peerbit.create();
        peers.push(peer);
        const A = await openSharedFs({ peerbit: peer, machineLabel: "A" });
        const backend = createSharedFsMountBackend(A);
        try {
            for (const via of ["writeFile", "mount"]) {
                const path = `/${via}.sh`;
                const before = await A.writeFile(path, "#!/bin/sh\n");
                if (via === "writeFile") {
                    await A.writeFile(path, "#!/bin/sh\n", { mode: EXEC });
                } else {
                    const handle = await backend.open(path, {
                        read: true,
                        write: true,
                    });
                    await backend.write(handle, encode("#!/bin/sh\n"), 0);
                    await backend.setattr(path, { mode: 0o755 });
                    await backend.release(handle);
                }
                const saved = (await A.stat(path))!;
                expect(saved.headVersionIds).toEqual([saved.versionId]);
                expect(saved.mode).toBe(EXEC);
                expect(saved.versionId!.slice(0, 32)).not.toBe(
                    before.id.slice(0, 32)
                );
                expect(await depthOf(A, saved.versionId!)).toBe(
                    (await depthOf(A, before.id)) + 1n
                );
            }
        } finally {
            backend.dispose();
        }
    });

    it("leaves a truncate-only change to the descriptor that emptied the file", async () => {
        // A reader that opens and closes the file between a redirect's
        // O_TRUNC open and its write (an editor or watcher reloading it) must
        // not publish the empty version, or the redirect's unchanged bytes
        // become an ordinary version two deeper than the version the file
        // was opened on. The emptying descriptor's release still commits
        // (`: > file` while an editor holds the file), and so does a flush
        // once the truncate is not the only change.
        const peer = await Peerbit.create();
        peers.push(peer);
        const A = await openSharedFs({ peerbit: peer, machineLabel: "A" });
        const backend = createSharedFsMountBackend(A);
        try {
            const before = await A.writeFile("/r.txt", "S\n", {
                mtime: 1_000,
            });
            const redirect = await backend.open("/r.txt", {
                write: true,
                truncate: true,
            });
            await backend.flush(redirect);
            const reader = await backend.open("/r.txt", { read: true });
            expect(decode(await backend.read(reader, 8, 0))).toBe("");
            await backend.flush(reader);
            await backend.release(reader);
            expect(await A.versions("/r.txt")).toHaveLength(1);
            expect(await text(A, "/r.txt")).toBe("S\n");
            await backend.write(redirect, encode("S\n"), 0);
            await backend.flush(redirect);
            await backend.release(redirect);
            const saved = (await A.stat("/r.txt"))!;
            expect(await A.versions("/r.txt")).toHaveLength(2);
            expect(saved.versionId!.slice(0, 32)).toBe(before.id.slice(0, 32));
            expect(await depthOf(A, saved.versionId!)).toBe(
                await depthOf(A, before.id)
            );

            await A.writeFile("/held.txt", "E");
            const editor = await backend.open("/held.txt", {
                read: true,
                write: true,
            });
            const emptier = await backend.open("/held.txt", {
                write: true,
                truncate: true,
            });
            await backend.flush(emptier);
            expect(await text(A, "/held.txt")).toBe("E");
            await backend.release(emptier);
            expect(await text(A, "/held.txt")).toBe("");
            await backend.release(editor);

            for (const via of ["open", "handle"]) {
                const path = `/${via}.txt`;
                await A.writeFile(path, "base");
                const writer = await backend.open(path, {
                    read: true,
                    write: true,
                });
                await backend.write(writer, encode("hello"), 0);
                let flushed = writer;
                if (via === "open") {
                    flushed = await backend.open(path, {
                        write: true,
                        truncate: true,
                    });
                } else {
                    await backend.truncate(writer, 0);
                }
                await backend.flush(flushed);
                expect(await text(A, path)).toBe("");
                if (flushed !== writer) await backend.release(flushed);
                await backend.release(writer);
            }
        } finally {
            backend.dispose();
        }
    });

    it("records a mount save of own bytes as a copy when its last change is a write, or a utimens sets the mtime it shows", async () => {
        // A write or truncate after a utimens makes the mtime the write's
        // clock again, and a utimens that sets the pending mtime sets
        // nothing (WinFsp fills the mtime of an atime-only SetFileTime from
        // getattr). Either way a save of unchanged bytes this replica wrote
        // is a copy, not a touch one deeper that a concurrent edit ties with.
        const peer = await Peerbit.create();
        peers.push(peer);
        const A = await openSharedFs({ peerbit: peer, machineLabel: "A" });
        const backend = createSharedFsMountBackend(A);
        try {
            for (const last of ["write", "truncate", "same-mtime"]) {
                const path = `/${last}.txt`;
                const before = await A.writeFile(path, "S", { mtime: 1_000 });
                const handle = await backend.open(path, {
                    read: true,
                    write: true,
                });
                await backend.write(handle, encode("S"), 0);
                if (last === "same-mtime") {
                    await backend.setattr(path, {
                        mtimeMs: (await backend.getattr(path)).mtimeMs,
                    });
                } else {
                    await backend.setattr(path, { mtimeMs: 5_000 });
                    if (last === "write") {
                        await backend.write(handle, encode("S"), 0);
                    } else {
                        await backend.truncate(handle, 1);
                    }
                }
                await backend.release(handle);
                const saved = (await A.stat(path))!;
                expect(saved.versionId).not.toBe(before.id);
                expect(saved.versionId!.slice(0, 32)).toBe(
                    before.id.slice(0, 32)
                );
                expect(await depthOf(A, saved.versionId!)).toBe(
                    await depthOf(A, before.id)
                );
            }
        } finally {
            backend.dispose();
        }
    });

    it("merges a chmod and a touch made on top of a recorded copy", async () => {
        // A mount save records a copy c of x that carries a later mtime.
        // Then one replica chmods c and another touches it back to an
        // earlier time. The merge base is c, not x, which c also lists:
        // against x, c's later mtime would count as a change too and beat
        // the touch. c's id sorts after x's at their shared depth, so rank
        // order alone would pick x.
        const peer = await Peerbit.create();
        peers.push(peer);
        const A = await openSharedFs({ peerbit: peer, machineLabel: "A" });
        const path = "/base.sh";
        const written = await A.writeFile(path, "S", { mtime: 1_000 });
        const x = (await A.program.entries.index.get(written.id, {
            local: true,
            remote: false,
        })) as unknown as FileVersion;
        const randomTail = () =>
            Buffer.from(randomBytes(32)).toString("base64url").slice(24);
        let tail = randomTail();
        while (tail <= x.id.slice(32)) tail = randomTail();
        const row = (
            id: string,
            parents: string[],
            depth: bigint,
            mtime: bigint
        ) =>
            new FileVersion({
                id,
                nodeId: x.nodeId,
                parentVersionIds: parents,
                causalDepth: depth,
                contentHash: x.contentHash,
                size: x.size,
                mode: x.mode,
                mtime,
                chunkIds: x.chunkIds,
                createdAt: x.createdAt + 1n,
                authorKey: "another-writer",
                machineLabel: "M",
            });
        const c = row(x.id.slice(0, 32) + tail, [x.id], x.causalDepth, 6_000n);
        await A.program.entries.put(c, { unique: true });
        const chmod = await A.setMetadata(path, { mode: EXEC });
        expect(chmod.parentVersionIds).toEqual([c.id]);
        const touch = row(
            `version:${Buffer.from(randomBytes(32)).toString("base64url")}`,
            [c.id],
            c.causalDepth + 1n,
            3_000n
        );
        await A.program.entries.put(touch, { unique: true });
        const merged = (await A.stat(path))!;
        expect([...merged.headVersionIds!].sort()).toEqual(
            [chmod.id, touch.id].sort()
        );
        expect(merged.mode).toBe(EXEC);
        expect(merged.updatedAt).toBe(3_000n);
    });

    it("collapses a copy run to the copy an edit builds on, retiring parents first", async () => {
        // x, then three copies of it by another replica as mount saves
        // record them (each also references x), then an edit on the last.
        // x stays (a read pins it, as an open mount file does) while the
        // copies fall outside keepVersions. c3 is older than c2, so only
        // "the copy a survivor builds on", not age, keeps c3. c2 sorts
        // before c1 by id at their shared depth, so only parent-first order
        // deletes c1 before c2: a run stopped after its first delete must
        // not leave c1 a childless (head) copy.
        const peer = await Peerbit.create();
        peers.push(peer);
        const A = await openSharedFs({ peerbit: peer, machineLabel: "A" });
        const path = "/run.txt";
        const written = await A.writeFile(path, "S", { mtime: 1_000 });
        const x = (await A.program.entries.index.get(written.id, {
            local: true,
            remote: false,
        })) as unknown as FileVersion;
        const [t2, t1, t3] = Array.from({ length: 3 }, () =>
            Buffer.from(randomBytes(32)).toString("base64url").slice(24)
        ).sort();
        const copy = (tail: string, parents: string[], age: bigint) =>
            new FileVersion({
                id: x.id.slice(0, 32) + tail,
                nodeId: x.nodeId,
                parentVersionIds: parents,
                causalDepth: x.causalDepth,
                contentHash: x.contentHash,
                size: x.size,
                mode: x.mode,
                mtime: x.mtime + age,
                chunkIds: x.chunkIds,
                createdAt: x.createdAt + age,
                authorKey: "another-writer",
                machineLabel: "M",
            });
        const c1 = copy(t1, [x.id], 1n);
        const c2 = copy(t2, [c1.id, x.id], 3n);
        const c3 = copy(t3, [c2.id, x.id], 2n);
        for (const version of [c1, c2, c3]) {
            await A.program.entries.put(version, { unique: true });
        }
        expect((await A.stat(path))!.headVersionIds).toEqual([c3.id]);
        // The edit is the newest version, kept by keepVersions 1.
        await waitUntil(() =>
            expect(BigInt(Date.now())).toBeGreaterThan(c2.createdAt)
        );
        const edit = await A.writeFile(path, "S3");
        expect(edit.parentVersionIds).toEqual([c3.id]);
        expect(decode(await A.readVersion(path, x.id))).toBe("S");

        const gc = () =>
            A.collectGarbage({
                keepVersions: 1,
                retentionMs: 0,
                graceMs: 0,
                settleMs: 0,
                nowMs: Date.now() + 40 * 24 * 3_600_000,
            });
        const entries = A.program.entries;
        const del = entries.del;
        let deletes = 0;
        entries.del = function (this: unknown, id: unknown, ...rest: any[]) {
            if (id === c1.id || id === c2.id) {
                if (deletes++ === 1) throw new Error("stopped after one");
            }
            return (del as any).call(this, id, ...rest);
        } as typeof del;
        try {
            await expect(gc()).rejects.toThrow("stopped after one");
        } finally {
            entries.del = del;
        }
        expect(deletes).toBe(2);
        expect((await A.stat(path))!.headVersionIds).toEqual([edit.id]);
        expect(await A.conflicts()).toEqual([]);

        await gc();
        expect(
            (await A.versions(path)).map((version) => version.id).sort()
        ).toEqual([x.id, c3.id, edit.id].sort());
        expect(await text(A, path)).toBe("S3");
    });

    it("merges a chmod made on a copy that GC has since retired", async () => {
        // B chmods copy c1 of x while A, cut off, records copy c2 over c1
        // and touches it twice, so A's head ranks first. A's GC then keeps
        // the two touches (keepVersions 2), x (a read pins it, as an open
        // mount file does) and c2 (the copy the touches build on), and
        // retires c1, which no kept version needs. When B's chmod arrives,
        // x stands in for c1 as the merge base, since every copy carries
        // x's rank prefix: the chmod wins.
        const peer = await Peerbit.create();
        peers.push(peer);
        const A = await openSharedFs({ peerbit: peer, machineLabel: "A" });
        const path = "/gc.sh";
        const written = await A.writeFile(path, "S", { mtime: 1_000 });
        const x = (await A.program.entries.index.get(written.id, {
            local: true,
            remote: false,
        })) as unknown as FileVersion;
        const row = (
            id: string,
            parents: string[],
            depth: bigint,
            mode: number,
            mtime: bigint
        ) =>
            new FileVersion({
                id,
                nodeId: x.nodeId,
                parentVersionIds: parents,
                causalDepth: depth,
                contentHash: x.contentHash,
                size: x.size,
                mode,
                mtime,
                chunkIds: x.chunkIds,
                createdAt: x.createdAt + 1n,
                authorKey: "another-writer",
                machineLabel: "M",
            });
        const tail = () =>
            Buffer.from(randomBytes(32)).toString("base64url").slice(24);
        const c1 = row(
            x.id.slice(0, 32) + tail(),
            [x.id],
            x.causalDepth,
            x.mode,
            1_500n
        );
        const c2 = row(
            x.id.slice(0, 32) + tail(),
            [c1.id, x.id],
            x.causalDepth,
            x.mode,
            1_800n
        );
        for (const version of [c1, c2]) {
            await A.program.entries.put(version, { unique: true });
        }
        // The touches are the newest two versions.
        await waitUntil(() =>
            expect(BigInt(Date.now())).toBeGreaterThan(c2.createdAt)
        );
        await A.setMetadata(path, { mtime: 2_000 });
        await A.setMetadata(path, { mtime: 3_000 });
        expect(decode(await A.readVersion(path, x.id))).toBe("S");
        const report = await A.collectGarbage({
            keepVersions: 2,
            retentionMs: 0,
            graceMs: 0,
            settleMs: 0,
            nowMs: Date.now() + 40 * 24 * 3_600_000,
        });
        expect(report.retiredVersions).toBe(1);
        const ids = (await A.versions(path)).map((version) => version.id);
        expect(ids).not.toContain(c1.id);
        expect(ids).toContain(c2.id);

        const chmod = row(
            `version:${Buffer.from(randomBytes(32)).toString("base64url")}`,
            [c1.id],
            x.causalDepth + 1n,
            EXEC,
            c1.mtime
        );
        await A.program.entries.put(chmod, { unique: true });
        const merged = (await A.stat(path))!;
        expect(merged.headVersionIds).toHaveLength(2);
        expect(merged.headVersionIds).toContain(chmod.id);
        expect(merged.mode).toBe(EXEC);
        expect(merged.updatedAt).toBe(3_000n);
        expect(await A.conflicts()).toEqual([]);
    });

    it("merges a chmod made on a save of merged heads after GC", async () => {
        // A chmod c and a touch t of x race, and t ranks first. An unchanged
        // save over both (writeFile or writeBatch) shows c's mode, which t
        // lacks. Recorded as a copy of t, a later copy (which then also
        // lists t) would let GC retire it while t stays (a read pins t, as
        // an open mount file does), and t would then stand in for it as the
        // merge base: a chmod back made on the save would count as unchanged
        // and be dropped. So that save is an ordinary version, which GC keeps
        // as t's only child, and the chmod back wins.
        const peer = await Peerbit.create();
        peers.push(peer);
        let offsetMs = 0;
        const A = await openSharedFs({
            peerbit: peer,
            machineLabel: "A",
            clock: () => Date.now() + offsetMs,
        });
        // Canonical (padded) ids, so a save could record a copy of either.
        const canonicalId = () =>
            `version:${Buffer.from(randomBytes(32)).toString("base64url")}=`;
        const saves: {
            path: string;
            x: FileVersion;
            touchId: string;
            savedId: string;
            savedDepth: bigint;
            savedMtime: bigint;
        }[] = [];
        const row = (
            x: FileVersion,
            id: string,
            parents: string[],
            depth: bigint,
            mode: number,
            mtime: bigint
        ) =>
            new FileVersion({
                id,
                nodeId: x.nodeId,
                parentVersionIds: parents,
                causalDepth: depth,
                contentHash: x.contentHash,
                size: x.size,
                mode,
                mtime,
                chunkIds: x.chunkIds,
                createdAt: x.createdAt + 1n,
                authorKey: "another-writer",
                machineLabel: "M",
            });
        const backend = createSharedFsMountBackend(A);
        try {
            for (const via of ["writeFile", "writeBatch"]) {
                const path = `/${via}.sh`;
                const written = await A.writeFile(path, "S", { mtime: 1_000 });
                const x = (await A.program.entries.index.get(written.id, {
                    local: true,
                    remote: false,
                })) as unknown as FileVersion;
                const [touchId, chmodId] = [
                    canonicalId(),
                    canonicalId(),
                ].sort();
                for (const version of [
                    row(x, touchId, [x.id], x.causalDepth + 1n, FILE, 2_000n),
                    row(x, chmodId, [x.id], x.causalDepth + 1n, EXEC, 1_000n),
                ]) {
                    await A.program.entries.put(version, { unique: true });
                }
                expect(await A.stat(path)).toMatchObject({
                    mode: EXEC,
                    updatedAt: 2_000n,
                });
                // keepVersions 1 keeps the mount save, the newest version.
                const later = async (than: bigint) =>
                    waitUntil(() =>
                        expect(BigInt(Date.now())).toBeGreaterThan(than)
                    );
                await later(x.createdAt + 1n);
                const saved =
                    via === "writeFile"
                        ? await A.writeFile(path, "S")
                        : (await A.writeBatch([{ path, content: "S" }]))
                              .results[0]!;
                expect(saved.mode).toBe(EXEC);
                saves.push({
                    path,
                    x,
                    touchId,
                    savedId: saved.id,
                    savedDepth: await depthOf(A, saved.id),
                    savedMtime: BigInt(saved.mtime),
                });
                await later(BigInt(saved.createdAt));
                const handle = await backend.open(path, {
                    read: true,
                    write: true,
                });
                await backend.write(handle, encode("S"), 0);
                await backend.release(handle);
                // The mount save is a copy of the first save.
                expect((await A.stat(path))!.versionId!.slice(0, 32)).toBe(
                    saved.id.slice(0, 32)
                );
            }
        } finally {
            backend.dispose();
        }
        // Earlier reads pinned the heads they saw; only each t stays pinned.
        offsetMs = 120_000;
        for (const { path, touchId } of saves) {
            expect(decode(await A.readVersion(path, touchId))).toBe("S");
        }
        await A.collectGarbage({
            keepVersions: 1,
            retentionMs: 0,
            graceMs: 0,
            settleMs: 0,
            nowMs: Date.now() + 40 * 24 * 3_600_000,
        });
        for (const { path, x, savedId, savedDepth, savedMtime } of saves) {
            const chmodBack = row(
                x,
                canonicalId(),
                [savedId],
                savedDepth + 1n,
                FILE,
                savedMtime
            );
            await A.program.entries.put(chmodBack, { unique: true });
            const merged = (await A.stat(path))!;
            expect(merged.headVersionIds).toContain(chmodBack.id);
            expect(merged.mode).toBe(FILE);
        }
        expect(await A.conflicts()).toEqual([]);
    });

    it("keeps the parents of a copy few while an open file is saved between touches", async () => {
        // A save through a descriptor held open builds on the open file's
        // previous save and takes in the change made since. With two or
        // more changes between saves (two touches, a chmod and a touch, or
        // another descriptor's save and a touch), listing every version
        // the copy run took in would add one parent per save, until a copy
        // no longer fits the index and every save of the file fails. A
        // copy lists the save's parents and the version it repeats.
        const peer = await Peerbit.create();
        peers.push(peer);
        const A = await openSharedFs({ peerbit: peer, machineLabel: "A" });
        const backend = createSharedFsMountBackend(A);
        const other = createSharedFsMountBackend(A);
        const parents = new Map<string, number[]>();
        try {
            for (const between of ["touch", "touch2", "chmod", "save"]) {
                const path = `/hot-${between}.txt`;
                await A.writeFile(path, "S", { mtime: 1_000 });
                const handle = await backend.open(path, {
                    read: true,
                    write: true,
                });
                const counts: number[] = [];
                for (let i = 0; i < 6; i++) {
                    await backend.write(handle, encode("S"), 0);
                    await backend.flush(handle);
                    const head = (await A.program.entries.index.get(
                        (await A.stat(path))!.versionId!,
                        { local: true, remote: false }
                    )) as unknown as FileVersion;
                    counts.push(head.parentVersionIds.length);
                    if (between === "touch2") {
                        await A.setMetadata(path, { mtime: 20_000 + i });
                    } else if (between === "chmod") {
                        await A.setMetadata(path, {
                            mode: i % 2 === 0 ? EXEC : FILE,
                        });
                    } else if (between === "save") {
                        const saver = await other.open(path, {
                            read: true,
                            write: true,
                        });
                        await other.write(saver, encode("S"), 0);
                        await other.release(saver);
                    }
                    await A.setMetadata(path, { mtime: 10_000 + i });
                }
                await backend.release(handle);
                parents.set(between, counts);
                expect(await text(A, path)).toBe("S");
            }
        } finally {
            backend.dispose();
            other.dispose();
        }
        for (const counts of parents.values()) {
            expect(counts).toEqual([1, 2, 2, 2, 2, 2]);
        }
    });

    it("reads a bounded number of version rows for a save at the end of a long run of copies", async () => {
        // Every mount save of unchanged bytes is a copy of the previous
        // one. Building a copy's parents and checking who wrote the bytes
        // read the head copy's parents only (the version the run repeats
        // is one of them), not the whole run, so a save does not slow down
        // as the run grows. touch: a touch between saves makes the opened
        // copy and the touch the save's parents; the touch descends from
        // the copy, so their merged metadata is the touch's, found without
        // walking the file's history.
        const peer = await Peerbit.create();
        peers.push(peer);
        const A = await openSharedFs({ peerbit: peer, machineLabel: "A" });
        // Count every version row the saves look up, whether through the
        // row cache or a full read of the node's rows.
        const program = A.program as any;
        let lookups = 0;
        const rowLookup = program.versionRowLookup;
        program.versionRowLookup = async function (...args: unknown[]) {
            const rowOf = await rowLookup.apply(this, args);
            return (id: string) => {
                lookups++;
                return rowOf(id);
            };
        };
        const rowsFor = program.versionRowsFor;
        program.versionRowsFor = async function (...args: unknown[]) {
            const rows: Map<string, unknown> = await rowsFor.apply(this, args);
            const get = rows.get.bind(rows);
            rows.get = (id: string) => {
                lookups++;
                return get(id);
            };
            return rows;
        };
        const backend = createSharedFsMountBackend(A);
        const counts = new Map<string, number[]>();
        try {
            for (const between of ["none", "touch"]) {
                const path = `/run-${between}.txt`;
                await A.writeFile(path, "S", { mtime: 1_000 });
                const handle = await backend.open(path, {
                    read: true,
                    write: true,
                });
                const saves: number[] = [];
                for (let i = 0; i < 12; i++) {
                    // A write in the ms of the last commit would show its
                    // mtime: that save is a no-op.
                    const last = Date.now();
                    await waitUntil(() =>
                        expect(Date.now()).toBeGreaterThan(last)
                    );
                    lookups = 0;
                    await backend.write(handle, encode("S"), 0);
                    await backend.flush(handle);
                    saves.push(lookups);
                    if (between === "touch") {
                        await A.setMetadata(path, { mtime: 10_000 + i });
                    }
                }
                await backend.release(handle);
                // An unchanged save over this replica's own head is free.
                lookups = 0;
                const head = (await A.stat(path))!.versionId;
                expect((await A.writeFile(path, "S")).id).toBe(head);
                saves.push(lookups);
                counts.set(between, saves);
                expect(await A.versions(path)).toHaveLength(
                    between === "touch" ? 25 : 13
                );
            }
        } finally {
            backend.dispose();
        }
        for (const saves of counts.values()) {
            expect(saves.filter((count) => count > 3)).toEqual([]);
        }
    });

    it("counts recorded copies toward keepVersions, so GC keeps the copy an open file is based on", async () => {
        // held: a descriptor holds the file open on c1, a mount save of
        // unchanged bytes, while another save of those bytes records c2.
        // c1 is among the newest keepVersions versions, so GC keeps it as
        // it keeps any version there, and the next write through the open
        // file can build on it. repeat: the same with unchanged writeFile
        // saves made elsewhere (copies with the copied version's mtime),
        // which are not counted but stay too. build: a rebuild that
        // rewrites identical output three times per change keeps no more
        // distinct contents than keepVersions allows.
        const peer = await Peerbit.create();
        peers.push(peer);
        let offsetMs = 0;
        const A = await openSharedFs({
            peerbit: peer,
            machineLabel: "A",
            clock: () => Date.now() + offsetMs,
        });
        const saver = createSharedFsMountBackend(A);
        const holder = createSharedFsMountBackend(A);
        // keepVersions orders by creation time: no two saves share a ms.
        const save = async (path: string, bytes: string) => {
            const handle = await saver.open(path, {
                read: true,
                write: true,
                truncate: true,
            });
            await saver.write(handle, encode(bytes), 0);
            await saver.release(handle);
            const saved = Date.now();
            await waitUntil(() => expect(Date.now()).toBeGreaterThan(saved));
            return (await A.stat(path))!.versionId!;
        };
        try {
            const x = (await A.writeFile("/held.txt", "S")).id;
            await A.writeFile("/build.txt", "a");
            const c1 = await save("/held.txt", "S");
            const held = await holder.open("/held.txt", {
                read: true,
                write: true,
            });
            const c2 = await save("/held.txt", "S");
            for (const id of [c1, c2]) {
                expect(id.slice(0, 32)).toBe(x.slice(0, 32));
            }
            const x2 = (await A.program.entries.index.get(
                (await A.writeFile("/repeat.txt", "R", { mtime: 1_000 })).id,
                { local: true, remote: false }
            )) as unknown as FileVersion;
            const repeat = (parents: string[], age: bigint) =>
                new FileVersion({
                    id:
                        x2.id.slice(0, 32) +
                        Buffer.from(randomBytes(32))
                            .toString("base64url")
                            .slice(24),
                    nodeId: x2.nodeId,
                    parentVersionIds: parents,
                    causalDepth: x2.causalDepth,
                    contentHash: x2.contentHash,
                    size: x2.size,
                    mode: x2.mode,
                    mtime: x2.mtime,
                    chunkIds: x2.chunkIds,
                    createdAt: x2.createdAt + age,
                    authorKey: "another-writer",
                    machineLabel: "B",
                });
            const r1 = repeat([x2.id], 1n);
            await A.program.entries.put(r1, { unique: true });
            const repeatHeld = await holder.open("/repeat.txt", {
                read: true,
                write: true,
            });
            const r2 = repeat([r1.id, x2.id], 2n);
            await A.program.entries.put(r2, { unique: true });
            const build: string[] = [];
            for (const bytes of ["a", "a", "a", "b", "b", "b", "b"]) {
                build.push(await save("/build.txt", bytes));
            }
            for (let i = 0; i < 4; i++) {
                build.push(await save("/build.txt", "c"));
            }
            // Earlier reads pinned the heads they saw.
            offsetMs = 120_000;
            await A.collectGarbage({
                keepVersions: 4,
                retentionMs: 0,
                graceMs: 0,
                settleMs: 0,
                nowMs: Date.now() + 40 * 24 * 3_600_000,
            });
            expect(
                (await A.versions("/held.txt")).map((v) => v.id).sort()
            ).toEqual([x, c1, c2].sort());
            expect(
                (await A.versions("/repeat.txt")).map((v) => v.id).sort()
            ).toEqual([x2.id, r1.id, r2.id].sort());
            const kept = await A.versions("/build.txt");
            expect(kept.map((v) => v.id).sort()).toEqual(
                build.slice(-4).sort()
            );
            expect(new Set(kept.map((v) => v.contentHash)).size).toBe(1);

            for (const handle of [held, repeatHeld]) {
                await holder.write(handle, encode("edited"), 0);
                await holder.release(handle);
            }
        } finally {
            saver.dispose();
            holder.dispose();
        }
        for (const path of ["/held.txt", "/repeat.txt"]) {
            expect(await text(A, path)).toBe("edited");
            expect((await A.stat(path))!.headVersionIds).toHaveLength(1);
        }
    });

    it("does not merge the version an open file showed as a head of its save", async () => {
        // A descriptor opens a script while it shows a chmod +x (m1). Then
        // a chmod -x (m2, made on m1) and another replica's concurrent
        // touch t of the original x arrive. A save through the open file
        // builds on m1 and takes in m2 and t. m1 is an ancestor of m2, so
        // it holds no change m2 lacks: merged as a head, its +x would bring
        // back the mode m2 reverted. A save of the same bytes (a copy) and
        // an edit both keep m2's mode.
        const peer = await Peerbit.create();
        peers.push(peer);
        const A = await openSharedFs({ peerbit: peer, machineLabel: "A" });
        const backend = createSharedFsMountBackend(A);
        try {
            for (const save of ["same", "edit"]) {
                const path = `/${save}.sh`;
                const written = await A.writeFile(path, "data\n", {
                    mtime: 1_000,
                });
                const x = (await A.program.entries.index.get(written.id, {
                    local: true,
                    remote: false,
                })) as unknown as FileVersion;
                await A.setMetadata(path, { mode: EXEC });
                const handle = await backend.open(path, {
                    read: true,
                    write: true,
                });
                const data = await backend.read(handle, 64, 0);
                await A.setMetadata(path, { mode: FILE });
                await A.program.entries.put(
                    new FileVersion({
                        id: `version:${Buffer.from(randomBytes(32)).toString("base64url")}=`,
                        nodeId: x.nodeId,
                        parentVersionIds: [x.id],
                        causalDepth: x.causalDepth + 1n,
                        contentHash: x.contentHash,
                        size: x.size,
                        mode: FILE,
                        mtime: 4_000n,
                        chunkIds: x.chunkIds,
                        createdAt: x.createdAt + 1n,
                        authorKey: "another-writer",
                        machineLabel: "B",
                    }),
                    { unique: true }
                );
                expect(await A.stat(path)).toMatchObject({
                    mode: FILE,
                    updatedAt: 4_000n,
                });
                await backend.write(
                    handle,
                    save === "same" ? data : encode("edited\n"),
                    0
                );
                await backend.flush(handle);
                await backend.release(handle);
                const saved = (await A.stat(path))!;
                expect(saved.headVersionIds).toHaveLength(1);
                expect(saved.mode).toBe(FILE);
                expect(await text(A, path)).toBe(
                    save === "same" ? "data\n" : "edited\n"
                );
            }
        } finally {
            backend.dispose();
        }
    });

    it("keeps the newest copy of a run when no kept version builds on one", async () => {
        // x stays (a read pins it, as an open mount file does). Its copies
        // c1 and the newer c2 retire, and so would an edit on c2: only the
        // head stays in keepVersions. GC keeps one copy so x keeps a child,
        // the newest, then the edit so that copy keeps one. Run once with
        // the newer copy's id sorting first and once last, so neither id
        // order alone picks it.
        const peer = await Peerbit.create();
        peers.push(peer);
        let offsetMs = 0;
        const A = await openSharedFs({
            peerbit: peer,
            machineLabel: "A",
            clock: () => Date.now() + offsetMs,
        });
        const runs: {
            path: string;
            x: FileVersion;
            c2: FileVersion;
            edit: { id: string };
            head: { id: string };
        }[] = [];
        for (const newerSortsFirst of [true, false]) {
            const path = `/run-${newerSortsFirst ? "first" : "last"}.txt`;
            const written = await A.writeFile(path, "S", { mtime: 1_000 });
            const x = (await A.program.entries.index.get(written.id, {
                local: true,
                remote: false,
            })) as unknown as FileVersion;
            const tails = Array.from({ length: 2 }, () =>
                Buffer.from(randomBytes(32)).toString("base64url").slice(24)
            ).sort();
            const [newerTail, olderTail] = newerSortsFirst
                ? tails
                : tails.reverse();
            const copy = (tail: string, parents: string[], age: bigint) =>
                new FileVersion({
                    id: x.id.slice(0, 32) + tail,
                    nodeId: x.nodeId,
                    parentVersionIds: parents,
                    causalDepth: x.causalDepth,
                    contentHash: x.contentHash,
                    size: x.size,
                    mode: x.mode,
                    mtime: x.mtime + age,
                    chunkIds: x.chunkIds,
                    createdAt: x.createdAt + age,
                    authorKey: "another-writer",
                    machineLabel: "M",
                });
            const c1 = copy(olderTail, [x.id], 1n);
            const c2 = copy(newerTail, [c1.id, x.id], 2n);
            for (const version of [c1, c2]) {
                await A.program.entries.put(version, { unique: true });
            }
            // The edit and the head are newer than the copies.
            await waitUntil(() =>
                expect(BigInt(Date.now())).toBeGreaterThan(c2.createdAt)
            );
            const edit = await A.writeFile(path, "S2");
            expect(edit.parentVersionIds).toEqual([c2.id]);
            const head = await A.writeFile(path, "S3");
            runs.push({ path, x, c2, edit, head });
        }
        // Earlier reads pinned the heads they saw; only each x stays pinned.
        offsetMs = 120_000;
        for (const { path, x } of runs) {
            expect(decode(await A.readVersion(path, x.id))).toBe("S");
        }
        await A.collectGarbage({
            keepVersions: 1,
            retentionMs: 0,
            graceMs: 0,
            settleMs: 0,
            nowMs: Date.now() + 40 * 24 * 3_600_000,
        });
        for (const { path, x, c2, edit, head } of runs) {
            expect(
                (await A.versions(path)).map((version) => version.id).sort()
            ).toEqual([x.id, c2.id, edit.id, head.id].sort());
            expect(await text(A, path)).toBe("S3");
        }
    });
});
