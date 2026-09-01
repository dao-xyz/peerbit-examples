import { Peerbit } from "peerbit";
import { createConnection } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CONFLICTS_DIR,
    createSharedFsIpcClient,
    createSharedFsIpcServer,
    createSharedFsMountBackend,
    encodeConflictPathName,
    openSharedFs,
    parseFlags,
    sharedFsBackendErrno,
    type SharedFsHandle,
    type SharedFsMountBackendTarget,
    type WriteFileOptions,
} from "../index.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const mountTarget = (
    fs: SharedFsHandle,
    overrides: Partial<SharedFsMountBackendTarget> = {}
): SharedFsMountBackendTarget => ({
    readFile: (path) => fs.readFile(path),
    readVersion: (path, versionId) => fs.readVersion(path, versionId),
    writeFile: (path, source, options) => fs.writeFile(path, source, options),
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

    it("maps retryable mount errors to the host-specific errno", () => {
        expect(sharedFsBackendErrno("EAGAIN", "linux")).toBe(-11);
        expect(sharedFsBackendErrno("EAGAIN", "win32")).toBe(-11);
        expect(sharedFsBackendErrno("EAGAIN", "darwin")).toBe(-35);
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

    it("keeps reads available but rejects writable opens before write readiness", async () => {
        await fs.writeFile("/settling.txt", "visible read");
        await fs.mkdir("/existing-dir");
        const readVersion = vi.fn((path: string, versionId: string) =>
            fs.readVersion(path, versionId)
        );
        const target = mountTarget(fs, {
            bootstrapStatus: () => ({
                phase: "overlay-active",
                writeReady: false,
            }),
            readVersion,
        });
        const backend = createSharedFsMountBackend(target);

        const readOnly = await backend.open("/settling.txt", { read: true });
        expect(decode(await backend.read(readOnly, 1024, 0))).toBe(
            "visible read"
        );
        await backend.release(readOnly);

        await expect(
            backend.open("/settling.txt", { read: true, write: true })
        ).rejects.toMatchObject({
            code: "EAGAIN",
            message: expect.stringContaining("await write readiness"),
        });
        // The readiness fence fires before an exact-version read can seed a
        // writable buffer from a partial namespace.
        expect(readVersion).not.toHaveBeenCalled();

        // Every namespace mutation fails at the readiness boundary before a
        // partial tree can leak misleading path errors such as ENOENT/EEXIST.
        const mutations = [
            () => backend.mkdir("/existing-dir"),
            () => backend.rmdir("/missing-dir"),
            () => backend.unlink("/missing-file"),
            () => backend.rename("/missing-from", "/missing-to"),
            () => backend.truncate("/missing-file", 0),
        ];
        for (const mutate of mutations) {
            await expect(mutate()).rejects.toMatchObject({ code: "EAGAIN" });
        }

        const server = await createSharedFsIpcServer(
            backend,
            "tcp://127.0.0.1:0"
        );
        try {
            const client = createSharedFsIpcClient(server.endpoint);
            await expect(
                client.open("/settling.txt", { read: true, write: true })
            ).rejects.toMatchObject({ code: "EAGAIN" });
        } finally {
            await server.close();
        }
    });

    it("refuses a writable ancestor fallback when the visible version is unavailable", async () => {
        const ancestor = await fs.writeFile("/stale.txt", "ancestor");
        const visible = await fs.writeFile("/stale.txt", "newest");
        const readFile = vi.fn(async () => encode("ancestor"));
        const readVersion = vi.fn(async (path: string, versionId: string) => {
            if (versionId === visible.id) {
                throw new Error("missing newest chunk");
            }
            return fs.readVersion(path, versionId);
        });
        const writeFile = vi.fn(
            (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => fs.writeFile(path, source, options)
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { readFile, readVersion, writeFile })
        );

        // Read-only access retains the library's availability fallback.
        const readOnly = await backend.open("/stale.txt", { read: true });
        expect(decode(await backend.read(readOnly, 1024, 0))).toBe("ancestor");
        await backend.release(readOnly);

        // A writable buffer may not contain ancestor bytes while claiming
        // the visible version as its causal base.
        await expect(
            backend.open("/stale.txt", { read: true, write: true })
        ).rejects.toMatchObject({
            code: "EIO",
            message: "missing newest chunk",
        });
        expect(readVersion).toHaveBeenCalledWith("/stale.txt", visible.id);
        expect(readVersion).not.toHaveBeenCalledWith("/stale.txt", ancestor.id);
        expect(writeFile).not.toHaveBeenCalled();
        expect(decode(await fs.readFile("/stale.txt"))).toBe("newest");
    });

    it("fails a writable open when the path changes nodes during its exact read", async () => {
        await fs.writeFile("/race.txt", "original");
        await fs.writeFile("/replacement.txt", "replacement");
        const original = await fs.stat("/race.txt");
        const replacement = await fs.stat("/replacement.txt");
        expect(original?.kind).toBe("file");
        expect(replacement?.kind).toBe("file");

        let statCalls = 0;
        const stat = vi.fn(async () => {
            statCalls++;
            return statCalls === 1 ? original : replacement;
        });
        const writeFile = vi.fn(
            (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => fs.writeFile(path, source, options)
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                stat,
                readVersion: async () => encode("original"),
                writeFile,
            })
        );

        await expect(
            backend.open("/race.txt", { read: true, write: true })
        ).rejects.toMatchObject({
            code: "EAGAIN",
            message: "Path changed while it was being opened: /race.txt",
        });
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("rejects a commit if an existing path is replaced after writable open", async () => {
        await fs.writeFile("/race.txt", "original");
        await fs.writeFile("/replacement.txt", "replacement");
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                // This runs after the mount captured its open snapshot and
                // before SharedFileSystem.writeFile resolves the path itself.
                await fs.rm(path);
                await fs.rename("/replacement.txt", path);
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/race.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("edited"), 0);

        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(writeFile).toHaveBeenCalledOnce();
        expect(decode(await fs.readFile("/race.txt"))).toBe("replacement");
    });

    it("rejects a create commit if another writer wins the absent-path race", async () => {
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                // The handle opened an absent path and therefore carries an
                // expectedNodeId of null. Materialize a competing node before
                // the library-level compare-and-set, which must reject.
                await fs.writeFile(path, "racer");
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/new.txt", {
            write: true,
            create: true,
            truncate: true,
        });
        await backend.write(handle, encode("ours"), 0);

        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(writeFile).toHaveBeenCalledOnce();
        expect(decode(await fs.readFile("/new.txt"))).toBe("racer");
    });

    it("rejects a create commit if the absent path becomes a directory", async () => {
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                await fs.mkdir(path);
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/new-directory", {
            write: true,
            create: true,
            truncate: true,
        });
        await backend.write(handle, encode("ours"), 0);

        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect((await fs.stat("/new-directory"))?.kind).toBe("directory");
    });

    it("keeps a concurrent later write dirty after one flush pass", async () => {
        let writeStarted!: () => void;
        let allowWrite!: () => void;
        const started = new Promise<void>((resolve) => {
            writeStarted = resolve;
        });
        const allowed = new Promise<void>((resolve) => {
            allowWrite = resolve;
        });
        let writes = 0;
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                writes++;
                if (writes === 1) {
                    writeStarted();
                    await allowed;
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/during-flush.txt", {
            write: true,
            create: true,
            truncate: true,
        });
        await backend.write(handle, encode("old"), 0);

        const flushing = backend.flush(handle);
        await started;
        await backend.write(handle, encode("new"), 0);
        allowWrite();
        await flushing;

        expect(decode(await fs.readFile("/during-flush.txt"))).toBe("old");
        await backend.release(handle);
        expect(decode(await fs.readFile("/during-flush.txt"))).toBe("new");
        expect(writeFile).toHaveBeenCalledTimes(2);
    });

    it("drains concurrent buffer mutations before fsync resolves", async () => {
        let firstWriteStarted!: () => void;
        let secondWriteStarted!: () => void;
        let allowFirstWrite!: () => void;
        let allowSecondWrite!: () => void;
        const firstStarted = new Promise<void>((resolve) => {
            firstWriteStarted = resolve;
        });
        const secondStarted = new Promise<void>((resolve) => {
            secondWriteStarted = resolve;
        });
        const firstAllowed = new Promise<void>((resolve) => {
            allowFirstWrite = resolve;
        });
        const secondAllowed = new Promise<void>((resolve) => {
            allowSecondWrite = resolve;
        });
        let writes = 0;
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                writes++;
                if (writes === 1) {
                    firstWriteStarted();
                    await firstAllowed;
                } else if (writes === 2) {
                    secondWriteStarted();
                    await secondAllowed;
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/during-fsync.txt", {
            write: true,
            create: true,
            truncate: true,
        });
        await backend.write(handle, encode("aaa"), 0);

        const syncing = backend.fsync(handle);
        await firstStarted;
        await backend.write(handle, encode("bbb"), 0);
        allowFirstWrite();
        await secondStarted;
        await backend.write(handle, encode("ccc"), 0);
        allowSecondWrite();
        await syncing;

        expect(decode(await fs.readFile("/during-fsync.txt"))).toBe("ccc");
        expect(writeFile).toHaveBeenCalledTimes(3);
        await backend.release(handle);
        expect(writeFile).toHaveBeenCalledTimes(3);
    });

    it("drains accepted writes and rejects mutations after release begins", async () => {
        let writeStarted!: () => void;
        let allowWrite!: () => void;
        const started = new Promise<void>((resolve) => {
            writeStarted = resolve;
        });
        const allowed = new Promise<void>((resolve) => {
            allowWrite = resolve;
        });
        let writes = 0;
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                writes++;
                if (writes === 1) {
                    writeStarted();
                    await allowed;
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/during-release.txt", {
            write: true,
            create: true,
            truncate: true,
        });
        await backend.write(handle, encode("accepted"), 0);

        const flushing = backend.flush(handle);
        await started;
        await backend.write(handle, encode("new value"), 0);
        const releasing = backend.release(handle);
        await expect(
            backend.write(handle, encode("too late"), 0)
        ).rejects.toMatchObject({ code: "EBADF" });
        await expect(backend.truncate(handle, 1)).rejects.toMatchObject({
            code: "EBADF",
        });
        allowWrite();
        await Promise.all([flushing, releasing]);

        expect(decode(await fs.readFile("/during-release.txt"))).toBe(
            "new value"
        );
        expect(writeFile).toHaveBeenCalledTimes(2);
    });

    it("shares one in-flight fence across concurrent release calls", async () => {
        let writeStarted!: () => void;
        let allowWrite!: () => void;
        const started = new Promise<void>((resolve) => {
            writeStarted = resolve;
        });
        const allowed = new Promise<void>((resolve) => {
            allowWrite = resolve;
        });
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                writeStarted();
                await allowed;
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/concurrent-release.txt", {
            write: true,
            create: true,
            truncate: true,
        });
        await backend.write(handle, encode("once"), 0);

        const firstRelease = backend.release(handle);
        await started;
        let secondSettled = false;
        const secondRelease = backend.release(handle).then(() => {
            secondSettled = true;
        });
        await Promise.resolve();
        expect(secondSettled).toBe(false);

        allowWrite();
        await Promise.all([firstRelease, secondRelease]);
        expect(decode(await fs.readFile("/concurrent-release.txt"))).toBe(
            "once"
        );
        expect(writeFile).toHaveBeenCalledOnce();
    });

    it("retains a dirty closing handle when release commit fails", async () => {
        let attempts = 0;
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                attempts++;
                if (attempts === 1) {
                    throw new Error("injected commit failure");
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/release-retry.txt", {
            write: true,
            create: true,
            truncate: true,
        });
        await backend.write(handle, encode("retry me"), 0);

        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EIO",
            message: "injected commit failure",
        });
        await expect(
            backend.write(handle, encode("too late"), 0)
        ).rejects.toMatchObject({ code: "EBADF" });

        await backend.release(handle);
        expect(decode(await fs.readFile("/release-retry.txt"))).toBe(
            "retry me"
        );
        expect(writeFile).toHaveBeenCalledTimes(2);
    });

    it("reloads committed metadata when a compatible target returns void", async () => {
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                await fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/void-target.txt", {
            write: true,
            create: true,
            truncate: true,
        });
        await backend.write(handle, encode("first"), 0);
        await backend.flush(handle);

        await backend.truncate(handle, 0);
        await backend.write(handle, encode("second"), 0);
        await backend.release(handle);

        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(decode(await fs.readFile("/void-target.txt"))).toBe("second");
        expect(
            (await fs.versions("/void-target.txt")).filter(
                (version) => version.head
            )
        ).toHaveLength(1);
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

    it("edits only the exact visible conflict version without resolving other heads", async () => {
        const backend = createSharedFsMountBackend(fs);
        await fs.writeFile("/contested.txt", "base");
        const base = (await fs.versions("/contested.txt"))
            .filter((version) => version.head)
            .map((version) => version.id);
        const left = await fs.writeFile("/contested.txt", "left", {
            baseVersionIds: base,
        });
        const right = await fs.writeFile("/contested.txt", "right", {
            baseVersionIds: base,
        });
        const visibleId = (await fs.stat("/contested.txt"))!.versionId!;
        const preservedId = [left.id, right.id].find((id) => id !== visibleId)!;

        const handle = await backend.open("/contested.txt", {
            read: true,
            write: true,
        });
        await backend.truncate(handle, 0);
        await backend.write(handle, encode("mounted edit"), 0);
        await backend.release(handle);

        const heads = (await fs.versions("/contested.txt")).filter(
            (version) => version.head
        );
        expect(heads).toHaveLength(2);
        expect(heads.map((version) => version.id)).toContain(preservedId);
        const edited = heads.find((version) => version.id !== preservedId)!;
        expect(edited.parentVersionIds).toEqual([visibleId]);
        expect(decode(await fs.readVersion("/contested.txt", edited.id))).toBe(
            "mounted edit"
        );
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
            const sharedBacking = new SharedArrayBuffer(12);
            const framed = new Uint8Array(sharedBacking, 2, 8);
            framed.set(encode("over ipc"));
            await client.write(handle, framed, 0);
            await client.release(handle);

            const stat = await client.getattr("/ipc/file.txt");
            expect(stat.kind).toBe("file");
            expect(stat.size).toBe("over ipc".length);
            expect(decode(await fs.readFile("/ipc/file.txt"))).toBe("over ipc");

            // Decoded Buffers may use a pooled backing allocation. Re-encoding
            // a subarray must honor its view bounds and never leak slab bytes.
            const readHandle = await client.open("/ipc/file.txt", {
                read: true,
            });
            const decodedBytes = await client.read(readHandle, 1024, 0);
            await client.release(readHandle);
            const copyHandle = await client.open("/ipc/copy.txt", {
                write: true,
                create: true,
                truncate: true,
            });
            await client.write(copyHandle, decodedBytes.subarray(2, 6), 0);
            await client.release(copyHandle);
            expect(decode(await fs.readFile("/ipc/copy.txt"))).toBe("er i");
        } finally {
            await server.close();
        }
    });

    it("returns read snapshots isolated from callers and later mutations", async () => {
        await fs.writeFile("/owned.txt", "hello");
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                // Exercise Buffer-backed handles: Buffer.slice/subarray would
                // preserve the alias even though Buffer is a Uint8Array.
                readVersion: async () => Buffer.from("hello"),
            })
        );
        const handle = await backend.open("/owned.txt", {
            read: true,
            write: true,
        });

        const callerOwned = await backend.read(handle, 3, 1);
        expect(decode(callerOwned)).toBe("ell");
        callerOwned[0] = "X".charCodeAt(0);
        expect(decode(await backend.read(handle, 1024, 0))).toBe("hello");

        const beforeWrite = await backend.read(handle, 1024, 0);
        await backend.write(handle, encode("Y"), 0);
        expect(decode(beforeWrite)).toBe("hello");
        expect(decode(await backend.read(handle, 1024, 0))).toBe("Yello");

        const beforeTruncate = await backend.read(handle, 1024, 0);
        await backend.truncate(handle, 2);
        expect(decode(beforeTruncate)).toBe("Yello");
        expect(decode(await backend.read(handle, 1024, 0))).toBe("Ye");

        await backend.release(handle);
        expect(decode(await fs.readFile("/owned.txt"))).toBe("Ye");
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

    it("does not discard a dirty rewrite when the same node gains a new head", async () => {
        const original = await fs.writeFile("/same-node-race.txt", "original");
        const writeFile = vi.fn(
            (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => fs.writeFile(path, source, options)
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/same-node-race.txt", {
            read: true,
            write: true,
        });

        const concurrent = await fs.writeFile(
            "/same-node-race.txt",
            "concurrent"
        );
        expect(concurrent.nodeId).toBe(original.nodeId);
        // Restore the exact opened bytes on a dirty handle. Content equality
        // alone is not a no-op because the opened head snapshot has advanced.
        await backend.write(handle, encode("original"), 0);
        await backend.release(handle);

        expect(writeFile).toHaveBeenCalledOnce();
        const heads = (await fs.versions("/same-node-race.txt")).filter(
            (version) => version.head
        );
        expect(heads).toHaveLength(2);
        expect(heads.map((version) => version.id)).toContain(concurrent.id);
        const mounted = heads.find((version) => version.id !== concurrent.id)!;
        expect(mounted.parentVersionIds).toEqual([original.id]);
        expect(
            decode(await fs.readVersion("/same-node-race.txt", mounted.id))
        ).toBe("original");
    });

    it("keeps a concurrent buffer mutation dirty while checking a no-op save", async () => {
        await fs.writeFile("/no-op-buffer-race.txt", "base");
        let statStarted!: () => void;
        let allowStat!: () => void;
        const started = new Promise<void>((resolve) => {
            statStarted = resolve;
        });
        const allowed = new Promise<void>((resolve) => {
            allowStat = resolve;
        });
        let deferNextStat = false;
        const stat = vi.fn(async (path: string) => {
            if (deferNextStat) {
                deferNextStat = false;
                statStarted();
                await allowed;
            }
            return fs.stat(path);
        });
        const backend = createSharedFsMountBackend(mountTarget(fs, { stat }));
        const handle = await backend.open("/no-op-buffer-race.txt", {
            read: true,
            write: true,
        });

        // The first buffer snapshot equals the opened version and takes the
        // asynchronous no-op path. Mutate the handle while that stat is in
        // flight; the later bytes must remain dirty for release to commit.
        await backend.write(handle, encode("base"), 0);
        deferNextStat = true;
        const flushing = backend.flush(handle);
        await started;
        await backend.write(handle, encode("next"), 0);
        allowStat();
        await flushing;
        await backend.release(handle);

        expect(decode(await fs.readFile("/no-op-buffer-race.txt"))).toBe(
            "next"
        );
        expect(await fs.versions("/no-op-buffer-race.txt")).toHaveLength(2);
    });

    it("keeps a concurrent buffer mutation dirty when heads advance during the no-op check", async () => {
        const original = await fs.writeFile(
            "/advanced-head-buffer-race.txt",
            "base"
        );
        let statStarted!: () => void;
        let allowStat!: () => void;
        const started = new Promise<void>((resolve) => {
            statStarted = resolve;
        });
        const allowed = new Promise<void>((resolve) => {
            allowStat = resolve;
        });
        let deferNextStat = false;
        const stat = vi.fn(async (path: string) => {
            if (deferNextStat) {
                deferNextStat = false;
                statStarted();
                await allowed;
            }
            return fs.stat(path);
        });
        const backend = createSharedFsMountBackend(mountTarget(fs, { stat }));
        const handle = await backend.open("/advanced-head-buffer-race.txt", {
            read: true,
            write: true,
        });

        await backend.write(handle, encode("base"), 0);
        deferNextStat = true;
        const flushing = backend.flush(handle);
        await started;
        const concurrent = await fs.writeFile(
            "/advanced-head-buffer-race.txt",
            "peer",
            { baseVersionIds: [original.id] }
        );
        await backend.write(handle, encode("next"), 0);
        allowStat();
        await flushing;
        await backend.release(handle);

        const heads = (
            await fs.versions("/advanced-head-buffer-race.txt")
        ).filter((version) => version.head);
        expect(heads.map((version) => version.id)).toContain(concurrent.id);
        const mounted = await Promise.all(
            heads.map(async (version) => ({
                version,
                contents: decode(
                    await fs.readVersion(
                        "/advanced-head-buffer-race.txt",
                        version.id
                    )
                ),
            }))
        );
        expect(mounted.some(({ contents }) => contents === "next")).toBe(true);
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

    it("closes retained IPC sessions during server shutdown", async () => {
        const backend = createSharedFsMountBackend(fs);
        const server = await createSharedFsIpcServer(
            backend,
            "tcp://127.0.0.1:0"
        );
        const endpoint = new URL(server.endpoint);
        const socket = createConnection({
            host: endpoint.hostname,
            port: Number(endpoint.port),
        });
        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error) => {
                    socket.off("connect", onConnect);
                    reject(error);
                };
                const onConnect = () => {
                    socket.off("error", onError);
                    resolve();
                };
                socket.once("error", onError);
                socket.once("connect", onConnect);
            });
            const response = new Promise<void>((resolve, reject) => {
                socket.once("data", () => resolve());
                socket.once("error", reject);
            });
            socket.write(
                `${JSON.stringify({ id: 1, op: "getattr", args: ["/"] })}\n`
            );
            await response;

            const disconnected = new Promise<void>((resolve) => {
                socket.once("close", () => resolve());
            });
            await server.close();
            await disconnected;
            await expect(server.close()).resolves.toBeUndefined();
        } finally {
            socket.destroy();
            await server.close();
        }
    });
});
