import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ROOT_NODE_ID,
    NamingEvent,
    SHARED_FS_MOUNT_NAMESPACE_SEMANTICS,
    SHARED_FS_MOUNT_READ_SEMANTICS,
    SharedFsError,
    SharedFsExpectedNamespaceMismatchError,
    SharedFsHandle,
    createSharedFsMountBackend,
    openSharedFs,
    type SharedFsHandle as SharedFsHandleType,
    type SharedFsMountBackendTarget,
} from "../index.js";
import { IgnoreAwareFs } from "../ignore/ignore-fs.js";

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
};

const namingEvent = (properties: {
    id: string;
    nodeId: string;
    parentId: string;
    name: string;
    parentNamingIds?: string[];
    causalDepth?: bigint;
}) =>
    new NamingEvent({
        ...properties,
        parentNamingIds: properties.parentNamingIds ?? [],
        causalDepth: properties.causalDepth ?? 100n,
        createdAt: 100n,
        authorKey: "race",
        machineLabel: "race",
    });

const exactTarget = (
    fs: SharedFsHandleType,
    overrides: Partial<SharedFsMountBackendTarget> = {}
): SharedFsMountBackendTarget => ({
    mountNamespaceSemantics: () => SHARED_FS_MOUNT_NAMESPACE_SEMANTICS,
    mutateNamespaceForMount: (mutation) => fs.mutateNamespaceForMount(mutation),
    mountReadSemantics: () => SHARED_FS_MOUNT_READ_SEMANTICS,
    readVersionForMount: (path, id) => fs.readVersionForMount(path, id),
    readFile: (path) => fs.readFile(path),
    readVersion: (path, id) => fs.readVersion(path, id),
    writeFile: (path, content, options) => fs.writeFile(path, content, options),
    mkdir: (path) => fs.mkdir(path),
    rm: (path) => fs.rm(path),
    rename: (from, to) => fs.rename(from, to),
    list: (path) => fs.list(path),
    versions: (path) => fs.versions(path),
    conflicts: (path, options) => fs.conflicts(path, options),
    stat: (path) => fs.stat(path),
    bootstrapStatus: () => fs.bootstrapStatus(),
    ...overrides,
});

describe("node-guarded mount namespace", () => {
    let peer: Peerbit;
    let fs: SharedFsHandleType;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "namespace-test",
        });
    });

    afterEach(async () => {
        await peer.stop().catch(() => undefined);
    });

    it("removes only the bound node and returns exact ids", async () => {
        await fs.writeFile("/file.txt", "value");
        const entry = (await fs.stat("/file.txt"))!;
        const result = await fs.mutateNamespaceForMount({
            type: "remove",
            path: "/file.txt",
            expectedNodeId: entry.nodeId,
            expectedKind: "file",
        });
        expect(result).toMatchObject({
            type: "removed",
            removedNodeId: entry.nodeId,
        });
        expect(result.type === "removed" && result.removeEventId).toMatch(
            /^naming:/
        );
        expect(await fs.stat("/file.txt")).toBeUndefined();
    });

    it("returns a typed initial mismatch", async () => {
        await fs.writeFile("/file.txt", "value");
        await expect(
            fs.mutateNamespaceForMount({
                type: "remove",
                path: "/file.txt",
                expectedNodeId: "file:not-the-node",
                expectedKind: "file",
            })
        ).rejects.toMatchObject({
            code: "EAGAIN",
            operation: "remove",
            role: "source",
            checkpoint: "initial",
        });
    });

    it("detects a same-node naming-head race at the final fence", async () => {
        await fs.writeFile("/file.txt", "value");
        const entry = (await fs.stat("/file.txt"))!;
        const entered = deferred();
        const allowed = deferred();
        const program = fs.program as any;
        const original = program.headsForNode.bind(program);
        let gate = true;
        program.headsForNode = async (...args: unknown[]) => {
            const value = await original(...args);
            if (gate) {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return value;
        };
        const removing = fs.mutateNamespaceForMount({
            type: "remove",
            path: "/file.txt",
            expectedNodeId: entry.nodeId,
            expectedKind: "file",
        });
        await entered.promise;
        const initial = await program.resolvePath("/file.txt");
        const away = namingEvent({
            id: "naming:race-away",
            nodeId: entry.nodeId,
            parentId: ROOT_NODE_ID,
            name: "temporary.txt",
            parentNamingIds: initial.state.heads.map((head: any) => head.id),
            causalDepth: initial.winner.causalDepth + 1n,
        });
        const back = namingEvent({
            id: "naming:race-back",
            nodeId: entry.nodeId,
            parentId: ROOT_NODE_ID,
            name: "file.txt",
            parentNamingIds: [away.id],
            causalDepth: away.causalDepth + 1n,
        });
        // Direct store insertion models a concurrently replicated peer; local
        // ordinary naming APIs are excluded by the program-local fence.
        await fs.program.entries.putMany([away, back], { unique: true });
        allowed.resolve();
        await expect(removing).rejects.toBeInstanceOf(
            SharedFsExpectedNamespaceMismatchError
        );
        await expect(removing).rejects.toMatchObject({
            expectedNodeId: entry.nodeId,
            actualNodeId: entry.nodeId,
            checkpoint: "before-append",
        });
    });

    it("rechecks directory emptiness after awaited work", async () => {
        await fs.mkdir("/dir");
        const entry = (await fs.stat("/dir"))!;
        const program = fs.program as any;
        const original = program.listByParentId.bind(program);
        const entered = deferred();
        const allowed = deferred();
        let calls = 0;
        program.listByParentId = async (...args: unknown[]) => {
            calls++;
            if (calls === 2) {
                entered.resolve();
                await allowed.promise;
            }
            return original(...args);
        };
        const removing = fs.mutateNamespaceForMount({
            type: "remove",
            path: "/dir",
            expectedNodeId: entry.nodeId,
            expectedKind: "directory",
        });
        await entered.promise;
        await fs.program.entries.put(
            namingEvent({
                id: "naming:late-child",
                nodeId: "dir:late-child",
                parentId: entry.nodeId,
                name: "late",
            }),
            { unique: true }
        );
        allowed.resolve();
        await expect(removing).rejects.toMatchObject({ code: "ENOTEMPTY" });
        expect(await fs.stat("/dir/late")).toBeDefined();
    });

    it("atomically replaces a file and reports the paired event ids", async () => {
        await fs.writeFile("/source.txt", "source");
        await fs.writeFile("/destination.txt", "destination");
        const source = (await fs.stat("/source.txt"))!;
        const destination = (await fs.stat("/destination.txt"))!;
        const result = await fs.mutateNamespaceForMount({
            type: "rename",
            from: "/source.txt",
            to: "/destination.txt",
            expectedSourceNodeId: source.nodeId,
            expectedDestinationNodeId: destination.nodeId,
            expectedDestinationParentNodeId: ROOT_NODE_ID,
        });
        expect(result).toMatchObject({
            type: "renamed",
            sourceNodeId: source.nodeId,
            replacedNodeId: destination.nodeId,
            destinationParentNodeId: ROOT_NODE_ID,
        });
        if (result.type !== "renamed") throw new Error("wrong result");
        expect(result.moveEventId).toMatch(/^naming:/);
        expect(result.replacementDeleteEventId).toMatch(/^naming:/);
        const tombstone = (await fs.program.entries.index.get(
            result.replacementDeleteEventId!,
            { local: true, remote: false }
        )) as any;
        expect(tombstone.observedContentHeads).toEqual(
            destination.headVersionIds
        );
        expect((await fs.stat("/destination.txt"))?.nodeId).toBe(source.nodeId);
    });

    it("validates every supplied open descendant binding", async () => {
        await fs.mkdir("/dir");
        await fs.writeFile("/dir/open.txt", "open");
        const dir = (await fs.stat("/dir"))!;
        await expect(
            fs.mutateNamespaceForMount({
                type: "rename",
                from: "/dir",
                to: "/moved",
                expectedSourceNodeId: dir.nodeId,
                expectedDestinationNodeId: null,
                expectedDestinationParentNodeId: ROOT_NODE_ID,
                expectedOpenDescendants: [
                    { path: "/dir/open.txt", nodeId: "file:wrong" },
                ],
            })
        ).rejects.toMatchObject({
            code: "EAGAIN",
            role: "open-descendant",
            checkpoint: "initial",
        });
        expect(await fs.stat("/dir/open.txt")).toBeDefined();
    });

    it("renames a directory when every open descendant remains bound", async () => {
        await fs.mkdir("/dir");
        await fs.writeFile("/dir/open.txt", "open");
        const dir = (await fs.stat("/dir"))!;
        const child = (await fs.stat("/dir/open.txt"))!;
        const result = await fs.mutateNamespaceForMount({
            type: "rename",
            from: "/dir",
            to: "/moved",
            expectedSourceNodeId: dir.nodeId,
            expectedDestinationNodeId: null,
            expectedDestinationParentNodeId: ROOT_NODE_ID,
            expectedOpenDescendants: [
                { path: "/dir/open.txt", nodeId: child.nodeId },
            ],
        });
        expect(result).toMatchObject({
            type: "renamed",
            sourceNodeId: dir.nodeId,
            replacedNodeId: null,
            replacementDeleteEventId: null,
        });
        expect((await fs.stat("/moved/open.txt"))?.nodeId).toBe(child.nodeId);
    });

    it("preserves a destination that appears during an absent-destination rename", async () => {
        await fs.mkdir("/source");
        const source = (await fs.stat("/source"))!;
        const program = fs.program as any;
        const original = program.isWithinSubtree.bind(program);
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        program.isWithinSubtree = async (...args: unknown[]) => {
            if (gate) {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return original(...args);
        };
        const renaming = fs.mutateNamespaceForMount({
            type: "rename",
            from: "/source",
            to: "/destination",
            expectedSourceNodeId: source.nodeId,
            expectedDestinationNodeId: null,
            expectedDestinationParentNodeId: ROOT_NODE_ID,
        });
        await entered.promise;
        await fs.program.entries.put(
            namingEvent({
                id: "naming:unexpected-destination",
                nodeId: "dir:unexpected-destination",
                parentId: ROOT_NODE_ID,
                name: "destination",
            }),
            { unique: true }
        );
        const unexpected = (await fs.stat("/destination"))!;
        allowed.resolve();
        await expect(renaming).rejects.toMatchObject({
            code: "EAGAIN",
            role: "destination",
            checkpoint: "before-append",
        });
        expect((await fs.stat("/destination"))?.nodeId).toBe(unexpected.nodeId);
        expect((await fs.stat("/source"))?.nodeId).toBe(source.nodeId);
    });

    it("preserves a replacement destination that wins during rename", async () => {
        await fs.writeFile("/source", "source");
        await fs.writeFile("/destination", "old");
        const source = (await fs.stat("/source"))!;
        const oldDestination = (await fs.stat("/destination"))!;
        const program = fs.program as any;
        const original = program.headsForNode.bind(program);
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        program.headsForNode = async (nodeId: string) => {
            const value = await original(nodeId);
            if (gate && nodeId === oldDestination.nodeId) {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return value;
        };
        const renaming = fs.mutateNamespaceForMount({
            type: "rename",
            from: "/source",
            to: "/destination",
            expectedSourceNodeId: source.nodeId,
            expectedDestinationNodeId: oldDestination.nodeId,
            expectedDestinationParentNodeId: ROOT_NODE_ID,
        });
        await entered.promise;
        await fs.program.entries.put(
            namingEvent({
                id: "naming:replacement-destination",
                nodeId: "dir:replacement-destination",
                parentId: ROOT_NODE_ID,
                name: "destination",
            }),
            { unique: true }
        );
        const replacement = (await fs.stat("/destination"))!;
        allowed.resolve();
        await expect(renaming).rejects.toMatchObject({
            code: "EAGAIN",
            role: "destination",
        });
        expect((await fs.stat("/destination"))?.nodeId).toBe(
            replacement.nodeId
        );
        expect((await fs.stat("/source"))?.nodeId).toBe(source.nodeId);
    });

    it("detects destination-parent replacement", async () => {
        await fs.mkdir("/source");
        await fs.mkdir("/parent");
        const source = (await fs.stat("/source"))!;
        const parent = (await fs.stat("/parent"))!;
        const program = fs.program as any;
        const original = program.isWithinSubtree.bind(program);
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        program.isWithinSubtree = async (...args: unknown[]) => {
            if (gate) {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return original(...args);
        };
        const renaming = fs.mutateNamespaceForMount({
            type: "rename",
            from: "/source",
            to: "/parent/moved",
            expectedSourceNodeId: source.nodeId,
            expectedDestinationNodeId: null,
            expectedDestinationParentNodeId: parent.nodeId,
        });
        await entered.promise;
        await fs.program.entries.put(
            namingEvent({
                id: "naming:replacement-parent",
                nodeId: "dir:replacement-parent",
                parentId: ROOT_NODE_ID,
                name: "parent",
            }),
            { unique: true }
        );
        const replacement = (await fs.stat("/parent"))!;
        allowed.resolve();
        await expect(renaming).rejects.toMatchObject({
            code: "EAGAIN",
            role: "destination-parent",
            expectedNodeId: parent.nodeId,
            actualNodeId: replacement.nodeId,
        });
        expect(await fs.stat("/parent/moved")).toBeUndefined();
    });

    it("detects same-node destination-parent head changes", async () => {
        await fs.mkdir("/source");
        await fs.mkdir("/parent");
        const source = (await fs.stat("/source"))!;
        const parent = (await fs.stat("/parent"))!;
        const program = fs.program as any;
        const initialParent = await program.resolvePath("/parent");
        const entered = deferred();
        const allowed = deferred();
        const original = program.isWithinSubtree.bind(program);
        let gate = true;
        program.isWithinSubtree = async (...args: unknown[]) => {
            if (gate) {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return original(...args);
        };
        const renaming = fs.mutateNamespaceForMount({
            type: "rename",
            from: "/source",
            to: "/parent/moved",
            expectedSourceNodeId: source.nodeId,
            expectedDestinationNodeId: null,
            expectedDestinationParentNodeId: parent.nodeId,
        });
        await entered.promise;
        const away = namingEvent({
            id: "naming:parent-away",
            nodeId: parent.nodeId,
            parentId: ROOT_NODE_ID,
            name: "temporary-parent",
            parentNamingIds: initialParent.state.heads.map(
                (head: any) => head.id
            ),
            causalDepth: initialParent.winner.causalDepth + 1n,
        });
        const back = namingEvent({
            id: "naming:parent-back",
            nodeId: parent.nodeId,
            parentId: ROOT_NODE_ID,
            name: "parent",
            parentNamingIds: [away.id],
            causalDepth: away.causalDepth + 1n,
        });
        await fs.program.entries.putMany([away, back], { unique: true });
        allowed.resolve();
        await expect(renaming).rejects.toMatchObject({
            code: "EAGAIN",
            role: "destination-parent",
            expectedNodeId: parent.nodeId,
            actualNodeId: parent.nodeId,
        });
    });

    it("detects same-node open-descendant head changes", async () => {
        await fs.mkdir("/source");
        await fs.writeFile("/source/open", "open");
        const source = (await fs.stat("/source"))!;
        const child = (await fs.stat("/source/open"))!;
        const program = fs.program as any;
        const initialChild = await program.resolvePath("/source/open");
        const entered = deferred();
        const allowed = deferred();
        const original = program.isWithinSubtree.bind(program);
        let gate = true;
        program.isWithinSubtree = async (...args: unknown[]) => {
            if (gate) {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return original(...args);
        };
        const renaming = fs.mutateNamespaceForMount({
            type: "rename",
            from: "/source",
            to: "/moved",
            expectedSourceNodeId: source.nodeId,
            expectedDestinationNodeId: null,
            expectedDestinationParentNodeId: ROOT_NODE_ID,
            expectedOpenDescendants: [
                { path: "/source/open", nodeId: child.nodeId },
            ],
        });
        await entered.promise;
        const away = namingEvent({
            id: "naming:child-away",
            nodeId: child.nodeId,
            parentId: source.nodeId,
            name: "temporary-open",
            parentNamingIds: initialChild.state.heads.map(
                (head: any) => head.id
            ),
            causalDepth: initialChild.winner.causalDepth + 1n,
        });
        const back = namingEvent({
            id: "naming:child-back",
            nodeId: child.nodeId,
            parentId: source.nodeId,
            name: "open",
            parentNamingIds: [away.id],
            causalDepth: away.causalDepth + 1n,
        });
        await fs.program.entries.putMany([away, back], { unique: true });
        allowed.resolve();
        await expect(renaming).rejects.toMatchObject({
            code: "EAGAIN",
            role: "open-descendant",
            expectedNodeId: child.nodeId,
            actualNodeId: child.nodeId,
        });
    });

    it("does not append for non-empty removal or a rename cycle", async () => {
        await fs.mkdir("/dir");
        await fs.writeFile("/dir/file", "value");
        const dir = (await fs.stat("/dir"))!;
        const puts = vi.spyOn(fs.program.entries, "put");
        const putMany = vi.spyOn(fs.program.entries, "putMany");
        await expect(
            fs.mutateNamespaceForMount({
                type: "remove",
                path: "/dir",
                expectedNodeId: dir.nodeId,
                expectedKind: "directory",
            })
        ).rejects.toMatchObject({ code: "ENOTEMPTY" });
        await expect(
            fs.mutateNamespaceForMount({
                type: "rename",
                from: "/dir",
                to: "/dir/child",
                expectedSourceNodeId: dir.nodeId,
                expectedDestinationNodeId: null,
                expectedDestinationParentNodeId: dir.nodeId,
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        expect(puts).not.toHaveBeenCalled();
        expect(putMany).not.toHaveBeenCalled();
    });

    it("holds a local naming fence across cycle validation and append", async () => {
        await fs.mkdir("/A");
        await fs.mkdir("/P");
        const a = (await fs.stat("/A"))!;
        const p = (await fs.stat("/P"))!;
        const program = fs.program as any;
        const original = program.isWithinSubtree.bind(program);
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        program.isWithinSubtree = async (...args: unknown[]) => {
            if (gate) {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return original(...args);
        };
        const guarded = fs.mutateNamespaceForMount({
            type: "rename",
            from: "/A",
            to: "/P/A",
            expectedSourceNodeId: a.nodeId,
            expectedDestinationNodeId: null,
            expectedDestinationParentNodeId: p.nodeId,
        });
        await entered.promise;
        await expect(fs.rename("/P", "/A/P")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect((await fs.stat("/P"))?.nodeId).toBe(p.nodeId);
        allowed.resolve();
        await expect(guarded).resolves.toMatchObject({ type: "renamed" });
        expect((await fs.stat("/P/A"))?.nodeId).toBe(a.nodeId);
    });

    it("fences central and writeBatch naming append paths", async () => {
        await fs.mkdir("/source");
        const source = (await fs.stat("/source"))!;
        const program = fs.program as any;
        const original = program.isWithinSubtree.bind(program);
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        program.isWithinSubtree = async (...args: unknown[]) => {
            if (gate) {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return original(...args);
        };
        const guarded = fs.mutateNamespaceForMount({
            type: "rename",
            from: "/source",
            to: "/moved",
            expectedSourceNodeId: source.nodeId,
            expectedDestinationNodeId: null,
            expectedDestinationParentNodeId: ROOT_NODE_ID,
        });
        await entered.promise;
        await expect(fs.mkdir("/blocked-mkdir")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        await expect(
            fs.writeBatch([{ path: "/blocked-batch", content: "bytes" }])
        ).rejects.toMatchObject({ code: "EAGAIN" });
        expect(await fs.stat("/blocked-mkdir")).toBeUndefined();
        expect(await fs.stat("/blocked-batch")).toBeUndefined();
        allowed.resolve();
        await guarded;
    });

    it("rejects a stale mkdir plan after guarded parent removal", async () => {
        await fs.mkdir("/parent");
        const parent = (await fs.stat("/parent"))!;
        const program = fs.program as any;
        const original = program.resolveParent.bind(program);
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        program.resolveParent = async (path: string) => {
            const value = await original(path);
            if (gate && path === "/parent/child") {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return value;
        };
        const creating = fs.mkdir("/parent/child");
        await entered.promise;
        await fs.mutateNamespaceForMount({
            type: "remove",
            path: "/parent",
            expectedNodeId: parent.nodeId,
            expectedKind: "directory",
        });
        allowed.resolve();
        await expect(creating).rejects.toMatchObject({ code: "EAGAIN" });
        expect(await fs.stat("/parent")).toBeUndefined();
        expect(await fs.stat("/parent/child")).toBeUndefined();
    });

    it("rejects a stale legacy rename plan after guarded source removal", async () => {
        await fs.writeFile("/source", "source");
        const source = (await fs.stat("/source"))!;
        const program = fs.program as any;
        const original = program.resolveParent.bind(program);
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        program.resolveParent = async (path: string) => {
            const value = await original(path);
            if (gate && path === "/moved") {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return value;
        };
        const legacyRename = fs.rename("/source", "/moved");
        await entered.promise;
        await fs.mutateNamespaceForMount({
            type: "remove",
            path: "/source",
            expectedNodeId: source.nodeId,
            expectedKind: "file",
        });
        allowed.resolve();
        await expect(legacyRename).rejects.toMatchObject({ code: "EAGAIN" });
        expect(await fs.stat("/source")).toBeUndefined();
        expect(await fs.stat("/moved")).toBeUndefined();
    });

    it("never partially deletes a legacy rename destination across a guard", async () => {
        await fs.writeFile("/source", "source");
        await fs.writeFile("/destination", "destination");
        await fs.writeFile("/guard", "guard");
        const destination = (await fs.stat("/destination"))!;
        const guard = (await fs.stat("/guard"))!;
        const program = fs.program as any;
        const original = program.headsForNode.bind(program);
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        program.headsForNode = async (nodeId: string) => {
            const value = await original(nodeId);
            if (gate && nodeId === destination.nodeId) {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return value;
        };
        const legacyRename = fs.rename("/source", "/destination");
        await entered.promise;
        await fs.mutateNamespaceForMount({
            type: "remove",
            path: "/guard",
            expectedNodeId: guard.nodeId,
            expectedKind: "file",
        });
        allowed.resolve();
        await expect(legacyRename).rejects.toMatchObject({ code: "EAGAIN" });
        expect(new TextDecoder().decode(await fs.readFile("/source"))).toBe(
            "source"
        );
        expect(
            new TextDecoder().decode(await fs.readFile("/destination"))
        ).toBe("destination");
    });

    it("fails inherited capability advertisement closed", () => {
        class LegacyOverride extends SharedFsHandle {
            override rm(path: string) {
                return super.rm(path);
            }
        }
        expect(
            new LegacyOverride(fs.program).mountNamespaceSemantics()
        ).toBeUndefined();
        expect(fs.mountNamespaceSemantics()).toBe(
            SHARED_FS_MOUNT_NAMESPACE_SEMANTICS
        );

        fs.program.mountNamespaceSemantics = () => undefined;
        expect(new SharedFsHandle(fs.program).mountNamespaceSemantics()).toBe(
            undefined
        );
    });

    it("binds a pure-read open descendant during backend directory rename", async () => {
        await fs.mkdir("/dir");
        await fs.writeFile("/dir/read.txt", "read");
        const child = (await fs.stat("/dir/read.txt"))!;
        const mutate = vi.fn((mutation) =>
            fs.mutateNamespaceForMount(mutation)
        );
        const target: SharedFsMountBackendTarget = {
            mountNamespaceSemantics: () => SHARED_FS_MOUNT_NAMESPACE_SEMANTICS,
            mutateNamespaceForMount: mutate,
            readFile: (path) => fs.readFile(path),
            readVersion: (path, id) => fs.readVersion(path, id),
            writeFile: (path, content, options) =>
                fs.writeFile(path, content, options),
            mkdir: (path) => fs.mkdir(path),
            rm: (path) => fs.rm(path),
            rename: (from, to) => fs.rename(from, to),
            list: (path) => fs.list(path),
            versions: (path) => fs.versions(path),
            conflicts: (path, options) => fs.conflicts(path, options),
            stat: (path) => fs.stat(path),
        };
        const backend = createSharedFsMountBackend(target);
        const handle = await backend.open("/dir/read.txt", { read: true });
        await backend.rename("/dir", "/moved");
        expect(mutate).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "rename",
                expectedOpenDescendants: [
                    { path: "/dir/read.txt", nodeId: child.nodeId },
                ],
            })
        );
        await backend.release(handle);
        expect((await fs.stat("/moved/read.txt"))?.nodeId).toBe(child.nodeId);
    });

    it("rejects rename while an existing-file open is in flight, then follows on retry", async () => {
        await fs.mkdir("/dir");
        await fs.writeFile("/dir/file.txt", "value");
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        const target = exactTarget(fs, {
            readVersionForMount: async (path, id) => {
                if (gate) {
                    gate = false;
                    entered.resolve();
                    await allowed.promise;
                }
                return fs.readVersionForMount(path, id);
            },
        });
        const backend = createSharedFsMountBackend(target);
        const opening = backend.open("/dir/file.txt", {
            read: true,
            write: true,
        });
        await entered.promise;
        await expect(backend.rename("/dir", "/moved")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        allowed.resolve();
        const handle = await opening;
        await backend.write(handle, new TextEncoder().encode("next!"), 0);
        await backend.rename("/dir", "/moved");
        await backend.release(handle);
        expect(
            new TextDecoder().decode(await fs.readFile("/moved/file.txt"))
        ).toBe("next!");
    });

    it("rejects rename while an affected handle commit is in flight", async () => {
        await fs.writeFile("/source.txt", "source");
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        const target = exactTarget(fs, {
            writeFile: async (path, content, options) => {
                if (gate) {
                    gate = false;
                    entered.resolve();
                    await allowed.promise;
                }
                return fs.writeFile(path, content, options);
            },
        });
        const backend = createSharedFsMountBackend(target);
        const handle = await backend.open("/source.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty!"), 0);
        const flushing = backend.fsync(handle);
        await entered.promise;
        await expect(
            backend.rename("/source.txt", "/destination.txt")
        ).rejects.toMatchObject({ code: "EAGAIN" });
        allowed.resolve();
        await flushing;
        await backend.rename("/source.txt", "/destination.txt");
        await backend.release(handle);
        expect(
            new TextDecoder().decode(await fs.readFile("/destination.txt"))
        ).toBe("dirty!");
    });

    it("rejects replacement rename while the destination commit is in flight", async () => {
        await fs.writeFile("/source.txt", "source");
        await fs.writeFile("/destination.txt", "destination");
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        const target = exactTarget(fs, {
            writeFile: async (path, content, options) => {
                if (gate && path === "/destination.txt") {
                    gate = false;
                    entered.resolve();
                    await allowed.promise;
                }
                return fs.writeFile(path, content, options);
            },
        });
        const backend = createSharedFsMountBackend(target);
        const destinationHandle = await backend.open("/destination.txt", {
            read: true,
            write: true,
        });
        await backend.write(
            destinationHandle,
            new TextEncoder().encode("committing!"),
            0
        );
        const flushing = backend.fsync(destinationHandle);
        await entered.promise;
        await expect(
            backend.rename("/source.txt", "/destination.txt")
        ).rejects.toMatchObject({ code: "EAGAIN" });
        allowed.resolve();
        await flushing;
        await backend.rename("/source.txt", "/destination.txt");
        await backend.release(destinationHandle);
        expect(
            new TextDecoder().decode(await fs.readFile("/destination.txt"))
        ).toBe("source");
    });

    it("rejects a commit admitted during an active namespace transition", async () => {
        await fs.writeFile("/source.txt", "source");
        const entered = deferred();
        const allowed = deferred();
        const target = exactTarget(fs, {
            mutateNamespaceForMount: async (mutation) => {
                entered.resolve();
                await allowed.promise;
                return fs.mutateNamespaceForMount(mutation);
            },
        });
        const backend = createSharedFsMountBackend(target);
        const handle = await backend.open("/source.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty!"), 0);
        const renaming = backend.rename("/source.txt", "/destination.txt");
        await entered.promise;
        await expect(
            backend.open("/source.txt", { read: true })
        ).rejects.toMatchObject({ code: "EAGAIN" });
        await expect(backend.flush(handle)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        allowed.resolve();
        await renaming;
        await backend.flush(handle);
        await backend.release(handle);
        expect(
            new TextDecoder().decode(await fs.readFile("/destination.txt"))
        ).toBe("dirty!");
    });

    it("keeps IgnoreAwareFs policy to one snapshot and delegated capability exact", async () => {
        const ignored = (await openSharedFs({
            peerbit: peer,
            machineLabel: "ignore-namespace-test",
            ignore: { patterns: ["dist/"] },
        })) as any;
        await ignored.writeFile("/source", "source");
        const source = await ignored.stat("/source");
        const current = vi.spyOn(ignored.ignorePolicy, "current");
        await expect(
            ignored.mutateNamespaceForMount({
                type: "rename",
                from: "/source",
                to: "/dist/source",
                expectedSourceNodeId: source.nodeId,
                expectedDestinationNodeId: null,
                expectedDestinationParentNodeId: ROOT_NODE_ID,
            })
        ).rejects.toMatchObject({ code: "EXDEV" });
        expect(current).toHaveBeenCalledTimes(1);
        expect(ignored.mountNamespaceSemantics()).toBe(
            SHARED_FS_MOUNT_NAMESPACE_SEMANTICS
        );

        // Simulate a delegated program subclass changing namespace behavior.
        ignored.program.rm = ignored.program.rm.bind(ignored.program);
        expect(ignored.program.mountNamespaceSemantics()).toBeUndefined();
        expect(ignored.mountNamespaceSemantics()).toBeUndefined();

        // A delegated subclass/monkey patch cannot bypass the wrapper's
        // identity checks by blindly returning the capability constant.
        ignored.program.mountNamespaceSemantics = () =>
            SHARED_FS_MOUNT_NAMESPACE_SEMANTICS;
        expect(ignored.program.mountNamespaceSemantics()).toBe(
            SHARED_FS_MOUNT_NAMESPACE_SEMANTICS
        );
        expect(ignored.mountNamespaceSemantics()).toBeUndefined();
    });

    it("fails IgnoreAwareFs subclass inheritance closed", async () => {
        const ignored = (await openSharedFs({
            peerbit: peer,
            machineLabel: "ignore-subclass-test",
            ignore: { patterns: ["dist/"] },
        })) as IgnoreAwareFs;
        class IgnoreOverride extends IgnoreAwareFs {
            override rm(path: string) {
                return super.rm(path);
            }
        }
        const wrapper = new IgnoreOverride(
            ignored.program,
            ignored.ignorePolicy,
            { patterns: ["dist/"] }
        );
        expect(wrapper.mountNamespaceSemantics()).toBeUndefined();
    });

    it("does not call legacy rename after exact-capability malformed output", async () => {
        await fs.writeFile("/from.txt", "from");
        const rename = vi.fn();
        const target: SharedFsMountBackendTarget = {
            mountNamespaceSemantics: () => SHARED_FS_MOUNT_NAMESPACE_SEMANTICS,
            mutateNamespaceForMount: vi.fn(async () => ({}) as any),
            readFile: (path) => fs.readFile(path),
            readVersion: (path, id) => fs.readVersion(path, id),
            writeFile: (path, content, options) =>
                fs.writeFile(path, content, options),
            mkdir: (path) => fs.mkdir(path),
            rm: (path) => fs.rm(path),
            rename,
            list: (path) => fs.list(path),
            versions: (path) => fs.versions(path),
            conflicts: (path, options) => fs.conflicts(path, options),
            stat: (path) => fs.stat(path),
        };
        const backend = createSharedFsMountBackend(target);
        await expect(
            backend.rename("/from.txt", "/to.txt")
        ).rejects.toMatchObject({
            code: "EIO",
        });
        expect(rename).not.toHaveBeenCalled();
        expect(await fs.stat("/from.txt")).toBeDefined();
    });

    it("detaches an unlinked dirty fd when a typed mismatch follows path replacement", async () => {
        await fs.writeFile("/file.txt", "original");
        const original = (await fs.stat("/file.txt"))!;
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const target = exactTarget(fs, {
            writeFile,
            mutateNamespaceForMount: async (mutation) => {
                if (mutation.type !== "remove") throw new Error("unexpected");
                await fs.rm(mutation.path);
                await fs.writeFile(mutation.path, "replacement");
                const replacement = (await fs.stat(mutation.path))!;
                throw new SharedFsExpectedNamespaceMismatchError(
                    "remove",
                    "source",
                    mutation.path,
                    mutation.expectedNodeId,
                    replacement.nodeId,
                    "before-append"
                );
            },
        });
        const backend = createSharedFsMountBackend(target);
        const handle = await backend.open("/file.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty-old"), 0);
        await expect(backend.unlink("/file.txt")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        const replacement = (await fs.stat("/file.txt"))!;
        expect(replacement.nodeId).not.toBe(original.nodeId);
        expect((await backend.getattr("/file.txt")).size).toBe(11);
        expect(new TextDecoder().decode(await backend.read(handle, 9, 0))).toBe(
            "dirty-old"
        );
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).not.toHaveBeenCalled();
        expect(new TextDecoder().decode(await fs.readFile("/file.txt"))).toBe(
            "replacement"
        );
    });

    it("keeps a dirty fd attached after a typed head-only mismatch with no binding change", async () => {
        await fs.writeFile("/file.txt", "original");
        const original = (await fs.stat("/file.txt"))!;
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const target = exactTarget(fs, {
            writeFile,
            mutateNamespaceForMount: async (mutation) => {
                if (mutation.type !== "remove") throw new Error("unexpected");
                throw new SharedFsExpectedNamespaceMismatchError(
                    "remove",
                    "source",
                    mutation.path,
                    mutation.expectedNodeId,
                    mutation.expectedNodeId,
                    "before-append"
                );
            },
        });
        const backend = createSharedFsMountBackend(target);
        const handle = await backend.open("/file.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty"), 0);
        await expect(backend.unlink("/file.txt")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect((await fs.stat("/file.txt"))?.nodeId).toBe(original.nodeId);
        expect((await backend.getattr("/file.txt")).size).toBe(8);
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).toHaveBeenCalledOnce();
        expect(new TextDecoder().decode(await fs.readFile("/file.txt"))).toBe(
            "dirtynal"
        );
    });

    it("revalidates rename source and destination fds after a typed mismatch", async () => {
        await fs.writeFile("/source.txt", "source");
        await fs.writeFile("/destination.txt", "destination");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const target = exactTarget(fs, {
            writeFile,
            mutateNamespaceForMount: async (mutation) => {
                if (mutation.type !== "rename") throw new Error("unexpected");
                await fs.rename(mutation.from, "/displaced-source.txt");
                await fs.writeFile(mutation.from, "new-source");
                await fs.rm(mutation.to);
                await fs.writeFile(mutation.to, "new-destination");
                const replacement = (await fs.stat(mutation.from))!;
                throw new SharedFsExpectedNamespaceMismatchError(
                    "rename",
                    "source",
                    mutation.from,
                    mutation.expectedSourceNodeId,
                    replacement.nodeId,
                    "before-append"
                );
            },
        });
        const backend = createSharedFsMountBackend(target);
        const sourceHandle = await backend.open("/source.txt", {
            read: true,
            write: true,
        });
        const destinationHandle = await backend.open("/destination.txt", {
            read: true,
            write: true,
        });
        await backend.write(
            sourceHandle,
            new TextEncoder().encode("dirty-source"),
            0
        );
        await backend.write(
            destinationHandle,
            new TextEncoder().encode("dirty-destination"),
            0
        );
        await expect(
            backend.rename("/source.txt", "/destination.txt")
        ).rejects.toMatchObject({ code: "EAGAIN" });
        await backend.flush(sourceHandle);
        await backend.flush(destinationHandle);
        await backend.release(sourceHandle);
        await backend.release(destinationHandle);
        expect(writeFile).not.toHaveBeenCalled();
        expect(new TextDecoder().decode(await fs.readFile("/source.txt"))).toBe(
            "new-source"
        );
        expect(
            new TextDecoder().decode(await fs.readFile("/destination.txt"))
        ).toBe("new-destination");
    });

    it("detaches a replaced open descendant after a typed rename mismatch", async () => {
        await fs.mkdir("/tree");
        await fs.writeFile("/tree/child.txt", "child");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const target = exactTarget(fs, {
            writeFile,
            mutateNamespaceForMount: async (mutation) => {
                if (mutation.type !== "rename") throw new Error("unexpected");
                const descendant = mutation.expectedOpenDescendants?.[0];
                if (!descendant) throw new Error("missing descendant");
                await fs.rm(descendant.path);
                await fs.writeFile(descendant.path, "replacement-child");
                const replacement = (await fs.stat(descendant.path))!;
                throw new SharedFsExpectedNamespaceMismatchError(
                    "rename",
                    "open-descendant",
                    descendant.path,
                    descendant.nodeId,
                    replacement.nodeId,
                    "before-append"
                );
            },
        });
        const backend = createSharedFsMountBackend(target);
        const childHandle = await backend.open("/tree/child.txt", {
            read: true,
            write: true,
        });
        await backend.write(
            childHandle,
            new TextEncoder().encode("dirty-child"),
            0
        );
        await expect(backend.rename("/tree", "/moved")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(await fs.stat("/moved")).toBeUndefined();
        expect(
            new TextDecoder().decode(await fs.readFile("/tree/child.txt"))
        ).toBe("replacement-child");
        await backend.flush(childHandle);
        await backend.release(childHandle);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("bounds typed-mismatch handle revalidation concurrency", async () => {
        await fs.mkdir("/tree");
        for (let index = 0; index < 10; index++) {
            await fs.writeFile(`/tree/${index}.txt`, `${index}`);
        }
        let revalidating = false;
        let active = 0;
        let maximum = 0;
        const target = exactTarget(fs, {
            stat: async (path) => {
                if (revalidating && path.startsWith("/tree/")) {
                    active++;
                    maximum = Math.max(maximum, active);
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    active--;
                }
                return fs.stat(path);
            },
            mutateNamespaceForMount: async (mutation) => {
                if (mutation.type !== "rename") throw new Error("unexpected");
                revalidating = true;
                throw new SharedFsExpectedNamespaceMismatchError(
                    "rename",
                    "source",
                    mutation.from,
                    mutation.expectedSourceNodeId,
                    mutation.expectedSourceNodeId,
                    "before-append"
                );
            },
        });
        const backend = createSharedFsMountBackend(target);
        const handles = await Promise.all(
            Array.from({ length: 10 }, (_, index) =>
                backend.open(`/tree/${index}.txt`, { read: true })
            )
        );
        await expect(backend.rename("/tree", "/moved")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(maximum).toBeGreaterThan(1);
        expect(maximum).toBeLessThanOrEqual(4);
        await Promise.all(handles.map((handle) => backend.release(handle)));
    });

    it("drains active binding rechecks and stops scheduling after the first failure", async () => {
        await fs.mkdir("/tree");
        for (let index = 0; index < 10; index++) {
            await fs.writeFile(`/tree/${index}.txt`, `${index}`);
        }
        const delayedStats = deferred();
        let revalidating = false;
        let calls = 0;
        const target = exactTarget(fs, {
            stat: async (path) => {
                if (revalidating && path.startsWith("/tree/")) {
                    calls++;
                    if (path === "/tree/0.txt") {
                        throw new Error("revalidation lookup failed");
                    }
                    await delayedStats.promise;
                }
                return fs.stat(path);
            },
            mutateNamespaceForMount: async (mutation) => {
                if (mutation.type !== "rename") throw new Error("unexpected");
                revalidating = true;
                throw new SharedFsExpectedNamespaceMismatchError(
                    "rename",
                    "source",
                    mutation.from,
                    mutation.expectedSourceNodeId,
                    mutation.expectedSourceNodeId,
                    "before-append"
                );
            },
        });
        const backend = createSharedFsMountBackend(target);
        const handles = await Promise.all(
            Array.from({ length: 10 }, (_, index) =>
                backend.open(`/tree/${index}.txt`, { read: true })
            )
        );
        let settled = false;
        const renaming = backend.rename("/tree", "/moved");
        void renaming.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            }
        );
        for (let attempt = 0; attempt < 100 && calls < 4; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        expect(calls).toBe(4);
        expect(settled).toBe(false);
        delayedStats.resolve();
        await expect(renaming).rejects.toMatchObject({ code: "EAGAIN" });
        const callsAtRejection = calls;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(calls).toBe(callsAtRejection);
        await Promise.all(handles.map((handle) => backend.release(handle)));
    });

    it("quarantines every stale sibling handle during unlink preflight", async () => {
        await fs.writeFile("/file.txt", "old-node");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const handles = await Promise.all([
            backend.open("/file.txt", { read: true, write: true }),
            backend.open("/file.txt", { read: true, write: true }),
        ]);
        await backend.write(handles[0], new TextEncoder().encode("dirty-a"), 0);
        await backend.write(handles[1], new TextEncoder().encode("dirty-b"), 0);
        await fs.rm("/file.txt");
        await fs.writeFile("/file.txt", "replacement");

        await expect(backend.unlink("/file.txt")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect((await backend.getattr("/file.txt")).size).toBe(11);
        expect(
            (await backend.readdir("/")).filter(
                (entry) => entry.name === "file.txt"
            )
        ).toHaveLength(1);
        await Promise.all(handles.map((handle) => backend.flush(handle)));
        await Promise.all(handles.map((handle) => backend.release(handle)));
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("quarantines stale source and destination handles in one rename preflight", async () => {
        await fs.writeFile("/source.txt", "old-source");
        await fs.writeFile("/destination.txt", "old-destination");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const sourceHandle = await backend.open("/source.txt", {
            read: true,
            write: true,
        });
        const destinationHandle = await backend.open("/destination.txt", {
            read: true,
            write: true,
        });
        await backend.write(
            sourceHandle,
            new TextEncoder().encode("dirty-source"),
            0
        );
        await backend.write(
            destinationHandle,
            new TextEncoder().encode("dirty-destination"),
            0
        );
        await fs.rm("/source.txt");
        await fs.rm("/destination.txt");
        await fs.writeFile("/source.txt", "new-source");
        await fs.writeFile("/destination.txt", "new-destination");

        await expect(
            backend.rename("/source.txt", "/destination.txt")
        ).rejects.toMatchObject({ code: "EAGAIN" });
        expect((await backend.getattr("/source.txt")).size).toBe(10);
        expect((await backend.getattr("/destination.txt")).size).toBe(15);
        await backend.flush(sourceHandle);
        await backend.flush(destinationHandle);
        await backend.release(sourceHandle);
        await backend.release(destinationHandle);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("detaches stale destination descendants after a successful directory replacement", async () => {
        await fs.mkdir("/source");
        await fs.writeFile("/source/moved.txt", "moved");
        await fs.mkdir("/destination");
        await fs.writeFile("/destination/stale.txt", "stale");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const target = exactTarget(fs, {
            writeFile,
            mutateNamespaceForMount: async (mutation) => {
                if (mutation.type !== "rename") throw new Error("unexpected");
                await fs.rm(mutation.to);
                await fs.rename(mutation.from, mutation.to);
                return {
                    type: "renamed",
                    sourceNodeId: mutation.expectedSourceNodeId,
                    replacedNodeId: mutation.expectedDestinationNodeId,
                    destinationParentNodeId:
                        mutation.expectedDestinationParentNodeId,
                    moveEventId: "naming:test-directory-move",
                    replacementDeleteEventId:
                        "naming:test-directory-replacement",
                };
            },
        });
        const backend = createSharedFsMountBackend(target);
        const staleHandle = await backend.open("/destination/stale.txt", {
            read: true,
            write: true,
        });
        await backend.write(staleHandle, new TextEncoder().encode("dirty"), 0);
        await fs.rm("/destination/stale.txt");

        await backend.rename("/source", "/destination");
        expect(await fs.stat("/source")).toBeUndefined();
        expect(await fs.stat("/destination/moved.txt")).toBeDefined();
        await expect(
            backend.getattr("/destination/stale.txt")
        ).rejects.toMatchObject({ code: "ENOENT" });
        await backend.flush(staleHandle);
        await backend.release(staleHandle);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("preserves dirty source data after deterministic capable rename rejection", async () => {
        await fs.writeFile("/source.txt", "old");
        await fs.mkdir("/destination");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const handle = await backend.open("/source.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("new"), 0);

        await expect(
            backend.rename("/source.txt", "/destination")
        ).rejects.toMatchObject({ code: "EISDIR" });
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).toHaveBeenCalledOnce();
        expect(new TextDecoder().decode(await fs.readFile("/source.txt"))).toBe(
            "new"
        );
    });

    it("binds directory descendants from the fresh path instead of last-handle wins", async () => {
        await fs.mkdir("/tree");
        await fs.writeFile("/tree/child.txt", "aaaaaa");
        const nodeA = (await fs.stat("/tree/child.txt"))!;
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const handleA = await backend.open("/tree/child.txt", {
            read: true,
            write: true,
        });
        await backend.write(handleA, new TextEncoder().encode("valid-a"), 0);

        await fs.rename("/tree/child.txt", "/holding-a.txt");
        await fs.writeFile("/tree/child.txt", "bbbbbbb");
        const nodeB = (await fs.stat("/tree/child.txt"))!;
        const handleB = await backend.open("/tree/child.txt", {
            read: true,
            write: true,
        });
        await backend.write(handleB, new TextEncoder().encode("stale-b"), 0);
        await fs.rm("/tree/child.txt");
        await fs.rename("/holding-a.txt", "/tree/child.txt");
        expect((await fs.stat("/tree/child.txt"))?.nodeId).toBe(nodeA.nodeId);
        expect(nodeB.nodeId).not.toBe(nodeA.nodeId);

        await backend.rename("/tree", "/moved");
        await backend.flush(handleB);
        await backend.release(handleB);
        await backend.flush(handleA);
        await backend.release(handleA);
        expect(writeFile).toHaveBeenCalledOnce();
        expect(writeFile.mock.calls[0][0]).toBe("/moved/child.txt");
        expect(
            new TextDecoder().decode(await fs.readFile("/moved/child.txt"))
        ).toBe("valid-a");
    });

    it("preserves a dirty fd after a deterministic capable unlink rejection", async () => {
        await fs.writeFile("/file.txt", "old");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, {
                writeFile,
                mutateNamespaceForMount: async () => {
                    throw new SharedFsError("EIO", "policy rejected unlink");
                },
            })
        );
        const handle = await backend.open("/file.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("new"), 0);

        await expect(backend.unlink("/file.txt")).rejects.toMatchObject({
            code: "EIO",
        });
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).toHaveBeenCalledOnce();
        expect(new TextDecoder().decode(await fs.readFile("/file.txt"))).toBe(
            "new"
        );
    });

    it("detaches a stale dirty fd before absent unlink returns ENOENT", async () => {
        await fs.writeFile("/file.txt", "old");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const handle = await backend.open("/file.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty"), 0);
        await fs.rm("/file.txt");

        await expect(backend.unlink("/file.txt")).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(backend.getattr("/file.txt")).rejects.toMatchObject({
            code: "ENOENT",
        });
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("detaches a stale file fd before replacement-directory unlink returns EISDIR", async () => {
        await fs.writeFile("/occupied", "old");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const handle = await backend.open("/occupied", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty"), 0);
        await fs.rm("/occupied");
        await fs.mkdir("/occupied");

        await expect(backend.unlink("/occupied")).rejects.toMatchObject({
            code: "EISDIR",
        });
        expect((await backend.getattr("/occupied")).kind).toBe("directory");
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("detaches a stale exact fd before mkdir returns EEXIST for a replacement", async () => {
        await fs.writeFile("/occupied", "old");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const handle = await backend.open("/occupied", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty"), 0);
        await fs.rm("/occupied");
        await fs.writeFile("/occupied", "replacement");

        await expect(backend.mkdir("/occupied")).rejects.toMatchObject({
            code: "EEXIST",
        });
        expect((await backend.getattr("/occupied")).size).toBe(11);
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("detaches stale descendants before absent rmdir returns ENOENT", async () => {
        await fs.mkdir("/tree");
        await fs.writeFile("/tree/child.txt", "child");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const handle = await backend.open("/tree/child.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty"), 0);
        await fs.rm("/tree/child.txt");
        await fs.rm("/tree");

        await expect(backend.rmdir("/tree")).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(backend.getattr("/tree/child.txt")).rejects.toMatchObject({
            code: "ENOENT",
        });
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("detaches old directory descendants when rename observes a replacement file", async () => {
        await fs.mkdir("/tree");
        await fs.writeFile("/tree/child.txt", "child");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const handle = await backend.open("/tree/child.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty"), 0);
        await fs.rm("/tree/child.txt");
        await fs.rm("/tree");
        await fs.writeFile("/tree", "replacement-file");

        await backend.rename("/tree", "/moved.txt");
        expect(new TextDecoder().decode(await fs.readFile("/moved.txt"))).toBe(
            "replacement-file"
        );
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("revalidates replaced-directory descendants before rejecting a missing destination parent", async () => {
        await fs.mkdir("/tree");
        await fs.writeFile("/tree/child.txt", "old-child");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const handle = await backend.open("/tree/child.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty-old"), 0);

        await fs.rm("/tree/child.txt");
        await fs.rm("/tree");
        await fs.mkdir("/tree");
        await fs.writeFile("/tree/child.txt", "replacement-child");

        await expect(
            backend.rename("/tree", "/missing-parent/moved")
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect((await backend.getattr("/tree/child.txt")).size).toBe(17);
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("revalidates destination descendants before a stale-root preflight error", async () => {
        await fs.mkdir("/source");
        await fs.mkdir("/destination");
        await fs.writeFile("/destination/child.txt", "old-child");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const childHandle = await backend.open("/destination/child.txt", {
            read: true,
            write: true,
        });
        await backend.write(
            childHandle,
            new TextEncoder().encode("dirty-child"),
            0
        );

        await fs.rm("/destination/child.txt");
        await fs.rm("/destination");
        await fs.writeFile("/destination", "intermediate");
        const rootHandle = await backend.open("/destination", {
            read: true,
            write: true,
        });
        await backend.write(
            rootHandle,
            new TextEncoder().encode("dirty-root"),
            0
        );
        await fs.rm("/destination");
        await fs.mkdir("/destination");
        await fs.writeFile("/destination/child.txt", "replacement-child");

        await expect(
            backend.rename("/source", "/destination")
        ).rejects.toMatchObject({ code: "EAGAIN" });
        expect((await backend.getattr("/destination/child.txt")).size).toBe(17);
        await backend.flush(childHandle);
        await backend.flush(rootHandle);
        await backend.release(childHandle);
        await backend.release(rootHandle);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("detaches a stale file descriptor when mkdir occupies its removed path", async () => {
        await fs.writeFile("/occupied", "old-file");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const handle = await backend.open("/occupied", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty"), 0);
        await fs.rm("/occupied");

        await backend.mkdir("/occupied");
        expect((await backend.getattr("/occupied")).kind).toBe("directory");
        expect(
            (await backend.readdir("/")).filter(
                (entry) => entry.name === "occupied"
            )
        ).toHaveLength(1);
        expect(new TextDecoder().decode(await backend.read(handle, 5, 0))).toBe(
            "dirty"
        );
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("detaches stale descendants after capable rmdir success", async () => {
        await fs.mkdir("/tree");
        await fs.writeFile("/tree/child.txt", "old-child");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const handle = await backend.open("/tree/child.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty"), 0);
        await fs.rm("/tree/child.txt");

        await backend.rmdir("/tree");
        await expect(backend.getattr("/tree/child.txt")).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect(
            (await backend.readdir("/")).map((entry) => entry.name)
        ).not.toContain("tree");
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("preserves and commits a dirty descendant after deterministic ENOTEMPTY", async () => {
        await fs.mkdir("/tree");
        await fs.writeFile("/tree/child.txt", "old-child");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const backend = createSharedFsMountBackend(
            exactTarget(fs, { writeFile })
        );
        const handle = await backend.open("/tree/child.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("committed"), 0);

        await expect(backend.rmdir("/tree")).rejects.toMatchObject({
            code: "ENOTEMPTY",
        });
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).toHaveBeenCalledOnce();
        expect(
            new TextDecoder().decode(await fs.readFile("/tree/child.txt"))
        ).toBe("committed");
    });

    it("quarantines stale descendants after an indeterminate capable rmdir error", async () => {
        await fs.mkdir("/tree");
        await fs.writeFile("/tree/child.txt", "old-child");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const target = exactTarget(fs, {
            writeFile,
            mutateNamespaceForMount: async (mutation) => {
                await fs.mutateNamespaceForMount(mutation);
                throw new SharedFsError(
                    "EIO",
                    "result lost after durable rmdir"
                );
            },
        });
        const backend = createSharedFsMountBackend(target);
        const handle = await backend.open("/tree/child.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty"), 0);
        await fs.rm("/tree/child.txt");

        await expect(backend.rmdir("/tree")).rejects.toMatchObject({
            code: "EIO",
        });
        await expect(backend.getattr("/tree/child.txt")).rejects.toMatchObject({
            code: "ENOENT",
        });
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("detaches a dirty unlinked descriptor from namespace overlays and commits", async () => {
        await fs.writeFile("/file.txt", "original");
        const writeFile = vi.spyOn(fs, "writeFile");
        const backend = createSharedFsMountBackend(fs);
        const handle = await backend.open("/file.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty"), 0);
        await backend.unlink("/file.txt");
        await expect(backend.getattr("/file.txt")).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect(
            (await backend.readdir("/")).map((entry) => entry.name)
        ).not.toContain("file.txt");
        expect(new TextDecoder().decode(await backend.read(handle, 5, 0))).toBe(
            "dirty"
        );
        await backend.flush(handle);
        await backend.fsync(handle);
        await backend.release(handle);
        expect(writeFile).not.toHaveBeenCalled();
        expect(await fs.stat("/file.txt")).toBeUndefined();
    });

    it("ignores an old detached fd after path recreation and later guarded mutations", async () => {
        await fs.writeFile("/file.txt", "old");
        const backend = createSharedFsMountBackend(fs);
        const oldHandle = await backend.open("/file.txt", {
            read: true,
            write: true,
        });
        await backend.write(oldHandle, new TextEncoder().encode("local"), 0);
        await backend.unlink("/file.txt");
        await fs.writeFile("/file.txt", "new");
        const replacement = (await fs.stat("/file.txt"))!;
        await backend.rename("/file.txt", "/renamed.txt");
        expect((await fs.stat("/renamed.txt"))?.nodeId).toBe(
            replacement.nodeId
        );
        expect(
            new TextDecoder().decode(await backend.read(oldHandle, 5, 0))
        ).toBe("local");
        await backend.unlink("/renamed.txt");
        expect(await fs.stat("/renamed.txt")).toBeUndefined();
        await backend.write(oldHandle, new TextEncoder().encode("!"), 0);
        await backend.flush(oldHandle);
        await backend.release(oldHandle);
        expect(await fs.stat("/file.txt")).toBeUndefined();
        expect(await fs.stat("/renamed.txt")).toBeUndefined();
    });

    it("detaches dirty replaced-destination handles while source handles follow", async () => {
        await fs.writeFile("/source.txt", "source");
        await fs.writeFile("/destination.txt", "destination");
        const writeFile = vi.spyOn(fs, "writeFile");
        const backend = createSharedFsMountBackend(fs);
        const sourceHandle = await backend.open("/source.txt", {
            read: true,
            write: true,
        });
        const destinationHandle = await backend.open("/destination.txt", {
            read: true,
            write: true,
        });
        await backend.write(
            sourceHandle,
            new TextEncoder().encode("moved!"),
            0
        );
        await backend.write(
            destinationHandle,
            new TextEncoder().encode("stale!"),
            0
        );
        await backend.rename("/source.txt", "/destination.txt");
        expect(
            new TextDecoder().decode(
                await backend.read(destinationHandle, 6, 0)
            )
        ).toBe("stale!");
        await backend.release(destinationHandle);
        await backend.release(sourceHandle);
        expect(writeFile).toHaveBeenCalledTimes(1);
        expect(writeFile.mock.calls[0][0]).toBe("/destination.txt");
        expect(
            new TextDecoder().decode(await fs.readFile("/destination.txt"))
        ).toBe("moved!");
        expect(await fs.stat("/source.txt")).toBeUndefined();
    });

    it("quarantines dirty handles when a capable result is malformed after mutation", async () => {
        await fs.writeFile("/source.txt", "source");
        const writeFile = vi.fn((path, content, options) =>
            fs.writeFile(path, content, options)
        );
        const target: SharedFsMountBackendTarget = {
            mountNamespaceSemantics: () => SHARED_FS_MOUNT_NAMESPACE_SEMANTICS,
            mutateNamespaceForMount: async (mutation) => {
                await fs.mutateNamespaceForMount(mutation);
                return {} as any;
            },
            readFile: (path) => fs.readFile(path),
            readVersion: (path, id) => fs.readVersion(path, id),
            writeFile,
            mkdir: (path) => fs.mkdir(path),
            rm: (path) => fs.rm(path),
            rename: (from, to) => fs.rename(from, to),
            list: (path) => fs.list(path),
            versions: (path) => fs.versions(path),
            conflicts: (path, options) => fs.conflicts(path, options),
            stat: (path) => fs.stat(path),
        };
        const backend = createSharedFsMountBackend(target);
        const handle = await backend.open("/source.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("dirty!"), 0);
        await expect(
            backend.rename("/source.txt", "/destination.txt")
        ).rejects.toMatchObject({ code: "EIO" });
        expect(await fs.stat("/source.txt")).toBeUndefined();
        expect(await fs.stat("/destination.txt")).toBeDefined();
        await backend.flush(handle);
        await backend.release(handle);
        expect(writeFile).not.toHaveBeenCalled();
        expect(
            new TextDecoder().decode(await fs.readFile("/destination.txt"))
        ).toBe("source");
    });

    it("keeps an immutable borrowed commit stable after descriptor detach", async () => {
        await fs.writeFile("/file.txt", "source");
        let retained: Uint8Array | undefined;
        const target = exactTarget(fs, {
            writeFile: async (path, content, options) => {
                if (content instanceof Uint8Array) retained = content;
                return fs.writeFile(path, content, options);
            },
        });
        const backend = createSharedFsMountBackend(target, {
            writeFileInput: "immutable-borrowed",
        });
        const handle = await backend.open("/file.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, new TextEncoder().encode("first!"), 0);
        await backend.fsync(handle);
        expect(new TextDecoder().decode(retained)).toBe("first!");
        await backend.unlink("/file.txt");
        await backend.write(handle, new TextEncoder().encode("second"), 0);
        expect(new TextDecoder().decode(retained)).toBe("first!");
        await backend.fsync(handle);
        await backend.release(handle);
        expect(await fs.stat("/file.txt")).toBeUndefined();
    });

    it("wakes deferred naming work and joins an active guard during close", async () => {
        await fs.writeFile("/file.txt", "value");
        const file = (await fs.stat("/file.txt"))!;
        const program = fs.program as any;
        const original = program.headsForNode.bind(program);
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        program.headsForNode = async (...args: unknown[]) => {
            const value = await original(...args);
            if (gate) {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return value;
        };
        const mutation = fs.mutateNamespaceForMount({
            type: "remove",
            path: "/file.txt",
            expectedNodeId: file.nodeId,
            expectedKind: "file",
        });
        await entered.promise;
        const deferredNaming = program.withDeferredOrdinaryNamingAppend(
            "test deferred naming",
            async () => undefined
        );
        const closing = fs.program.close();
        await expect(deferredNaming).rejects.toMatchObject({ code: "ECLOSED" });
        allowed.resolve();
        await mutation;
        await closing;
    });

    it("drains a Guard D naming resurrection blocked by the mount fence before close", async () => {
        await fs.mkdir("/important");
        await fs.writeFile("/guard.txt", "guard");
        const important = (await fs.stat("/important"))!;
        const guard = (await fs.stat("/guard.txt"))!;
        const program = fs.program as any;
        const naming = (
            await program.entries.index
                .iterate(
                    { query: { kind: "naming" } },
                    { local: true, remote: false, resolve: true }
                )
                .all()
        ).find((row: NamingEvent) => row.nodeId === important.nodeId);
        expect(naming).toBeInstanceOf(NamingEvent);

        const originalHeads = program.headsForNode.bind(program);
        const fenceEntered = deferred();
        const fenceAllowed = deferred();
        let gate = true;
        program.headsForNode = async (nodeId: string) => {
            const value = await originalHeads(nodeId);
            if (gate && nodeId === guard.nodeId) {
                gate = false;
                fenceEntered.resolve();
                await fenceAllowed.promise;
            }
            return value;
        };
        const guardedRemove = fs.mutateNamespaceForMount({
            type: "remove",
            path: "/guard.txt",
            expectedNodeId: guard.nodeId,
            expectedKind: "file",
        });
        await fenceEntered.promise;

        await program.entries.del(naming.id);
        for (let attempt = 0; attempt < 100; attempt++) {
            if (program.pendingGuardNaming.size > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(program.pendingGuardNaming.size).toBeGreaterThan(0);
        if (program.guardFlushTimer) {
            clearTimeout(program.guardFlushTimer);
            program.guardFlushTimer = undefined;
        }
        const blockedFlush = program.startGuardFlush();
        for (let attempt = 0; attempt < 100; attempt++) {
            if (
                program.guardFlushBusy &&
                program.pendingGuardNaming.size === 0
            ) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(program.guardFlushBusy).toBe(true);
        expect(program.pendingGuardNaming.size).toBe(0);

        const closing = program.close();
        fenceAllowed.resolve();
        await guardedRemove;
        await blockedFlush;
        await closing;
        expect(program.pendingGuardNaming.size).toBe(0);

        const reopenedProgram = await (peer as any).open(program, {
            existing: "reuse",
            args: {
                machineLabel: "guard-close-reopen",
                allowPartialWrites: true,
                addressOpen: true,
                bootstrap: false,
            },
        });
        expect(reopenedProgram).toBe(program);
        expect((await fs.stat("/important"))?.nodeId).toBe(important.nodeId);
    });

    it("never aliases a stale ordinary naming epoch across close and reopen", async () => {
        const program = fs.program as any;
        const originalResolvePath = program.resolvePath.bind(program);
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        program.resolvePath = async (...args: unknown[]) => {
            const result = await originalResolvePath(...args);
            if (gate && args[0] === "/stale-after-reopen") {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return result;
        };

        const capturedEpoch = program.localNamingFenceEpoch;
        const staleCreate = fs.mkdir("/stale-after-reopen");
        await entered.promise;
        await program.close();
        const closedEpoch = program.localNamingFenceEpoch;
        expect(closedEpoch).toBeGreaterThan(capturedEpoch);

        const reopenedProgram = await (peer as any).open(program, {
            existing: "reuse",
            args: {
                machineLabel: "namespace-epoch-reopen",
                allowPartialWrites: true,
                addressOpen: true,
                bootstrap: false,
            },
        });
        expect(reopenedProgram).toBe(program);
        expect(program.localNamingFenceEpoch).toBeGreaterThan(closedEpoch);

        allowed.resolve();
        await expect(staleCreate).rejects.toMatchObject({ code: "EAGAIN" });
        expect(await fs.stat("/stale-after-reopen")).toBeUndefined();
    });

    it("drops a queued Guard D batch when close observes it disarmed", async () => {
        await fs.mkdir("/important");
        const important = (await fs.stat("/important"))!;
        const program = fs.program as any;
        const naming = (
            await program.entries.index
                .iterate(
                    { query: { kind: "naming" } },
                    { local: true, remote: false, resolve: true }
                )
                .all()
        ).find((row: NamingEvent) => row.nodeId === important.nodeId);
        expect(naming).toBeInstanceOf(NamingEvent);
        program.pendingGuardNaming.set(
            important.nodeId,
            new Map([[naming.id, naming]])
        );
        // Reproduce a bootstrap decision that disarmed after enqueue but
        // before the coalescing timer got to own the batch.
        program.guardArmed = false;

        await program.close();
        expect(program.pendingGuardNaming.size).toBe(0);
    });

    it("does not publish an old Guard D decision after disarm and re-arm", async () => {
        await fs.mkdir("/important");
        const important = (await fs.stat("/important"))!;
        const program = fs.program as any;
        const naming = (
            await program.entries.index
                .iterate(
                    { query: { kind: "naming" } },
                    { local: true, remote: false, resolve: true }
                )
                .all()
        ).find((row: NamingEvent) => row.nodeId === important.nodeId);
        expect(naming).toBeInstanceOf(NamingEvent);
        program.pendingGuardNaming.set(
            important.nodeId,
            new Map([[naming.id, naming]])
        );
        const originalQuery = program.queryDocuments.bind(program);
        const entered = deferred();
        const allowed = deferred();
        let gate = true;
        program.queryDocuments = async (...args: unknown[]) => {
            const value = await originalQuery(...args);
            if (gate) {
                gate = false;
                entered.resolve();
                await allowed.promise;
            }
            return value;
        };
        const putPreferLinked = vi.fn(program.putPreferLinked.bind(program));
        program.putPreferLinked = putPreferLinked;

        const flush = program.startGuardFlush();
        await entered.promise;
        program.setGuardArmed(false);
        program.setGuardArmed(true);
        allowed.resolve();
        await flush;
        expect(putPreferLinked).not.toHaveBeenCalled();
    });

    it("rechecks the Guard D token after the publication presence probe", async () => {
        await fs.mkdir("/important");
        const important = (await fs.stat("/important"))!;
        const program = fs.program as any;
        const naming = (
            await program.entries.index
                .iterate(
                    { query: { kind: "naming" } },
                    { local: true, remote: false, resolve: true }
                )
                .all()
        ).find((row: NamingEvent) => row.nodeId === important.nodeId);
        expect(naming).toBeInstanceOf(NamingEvent);
        program.pendingGuardNaming.set(
            important.nodeId,
            new Map([[naming.id, naming]])
        );
        const originalHasDocument = program.hasDocument.bind(program);
        const presenceEntered = deferred();
        const presenceAllowed = deferred();
        let gate = true;
        program.hasDocument = async (id: string) => {
            const present = await originalHasDocument(id);
            if (gate && id === naming.id) {
                gate = false;
                presenceEntered.resolve();
                await presenceAllowed.promise;
            }
            return present;
        };
        const entriesPut = vi.spyOn(program.entries, "put");

        const flush = program.startGuardFlush();
        await presenceEntered.promise;
        program.setGuardArmed(false);
        program.setGuardArmed(true);
        presenceAllowed.resolve();
        await flush;
        expect(entriesPut).not.toHaveBeenCalled();
    });

    it("joins a queued existing-file batch before close and reopen", async () => {
        await fs.writeFile("/batched.txt", "old");
        const program = fs.program as any;
        const priorBatch = deferred();
        program.writeBatchChain = priorBatch.promise;
        const batch = fs.writeBatch([
            { path: "/batched.txt", content: "new-batched-value" },
        ]);
        let closeSettled = false;
        const closing = program.close().then(() => {
            closeSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(closeSettled).toBe(false);

        priorBatch.resolve();
        await batch;
        await closing;
        const reopenedProgram = await (peer as any).open(program, {
            existing: "reuse",
            args: {
                machineLabel: "write-batch-close-reopen",
                allowPartialWrites: true,
                addressOpen: true,
                bootstrap: false,
            },
        });
        expect(reopenedProgram).toBe(program);
        expect(
            new TextDecoder().decode(await fs.readFile("/batched.txt"))
        ).toBe("new-batched-value");
    });
});
