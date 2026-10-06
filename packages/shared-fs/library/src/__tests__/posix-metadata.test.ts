import { Peerbit } from "peerbit";
import { concat } from "uint8arrays";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    FileChunk,
    FileVersion,
    SHARED_FS_MODE,
    openSharedFs,
    type SharedFsFileMode,
    type SharedFsHandle,
} from "../index.js";

const { file: FILE, executable: EXEC, symlink: LINK } = SHARED_FS_MODE;

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const waitUntil = async (assertion: () => Promise<void> | void) => {
    const deadline = Date.now() + (process.env.CI ? 90_000 : 30_000);
    for (;;) {
        try {
            return await assertion();
        } catch (error) {
            if (Date.now() > deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
};

const borshString = (value: string) => {
    const text = new TextEncoder().encode(value);
    const out = new Uint8Array(4 + text.byteLength);
    new DataView(out.buffer).setUint32(0, text.byteLength, true);
    out.set(text, 4);
    return out;
};

const versionDoc = async (fs: SharedFsHandle, id: string) =>
    (await fs.program.entries.index.get(id, {
        local: true,
        remote: false,
    })) as unknown as FileVersion;

describe("shared fs posix metadata", () => {
    const peers: Peerbit[] = [];
    afterEach(async () => {
        await Promise.allSettled(peers.splice(0).map((peer) => peer.stop()));
    });

    const open = async (options: { ignore?: { patterns: string[] } } = {}) => {
        const peer = await Peerbit.create();
        peers.push(peer);
        return openSharedFs({
            peerbit: peer,
            machineLabel: "posix",
            ...options,
        });
    };

    it("stores mode and mtime on versions, rows and entries", async () => {
        const fs = await open();
        const script = await fs.writeFile("/a.sh", "echo", {
            mode: EXEC,
            mtime: 1234,
        });
        expect(script).toMatchObject({ mode: EXEC, mtime: 1234n });
        const [row] = await fs.program.entries.index
            .iterate(
                { query: { id: script.id } },
                { local: true, remote: false, resolve: false }
            )
            .all();
        expect(row).toMatchObject({ mode: EXEC, mtime: 1234n });
        expect(await fs.stat("/a.sh")).toMatchObject({
            kind: "file",
            mode: EXEC,
            updatedAt: 1234n,
        });
        const plain = await fs.writeFile("/b.txt", "b");
        expect(plain).toMatchObject({ mode: FILE, mtime: plain.createdAt });
        for (const options of [
            { mode: 0o100600 as typeof FILE },
            { mtime: -1 },
            { mtime: 2 ** 53 },
        ]) {
            await expect(
                fs.writeFile("/c.txt", "c", options)
            ).rejects.toMatchObject({ code: "EINVAL" });
        }
    });

    it("rejects invalid metadata at ingest and the pre-v9.2 program", async () => {
        const fs = await open();
        const base = await versionDoc(fs, (await fs.writeFile("/x", "x")).id);
        const forged = (
            name: string,
            patch: { mode?: number; size?: bigint; mtime?: bigint }
        ) =>
            new FileVersion({
                id: `version:forged-${name}`,
                nodeId: base.nodeId,
                parentVersionIds: [base.id],
                causalDepth: 2,
                contentHash: base.contentHash,
                size: patch.size ?? base.size,
                mode: patch.mode ?? FILE,
                mtime: patch.mtime ?? 0n,
                chunkIds: base.chunkIds,
                createdAt: 1,
                authorKey: "x",
                machineLabel: "x",
            });
        for (const version of [
            forged("mode", { mode: 0o100600 }),
            forged("empty-link", { mode: LINK, size: 0n }),
            forged("long-link", { mode: LINK, size: 1024n }),
            forged("mtime", { mtime: 2n ** 53n }),
        ]) {
            await expect(
                fs.program.entries.put(version).then(() => version.id)
            ).rejects.toThrow();
        }
        // The variant is the format break: the v9.2 program loads, the
        // previous variant no longer does.
        const blocks = peers[0].services.blocks;
        const bytes = (await blocks.get(fs.address!))!;
        const variant = borshString("peerbit_shared_fs_v9_2");
        const at = Buffer.from(bytes).indexOf(variant);
        expect(at).toBeGreaterThanOrEqual(0);
        const legacy = await blocks.put(
            concat([
                bytes.subarray(0, at),
                borshString("peerbit_shared_fs_v9_1"),
                bytes.subarray(at + variant.byteLength),
            ])
        );
        await expect(
            openSharedFs({
                peerbit: peers[0],
                address: legacy,
                machineLabel: "old",
            })
        ).rejects.toThrow(/no variant matches/);
    });

    it("inherits mode through edits, batches, resolveConflict and restore", async () => {
        const fs = await open();
        await fs.writeFile("/t.sh", "one", { mode: EXEC });
        expect((await fs.writeFile("/t.sh", "two")).mode).toBe(EXEC);
        await fs.writeBatch([{ path: "/t.sh", content: "three" }]);
        // Selecting the hidden bytes modifies the file at resolution time;
        // selecting the visible ones keeps their mtime.
        for (const pick of [1, 0]) {
            const base = (await fs.stat("/t.sh"))!.versionId!;
            for (const [content, mtime] of [
                ["left", 1],
                ["right", 2],
            ] as const) {
                await fs.writeFile("/t.sh", `${content}${pick}`, {
                    baseVersionIds: [base],
                    mtime,
                });
            }
            const [conflict] = await fs.conflicts("/t.sh");
            expect(conflict.versions.map((version) => version.mode)).toEqual([
                EXEC,
                EXEC,
            ]);
            const selected = conflict.versions[pick];
            const resolution = await fs.resolveConflict("/t.sh", selected.id);
            expect(resolution).toMatchObject({
                mode: EXEC,
                mtime: pick ? resolution.createdAt : selected.mtime,
            });
        }

        const entry = (await fs.stat("/t.sh"))!;
        const visible = await versionDoc(fs, entry.versionId!);
        await fs.rm("/t.sh");
        await fs.program.entries.put(
            new FileVersion({
                ...visible,
                id: "version:posix-delete-vs-edit",
                parentVersionIds: [visible.id],
                causalDepth: visible.causalDepth + 1n,
                chunkIds: visible.chunkIds,
            }),
            { unique: true }
        );
        const expectedConflicts = (await fs.namingConflicts()).filter(
            (candidate) => candidate.nodeId === entry.nodeId
        );
        expect(expectedConflicts.map((c) => c.type)).toEqual([
            "delete-vs-edit",
        ]);
        await fs.resolveNamingConflict(
            entry.nodeId,
            { type: "restore" },
            { expectedConflicts }
        );
        expect((await fs.stat("/t.sh"))!.mode).toBe(EXEC);
    });

    it("keeps same-bytes mtime, advances it on edits and compares it in no-ops", async () => {
        const fs = await open();
        const first = await fs.writeFile("/m.txt", "same", { mtime: 1000 });
        expect((await fs.writeFile("/m.txt", "same")).id).toBe(first.id);
        expect(
            (await fs.writeFile("/m.txt", "same", { mode: FILE, mtime: 1000 }))
                .id
        ).toBe(first.id);
        const touched = await fs.writeFile("/m.txt", "same", { mtime: 2000 });
        expect(touched).toMatchObject({
            mtime: 2000n,
            parentVersionIds: [first.id],
        });
        const rebased = await fs.writeFile("/m.txt", "same", {
            baseVersionIds: [touched.id],
        });
        expect(rebased).toMatchObject({ mtime: 2000n, mode: FILE });
        const edited = await fs.writeFile("/m.txt", "changed");
        expect(edited.mtime).toBe(edited.createdAt);

        const exact = {
            expectedNodeId: edited.nodeId,
            baseVersionIds: [edited.id],
            noOpIfHeadVersionIds: [edited.id],
        };
        expect(
            (await fs.writeFile("/m.txt", "changed", exact)).mountWriteOutcome
        ).toBe("unchanged");
        expect(
            await fs.writeFile("/m.txt", "changed", { ...exact, mode: EXEC })
        ).toMatchObject({ mountWriteOutcome: "created", mode: EXEC });
    });

    it("absorbs same-bytes heads into an explicit-base write", async () => {
        const fs = await open();
        const opened = await fs.writeFile("/a.sh", "one");
        // A chmod that landed while a writer still held `opened`.
        const chmod = await fs.setMetadata("/a.sh", { mode: EXEC });
        const baseVersionIds = [opened.id];
        const edit = await fs.writeFile("/a.sh", "two", { baseVersionIds });
        expect(baseVersionIds).toEqual([opened.id]);
        expect(edit).toMatchObject({
            parentVersionIds: [opened.id, chmod.id],
            mode: EXEC,
        });
        expect((await fs.stat("/a.sh"))!.headVersionIds).toEqual([edit.id]);
    });

    it("reuses chunks for same-bytes writes and setMetadata with no chunk IO", async () => {
        const fs = await open();
        const program = fs.program as any;
        const source = await fs.writeFile("/r.bin", "payload");
        const put = vi.spyOn(fs.program.entries, "put");
        const touch = vi.spyOn(program, "touchChunks");
        const read = vi.spyOn(program, "readFileVersion");
        const chunkPuts = () =>
            put.mock.calls.filter(([doc]) => doc instanceof FileChunk).length;

        const exec = await fs.writeFile("/r.bin", "payload", { mode: EXEC });
        const touched = await fs.setMetadata("/r.bin", { mtime: 42 });
        expect(touched).toMatchObject({ mode: EXEC, mtime: 42n });
        expect(chunkPuts()).toBe(0);
        expect(touch).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        const chunkIds = (await versionDoc(fs, source.id)).chunkIds;
        for (const id of [exec.id, touched.id]) {
            expect((await versionDoc(fs, id)).chunkIds).toEqual(chunkIds);
        }

        await fs.writeFile("/r.bin", "payload", { mode: FILE, dedup: "off" });
        expect(chunkPuts()).toBe(1);
        await fs.writeFile("/r.bin", "payload", { mode: EXEC, chunkSize: 4 });
        expect(touch).toHaveBeenCalledTimes(2);
        expect(decode(await fs.readFile("/r.bin"))).toBe("payload");
    });

    it("reuses chunks only from a current head whose chunks are all local", async () => {
        const fs = await open();
        const program = fs.program as any;
        const touch = vi.spyOn(program, "touchChunks");
        // A superseded base can be retired under the write: full path.
        const old = await fs.writeFile("/f.txt", "old");
        await fs.writeFile("/f.txt", "new");
        await fs.writeFile("/f.txt", "old", { baseVersionIds: [old.id] });
        expect(touch).toHaveBeenCalledTimes(3);
        // A head whose chunk is not local (still replicating in, say): the
        // full path re-puts it from the caller's bytes.
        const head = await fs.writeFile("/g.sh", "gone");
        const [gone] = (await versionDoc(fs, head.id)).chunkIds;
        program.gcSuppressed.add(gone);
        try {
            await program.entries.del(gone);
            expect(await program.hasDocument(gone)).toBe(false);
            await fs.writeFile("/g.sh", "gone", { mode: EXEC });
        } finally {
            program.gcSuppressed.delete(gone);
        }
        expect(touch).toHaveBeenCalledTimes(5);
        expect(await program.hasDocument(gone)).toBe(true);
    });

    it("guards setMetadata and keeps the other head of a content conflict", async () => {
        const fs = await open({ ignore: { patterns: ["dist/"] } });
        const file = await fs.writeFile("/s.txt", "s");
        expect(
            await fs.setMetadata("/s.txt", {
                mode: FILE,
                mtime: Number(file.mtime),
            })
        ).toMatchObject({ id: file.id });
        await expect(
            fs.setMetadata(
                "/s.txt",
                { mode: EXEC },
                { expectedNodeId: "file:other" }
            )
        ).rejects.toMatchObject({ code: "EAGAIN", checkpoint: "initial" });
        // A local replacement while the source loads is caught before the put.
        const replaced = await fs.writeFile("/r.txt", "r");
        const program = fs.program as any;
        const getDocument = program.getDocument.bind(program);
        vi.spyOn(program, "getDocument").mockImplementationOnce(
            async (...args: unknown[]) => {
                await fs.rm("/r.txt");
                await fs.writeFile("/r.txt", "r");
                return getDocument(...args);
            }
        );
        await expect(
            fs.setMetadata(
                "/r.txt",
                { mode: EXEC },
                { expectedNodeId: replaced.nodeId }
            )
        ).rejects.toMatchObject({
            code: "EAGAIN",
            checkpoint: "before-version",
        });
        await fs.mkdir("/d");
        await fs.writeFile("/l", "s.txt", { mode: LINK });
        for (const [path, code] of [
            ["/d", "EISDIR"],
            ["/missing", "ENOENT"],
            ["/l", "EINVAL"],
            ["/dist/x.js", "EIGNORED"],
        ]) {
            await expect(
                fs.setMetadata(path, { mode: EXEC })
            ).rejects.toMatchObject({ code });
        }
        await expect(
            fs.setMetadata("/s.txt", { mode: LINK as typeof FILE })
        ).rejects.toMatchObject({ code: "EINVAL" });

        // Three heads holding two contents: one conflict entry per content.
        for (const [content, mtime] of [
            ["left", undefined],
            ["right", undefined],
            ["left", 7],
        ] as const) {
            await fs.writeFile("/s.txt", content, {
                baseVersionIds: [file.id],
                mtime,
            });
        }
        const before = (await fs.stat("/s.txt"))!;
        expect(before).toMatchObject({ conflict: true });
        expect(before.headVersionIds).toHaveLength(3);
        expect((await fs.conflicts("/s.txt"))[0].versions).toHaveLength(2);
        expect(
            (await fs.conflicts()).map((c) => [c.path, c.versions.length])
        ).toEqual([["/s.txt", 2]]);
        const heads = (await fs.versions("/s.txt")).filter((v) => v.head);
        const ids = (same: boolean) =>
            heads
                .filter((v) => (v.contentHash === before.contentHash) === same)
                .map((v) => v.id);
        // setMetadata merges only the heads holding the visible bytes.
        const updated = await fs.setMetadata("/s.txt", { mode: EXEC });
        expect(updated.parentVersionIds.sort()).toEqual(ids(true).sort());
        expect((await fs.stat("/s.txt"))!.headVersionIds!.sort()).toEqual(
            [updated.id, ...ids(false)].sort()
        );
        const [conflict] = await fs.conflicts("/s.txt");
        expect(conflict.versions).toHaveLength(2);
        expect(conflict.versions[0].id).toBe(updated.id);
    });

    it("stores symlinks as fixed-type file nodes with validated targets", async () => {
        const fs = await open();
        await fs.writeFile("/link", "../target", { mode: LINK });
        expect(await fs.stat("/link")).toMatchObject({
            kind: "file",
            mode: LINK,
            size: 9n,
        });
        expect(decode(await fs.readFile("/link"))).toBe("../target");
        await fs.writeFile("/link", "/dangling/abs", { mode: LINK });
        await fs.writeFile("/file", "x");
        const invalid: [string, Uint8Array | string, SharedFsFileMode?][] = [
            ["/link", "bytes", undefined],
            ["/link", "bytes", EXEC],
            ["/file", "target", LINK],
            ["/new", "", LINK],
            ["/new", "a".repeat(1024), LINK],
            ["/new", "a\0b", LINK],
            ["/new", new Uint8Array([0xff]), LINK],
        ];
        for (const [path, content, mode] of invalid) {
            await expect(
                fs.writeFile(path, content, { mode })
            ).rejects.toMatchObject({ code: "EINVAL" });
        }
        // A base of the other type (say from a replaced node) fails too.
        const linkId = (await fs.stat("/link"))!.versionId!;
        const fileId = (await fs.stat("/file"))!.versionId!;
        for (const [path, baseId, mode] of [
            ["/file", linkId, undefined],
            ["/new", linkId, undefined],
            ["/new", fileId, LINK],
        ] as const) {
            await expect(
                fs.writeFile(path, "t", { baseVersionIds: [baseId], mode })
            ).rejects.toMatchObject({ code: "EINVAL" });
        }
        expect((await fs.stat("/file"))!.mode).toBe(FILE);
        await expect(
            fs.writeBatch([{ path: "/link", content: "x" }])
        ).rejects.toMatchObject({ code: "EINVAL" });
        await fs.writeFile("/long", "a".repeat(1023), { mode: LINK });
        await fs.rename("/link", "/moved");
        expect(decode(await fs.readFile("/moved"))).toBe("/dangling/abs");
        await fs.rm("/moved");
        expect(await fs.stat("/moved")).toBeUndefined();
    });

    it("replicates metadata and settles concurrent metadata changes across peers", async () => {
        let partitioned = false;
        const deny = () => partitioned;
        const create = async () => {
            const peer = await Peerbit.create({
                libp2p: {
                    connectionGater: {
                        denyDialPeer: deny,
                        denyDialMultiaddr: deny,
                        denyInboundConnection: deny,
                        denyOutboundConnection: deny,
                        denyInboundEncryptedConnection: deny,
                        denyOutboundEncryptedConnection: deny,
                        denyInboundUpgradedConnection: deny,
                        denyOutboundUpgradedConnection: deny,
                    },
                },
            });
            peers.push(peer);
            return peer;
        };
        const [a, b] = [await create(), await create()];
        await a.dial(b);
        const fsA = await openSharedFs({ peerbit: a, machineLabel: "a" });
        await fsA.writeFile("/x.sh", "x", { mode: EXEC, mtime: 1000 });
        await fsA.writeFile("/link", "x.sh", { mode: LINK });
        const paths = ["/chmod", "/touch", "/edit"];
        for (const path of paths) await fsA.writeFile(path, path);
        const fsB = await openSharedFs({
            peerbit: b,
            address: fsA.address,
            machineLabel: "b",
            allowPartialWrites: true,
        });
        await waitUntil(async () => {
            expect(await fsB.stat("/x.sh")).toMatchObject({
                mode: EXEC,
                updatedAt: 1000n,
            });
            expect((await fsB.stat("/link"))?.mode).toBe(LINK);
            expect(decode(await fsB.readFile("/link"))).toBe("x.sh");
            for (const path of paths)
                expect(await fsB.stat(path)).toBeDefined();
        });

        partitioned = true;
        await a.hangUp(b.identity.publicKey);
        await waitUntil(() => {
            expect(a.libp2p.getConnections()).toHaveLength(0);
            expect(b.libp2p.getConnections()).toHaveLength(0);
        });
        await fsA.setMetadata("/chmod", { mode: EXEC });
        await fsB.setMetadata("/chmod", { mode: EXEC });
        await fsA.setMetadata("/touch", { mode: EXEC });
        await fsB.setMetadata("/touch", { mtime: 5000 });
        await fsA.setMetadata("/edit", { mode: EXEC });
        await fsB.writeFile("/edit", "edited");
        partitioned = false;
        await a.dial(b);

        await waitUntil(async () => {
            for (const fs of [fsA, fsB]) {
                for (const path of paths) {
                    expect((await fs.stat(path))!.headVersionIds).toHaveLength(
                        2
                    );
                }
            }
        });
        for (const fs of [fsA, fsB]) {
            expect(
                (await fs.conflicts()).map((c) => [c.path, c.versions.length])
            ).toEqual([["/edit", 2]]);
            expect(await fs.stat("/chmod")).toMatchObject({
                conflict: false,
                mode: EXEC,
            });
        }
        const [touchA, touchB] = [
            (await fsA.stat("/touch"))!,
            (await fsB.stat("/touch"))!,
        ];
        expect(touchA).toMatchObject({ conflict: false });
        expect(touchA.versionId).toBe(touchB.versionId);
        // The next write merges both heads; heads[0] supplies mode AND
        // mtime, so exactly one of the two changes survives.
        const merged = await fsA.writeFile("/touch", "/touch");
        expect(merged.parentVersionIds.sort()).toEqual(
            [...touchA.headVersionIds!].sort()
        );
        expect(merged.mode === EXEC).not.toBe(merged.mtime === 5000n);
    });
});
