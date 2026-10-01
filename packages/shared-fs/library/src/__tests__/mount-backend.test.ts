import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CONFLICTS_DIR,
    createSharedFsIpcServer,
    createSharedFsMountBackend,
    encodeConflictPathName,
    openSharedFs,
    parseFlags,
    SharedFsError,
    SharedFsExpectedNodeMismatchError,
    SharedFsHandle,
    type SharedFsEntryInfo,
    type SharedFsMountBackendTarget,
    type SharedFsMountNamespaceMutation,
    type SharedFsMountProfileEvent,
    type WriteFileOptions,
} from "../index.js";
import {
    encodeIpcV2Frame,
    IpcV2FrameKind,
    writeIpcV2Frame,
} from "../ipc-v2.js";
import {
    connectIpcEndpoint,
    createIpcV2TestClient,
    negotiateIpcV2,
    readIpcV2Response,
} from "./ipc-v2-test-client.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const chunkIdsOf = async (fs: SharedFsHandle, versionId: string) =>
    (
        (await fs.program.entries.index.get(versionId, {
            local: true,
            remote: false,
        })) as unknown as { chunkIds: string[] }
    ).chunkIds;

const mountTarget = (
    fs: SharedFsHandle,
    overrides: Partial<SharedFsMountBackendTarget> = {}
): SharedFsMountBackendTarget => ({
    readVersionForMount: (path, versionId) =>
        fs.readVersionForMount(path, versionId),
    writeFile: (path, source, options) => fs.writeFile(path, source, options),
    setMetadata: (path, patch, options) => fs.setMetadata(path, patch, options),
    mkdir: (path) => fs.mkdir(path),
    mutateNamespaceForMount: (mutation) => fs.mutateNamespaceForMount(mutation),
    list: (path) => fs.list(path),
    versions: (path) => fs.versions(path),
    conflicts: (path, options) => fs.conflicts(path, options),
    stat: (path) => fs.stat(path),
    bootstrapStatus: () => fs.bootstrapStatus(),
    onNamespaceChange: (listener) => fs.onNamespaceChange(listener),
    ...overrides,
});

/** A verified reader that hands out `bytes` as the snapshot allocation. */
const readVersionAs =
    (fs: SharedFsHandle, bytes: Uint8Array) =>
    async (path: string, versionId: string) => {
        const snapshot = await fs.readVersionForMount(path, versionId);
        return snapshot && { ...snapshot, bytes };
    };

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
};

const gatedBorrowingBackend = (
    fs: SharedFsHandle,
    openedBytes: Uint8Array,
    options: { failCalls?: number } = {}
) => {
    const firstStarted = deferred();
    const firstAllowed = deferred();
    const inputs: Uint8Array[] = [];
    let calls = 0;
    const writeFile = vi.fn(
        async (
            path: string,
            source: Uint8Array | string | AsyncIterable<Uint8Array>,
            writeOptions?: WriteFileOptions
        ) => {
            if (!(source instanceof Uint8Array)) {
                throw new Error("mount commits must use Uint8Array input");
            }
            calls++;
            inputs.push(source);
            if (calls === 1) {
                firstStarted.resolve();
                await firstAllowed.promise;
            }
            if (calls <= (options.failCalls ?? 0)) {
                throw new Error("injected commit failure");
            }
            return fs.writeFile(path, source, writeOptions);
        }
    );
    const backend = createSharedFsMountBackend(
        mountTarget(fs, {
            readVersionForMount: readVersionAs(fs, openedBytes),
            writeFile,
        })
    );
    return { backend, firstStarted, firstAllowed, inputs, writeFile };
};

const gatedProfiledBackend = (
    fs: SharedFsHandle,
    options: { failCalls?: number } = {}
) => {
    const firstStarted = deferred();
    const firstAllowed = deferred();
    const events: SharedFsMountProfileEvent[] = [];
    let calls = 0;
    const writeFile = vi.fn(
        async (
            path: string,
            source: Uint8Array | string | AsyncIterable<Uint8Array>,
            writeOptions?: WriteFileOptions
        ) => {
            calls++;
            if (calls === 1) {
                firstStarted.resolve();
                await firstAllowed.promise;
            }
            if (calls <= (options.failCalls ?? 0)) {
                throw new Error("injected commit failure");
            }
            return fs.writeFile(path, source, writeOptions);
        }
    );
    const backend = createSharedFsMountBackend(mountTarget(fs, { writeFile }), {
        profile: (event) => events.push(event),
    });
    return { backend, firstStarted, firstAllowed, writeFile, events };
};

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

    it("profiles each commit fence once with its trigger and nested target write", async () => {
        const events: SharedFsMountProfileEvent[] = [];
        // The library's own writeFile sub-phases (see write-file-profile
        // tests) are kept apart so this test pins the mount-level stream.
        const subPhases: SharedFsMountProfileEvent[] = [];
        const backend = createSharedFsMountBackend(fs, {
            profile: (event) =>
                (event.phase.startsWith("writeFile.")
                    ? subPhases
                    : events
                ).push(event),
        });
        const handle = await backend.open("/profiled.txt", {
            write: true,
            create: true,
        });
        await backend.write(handle, encode("hello"), 0);
        await backend.flush(handle);

        expect(events.map((event) => event.phase)).toEqual([
            "mount.target.writeFile",
            "mount.localCommit",
        ]);
        const [writeFile, flush] = events;
        expect(writeFile).toMatchObject({
            source: "node-daemon",
            operation: "writeFile",
            ok: true,
            detail: { bytes: 5, mutationGeneration: 2, writeId: 1 },
        });
        expect(subPhases.length).toBeGreaterThan(0);
        expect(subPhases.every((event) => event.detail?.writeId === 1)).toBe(
            true
        );
        expect(flush).toMatchObject({
            operation: "flush",
            ok: true,
            detail: {
                trigger: "flush",
                requiredCommit: true,
                cutoffGeneration: 2,
                persistedGenerationBefore: 0,
                commitsStarted: 1,
                commitsJoined: 0,
                writeFileNs: writeFile.durationNs,
            },
        });
        // The nested write lies inside its fence on the same monotonic clock,
        // so a consumer can subtract writeFileNs instead of adding both.
        expect(BigInt(writeFile.startUnixNs) >= BigInt(flush.startUnixNs)).toBe(
            true
        );
        expect(flush.durationNs).toBeGreaterThanOrEqual(writeFile.durationNs);

        events.length = 0;
        await backend.fsync(handle);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            phase: "mount.localCommit",
            operation: "fsync",
            detail: {
                trigger: "fsync",
                requiredCommit: false,
                commitsStarted: 0,
                writeFileNs: 0,
            },
        });

        events.length = 0;
        await backend.release(handle);
        expect(events.map((event) => [event.phase, event.operation])).toEqual([
            ["mount.localCommit", "release"],
        ]);

        events.length = 0;
        subPhases.length = 0;
        await backend.truncate("/profiled.txt", 2);
        expect(events.map((event) => [event.phase, event.operation])).toEqual([
            ["mount.target.writeFile", "writeFile"],
            ["mount.localCommit", "truncate"],
        ]);
        expect(events[0].detail).toMatchObject({ writeId: 2 });
        expect(subPhases.length).toBeGreaterThan(0);
        expect(subPhases.every((event) => event.detail?.writeId === 2)).toBe(
            true
        );
        expect(events[1].detail).toMatchObject({
            trigger: "truncate",
            requiredCommit: true,
            commitsStarted: 1,
        });
        expect(decode(await fs.readFile("/profiled.txt"))).toBe("he");
    });

    it("reports a fence that joins an in-flight commit without its write time", async () => {
        const { backend, firstStarted, firstAllowed, writeFile, events } =
            gatedProfiledBackend(fs);
        const handle = await backend.open("/joined.txt", {
            write: true,
            create: true,
        });
        await backend.write(handle, encode("joined"), 0);
        const flushing = backend.flush(handle);
        await firstStarted.promise;
        const syncing = backend.fsync(handle);
        firstAllowed.resolve();
        await Promise.all([flushing, syncing]);

        const fences = events.filter(
            (event) => event.phase === "mount.localCommit"
        );
        expect(fences.map((event) => event.operation).sort()).toEqual([
            "flush",
            "fsync",
        ]);
        const fsync = fences.find((event) => event.operation === "fsync")!;
        expect(fsync.detail).toMatchObject({
            requiredCommit: true,
            commitsStarted: 0,
            commitsJoined: 1,
            writeFileNs: 0,
        });
        expect(writeFile).toHaveBeenCalledOnce();
        await backend.release(handle);
    });

    it("keeps one shared fence and one record for overlapping profiled releases", async () => {
        const { backend, firstStarted, firstAllowed, writeFile, events } =
            gatedProfiledBackend(fs);
        const handle = await backend.open("/profiled-release.txt", {
            write: true,
            create: true,
            truncate: true,
        });
        await backend.write(handle, encode("once"), 0);

        const firstRelease = backend.release(handle);
        await firstStarted.promise;
        let secondSettled = false;
        const secondRelease = backend.release(handle).then(() => {
            secondSettled = true;
        });
        await Promise.resolve();
        expect(secondSettled).toBe(false);

        firstAllowed.resolve();
        await Promise.all([firstRelease, secondRelease]);
        expect(decode(await fs.readFile("/profiled-release.txt"))).toBe("once");
        expect(writeFile).toHaveBeenCalledOnce();
        expect(
            events.filter((event) => event.phase === "mount.localCommit")
        ).toMatchObject([
            {
                operation: "release",
                ok: true,
                detail: { trigger: "release", commitsStarted: 1 },
            },
        ]);
        // The descriptor is gone after the shared fence completed.
        await expect(backend.fsync(handle)).rejects.toMatchObject({
            code: "EBADF",
        });
    });

    it("retains a failed profiled release for retry and records both attempts", async () => {
        const { backend, firstAllowed, writeFile, events } =
            gatedProfiledBackend(fs, { failCalls: 1 });
        firstAllowed.resolve();
        const handle = await backend.open("/profiled-retry.txt", {
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
        expect(decode(await fs.readFile("/profiled-retry.txt"))).toBe(
            "retry me"
        );
        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(
            events
                .filter((event) => event.phase !== "profile.start")
                .map((event) => [
                    event.phase,
                    event.ok,
                    event.detail?.code ?? null,
                ])
        ).toEqual([
            ["mount.target.writeFile", false, "EIO"],
            ["mount.localCommit", false, "EIO"],
            ["mount.target.writeFile", true, null],
            ["mount.localCommit", true, null],
        ]);
    });

    it("keeps default directory entries compact without per-entry lookups", async () => {
        await fs.mkdir("/docs");
        await fs.writeFile("/note.txt", "hello");
        const list = vi.fn((path?: string) => fs.list(path));
        const stat = vi.fn((path: string) => fs.stat(path));
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { list, stat })
        );

        const entries = await backend.readdir("/");

        expect(entries).toEqual([
            { name: "docs", kind: "directory" },
            { name: "note.txt", kind: "file" },
            { name: CONFLICTS_DIR, kind: "directory" },
        ]);
        expect(entries.every((entry) => !("stat" in entry))).toBe(true);
        expect(list).toHaveBeenCalledOnce();
        expect(list).toHaveBeenCalledWith("/");
        expect(stat).not.toHaveBeenCalled();
    });

    it("keeps wide default listings on the compact wire shape", async () => {
        const wideEntries: SharedFsEntryInfo[] = Array.from(
            { length: 10_000 },
            (_, index) => {
                const name = `file-${index.toString().padStart(5, "0")}.txt`;
                return {
                    path: `/${name}`,
                    nodeId: `node-${index}`,
                    name,
                    kind: "file",
                    size: 1n,
                    updatedAt: 1_725_000_000_000n,
                    authorKey: "author",
                    machineLabel: "machine",
                    conflict: false,
                };
            }
        );
        const list = vi.fn(async () => wideEntries);
        const stat = vi.fn((path: string) => fs.stat(path));
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { list, stat })
        );

        const entries = await backend.readdir("/");
        const encodedBytes = Buffer.byteLength(JSON.stringify(entries));

        expect(entries).toHaveLength(10_001);
        expect(entries.every((entry) => !("stat" in entry))).toBe(true);
        expect(encodedBytes).toBeLessThan(600_000);
        expect(list).toHaveBeenCalledOnce();
        expect(stat).not.toHaveBeenCalled();
    });

    it("keeps rich unescaped maximum-name listings within the 64 MiB IPC bound", async () => {
        const wideEntries: SharedFsEntryInfo[] = Array.from(
            { length: 10_000 },
            (_, index) => {
                const suffix = index.toString().padStart(5, "0");
                const name = `${"x".repeat(250)}${suffix}`;
                return {
                    path: `/${name}`,
                    nodeId: `node-${index}`,
                    name,
                    kind: "file",
                    size: 1n,
                    updatedAt: 1_725_000_000_000n,
                    authorKey: "author",
                    machineLabel: "machine",
                    conflict: false,
                };
            }
        );
        const list = vi.fn(async () => wideEntries);
        const stat = vi.fn((path: string) => fs.stat(path));
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { list, stat })
        );

        const entries = await backend.readdir("/", { includeStats: true });
        const encodedBytes = Buffer.byteLength(JSON.stringify(entries));

        expect(entries).toHaveLength(10_001);
        expect(
            entries.every(
                (entry) =>
                    entry.stat !== undefined &&
                    !("path" in entry.stat) &&
                    !("kind" in entry.stat)
            )
        ).toBe(true);
        // Multiplying this representative 10k response slightly overestimates
        // 100k because it repeats the fixed conflicts entry ten times.
        expect(encodedBytes * 10).toBeLessThan(64 * 1024 * 1024);
        expect(list).toHaveBeenCalledOnce();
        expect(stat).not.toHaveBeenCalled();
    });

    it("returns requested directory-entry stats without per-entry lookups", async () => {
        await fs.mkdir("/docs");
        await fs.writeFile("/note.txt", "hello");
        await fs.writeFile("/tool.sh", "#!", { mode: 0o100755 });
        await fs.writeFile("/link", "note.txt", { mode: 0o120000 });
        const sourceEntries = new Map(
            (await fs.list("/")).map((entry) => [entry.name, entry])
        );
        const list = vi.fn((path?: string) => fs.list(path));
        const stat = vi.fn((path: string) => fs.stat(path));
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { list, stat })
        );

        const entries = await backend.readdir("/", { includeStats: true });

        expect(list).toHaveBeenCalledOnce();
        expect(list).toHaveBeenCalledWith("/");
        expect(stat).not.toHaveBeenCalled();

        // A directory reports its change stamp, equal to a later getattr.
        const docs = entries.find((entry) => entry.name === "docs");
        const docsStat = await backend.getattr("/docs");
        expect(docs).toEqual({
            name: "docs",
            kind: "directory",
            stat: {
                size: 0,
                mode: 0o040755,
                mtimeMs: docsStat.mtimeMs,
                ctimeMs: docsStat.mtimeMs,
                nlink: 2,
            },
        });
        const note = entries.find((entry) => entry.name === "note.txt");
        expect(note).toEqual({
            name: "note.txt",
            kind: "file",
            stat: {
                size: 5,
                mode: 0o100644,
                mtimeMs: Number(sourceEntries.get("note.txt")!.updatedAt),
                ctimeMs: Number(sourceEntries.get("note.txt")!.updatedAt),
                nlink: 1,
            },
        });
        expect(entries.find((entry) => entry.name === "tool.sh")).toMatchObject(
            { kind: "file", stat: { size: 2, mode: 0o100755 } }
        );
        // A symlink lists as DT_LNK with its target's byte length.
        expect(entries.find((entry) => entry.name === "link")).toMatchObject({
            kind: "symlink",
            stat: { size: "note.txt".length, mode: 0o120777, nlink: 1 },
        });
        const conflictsStat = await backend.getattr(`/${CONFLICTS_DIR}`);
        expect(entries.find((entry) => entry.name === CONFLICTS_DIR)).toEqual({
            name: CONFLICTS_DIR,
            kind: "directory",
            stat: {
                size: 0,
                mode: 0o040755,
                mtimeMs: conflictsStat.mtimeMs,
                ctimeMs: conflictsStat.mtimeMs,
                nlink: 2,
            },
        });
    });

    it("reports the dirty open-handle size in directory-entry stats", async () => {
        const list = vi.fn((path?: string) => fs.list(path));
        const stat = vi.fn((path: string) => fs.stat(path));
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { list, stat })
        );
        const handle = await backend.open(
            "/pending.txt",
            { write: true, create: true, truncate: true },
            0o755
        );
        const before = Date.now();
        await backend.write(handle, encode("not committed"), 0);
        const after = Date.now();
        list.mockClear();
        stat.mockClear();

        const pending = (
            await backend.readdir("/", { includeStats: true })
        ).find((entry) => entry.name === "pending.txt");

        expect(list).toHaveBeenCalledOnce();
        expect(stat).not.toHaveBeenCalled();
        expect(pending).toMatchObject({
            name: "pending.txt",
            kind: "file",
            stat: {
                size: "not committed".length,
                mode: 0o100755,
                nlink: 1,
            },
        });
        // The time of the last write, as getattr reports it.
        expect(pending!.stat!.mtimeMs).toBeGreaterThanOrEqual(before);
        expect(pending!.stat!.mtimeMs).toBeLessThanOrEqual(after);
        expect(pending!.stat!.ctimeMs).toBe(pending!.stat!.mtimeMs);
        expect(await backend.getattr("/pending.txt")).toMatchObject(
            pending!.stat!
        );
        expect(await fs.readFile("/pending.txt")).toBeUndefined();

        await backend.release(handle);
    });

    it("requires O_CREAT for missing writable opens and enforces handle access", async () => {
        const backend = createSharedFsMountBackend(fs);

        await expect(
            backend.open("/missing.txt", { write: true })
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
            backend.open("/missing-truncate.txt", {
                write: true,
                truncate: true,
            })
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.stat("/missing.txt")).toBeUndefined();
        expect(await fs.stat("/missing-truncate.txt")).toBeUndefined();

        await fs.writeFile("/modes.txt", "seed");
        const writeOnly = await backend.open("/modes.txt", { write: true });
        // Access is checked before zero-length / EOF read shortcuts.
        await expect(
            backend.read(writeOnly, 0, Number.MAX_SAFE_INTEGER)
        ).rejects.toMatchObject({ code: "EBADF" });
        await backend.write(writeOnly, encode("X"), 1);
        await backend.release(writeOnly);
        expect(decode(await fs.readFile("/modes.txt"))).toBe("sXed");

        const readOnly = await backend.open("/modes.txt", { read: true });
        await expect(
            backend.write(readOnly, encode("no"), 0)
        ).rejects.toMatchObject({ code: "EBADF" });
        await expect(backend.truncate(readOnly, 0)).rejects.toMatchObject({
            code: "EBADF",
        });
        await backend.release(readOnly);
    });

    it("validates an absent create's parent while its intent is held", async () => {
        const backend = createSharedFsMountBackend(fs);

        await expect(
            backend.open("/missing-parent/child.txt", {
                write: true,
                create: true,
                exclusive: true,
            })
        ).rejects.toMatchObject({ code: "ENOENT" });

        // The failed open must release its exact child intent so repairing the
        // namespace is not blocked by an uncreatable reservation.
        await backend.mkdir("/missing-parent");
        const repaired = await backend.open("/missing-parent/child.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.release(repaired);

        await fs.writeFile("/file-parent", "not a directory");
        await expect(
            backend.open("/file-parent/child.txt", {
                write: true,
                create: true,
                exclusive: true,
            })
        ).rejects.toMatchObject({ code: "ENOTDIR" });
    });

    it("materializes read-only O_CREAT handles but rejects read-only O_TRUNC", async () => {
        const backend = createSharedFsMountBackend(fs);
        const created = await backend.open("/read-created.txt", {
            read: true,
            create: true,
        });

        expect(decode(await backend.read(created, 1024, 0))).toBe("");
        expect((await backend.getattr("/read-created.txt")).size).toBe(0);
        expect(
            (await backend.readdir("/")).map((entry) => entry.name)
        ).toContain("read-created.txt");
        expect(await fs.stat("/read-created.txt")).toBeUndefined();
        await backend.release(created);
        expect(decode(await fs.readFile("/read-created.txt"))).toBe("");

        await fs.writeFile("/read-existing.txt", "preserved");
        const versionsBefore = await fs.versions("/read-existing.txt");
        const existing = await backend.open("/read-existing.txt", {
            read: true,
            create: true,
        });
        expect(decode(await backend.read(existing, 1024, 0))).toBe("preserved");
        await backend.release(existing);
        expect(await fs.versions("/read-existing.txt")).toHaveLength(
            versionsBefore.length
        );

        await expect(
            backend.open("/read-existing.txt", {
                read: true,
                truncate: true,
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            backend.open("/read-existing.txt", {
                read: true,
                exclusive: true,
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            backend.open("/read-existing.txt", 0o3)
        ).rejects.toMatchObject({ code: "EINVAL" });
        expect(decode(await fs.readFile("/read-existing.txt"))).toBe(
            "preserved"
        );
    });

    it("applies create and truncate combinations without implicit creation", async () => {
        const backend = createSharedFsMountBackend(fs);
        await fs.writeFile("/create-matrix.txt", "preserved");

        const preserve = await backend.open("/create-matrix.txt", {
            write: true,
            create: true,
        });
        await backend.release(preserve);
        expect(decode(await fs.readFile("/create-matrix.txt"))).toBe(
            "preserved"
        );

        const truncateExisting = await backend.open("/create-matrix.txt", {
            write: true,
            create: true,
            truncate: true,
        });
        await backend.release(truncateExisting);
        expect(decode(await fs.readFile("/create-matrix.txt"))).toBe("");

        const createMissing = await backend.open("/created-empty.txt", {
            write: true,
            create: true,
        });
        await backend.release(createMissing);
        expect(decode(await fs.readFile("/created-empty.txt"))).toBe("");
    });

    it("uses the current handle length for every O_APPEND write", async () => {
        await fs.writeFile("/append.txt", "base");
        const backend = createSharedFsMountBackend(fs);
        const handle = await backend.open("/append.txt", {
            read: true,
            write: true,
            append: true,
        });

        await Promise.all([
            backend.write(handle, encode("A"), 0),
            // O_APPEND ignores even an otherwise-invalid caller offset.
            backend.write(handle, encode("B"), -100),
        ]);
        expect(decode(await backend.read(handle, 1024, 0))).toBe("baseAB");
        await backend.release(handle);
        expect(decode(await fs.readFile("/append.txt"))).toBe("baseAB");

        const truncated = await backend.open("/append.txt", {
            write: true,
            append: true,
            truncate: true,
        });
        await backend.write(truncated, encode("A"), 9999);
        await backend.write(truncated, encode("B"), 0);
        await backend.release(truncated);
        expect(decode(await fs.readFile("/append.txt"))).toBe("AB");

        await expect(
            backend.open("/missing-append.txt", {
                write: true,
                append: true,
            })
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("allocates append offsets atomically across sibling descriptors and coalesces their commit", async () => {
        await fs.writeFile("/sibling-append.txt", "base");
        const versionsBefore = await fs.versions("/sibling-append.txt");
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
        const first = await backend.open("/sibling-append.txt", {
            read: true,
            write: true,
            append: true,
        });
        const second = await backend.open("/sibling-append.txt", {
            read: true,
            write: true,
            append: true,
        });

        await Promise.all([
            backend.write(first, encode("A"), 0),
            backend.write(second, encode("B"), -100),
        ]);
        expect(decode(await backend.read(first, 1024, 0))).toBe("baseAB");
        expect(decode(await backend.read(second, 1024, 0))).toBe("baseAB");

        await Promise.all([backend.release(first), backend.release(second)]);
        expect(writeFile).toHaveBeenCalledOnce();
        expect(decode(await fs.readFile("/sibling-append.txt"))).toBe("baseAB");
        expect(await fs.versions("/sibling-append.txt")).toHaveLength(
            versionsBefore.length + 1
        );
        expect(await fs.conflicts("/sibling-append.txt")).toHaveLength(0);
    });

    it("shares O_TRUNC and later writes immediately with sibling readers", async () => {
        await fs.writeFile("/sibling-truncate.txt", "long value");
        const readVersionForMount = vi.fn((path: string, versionId: string) =>
            fs.readVersionForMount(path, versionId)
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { readVersionForMount })
        );
        const reader = await backend.open("/sibling-truncate.txt", {
            read: true,
        });
        const truncating = await backend.open("/sibling-truncate.txt", {
            read: true,
            write: true,
            truncate: true,
        });

        expect(decode(await backend.read(reader, 1024, 0))).toBe("");
        // Only the reader loaded bytes; the truncating sibling reuses its state.
        expect(readVersionForMount).toHaveBeenCalledOnce();
        await backend.write(truncating, encode("new"), 0);
        expect(decode(await backend.read(reader, 1024, 0))).toBe("new");

        await backend.release(truncating);
        await backend.release(reader);
        expect(decode(await fs.readFile("/sibling-truncate.txt"))).toBe("new");
    });

    it("does not extend or dirty a file for a zero-byte sparse write", async () => {
        await fs.writeFile("/zero-write.txt", "base");
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
        const handle = await backend.open("/zero-write.txt", {
            read: true,
            write: true,
        });

        expect(
            await backend.write(handle, new Uint8Array(0), 1024 * 1024)
        ).toBe(0);
        expect((await backend.getattr("/zero-write.txt")).size).toBe(4);
        await backend.release(handle);
        expect(writeFile).not.toHaveBeenCalled();
        expect(decode(await fs.readFile("/zero-write.txt"))).toBe("base");
    });

    it("keeps reads available but rejects writable opens before write readiness", async () => {
        await fs.writeFile("/settling.txt", "visible read");
        await fs.mkdir("/existing-dir");
        const readVersionForMount = vi.fn((path: string, versionId: string) =>
            fs.readVersionForMount(path, versionId)
        );
        const target = mountTarget(fs, {
            bootstrapStatus: () => ({
                phase: "overlay-active",
                writeReady: false,
            }),
            readVersionForMount,
        });
        const backend = createSharedFsMountBackend(target);

        const readOnly = await backend.open("/settling.txt", { read: true });
        expect(decode(await backend.read(readOnly, 1024, 0))).toBe(
            "visible read"
        );
        // Descriptor errors win over global readiness: an invalid operation
        // must not look transient merely because the namespace is settling.
        await expect(
            backend.write(readOnly, encode("no"), 0)
        ).rejects.toMatchObject({ code: "EBADF" });
        await expect(backend.truncate(readOnly, 0)).rejects.toMatchObject({
            code: "EBADF",
        });
        await backend.release(readOnly);

        await expect(
            backend.open("/settling.txt", { read: true, write: true })
        ).rejects.toMatchObject({
            code: "EAGAIN",
            message: expect.stringContaining("await write readiness"),
        });
        await expect(
            backend.open("/read-create.txt", {
                read: true,
                create: true,
            })
        ).rejects.toMatchObject({ code: "EAGAIN" });
        // Only the read-only open read bytes. The readiness fence fires before
        // an exact-version read can seed a writable buffer from a partial
        // namespace.
        expect(readVersionForMount).toHaveBeenCalledOnce();

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
        const client = createIpcV2TestClient(server);
        try {
            await expect(
                client.open("/settling.txt", { read: true, write: true })
            ).rejects.toMatchObject({ code: "EAGAIN" });
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("refuses a writable ancestor fallback when the visible version is unavailable", async () => {
        const ancestor = await fs.writeFile("/stale.txt", "ancestor");
        const visible = await fs.writeFile("/stale.txt", "newest");
        const readVersionForMount = vi.fn(
            async (path: string, versionId: string) => {
                if (versionId === visible.id) {
                    throw new Error("missing newest chunk");
                }
                return fs.readVersionForMount(path, versionId);
            }
        );
        const writeFile = vi.fn(
            (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => fs.writeFile(path, source, options)
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { readVersionForMount, writeFile })
        );

        // A writable attach may not reuse ancestor bytes while claiming the
        // visible version as its causal base.
        await expect(
            backend.open("/stale.txt", { read: true, write: true })
        ).rejects.toMatchObject({
            code: "EIO",
            message: "missing newest chunk",
        });
        expect(readVersionForMount).toHaveBeenCalledWith(
            "/stale.txt",
            visible.id
        );
        expect(readVersionForMount).not.toHaveBeenCalledWith(
            "/stale.txt",
            ancestor.id
        );
        expect(writeFile).not.toHaveBeenCalled();
        expect(decode(await fs.readFile("/stale.txt"))).toBe("newest");
    });

    it("opens from the target-verified exact snapshot", async () => {
        const written = await fs.writeFile("/verified-open.txt", "verified");
        const readVersionForMount = vi.fn((path: string, versionId: string) =>
            fs.readVersionForMount(path, versionId)
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { readVersionForMount })
        );

        const handle = await backend.open("/verified-open.txt", {
            read: true,
            write: true,
        });
        expect(decode(await backend.read(handle, 1024, 0))).toBe("verified");
        await backend.release(handle);

        expect(readVersionForMount).toHaveBeenCalledOnce();
        expect(readVersionForMount).toHaveBeenCalledWith(
            "/verified-open.txt",
            written.id
        );
    });

    it("shares one verified load, hash, and backing buffer across sibling opens", async () => {
        const written = await fs.writeFile("/shared-open.txt", "before");
        const verified = await fs.readVersionForMount(
            "/shared-open.txt",
            written.id
        );
        expect(verified).toBeDefined();
        const verifiedBytes = new Uint8Array(verified!.bytes);
        const verifiedSnapshot = { ...verified!, bytes: verifiedBytes };
        const readVersionForMount = vi.fn(async () => verifiedSnapshot);
        const inputs: Uint8Array[] = [];
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                if (!(source instanceof Uint8Array)) {
                    throw new Error("mount commits must use Uint8Array input");
                }
                inputs.push(source);
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                readVersionForMount,
                writeFile,
            })
        );

        const [reader, writer] = await Promise.all([
            backend.open("/shared-open.txt", { read: true }),
            backend.open("/shared-open.txt", {
                read: true,
                write: true,
            }),
        ]);
        expect(readVersionForMount).toHaveBeenCalledOnce();

        await backend.write(writer, encode("after!"), 0);
        expect(decode(await backend.read(reader, 1024, 0))).toBe("after!");
        await backend.flush(writer);

        expect(writeFile).toHaveBeenCalledOnce();
        expect(inputs[0].buffer).toBe(verifiedBytes.buffer);
        await Promise.all([backend.release(reader), backend.release(writer)]);
    });

    it("drops shared state after the last sibling release", async () => {
        await fs.writeFile("/state-cleanup.txt", "content");
        const readVersionForMount = vi.fn((path: string, versionId: string) =>
            fs.readVersionForMount(path, versionId)
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { readVersionForMount })
        );

        const first = await backend.open("/state-cleanup.txt", { read: true });
        const sibling = await backend.open("/state-cleanup.txt", {
            read: true,
        });
        expect(readVersionForMount).toHaveBeenCalledOnce();
        await Promise.all([backend.release(first), backend.release(sibling)]);

        const reopened = await backend.open("/state-cleanup.txt", {
            read: true,
        });
        expect(readVersionForMount).toHaveBeenCalledTimes(2);
        await backend.release(reopened);
    });

    it("fails closed when a verified-read capability returns malformed binding metadata", async () => {
        const written = await fs.writeFile("/invalid-read.txt", "verified");
        const valid = await fs.readVersionForMount(
            "/invalid-read.txt",
            written.id
        );
        expect(valid).toBeDefined();
        const invalidSnapshots: [string, unknown][] = [
            ["null", null],
            ["non-byte input", { ...valid, bytes: "verified" }],
            ["wrong version", { ...valid, versionId: "version:other" }],
            ["wrong node", { ...valid, nodeId: "file:other" }],
            ["empty hash", { ...valid, contentHash: "" }],
            ["wrong hash", { ...valid, contentHash: "not-the-head-hash" }],
            ["wrong size", { ...valid, size: valid!.size + 1n }],
            [
                "byte-length mismatch",
                { ...valid, bytes: valid!.bytes.subarray(1) },
            ],
        ];

        for (const [label, invalid] of invalidSnapshots) {
            const backend = createSharedFsMountBackend(
                mountTarget(fs, {
                    readVersionForMount: async () => invalid as any,
                })
            );
            await expect(
                backend.open("/invalid-read.txt", {
                    read: true,
                    write: true,
                }),
                label
            ).rejects.toMatchObject({
                code: "EIO",
                message: expect.stringContaining("invalid verified snapshot"),
            });
        }
    });

    it("lets O_TRUNC bypass the exact reader", async () => {
        await fs.writeFile("/truncate-bypass.txt", "old");
        const readVersionForMount = vi.fn(async () => {
            throw new Error("O_TRUNC must not read the replaced bytes");
        });
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { readVersionForMount })
        );

        const truncated = await backend.open("/truncate-bypass.txt", {
            write: true,
            truncate: true,
        });
        await backend.write(truncated, encode("new"), 0);
        await backend.release(truncated);
        expect(readVersionForMount).not.toHaveBeenCalled();
        expect(decode(await fs.readFile("/truncate-bypass.txt"))).toBe("new");
    });

    it("retries a verified snapshot when the same node advances heads", async () => {
        const original = await fs.writeFile("/verified-race.txt", "original");
        const entered = deferred();
        const allowed = deferred();
        let calls = 0;
        const readVersionForMount = vi.fn(
            async (path: string, versionId: string) => {
                calls++;
                const snapshot = await fs.readVersionForMount(path, versionId);
                if (calls === 1) {
                    entered.resolve();
                    await allowed.promise;
                }
                return snapshot;
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { readVersionForMount })
        );

        const opening = backend.open("/verified-race.txt", {
            read: true,
            write: true,
        });
        await entered.promise;
        const concurrent = await fs.writeFile(
            "/verified-race.txt",
            "concurrent"
        );
        expect(concurrent.nodeId).toBe(original.nodeId);
        allowed.resolve();

        const handle = await opening;
        expect(decode(await backend.read(handle, 1024, 0))).toBe("concurrent");
        await backend.release(handle);
        expect(readVersionForMount).toHaveBeenCalledTimes(2);
        expect(readVersionForMount.mock.calls.map((call) => call[1])).toEqual([
            original.id,
            concurrent.id,
        ]);
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
            mountTarget(fs, { stat, writeFile })
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

    it("quarantines an existing-node mismatch across later path repair", async () => {
        await fs.writeFile("/quarantined.txt", "original");
        const entered = deferred();
        const allowed = deferred();
        let actualNodeId: string | null = null;
        const writeFile = vi.fn(
            async (
                path: string,
                _source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                entered.resolve();
                await allowed.promise;
                throw new SharedFsExpectedNodeMismatchError(
                    path,
                    options?.expectedNodeId ?? null,
                    actualNodeId,
                    "before-naming"
                );
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/quarantined.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("stale data"), 0);

        const flushing = backend.flush(handle);
        await entered.promise;
        await fs.rm("/quarantined.txt");
        await fs.writeFile("/quarantined.txt", "replacement");
        actualNodeId = (await fs.stat("/quarantined.txt"))?.nodeId ?? null;
        allowed.resolve();
        await expect(flushing).rejects.toMatchObject({ code: "EAGAIN" });

        await fs.rm("/quarantined.txt");
        await fs.writeFile("/quarantined.txt", "repaired");
        await expect(backend.flush(handle)).rejects.toMatchObject({
            code: "EBADF",
        });
        await expect(
            backend.write(handle, encode("still stale"), 0)
        ).rejects.toMatchObject({ code: "EBADF" });
        await backend.release(handle);
        expect(writeFile).toHaveBeenCalledOnce();
        expect(decode(await fs.readFile("/quarantined.txt"))).toBe("repaired");
    });

    it("terminalizes an ordinary create that loses its absent-path race", async () => {
        let calls = 0;
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                // The handle opened an absent path and therefore carries an
                // expectedNodeId of null. Materialize a competing node before
                // the library-level compare-and-set, which must reject.
                calls++;
                if (calls === 1) {
                    await fs.writeFile(path, "racer");
                }
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

        await expect(backend.flush(handle)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(writeFile).toHaveBeenCalledOnce();
        expect(decode(await fs.readFile("/new.txt"))).toBe("racer");

        await fs.rm("/new.txt");
        const fresh = await backend.open("/new.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await expect(
            backend.write(handle, encode("resurrected"), 0)
        ).rejects.toMatchObject({ code: "EBADF" });
        await expect(backend.flush(handle)).rejects.toMatchObject({
            code: "EBADF",
        });
        await expect(backend.fsync(handle)).rejects.toMatchObject({
            code: "EBADF",
        });
        await backend.release(handle);
        expect(writeFile).toHaveBeenCalledOnce();

        await backend.write(fresh, encode("fresh"), 0);
        await backend.release(fresh);
        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(decode(await fs.readFile("/new.txt"))).toBe("fresh");
    });

    it("terminalizes an atomic create loser even if its winner is already removed", async () => {
        let injectWinner = true;
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                if (injectWinner) {
                    injectWinner = false;
                    await fs.writeFile(path, "short-lived winner");
                    try {
                        return await fs.writeFile(path, source, options);
                    } catch (error) {
                        await fs.rm(path);
                        throw error;
                    }
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/removed-winner.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(handle, encode("stale"), 0);

        await expect(backend.flush(handle)).rejects.toMatchObject({
            code: "EEXIST",
        });
        expect(await fs.stat("/removed-winner.txt")).toBeUndefined();
        await expect(backend.fsync(handle)).rejects.toMatchObject({
            code: "EBADF",
        });
        await backend.release(handle);
        expect(writeFile).toHaveBeenCalledOnce();

        const fresh = await backend.open("/removed-winner.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(fresh, encode("fresh"), 0);
        await backend.release(fresh);
        expect(decode(await fs.readFile("/removed-winner.txt"))).toBe("fresh");
    });

    it("terminalizes an absent create whose parent disappears before release", async () => {
        await fs.mkdir("/parent");
        const backend = createSharedFsMountBackend(fs);
        const stale = await backend.open("/parent/child.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(stale, encode("stale"), 0);
        await fs.rm("/parent");

        await expect(backend.release(stale)).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(backend.flush(stale)).rejects.toMatchObject({
            code: "EBADF",
        });

        await backend.mkdir("/parent");
        const fresh = await backend.open("/parent/child.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(fresh, encode("fresh"), 0);
        await backend.release(fresh);
        await backend.release(stale);
        expect(decode(await fs.readFile("/parent/child.txt"))).toBe("fresh");
    });

    it("terminalizes an absent create whose parent becomes a file", async () => {
        await fs.mkdir("/changing-parent");
        const backend = createSharedFsMountBackend(fs);
        const stale = await backend.open("/changing-parent/child.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(stale, encode("stale"), 0);
        await fs.rm("/changing-parent");
        await fs.writeFile("/changing-parent", "replacement file");

        await expect(backend.release(stale)).rejects.toMatchObject({
            code: "ENOTDIR",
        });
        await expect(backend.fsync(stale)).rejects.toMatchObject({
            code: "EBADF",
        });

        await fs.rm("/changing-parent");
        await backend.mkdir("/changing-parent");
        const fresh = await backend.open("/changing-parent/child.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(fresh, encode("fresh"), 0);
        await backend.release(fresh);
        await backend.release(stale);
        expect(decode(await fs.readFile("/changing-parent/child.txt"))).toBe(
            "fresh"
        );
    });

    it("terminalizes an absent create whose parent directory node is replaced", async () => {
        await fs.mkdir("/replaced-parent");
        const originalParent = await fs.stat("/replaced-parent");
        expect(originalParent?.kind).toBe("directory");
        const backend = createSharedFsMountBackend(fs);
        const stale = await backend.open("/replaced-parent/child.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(stale, encode("stale"), 0);

        await fs.rm("/replaced-parent");
        await fs.mkdir("/replaced-parent");
        const replacementParent = await fs.stat("/replaced-parent");
        expect(replacementParent?.kind).toBe("directory");
        expect(replacementParent?.nodeId).not.toBe(originalParent?.nodeId);

        await expect(backend.release(stale)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(await fs.stat("/replaced-parent/child.txt")).toBeUndefined();
        await expect(backend.flush(stale)).rejects.toMatchObject({
            code: "EBADF",
        });

        const fresh = await backend.open("/replaced-parent/child.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(fresh, encode("fresh"), 0);
        await backend.release(fresh);
        await backend.release(stale);
        expect(decode(await fs.readFile("/replaced-parent/child.txt"))).toBe(
            "fresh"
        );
    });

    it("keeps an unrelated custom EAGAIN retryable", async () => {
        let fail = true;
        const writeFile = vi.fn(
            (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                if (fail) {
                    fail = false;
                    throw new SharedFsError(
                        "EAGAIN",
                        "custom target is temporarily busy"
                    );
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/retry-eagain.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(handle, encode("retained"), 0);

        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        await expect(
            backend.open("/retry-eagain.txt", {
                write: true,
                create: true,
                exclusive: true,
            })
        ).rejects.toMatchObject({ code: "EEXIST" });

        await backend.release(handle);
        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(decode(await fs.readFile("/retry-eagain.txt"))).toBe("retained");
    });

    it("keeps untyped custom parent-like failures retryable", async () => {
        for (const code of ["ENOENT", "ENOTDIR"] as const) {
            const parent = `/custom-${code.toLowerCase()}`;
            const path = `${parent}/child.txt`;
            await fs.mkdir(parent);
            let fail = true;
            const writeFile = vi.fn(
                (
                    targetPath: string,
                    source: Uint8Array | string | AsyncIterable<Uint8Array>,
                    options?: WriteFileOptions
                ) => {
                    if (fail) {
                        fail = false;
                        throw new SharedFsError(
                            code,
                            "custom target transient parent failure"
                        );
                    }
                    return fs.writeFile(targetPath, source, options);
                }
            );
            const backend = createSharedFsMountBackend(
                mountTarget(fs, { writeFile })
            );
            const handle = await backend.open(path, {
                write: true,
                create: true,
                exclusive: true,
            });
            await backend.write(handle, encode("retained"), 0);

            await expect(backend.release(handle)).rejects.toMatchObject({
                code,
            });
            await expect(
                backend.open(path, {
                    write: true,
                    create: true,
                    exclusive: true,
                })
            ).rejects.toMatchObject({ code: "EEXIST" });

            await backend.release(handle);
            expect(writeFile).toHaveBeenCalledTimes(2);
            expect(decode(await fs.readFile(path))).toBe("retained");
        }
    });

    it("enforces O_EXCL against settled paths and local pending creators", async () => {
        const backend = createSharedFsMountBackend(fs);
        await fs.writeFile("/settled.txt", "exists");
        await fs.mkdir("/settled-directory");

        for (const path of ["/settled.txt", "/settled-directory", "/"]) {
            await expect(
                backend.open(path, {
                    write: true,
                    create: true,
                    exclusive: true,
                })
            ).rejects.toMatchObject({ code: "EEXIST" });
        }
        expect(decode(await fs.readFile("/settled.txt"))).toBe("exists");
        await expect(backend.open("/", { read: true })).rejects.toMatchObject({
            code: "EISDIR",
        });

        const ordinary = await backend.open("/ordinary-pending.txt", {
            write: true,
            create: true,
        });
        const ordinarySibling = await backend.open("/ordinary-pending.txt", {
            read: true,
            write: true,
            create: true,
        });
        await backend.write(ordinary, encode("shared"), 0);
        expect(decode(await backend.read(ordinarySibling, 1024, 0))).toBe(
            "shared"
        );
        await expect(
            backend.open("/ordinary-pending.txt", {
                write: true,
                create: true,
                exclusive: true,
            })
        ).rejects.toMatchObject({ code: "EEXIST" });
        await backend.release(ordinary);
        await backend.release(ordinarySibling);

        const exclusive = await backend.open("/exclusive-pending.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        const exclusiveSibling = await backend.open("/exclusive-pending.txt", {
            write: true,
            create: true,
        });
        await expect(
            backend.open("/exclusive-pending.txt", {
                write: true,
                create: true,
                exclusive: true,
            })
        ).rejects.toMatchObject({ code: "EEXIST" });
        await backend.release(exclusive);
        await backend.release(exclusiveSibling);
    });

    it("rejects an ancestor rename while a descendant create intent is pending", async () => {
        await fs.mkdir("/source");
        const mutate = vi.fn((mutation: SharedFsMountNamespaceMutation) =>
            fs.mutateNamespaceForMount(mutation)
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { mutateNamespaceForMount: mutate })
        );
        const handle = await backend.open("/source/pending.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(handle, encode("pending"), 0);

        await expect(
            backend.rename("/source/pending.txt", "/source/other.txt")
        ).rejects.toMatchObject({ code: "EAGAIN" });
        await expect(backend.rename("/source", "/moved")).rejects.toMatchObject(
            { code: "EAGAIN" }
        );
        expect(mutate).not.toHaveBeenCalled();
        expect((await backend.getattr("/source/pending.txt")).size).toBe(
            "pending".length
        );
        await expect(
            backend.getattr("/moved/pending.txt")
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
            backend.open("/source/pending.txt", {
                write: true,
                create: true,
                exclusive: true,
            })
        ).rejects.toMatchObject({ code: "EEXIST" });

        await backend.release(handle);
        await backend.rename("/source", "/moved");
        expect(mutate).toHaveBeenCalledOnce();
        expect(decode(await fs.readFile("/moved/pending.txt"))).toBe("pending");
    });

    it("gates exact and descendant create intents at rename destinations", async () => {
        await fs.writeFile("/source.txt", "source");
        await fs.mkdir("/source-dir");
        await fs.mkdir("/destination-dir");
        const mutate = vi.fn((mutation: SharedFsMountNamespaceMutation) =>
            fs.mutateNamespaceForMount(mutation)
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { mutateNamespaceForMount: mutate })
        );

        const exact = await backend.open("/destination.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(exact, encode("pending"), 0);

        await expect(
            backend.rename("/source.txt", "/destination.txt")
        ).rejects.toMatchObject({ code: "EAGAIN" });
        await expect(backend.unlink("/destination.txt")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(mutate).not.toHaveBeenCalled();
        expect(decode(await fs.readFile("/source.txt"))).toBe("source");

        // Once the pending create publishes, its old handle cannot recreate
        // the path after an ordinary unlink.
        await backend.release(exact);
        await backend.unlink("/destination.txt");
        await backend.release(exact);
        expect(await fs.stat("/destination.txt")).toBeUndefined();

        const descendant = await backend.open("/destination-dir/pending.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await expect(
            backend.rename("/source-dir", "/destination-dir")
        ).rejects.toMatchObject({ code: "EAGAIN" });
        // Only the earlier unlink reached the target.
        expect(mutate.mock.calls.map(([mutation]) => mutation.type)).toEqual([
            "remove",
        ]);
        await backend.release(descendant);
    });

    it("serializes overlapping renames so an open handle follows the retry", async () => {
        await fs.mkdir("/a");
        await fs.writeFile("/a/file.txt", "original");
        const firstMoved = deferred();
        const firstAllowed = deferred();
        let calls = 0;
        const mutate = vi.fn(
            async (mutation: SharedFsMountNamespaceMutation) => {
                calls++;
                const result = await fs.mutateNamespaceForMount(mutation);
                if (calls === 1) {
                    firstMoved.resolve();
                    await firstAllowed.promise;
                }
                return result;
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { mutateNamespaceForMount: mutate })
        );
        const handle = await backend.open("/a/file.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("updated!"), 0);

        const firstRename = backend.rename("/a", "/b");
        await firstMoved.promise;
        try {
            await expect(backend.rename("/b", "/c")).rejects.toMatchObject({
                code: "EAGAIN",
            });
            await expect(
                backend.rename("/b/file.txt", "/elsewhere.txt")
            ).rejects.toMatchObject({ code: "EAGAIN" });
            expect(mutate).toHaveBeenCalledOnce();
        } finally {
            firstAllowed.resolve();
        }
        await firstRename;

        await backend.rename("/b", "/c");
        await backend.release(handle);
        expect(mutate).toHaveBeenCalledTimes(2);
        expect(await fs.stat("/a")).toBeUndefined();
        expect(await fs.stat("/b")).toBeUndefined();
        expect(decode(await fs.readFile("/c/file.txt"))).toBe("updated!");
    });

    it("gates an in-flight create lookup below a rename destination", async () => {
        await fs.mkdir("/source");
        const statEntered = deferred();
        const statAllowed = deferred();
        let gatedStat = true;
        const stat = vi.fn(async (path: string) => {
            if (path === "/destination/racing.txt" && gatedStat) {
                gatedStat = false;
                statEntered.resolve();
                await statAllowed.promise;
            }
            return fs.stat(path);
        });
        const mutate = vi.fn((mutation: SharedFsMountNamespaceMutation) =>
            fs.mutateNamespaceForMount(mutation)
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { stat, mutateNamespaceForMount: mutate })
        );

        const opening = backend.open("/destination/racing.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await statEntered.promise;
        await expect(
            backend.rename("/source", "/destination")
        ).rejects.toMatchObject({ code: "EAGAIN" });
        expect(mutate).not.toHaveBeenCalled();
        statAllowed.resolve();
        await expect(opening).rejects.toMatchObject({ code: "ENOENT" });
        await backend.rename("/source", "/destination");
        expect((await fs.stat("/destination"))?.kind).toBe("directory");
        expect(await fs.stat("/source")).toBeUndefined();
    });

    it("preflights mkdir against an exact pending create before path lookup", async () => {
        const stat = vi.fn((path: string) => fs.stat(path));
        const mkdir = vi.fn((path: string) => fs.mkdir(path));
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { stat, mkdir })
        );
        const handle = await backend.open("/node", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(handle, encode("pending"), 0);
        const lookupsBeforeMkdir = stat.mock.calls.length;

        await expect(backend.mkdir("/node")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(stat).toHaveBeenCalledTimes(lookupsBeforeMkdir);
        expect(mkdir).not.toHaveBeenCalled();

        await backend.release(handle);
        await backend.unlink("/node");
        await backend.mkdir("/node");
        await backend.release(handle);
        expect((await fs.stat("/node"))?.kind).toBe("directory");
    });

    it("gates an exact create lookup while mkdir is in flight", async () => {
        const statEntered = deferred();
        const statAllowed = deferred();
        const mkdirEntered = deferred();
        const mkdirAllowed = deferred();
        let gatedStat = true;
        const stat = vi.fn(async (path: string) => {
            if (path === "/node" && gatedStat) {
                gatedStat = false;
                statEntered.resolve();
                await statAllowed.promise;
            }
            return fs.stat(path);
        });
        const mkdir = vi.fn(async (path: string) => {
            mkdirEntered.resolve();
            await mkdirAllowed.promise;
            return fs.mkdir(path);
        });
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { stat, mkdir })
        );

        const opening = backend.open("/node", {
            write: true,
            create: true,
            exclusive: true,
        });
        await statEntered.promise;
        await expect(backend.mkdir("/node")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(mkdir).not.toHaveBeenCalled();
        statAllowed.resolve();
        const fresh = await opening;
        await backend.release(fresh);
        expect((await fs.stat("/node"))?.kind).toBe("file");
    });

    it("rejects rmdir while a descendant create intent is pending", async () => {
        await fs.mkdir("/tree");
        const mutate = vi.fn((mutation: SharedFsMountNamespaceMutation) =>
            fs.mutateNamespaceForMount(mutation)
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { mutateNamespaceForMount: mutate })
        );
        const handle = await backend.open("/tree/pending.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(handle, encode("pending"), 0);

        await expect(backend.rmdir("/tree")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(mutate).not.toHaveBeenCalled();
        expect((await fs.stat("/tree"))?.kind).toBe("directory");

        await backend.release(handle);
        await backend.unlink("/tree/pending.txt");
        await backend.rmdir("/tree");
        await backend.release(handle);
        expect(await fs.stat("/tree")).toBeUndefined();
    });

    it("gates an exact create lookup while unlink removes its path", async () => {
        await fs.writeFile("/removed.txt", "winner");
        const statEntered = deferred();
        const statAllowed = deferred();
        const rmAllowed = deferred();
        let gatedStat = true;
        const stat = vi.fn(async (path: string) => {
            if (path === "/removed.txt" && gatedStat) {
                gatedStat = false;
                statEntered.resolve();
                await statAllowed.promise;
            }
            return fs.stat(path);
        });
        const mutate = vi.fn(
            async (mutation: SharedFsMountNamespaceMutation) => {
                const result = await fs.mutateNamespaceForMount(mutation);
                await rmAllowed.promise;
                return result;
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { stat, mutateNamespaceForMount: mutate })
        );

        const opening = backend.open("/removed.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await statEntered.promise;
        await expect(backend.unlink("/removed.txt")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(mutate).not.toHaveBeenCalled();
        statAllowed.resolve();
        await expect(opening).rejects.toMatchObject({ code: "EEXIST" });
        expect(await fs.stat("/removed.txt")).toBeDefined();
    });

    it("gates a descendant create lookup while rmdir removes its namespace", async () => {
        await fs.mkdir("/tree");
        const statEntered = deferred();
        const statAllowed = deferred();
        const rmAllowed = deferred();
        let gatedStat = true;
        const stat = vi.fn(async (path: string) => {
            if (path === "/tree/racing.txt" && gatedStat) {
                gatedStat = false;
                statEntered.resolve();
                await statAllowed.promise;
            }
            return fs.stat(path);
        });
        const mutate = vi.fn(
            async (mutation: SharedFsMountNamespaceMutation) => {
                const result = await fs.mutateNamespaceForMount(mutation);
                await rmAllowed.promise;
                return result;
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { stat, mutateNamespaceForMount: mutate })
        );

        const opening = backend.open("/tree/racing.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await statEntered.promise;
        await expect(backend.rmdir("/tree")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(mutate).not.toHaveBeenCalled();
        statAllowed.resolve();
        const fresh = await opening;
        await backend.release(fresh);
        rmAllowed.resolve();
        await backend.unlink("/tree/racing.txt");
        await backend.rmdir("/tree");
        expect(await fs.stat("/tree")).toBeUndefined();
    });

    it("gates a create lookup that races an in-flight ancestor rename", async () => {
        await fs.mkdir("/source");
        const statEntered = deferred();
        const statAllowed = deferred();
        const renameEntered = deferred();
        const renameAllowed = deferred();
        const stat = vi.fn(async (path: string) => {
            if (path === "/source/racing.txt") {
                statEntered.resolve();
                await statAllowed.promise;
            }
            return fs.stat(path);
        });
        const mutate = vi.fn(
            async (mutation: SharedFsMountNamespaceMutation) => {
                renameEntered.resolve();
                await renameAllowed.promise;
                return fs.mutateNamespaceForMount(mutation);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { stat, mutateNamespaceForMount: mutate })
        );

        const opening = backend.open("/source/racing.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await statEntered.promise;
        await expect(backend.rename("/source", "/moved")).rejects.toMatchObject(
            { code: "EAGAIN" }
        );
        expect(mutate).not.toHaveBeenCalled();
        statAllowed.resolve();
        const raced = await opening;
        await backend.release(raced);
        renameAllowed.resolve();
        await backend.rename("/source", "/moved");

        expect(mutate).toHaveBeenCalledOnce();
        expect(await fs.stat("/source")).toBeUndefined();
        expect((await fs.stat("/moved"))?.kind).toBe("directory");
        expect(await fs.stat("/moved/racing.txt")).toBeDefined();

        // Both the rename gate and the failed open's create intent must be
        // gone once the operations settle.
        const moved = await backend.open("/moved/fresh.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.release(moved);
    });

    it("shares a provisional create while its first commit is in flight", async () => {
        const commitEntered = deferred();
        const commitAllowed = deferred();
        let calls = 0;
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                calls++;
                if (calls === 1) {
                    commitEntered.resolve();
                    await commitAllowed.promise;
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const first = await backend.open("/ordinary-race.txt", {
            write: true,
            create: true,
        });
        await backend.write(first, encode("left"), 0);
        const firstRelease = backend.release(first);
        await commitEntered.promise;

        const sibling = await backend.open("/ordinary-race.txt", {
            read: true,
            write: true,
            create: true,
        });
        expect(decode(await backend.read(sibling, 1024, 0))).toBe("left");
        await backend.write(sibling, encode("right"), 0);
        await expect(
            backend.open("/ordinary-race.txt", {
                write: true,
                create: true,
                exclusive: true,
            })
        ).rejects.toMatchObject({ code: "EEXIST" });

        const siblingRelease = backend.release(sibling);
        expect(writeFile).toHaveBeenCalledOnce();
        expect(await fs.stat("/ordinary-race.txt")).toBeUndefined();
        commitAllowed.resolve();
        await Promise.all([firstRelease, siblingRelease]);

        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(decode(await fs.readFile("/ordinary-race.txt"))).toBe("right");
    });

    it("terminalizes an O_EXCL loser as EEXIST", async () => {
        let calls = 0;
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                calls++;
                if (calls === 1) {
                    await fs.writeFile(path, "racer");
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/exclusive-race.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(handle, encode("ours"), 0);

        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EEXIST",
        });
        expect(writeFile).toHaveBeenCalledOnce();
        expect(decode(await fs.readFile("/exclusive-race.txt"))).toBe("racer");

        await fs.rm("/exclusive-race.txt");
        await backend.release(handle);
        await expect(backend.flush(handle)).rejects.toMatchObject({
            code: "EBADF",
        });
        await expect(backend.fsync(handle)).rejects.toMatchObject({
            code: "EBADF",
        });
        await expect(
            backend.write(handle, encode("resurrected"), 0)
        ).rejects.toMatchObject({ code: "EBADF" });
        expect(writeFile).toHaveBeenCalledOnce();

        const fresh = await backend.open("/exclusive-race.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(fresh, encode("fresh"), 0);
        await backend.release(fresh);
        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(decode(await fs.readFile("/exclusive-race.txt"))).toBe("fresh");
    });

    it("discards an unreachable one-shot create after release failure", async () => {
        let calls = 0;
        const writeFile = vi.fn(
            (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                calls++;
                if (calls === 1) {
                    throw new Error("injected one-shot release failure");
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const abandoned = await backend.open("/mknod-retry.txt", {
            write: true,
            create: true,
            exclusive: true,
            releaseFailure: "discard",
        });

        await expect(backend.release(abandoned)).rejects.toMatchObject({
            code: "EIO",
        });
        await expect(backend.flush(abandoned)).rejects.toMatchObject({
            code: "EBADF",
        });

        const retry = await backend.open("/mknod-retry.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.release(retry);
        expect(writeFile).toHaveBeenCalledTimes(2);
        expect((await fs.stat("/mknod-retry.txt"))?.kind).toBe("file");
    });

    it("retains an exclusive create intent across a failed release retry", async () => {
        let calls = 0;
        const writeFile = vi.fn(
            (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                calls++;
                if (calls === 1) {
                    throw new Error("injected create failure");
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/exclusive-retry.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(handle, encode("retained"), 0);

        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EIO",
        });
        await expect(
            backend.open("/exclusive-retry.txt", {
                write: true,
                create: true,
                exclusive: true,
            })
        ).rejects.toMatchObject({ code: "EEXIST" });

        await backend.release(handle);
        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(decode(await fs.readFile("/exclusive-retry.txt"))).toBe(
            "retained"
        );
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

    it("keeps an in-flight append snapshot stable at the fsync cutoff", async () => {
        await fs.writeFile("/append-fence.txt", "base");
        const started = deferred();
        const allowed = deferred();
        const inputs: Uint8Array[] = [];
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                if (!(source instanceof Uint8Array)) {
                    throw new Error("mount commits must use Uint8Array input");
                }
                inputs.push(source);
                if (inputs.length === 1) {
                    started.resolve();
                    await allowed.promise;
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/append-fence.txt", {
            write: true,
            append: true,
        });
        await backend.write(handle, encode("A"), 0);

        const syncing = backend.fsync(handle);
        await started.promise;
        await backend.write(handle, encode("B"), 0);
        expect(decode(inputs[0])).toBe("baseA");
        allowed.resolve();
        await syncing;

        expect(decode(inputs[0])).toBe("baseA");
        expect(decode(await fs.readFile("/append-fence.txt"))).toBe("baseA");
        expect(writeFile).toHaveBeenCalledOnce();
        await backend.release(handle);
        expect(decode(await fs.readFile("/append-fence.txt"))).toBe("baseAB");
        expect(writeFile).toHaveBeenCalledTimes(2);
    });

    it("borrows a commit snapshot and detaches an overlapping write", async () => {
        const openedBytes = encode("base");
        await fs.writeFile("/cow-overlap.txt", openedBytes.slice());
        const { backend, firstStarted, firstAllowed, inputs, writeFile } =
            gatedBorrowingBackend(fs, openedBytes);
        const handle = await backend.open("/cow-overlap.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("old!"), 0);

        const flushing = backend.flush(handle);
        await firstStarted.promise;
        expect(inputs[0].buffer).toBe(openedBytes.buffer);
        expect(decode(inputs[0])).toBe("old!");

        await backend.write(handle, encode("new!"), 0);
        expect(decode(inputs[0])).toBe("old!");
        firstAllowed.resolve();
        await flushing;

        expect(decode(await fs.readFile("/cow-overlap.txt"))).toBe("old!");
        await backend.release(handle);
        expect(decode(await fs.readFile("/cow-overlap.txt"))).toBe("new!");
        expect(writeFile).toHaveBeenCalledTimes(2);
    });

    it("keeps a settled immutable snapshot stable across a later handle write", async () => {
        const openedBytes = encode("base");
        await fs.writeFile("/cow-settled.txt", openedBytes.slice());
        const inputs: Uint8Array[] = [];
        const committedIds: string[] = [];
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                if (!(source instanceof Uint8Array)) {
                    throw new Error("mount commits must use Uint8Array input");
                }
                inputs.push(source);
                const result = await fs.writeFile(path, source, options);
                committedIds.push(result.id);
                return result;
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                readVersionForMount: readVersionAs(fs, openedBytes),
                writeFile,
            })
        );
        const handle = await backend.open("/cow-settled.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("old!"), 0);
        await backend.flush(handle);

        expect(inputs[0].buffer).toBe(openedBytes.buffer);
        expect(decode(await fs.readFile("/cow-settled.txt"))).toBe("old!");
        // Dirty operations that do not actually mutate bytes must not replace
        // and then clear the already-exposed protection token on their
        // identical-bytes commit.
        await backend.truncate(handle, 4);
        await backend.write(handle, new Uint8Array(0), 0);
        await backend.flush(handle);
        expect(writeFile).toHaveBeenCalledTimes(2);

        await backend.write(handle, encode("new!"), 0);

        // SharedFileSystem retains chunk views after writeFile resolves. The
        // next handle mutation must detach instead of corrupting that version.
        expect(decode(inputs[0])).toBe("old!");
        expect(decode(await fs.readFile("/cow-settled.txt"))).toBe("old!");
        expect(
            decode(await fs.readVersion("/cow-settled.txt", committedIds[0]))
        ).toBe("old!");

        await backend.release(handle);
        expect(decode(await fs.readFile("/cow-settled.txt"))).toBe("new!");
        expect(
            decode(await fs.readVersion("/cow-settled.txt", committedIds[0]))
        ).toBe("old!");
    });

    it("copies logical bytes instead of lending oversized buffer slack", async () => {
        const inputs: Uint8Array[] = [];
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                if (!(source instanceof Uint8Array)) {
                    throw new Error("mount commits must use Uint8Array input");
                }
                inputs.push(source);
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/cow-slack.txt", {
            write: true,
            create: true,
            truncate: true,
        });
        // Geometric growth gives this one-byte file 64 KiB of handle capacity.
        await backend.write(handle, encode("a"), 0);
        await backend.flush(handle);

        expect(inputs[0].byteLength).toBe(1);
        expect(inputs[0].buffer.byteLength).toBe(1);
        await backend.write(handle, encode("b"), 0);
        expect(decode(inputs[0])).toBe("a");
        expect(decode(await fs.readFile("/cow-slack.txt"))).toBe("a");

        await backend.release(handle);
        expect(decode(await fs.readFile("/cow-slack.txt"))).toBe("b");
    });

    it("copies an exact-length view backed by an oversized allocation", async () => {
        const backing = new Uint8Array(64 * 1024);
        const openedBytes = backing.subarray(100, 104);
        openedBytes.set(encode("base"));
        await fs.writeFile("/cow-view-slack.txt", openedBytes.slice());
        const inputs: Uint8Array[] = [];
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                if (!(source instanceof Uint8Array)) {
                    throw new Error("mount commits must use Uint8Array input");
                }
                inputs.push(source);
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                readVersionForMount: readVersionAs(fs, openedBytes),
                writeFile,
            })
        );
        const handle = await backend.open("/cow-view-slack.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("save"), 0);
        await backend.flush(handle);

        expect(inputs[0].byteLength).toBe(4);
        expect(inputs[0].buffer.byteLength).toBe(4);
        expect(inputs[0].buffer).not.toBe(backing.buffer);
        await backend.release(handle);
    });

    it("copies a pooled Buffer-backed handle instead of aliasing it", async () => {
        await fs.writeFile("/cow-pooled.txt", "hello");
        // Buffer.from uses the shared pool (byteOffset > 0), so the commit
        // copies; Buffer#slice would hand the target a live alias instead.
        const openedBytes = Buffer.from("hello");
        const inputs: Uint8Array[] = [];
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                readVersionForMount: readVersionAs(fs, openedBytes),
                writeFile: async (path, source, options) => {
                    inputs.push(source as Uint8Array);
                    return fs.writeFile(path, source, options);
                },
            })
        );
        const handle = await backend.open("/cow-pooled.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("HELLO"), 0);
        await backend.flush(handle);
        await backend.write(handle, encode("xxxxx"), 0);

        expect(decode(inputs[0])).toBe("HELLO");
        await backend.release(handle);
        expect(decode(await fs.readFile("/cow-pooled.txt"))).toBe("xxxxx");
    });

    it("keeps a borrowed commit snapshot stable across an overlapping shrink", async () => {
        const openedBytes = encode("ABCDEFGH");
        await fs.writeFile("/cow-shrink.txt", openedBytes.slice());
        const { backend, firstStarted, firstAllowed, inputs } =
            gatedBorrowingBackend(fs, openedBytes);
        const handle = await backend.open("/cow-shrink.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("1234"), 0);

        const flushing = backend.flush(handle);
        await firstStarted.promise;
        expect(decode(inputs[0])).toBe("1234EFGH");

        await backend.truncate(handle, 3);
        expect(decode(inputs[0])).toBe("1234EFGH");
        firstAllowed.resolve();
        await flushing;

        expect(decode(await fs.readFile("/cow-shrink.txt"))).toBe("1234EFGH");
        await backend.release(handle);
        expect(decode(await fs.readFile("/cow-shrink.txt"))).toBe("123");
    });

    it("keeps a borrowed commit snapshot stable across an overlapping sparse grow", async () => {
        const openedBytes = encode("base");
        await fs.writeFile("/cow-grow.txt", openedBytes.slice());
        const { backend, firstStarted, firstAllowed, inputs } =
            gatedBorrowingBackend(fs, openedBytes);
        const handle = await backend.open("/cow-grow.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("old!"), 0);

        const flushing = backend.flush(handle);
        await firstStarted.promise;
        const sparseOffset = 70 * 1024;
        await backend.write(handle, encode("Z"), sparseOffset);
        expect(decode(inputs[0])).toBe("old!");
        firstAllowed.resolve();
        await flushing;
        await backend.release(handle);

        const committed = await fs.readFile("/cow-grow.txt");
        expect(committed?.byteLength).toBe(sparseOffset + 1);
        expect(decode(committed?.subarray(0, 4))).toBe("old!");
        expect(
            committed?.subarray(4, sparseOffset).every((byte) => byte === 0)
        ).toBe(true);
        expect(committed?.[sparseOffset]).toBe("Z".charCodeAt(0));
    });

    it("keeps rejected immutable snapshots stable across concurrent and later mutations", async () => {
        const openedBytes = encode("base");
        await fs.writeFile("/cow-failure.txt", openedBytes.slice());
        const { backend, firstStarted, firstAllowed, inputs, writeFile } =
            gatedBorrowingBackend(fs, openedBytes, { failCalls: 2 });
        const handle = await backend.open("/cow-failure.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("old!"), 0);

        const flushing = backend.flush(handle);
        await firstStarted.promise;
        await backend.write(handle, encode("mid!"), 0);
        expect(decode(inputs[0])).toBe("old!");
        firstAllowed.resolve();
        await expect(flushing).rejects.toMatchObject({ code: "EIO" });

        // A second rejection occurs without an overlapping mutation, leaving
        // its exposed marker responsible for the later detachment.
        await expect(backend.flush(handle)).rejects.toMatchObject({
            code: "EIO",
        });
        await backend.write(handle, encode("new!"), 0);
        expect(decode(inputs[0])).toBe("old!");
        expect(decode(inputs[1])).toBe("mid!");
        await backend.release(handle);
        expect(decode(await fs.readFile("/cow-failure.txt"))).toBe("new!");
        expect(writeFile).toHaveBeenCalledTimes(3);
    });

    it("bounds fsync at its captured generation under sibling writes", async () => {
        const firstStarted = deferred();
        const firstAllowed = deferred();
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                if (writeFile.mock.calls.length === 1) {
                    firstStarted.resolve();
                    await firstAllowed.promise;
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const fence = await backend.open("/during-fsync.txt", {
            write: true,
            create: true,
            truncate: true,
        });
        const sibling = await backend.open("/during-fsync.txt", {
            read: true,
            write: true,
        });
        await backend.write(fence, encode("aaa"), 0);

        const syncing = backend.fsync(fence);
        await firstStarted.promise;
        await backend.write(sibling, encode("bbb"), 0);
        await backend.write(sibling, encode("ccc"), 0);
        firstAllowed.resolve();
        await syncing;

        expect(writeFile).toHaveBeenCalledOnce();
        expect(decode(await fs.readFile("/during-fsync.txt"))).toBe("aaa");
        expect(decode(await backend.read(sibling, 1024, 0))).toBe("ccc");

        await backend.release(fence);
        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(decode(await fs.readFile("/during-fsync.txt"))).toBe("ccc");
        await backend.release(sibling);
        expect(writeFile).toHaveBeenCalledTimes(2);
    });

    it("bounds release at its captured generation under sibling writes", async () => {
        await fs.writeFile("/release-cutoff.txt", "base");
        const firstStarted = deferred();
        const firstAllowed = deferred();
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                if (writeFile.mock.calls.length === 1) {
                    firstStarted.resolve();
                    await firstAllowed.promise;
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const closing = await backend.open("/release-cutoff.txt", {
            write: true,
            append: true,
        });
        const sibling = await backend.open("/release-cutoff.txt", {
            read: true,
            write: true,
            append: true,
        });
        await backend.write(closing, encode("A"), 0);

        const releasing = backend.release(closing);
        await firstStarted.promise;
        await backend.write(sibling, encode("B"), 0);
        firstAllowed.resolve();
        await releasing;

        expect(writeFile).toHaveBeenCalledOnce();
        expect(decode(await fs.readFile("/release-cutoff.txt"))).toBe("baseA");
        expect(decode(await backend.read(sibling, 1024, 0))).toBe("baseAB");

        await backend.release(sibling);
        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(decode(await fs.readFile("/release-cutoff.txt"))).toBe("baseAB");
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
        expect(await backend.readdir(`/${CONFLICTS_DIR}`)).toEqual([
            { name: conflictName, kind: "directory" },
        ]);
        expect(
            (await backend.readdir(`/${CONFLICTS_DIR}/${conflictName}`)).sort(
                (a, b) => a.name.localeCompare(b.name)
            )
        ).toEqual(
            [left.id, right.id]
                .sort((a, b) => a.localeCompare(b))
                .map((name) => ({ name, kind: "file" }))
        );
        const conflictEntries = await backend.readdir(`/${CONFLICTS_DIR}`, {
            includeStats: true,
        });
        expect(conflictEntries.map((entry) => entry.name)).toEqual([
            conflictName,
        ]);
        expect(conflictEntries[0]).toMatchObject({
            kind: "directory",
            stat: {
                size: 0,
                mode: 0o040755,
                nlink: 2,
            },
        });
        const versionEntries = await backend.readdir(
            `/${CONFLICTS_DIR}/${conflictName}`,
            { includeStats: true }
        );
        expect(versionEntries.map((entry) => entry.name).sort()).toEqual(
            [left.id, right.id].sort()
        );
        const versionsById = new Map(
            (await fs.versions("/note.txt")).map((version) => [
                version.id,
                version,
            ])
        );
        for (const entry of versionEntries) {
            const version = versionsById.get(entry.name)!;
            expect(entry.stat).toEqual({
                size: Number(version.size),
                mode: 0o100644,
                mtimeMs: Number(version.mtime),
                ctimeMs: Number(version.mtime),
                nlink: 1,
            });
        }

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
        const client = createIpcV2TestClient(server);
        try {
            await client.mkdir("/ipc");
            const handle = await client.open(
                "/ipc/file.txt",
                { write: true, create: true, truncate: true },
                0o755
            );
            const sharedBacking = new SharedArrayBuffer(12);
            const framed = new Uint8Array(sharedBacking, 2, 8);
            framed.set(encode("over ipc"));
            await client.write(handle, framed, 0);
            await client.release(handle);

            const stat = await client.getattr("/ipc/file.txt");
            expect(stat.kind).toBe("file");
            expect(stat.size).toBe("over ipc".length);
            expect(await client.readdir("/ipc")).toEqual([
                { name: "file.txt", kind: "file" },
            ]);
            const [dirent] = await client.readdir("/ipc", {
                includeStats: true,
            });
            expect(dirent).toMatchObject({
                name: "file.txt",
                kind: "file",
                stat: {
                    size: "over ipc".length,
                    mode: 0o100755,
                    nlink: 1,
                },
            });
            expect(decode(await fs.readFile("/ipc/file.txt"))).toBe("over ipc");

            // A v2 read body is a view into a larger socket chunk. Writing a
            // subarray back must honor its view bounds and never leak the
            // surrounding bytes.
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
            await client.close();
            await server.close();
        }
    });

    it("returns read snapshots isolated from callers and later mutations", async () => {
        await fs.writeFile("/owned.txt", "hello");
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                // Exercise Buffer-backed handles: Buffer.slice/subarray would
                // preserve the alias even though Buffer is a Uint8Array.
                readVersionForMount: readVersionAs(fs, Buffer.from("hello")),
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
        await fs.writeFile("/trunc.txt", "long original content", {
            mtime: 1000,
        });

        // ftruncate-style: shrink via an open handle, then commit. The
        // truncate alone advances mtime, and fstat equals the stat after.
        const handle = await backend.open("/trunc.txt", {
            read: true,
            write: true,
        });
        await backend.truncate(handle, 4);
        const fstat = await backend.getattr("/trunc.txt");
        expect(fstat.mtimeMs).toBeGreaterThan(1000);
        await backend.release(handle);
        expect(decode(await fs.readFile("/trunc.txt"))).toBe("long");
        expect(await backend.getattr("/trunc.txt")).toEqual(fstat);

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
            read: true,
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

    it("publishes identical-bytes saves with an advanced mtime but mints nothing for a bare flush", async () => {
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
        // An old stored mtime keeps every save below in a later millisecond.
        const seed = await fs.writeFile("/stable.txt", "same content", {
            mtime: 1000,
        });
        const chunkIds = await chunkIdsOf(fs, seed.id);
        const versionCount = async () =>
            (await fs.versions("/stable.txt")).length;

        // A flush with no write mints nothing.
        const handle = await backend.open("/stable.txt", {
            read: true,
            write: true,
        });
        await backend.flush(handle);
        await backend.fsync(handle);
        await backend.release(handle);
        expect(await versionCount()).toBe(1);
        expect(writeFile).not.toHaveBeenCalled();

        // Any write, even of identical bytes, advances mtime (make, rsync
        // and git's stat cache depend on it) and publishes one version
        // across flush+release, with fstat before close equal to the stat
        // after it.
        const rewrite = await backend.open("/stable.txt", {
            read: true,
            write: true,
        });
        await backend.write(rewrite, encode("same content"), 0);
        const fstat = await backend.getattr("/stable.txt");
        await backend.flush(rewrite);
        await backend.release(rewrite);
        expect(await versionCount()).toBe(2);
        expect(fstat.mtimeMs).toBeGreaterThan(1000);
        expect(await backend.getattr("/stable.txt")).toEqual(fstat);

        // O_TRUNC rewrite with identical content (shell `> file`, editors
        // that rewrite in place) publishes one version too.
        await fs.setMetadata("/stable.txt", { mtime: 1000 });
        const truncated = await backend.open("/stable.txt", {
            write: true,
            truncate: true,
        });
        await backend.write(truncated, encode("same content"), 0);
        await backend.release(truncated);
        expect(await versionCount()).toBe(4);
        expect(
            Number((await fs.stat("/stable.txt"))!.updatedAt)
        ).toBeGreaterThan(1000);

        // Every identical-bytes version reuses the source's chunks.
        for (const version of await fs.versions("/stable.txt")) {
            expect(await chunkIdsOf(fs, version.id)).toEqual(chunkIds);
        }
        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(writeFile.mock.calls[0]?.[2]).toMatchObject({
            noOpIfHeadVersionIds: expect.any(Array),
            mtime: fstat.mtimeMs,
        });
    });

    it("creates with the create mode's exec bit and keeps fstat equal to the stat after close", async () => {
        const backend = createSharedFsMountBackend(fs);
        const handle = await backend.open(
            "/tool.sh",
            { write: true, create: true, exclusive: true },
            0o755
        );
        await backend.write(handle, encode("#!/bin/sh\n"), 0);
        const fstat = await backend.getattr("/tool.sh");
        expect(fstat).toMatchObject({ kind: "file", mode: 0o100755 });
        await backend.release(handle);
        expect(await backend.getattr("/tool.sh")).toEqual(fstat);
        expect(await fs.stat("/tool.sh")).toMatchObject({
            mode: 0o100755,
            updatedAt: BigInt(fstat.mtimeMs),
        });

        const plain = await backend.open(
            "/plain.txt",
            { write: true, create: true },
            0o666
        );
        await backend.release(plain);
        expect(await backend.getattr("/plain.txt")).toMatchObject({
            mode: 0o100644,
        });
    });

    it("folds chmod and utimens into a pending create or write as one version", async () => {
        const writeFile = vi.fn(
            (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => fs.writeFile(path, source, options)
        );
        const setMetadata = vi.fn(
            (
                path: string,
                patch: { mode?: 0o100644 | 0o100755; mtime?: number },
                options?: { expectedNodeId?: string }
            ) => fs.setMetadata(path, patch, options)
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile, setMetadata })
        );
        // git's config.lock: O_EXCL create, chmod, write, close, rename.
        await backend.mkdir("/.git");
        const lock = await backend.open(
            "/.git/config.lock",
            { write: true, create: true, exclusive: true },
            0o666
        );
        await backend.setattr("/.git/config.lock", { mode: 0o755 });
        expect((await backend.getattr("/.git/config.lock")).mode).toBe(
            0o100755
        );
        await backend.write(lock, encode("[core]\n"), 0);
        await backend.release(lock);
        await backend.rename("/.git/config.lock", "/.git/config");
        expect(await fs.versions("/.git/config")).toHaveLength(1);
        expect(await fs.stat("/.git/config")).toMatchObject({
            mode: 0o100755,
        });

        // cp -p: write, then futimens before close.
        const copy = await backend.open("/copy.txt", {
            write: true,
            create: true,
        });
        await backend.write(copy, encode("copy"), 0);
        await backend.setattr("/copy.txt", { mtimeMs: 946684800000 });
        await backend.release(copy);
        expect(await fs.versions("/copy.txt")).toHaveLength(1);
        expect(await fs.stat("/copy.txt")).toMatchObject({
            updatedAt: 946684800000n,
        });
        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(setMetadata).not.toHaveBeenCalled();

        // utimens then write: the write time wins.
        const edit = await backend.open("/copy.txt", {
            read: true,
            write: true,
        });
        await backend.setattr("/copy.txt", { mtimeMs: 1000 });
        const before = Date.now();
        await backend.write(edit, encode("edit"), 0);
        await backend.release(edit);
        expect(
            Number((await fs.stat("/copy.txt"))!.updatedAt)
        ).toBeGreaterThanOrEqual(before);

        // cp -p over a file that already has the source's mtime (npm's
        // 1985 epoch, SOURCE_DATE_EPOCH): the explicit time is kept.
        const epoch = 499162500000;
        await fs.writeFile("/pkg.js", "old", { mtime: epoch });
        const pkg = await backend.open("/pkg.js", {
            write: true,
            truncate: true,
        });
        await backend.write(pkg, encode("new"), 0);
        await backend.setattr("/pkg.js", { mtimeMs: epoch });
        const fstat = await backend.getattr("/pkg.js");
        expect(fstat.mtimeMs).toBe(epoch);
        await backend.release(pkg);
        expect(await backend.getattr("/pkg.js")).toEqual(fstat);
    });

    it("sets metadata of closed files without reading or writing their bytes", async () => {
        const readVersionForMount = vi.fn((path: string, versionId: string) =>
            fs.readVersionForMount(path, versionId)
        );
        const writeFile = vi.fn(
            (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => fs.writeFile(path, source, options)
        );
        const setMetadata = vi.fn(
            (
                path: string,
                patch: { mode?: 0o100644 | 0o100755; mtime?: number },
                options?: { expectedNodeId?: string }
            ) => fs.setMetadata(path, patch, options)
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { readVersionForMount, writeFile, setMetadata })
        );
        const seed = await fs.writeFile("/run.sh", "echo hi");
        // chmod keeps only the exec bit; any x bit gives 0755.
        await backend.setattr("/run.sh", { mode: 0o744 });
        expect(await backend.getattr("/run.sh")).toMatchObject({
            mode: 0o100755,
        });
        await backend.setattr("/run.sh", { mode: 0o600 });
        expect(await backend.getattr("/run.sh")).toMatchObject({
            mode: 0o100644,
        });
        await backend.setattr("/run.sh", { mtimeMs: 946684800000 });
        expect(await backend.getattr("/run.sh")).toMatchObject({
            mtimeMs: 946684800000,
            ctimeMs: 946684800000,
        });
        // Values equal to the entry change nothing.
        await backend.setattr("/run.sh", {
            mode: 0o644,
            mtimeMs: 946684800000,
        });
        expect(setMetadata.mock.calls).toEqual([
            ["/run.sh", { mode: 0o100755 }, { expectedNodeId: seed.nodeId }],
            ["/run.sh", { mode: 0o100644 }, { expectedNodeId: seed.nodeId }],
            [
                "/run.sh",
                { mtime: 946684800000 },
                { expectedNodeId: seed.nodeId },
            ],
        ]);
        expect(readVersionForMount).not.toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
        expect(await fs.versions("/run.sh")).toHaveLength(4);
        expect(decode(await fs.readFile("/run.sh"))).toBe("echo hi");

        // Directories, the root and symlinks ignore chmod and utimens.
        await fs.mkdir("/dir");
        await fs.writeFile("/link", "run.sh", { mode: 0o120000 });
        for (const path of ["/", "/dir", "/link"]) {
            await backend.setattr(path, { mode: 0o755, mtimeMs: 1 });
        }
        expect(setMetadata).toHaveBeenCalledTimes(3);
        await expect(
            backend.setattr(`/${CONFLICTS_DIR}`, { mode: 0o755 })
        ).rejects.toMatchObject({ code: "EROFS" });
        await expect(
            backend.setattr("/missing", { mode: 0o755 })
        ).rejects.toMatchObject({ code: "ENOENT" });
        for (const mode of [0o10000, -1, 1.5, "x"] as unknown as number[]) {
            await expect(
                backend.setattr("/run.sh", { mode })
            ).rejects.toMatchObject({ code: "EINVAL" });
            await expect(
                backend.open("/new.txt", { write: true, create: true }, mode)
            ).rejects.toMatchObject({ code: "EINVAL" });
        }
        expect(await fs.stat("/new.txt")).toBeUndefined();
    });

    it("rebases open clean files onto a chmod without republishing their bytes", async () => {
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
        await fs.writeFile("/open.sh", "v1");
        const handle = await backend.open("/open.sh", {
            read: true,
            write: true,
        });
        await backend.setattr("/open.sh", { mode: 0o755 });
        expect(writeFile).not.toHaveBeenCalled();
        await backend.write(handle, encode("v2"), 0);
        const fstat = await backend.getattr("/open.sh");
        expect(fstat.mode).toBe(0o100755);
        await backend.release(handle);
        expect(await backend.getattr("/open.sh")).toEqual(fstat);
        const heads = (await fs.versions("/open.sh")).filter(
            (version) => version.head
        );
        expect(heads).toHaveLength(1);
        expect(heads[0]).toMatchObject({ mode: 0o100755 });
        expect(decode(await fs.readFile("/open.sh"))).toBe("v2");

        // A stale clean descriptor never publishes its old bytes.
        await fs.writeFile("/stale.sh", "old");
        const stale = await backend.open("/stale.sh", {
            read: true,
            write: true,
        });
        await fs.writeFile("/stale.sh", "newer");
        await backend.setattr("/stale.sh", { mode: 0o755 });
        await backend.release(stale);
        expect(await fs.conflicts("/stale.sh")).toEqual([]);
        expect(decode(await fs.readFile("/stale.sh"))).toBe("newer");
        expect(await fs.stat("/stale.sh")).toMatchObject({ mode: 0o100755 });
        expect(writeFile).toHaveBeenCalledOnce();
    });

    it("keeps a chmodded fd's base unless the chmod copied that fd's bytes", async () => {
        const headsOf = async (path: string) =>
            Promise.all(
                (await fs.versions(path))
                    .filter((version) => version.head)
                    .map(async (version) => ({
                        bytes: decode(await fs.readVersion(path, version.id)),
                        mode: version.mode,
                    }))
            );
        // A peer's edit, already 0755, lands before the chmod reads the
        // heads, so the equal chmod returns that edit as is.
        const base = await fs.writeFile("/s.sh", "base");
        let peerEdit = true;
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                setMetadata: async (path, patch, options) => {
                    if (path === "/s.sh" && peerEdit) {
                        peerEdit = false;
                        await fs.writeFile(path, "remote", {
                            mode: 0o100755,
                            baseVersionIds: [base.id],
                        });
                    }
                    return fs.setMetadata(path, patch, options);
                },
            })
        );
        const handle = await backend.open("/s.sh", {
            read: true,
            write: true,
        });
        await backend.setattr("/s.sh", { mode: 0o755 });
        await backend.write(handle, encode("-local"), 4);
        await backend.release(handle);
        expect(await headsOf("/s.sh")).toEqual(
            expect.arrayContaining([
                { bytes: "base-local", mode: 0o100755 },
                { bytes: "remote", mode: 0o100755 },
            ])
        );

        // A stale fd's chmod copies the newer bytes; the fd's own fork
        // still carries the exec bit it showed.
        await fs.writeFile("/t.sh", "old");
        const stale = await backend.open("/t.sh", {
            read: true,
            write: true,
        });
        await fs.writeFile("/t.sh", "remote-newer");
        await backend.setattr("/t.sh", { mode: 0o755 });
        await backend.write(stale, encode("LOCAL"), 0);
        expect((await backend.getattr("/t.sh")).mode).toBe(0o100755);
        await backend.release(stale);
        expect(await headsOf("/t.sh")).toEqual(
            expect.arrayContaining([
                { bytes: "LOCAL", mode: 0o100755 },
                { bytes: "remote-newer", mode: 0o100755 },
            ])
        );
    });

    it("keeps a remote chmod across an open fd's commits and rebases its fstat", async () => {
        const backend = createSharedFsMountBackend(fs);
        // A remote chmod +x survives the fd's edit, and the flush rebases
        // the fd so its next dirty fstat equals the stat after close.
        await fs.writeFile("/r.sh", "v1");
        const handle = await backend.open("/r.sh", {
            read: true,
            write: true,
        });
        await fs.setMetadata("/r.sh", { mode: 0o100755 });
        await backend.write(handle, encode("v2"), 0);
        await backend.flush(handle);
        expect(await fs.stat("/r.sh")).toMatchObject({ mode: 0o100755 });
        await backend.write(handle, encode("v3"), 0);
        const fstat = await backend.getattr("/r.sh");
        expect(fstat.mode).toBe(0o100755);
        await backend.release(handle);
        expect(await backend.getattr("/r.sh")).toEqual(fstat);

        // A committed local chmod becomes the base, so a later remote
        // chmod -x survives the fd's next write.
        await fs.writeFile("/p.sh", "v1");
        const edit = await backend.open("/p.sh", { read: true, write: true });
        await backend.write(edit, encode("v2"), 0);
        await backend.setattr("/p.sh", { mode: 0o755 });
        await backend.flush(edit);
        expect(await fs.stat("/p.sh")).toMatchObject({ mode: 0o100755 });
        await fs.setMetadata("/p.sh", { mode: 0o100644 });
        await backend.write(edit, encode("v3"), 0);
        await backend.release(edit);
        expect(await fs.stat("/p.sh")).toMatchObject({ mode: 0o100644 });
        expect(await fs.conflicts("/p.sh")).toEqual([]);
    });

    it("rejects a rename that overlaps a chmod of an open file", async () => {
        const entered = deferred();
        const allowed = deferred();
        const setMetadata = vi.fn(
            async (
                path: string,
                patch: { mode?: 0o100644 | 0o100755; mtime?: number },
                options?: { expectedNodeId?: string }
            ) => {
                entered.resolve();
                await allowed.promise;
                return fs.setMetadata(path, patch, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { setMetadata })
        );
        await fs.writeFile("/busy.sh", "x");
        const handle = await backend.open("/busy.sh", { read: true });
        const chmod = backend.setattr("/busy.sh", { mode: 0o755 });
        await entered.promise;
        await expect(
            backend.rename("/busy.sh", "/moved.sh")
        ).rejects.toMatchObject({ code: "EAGAIN" });
        allowed.resolve();
        await chmod;
        await backend.rename("/busy.sh", "/moved.sh");
        await backend.release(handle);
        expect(await fs.stat("/moved.sh")).toMatchObject({ mode: 0o100755 });
    });

    it("creates, reads, lists, replaces and removes symlinks without following them", async () => {
        const backend = createSharedFsMountBackend(fs);
        await backend.mkdir("/bin");
        // Targets are opaque: a dangling relative target is fine.
        await backend.symlink("../lib/tool.js", "/bin/tool");
        expect(await backend.readlink("/bin/tool")).toBe("../lib/tool.js");
        const {
            path: _path,
            kind,
            ...lstat
        } = await backend.getattr("/bin/tool");
        expect(kind).toBe("symlink");
        expect(lstat).toMatchObject({
            mode: 0o120777,
            size: "../lib/tool.js".length,
            nlink: 1,
        });
        expect(await backend.readdir("/bin", { includeStats: true })).toEqual([
            { name: "tool", kind: "symlink", stat: lstat },
        ]);
        expect(await fs.stat("/bin/tool")).toMatchObject({
            kind: "file",
            mode: 0o120000,
        });

        for (const [target, path, code] of [
            ["x", "/bin/tool", "EEXIST"],
            ["x", "/", "EEXIST"],
            ["x", "/missing/link", "ENOENT"],
            ["", "/bin/empty", "EINVAL"],
            ["x", `/${CONFLICTS_DIR}/link`, "EROFS"],
        ]) {
            await expect(backend.symlink(target, path)).rejects.toMatchObject({
                code,
            });
        }
        await expect(
            backend.open("/bin/tool", { read: true })
        ).rejects.toMatchObject({ code: "EINVAL" });
        for (const [path, code] of [
            ["/bin", "EINVAL"],
            ["/", "EINVAL"],
            ["/bin/none", "ENOENT"],
        ]) {
            await expect(backend.readlink(path)).rejects.toMatchObject({
                code,
            });
        }
        await expect(backend.rmdir("/bin/tool")).rejects.toMatchObject({
            code: "ENOTDIR",
        });

        // ln -sf is symlink(tmp) plus rename, over a link and over a file.
        await backend.symlink("../lib/v2.js", "/bin/tool.tmp");
        await backend.rename("/bin/tool.tmp", "/bin/tool");
        expect(await backend.readlink("/bin/tool")).toBe("../lib/v2.js");
        await fs.writeFile("/bin/file", "bytes");
        await backend.rename("/bin/tool", "/bin/file");
        expect(await backend.readlink("/bin/file")).toBe("../lib/v2.js");
        await backend.unlink("/bin/file");
        expect(await backend.readdir("/bin")).toEqual([]);
    });

    it("answers readlink and symlink races from the path's new binding", async () => {
        let race: (() => Promise<unknown>) | undefined;
        const takeRace = async () => {
            const pending = race;
            race = undefined;
            await pending?.();
        };
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                readVersionForMount: async (path, versionId) => {
                    await takeRace();
                    return fs.readVersionForMount(path, versionId);
                },
                writeFile: async (path, source, options) => {
                    await takeRace();
                    return fs.writeFile(path, source, options);
                },
            })
        );
        await backend.mkdir("/bin");
        await backend.symlink("v1", "/bin/tool");
        // ln -sf (symlink tmp + rename over), unlink, or a file renamed
        // over the link between readlink's lookup and its read.
        race = async () => {
            await fs.writeFile("/bin/tool.tmp", "v2", { mode: 0o120000 });
            await backend.rename("/bin/tool.tmp", "/bin/tool");
        };
        expect(await backend.readlink("/bin/tool")).toBe("v2");
        race = () => backend.unlink("/bin/tool");
        await expect(backend.readlink("/bin/tool")).rejects.toMatchObject({
            code: "ENOENT",
        });
        await fs.writeFile("/bin/tool", "v3", { mode: 0o120000 });
        race = async () => {
            await fs.writeFile("/bin/file", "bytes");
            await backend.rename("/bin/file", "/bin/tool");
        };
        await expect(backend.readlink("/bin/tool")).rejects.toMatchObject({
            code: "EINVAL",
        });

        // A racing ln -s wins the name: EEXIST, and its entry is kept.
        race = () => fs.writeFile("/bin/raced", "winner");
        await expect(backend.symlink("x", "/bin/raced")).rejects.toMatchObject({
            code: "EEXIST",
        });
        expect(decode(await fs.readFile("/bin/raced"))).toBe("winner");
        // A link never lands in a directory that replaced its parent.
        await fs.mkdir("/lib");
        race = async () => {
            await fs.rm("/lib");
            await fs.mkdir("/lib");
        };
        await expect(backend.symlink("x", "/lib/late")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(await fs.stat("/lib/late")).toBeUndefined();
    });

    it("fails readlink with EIO when the target is unavailable and shows link conflicts as regular files", async () => {
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { readVersionForMount: async () => undefined })
        );
        const base = await fs.writeFile("/link", "a", { mode: 0o120000 });
        await expect(backend.readlink("/link")).rejects.toMatchObject({
            code: "EIO",
        });
        const left = await fs.writeFile("/link", "left", {
            mode: 0o120000,
            baseVersionIds: [base.id],
        });
        await fs.writeFile("/link", "right", {
            mode: 0o120000,
            baseVersionIds: [base.id],
        });
        const dir = `/${CONFLICTS_DIR}/${encodeConflictPathName("/link")}`;
        expect(await backend.getattr(`${dir}/${left.id}`)).toEqual({
            path: `${dir}/${left.id}`,
            kind: "file",
            size: 4,
            mode: 0o100644,
            mtimeMs: Number(left.mtime),
            ctimeMs: Number(left.mtime),
            nlink: 1,
        });
        for (const entry of await backend.readdir(dir, {
            includeStats: true,
        })) {
            expect(entry).toMatchObject({
                kind: "file",
                stat: { mode: 0o100644 },
            });
        }
    });

    it("stats entries without a mode as 0644 and keeps root and conflict directory times stable while their names do not change", async () => {
        await fs.writeFile("/plain.txt", "x");
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                stat: async (path) => {
                    const entry = await fs.stat(path);
                    return entry && { ...entry, mode: undefined };
                },
                list: async (path) =>
                    (await fs.list(path)).map((entry) => ({
                        ...entry,
                        mode: undefined,
                    })),
            }),
            // A frozen clock: only name changes can move directory times,
            // which stay at most a second ahead of it.
            { clock: () => 1_000_500 }
        );
        expect(await backend.getattr("/plain.txt")).toMatchObject({
            kind: "file",
            mode: 0o100644,
        });
        const listed = await backend.readdir("/", { includeStats: true });
        expect(
            listed.find((entry) => entry.name === "plain.txt")
        ).toMatchObject({ kind: "file", stat: { mode: 0o100644 } });

        const base = await fs.writeFile("/c.txt", "base");
        for (const side of ["left", "right"]) {
            await fs.writeFile("/c.txt", side, { baseVersionIds: [base.id] });
        }
        const perPath = `/${CONFLICTS_DIR}/${encodeConflictPathName("/c.txt")}`;
        const times = async () => ({
            root: await backend.getattr("/"),
            conflicts: await backend.getattr(`/${CONFLICTS_DIR}`),
            conflict: await backend.getattr(perPath),
            listedConflicts: (
                await backend.readdir("/", { includeStats: true })
            ).find((entry) => entry.name === CONFLICTS_DIR)?.stat,
            listedConflict: (
                await backend.readdir(`/${CONFLICTS_DIR}`, {
                    includeStats: true,
                })
            ).map((entry) => entry.stat),
        });
        const before = await times();
        expect(await times()).toEqual(before);
        // Every conflict directory shares one stamp; listings repeat it.
        expect(before.conflict.mtimeMs).toBe(before.conflicts.mtimeMs);
        expect(before.conflicts.ctimeMs).toBe(before.conflicts.mtimeMs);
        expect(before.listedConflicts?.mtimeMs).toBe(before.conflicts.mtimeMs);
        expect(before.listedConflict).toEqual([
            {
                size: 0,
                mode: 0o040755,
                mtimeMs: before.conflicts.mtimeMs,
                ctimeMs: before.conflicts.mtimeMs,
                nlink: 2,
            },
        ]);

        // A third conflicting head changes the conflict directories only.
        await fs.writeFile("/c.txt", "third", { baseVersionIds: [base.id] });
        const forked = await times();
        expect(forked.conflicts.mtimeMs).toBeGreaterThan(
            before.conflicts.mtimeMs
        );
        expect(forked.conflict.mtimeMs).toBe(forked.conflicts.mtimeMs);
        expect(forked.root).toEqual(before.root);

        // A content write keeps `/`; a top-level create moves it.
        await fs.writeFile("/plain.txt", "edited");
        expect(await backend.getattr("/")).toEqual(before.root);
        await fs.writeFile("/created.txt", "new");
        expect((await backend.getattr("/")).mtimeMs).toBeGreaterThan(
            before.root.mtimeMs
        );
    });

    it("publishes a capable rewrite when heads advance inside target.writeFile", async () => {
        const original = await fs.writeFile(
            "/capable-head-race.txt",
            "original"
        );
        const entered = deferred();
        const allowed = deferred();
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                entered.resolve();
                await allowed.promise;
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/capable-head-race.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("original"), 0);

        const flushing = backend.flush(handle);
        await entered.promise;
        const concurrent = await fs.writeFile(
            "/capable-head-race.txt",
            "concurrent"
        );
        allowed.resolve();
        await flushing;
        await backend.release(handle);

        const heads = (await fs.versions("/capable-head-race.txt")).filter(
            (version) => version.head
        );
        expect(heads.map((version) => version.id)).toContain(concurrent.id);
        const mounted = heads.find((version) => version.id !== concurrent.id)!;
        expect(mounted.parentVersionIds).toEqual([original.id]);
        expect(
            decode(await fs.readVersion("/capable-head-race.txt", mounted.id))
        ).toBe("original");
    });

    it("rejects a capable commit after the opened path is replaced", async () => {
        await fs.writeFile("/capable-replaced.txt", "original");
        const backend = createSharedFsMountBackend(fs);
        const handle = await backend.open("/capable-replaced.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("edited!!"), 0);
        await fs.rm("/capable-replaced.txt");
        await fs.writeFile("/capable-replaced.txt", "replacement");

        await expect(backend.release(handle)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(decode(await fs.readFile("/capable-replaced.txt"))).toBe(
            "replacement"
        );
    });

    it("keeps a concurrent mutation dirty after a capable no-op", async () => {
        await fs.writeFile("/capable-buffer-race.txt", "base");
        const entered = deferred();
        const allowed = deferred();
        let calls = 0;
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                calls++;
                if (calls === 1) {
                    entered.resolve();
                    await allowed.promise;
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/capable-buffer-race.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("base"), 0);
        // Restoring the opened mtime leaves nothing to publish.
        await backend.setattr("/capable-buffer-race.txt", {
            mtimeMs: Number(
                (await fs.stat("/capable-buffer-race.txt"))!.updatedAt
            ),
        });

        const flushing = backend.flush(handle);
        await entered.promise;
        await backend.write(handle, encode("next"), 0);
        allowed.resolve();
        await flushing;
        expect(decode(await fs.readFile("/capable-buffer-race.txt"))).toBe(
            "base"
        );

        await backend.release(handle);
        expect(decode(await fs.readFile("/capable-buffer-race.txt"))).toBe(
            "next"
        );
        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(await writeFile.mock.results[0]!.value).toMatchObject({
            mountWriteOutcome: "unchanged",
        });
    });

    it("protects capable no-op input retained by a forwarding target", async () => {
        const openedBytes = encode("base");
        await fs.writeFile("/capable-retained-noop.txt", openedBytes.slice());
        const retained: Uint8Array[] = [];
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                if (!(source instanceof Uint8Array)) {
                    throw new Error("mount commits must use Uint8Array input");
                }
                retained.push(source);
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                readVersionForMount: readVersionAs(fs, openedBytes),
                writeFile,
            })
        );
        const handle = await backend.open("/capable-retained-noop.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("base"), 0);
        // Restoring the opened mtime leaves nothing to publish.
        await backend.setattr("/capable-retained-noop.txt", {
            mtimeMs: Number(
                (await fs.stat("/capable-retained-noop.txt"))!.updatedAt
            ),
        });
        await backend.flush(handle);
        expect(writeFile).toHaveBeenCalledOnce();
        expect(await writeFile.mock.results[0]!.value).toMatchObject({
            mountWriteOutcome: "unchanged",
        });
        expect(decode(retained[0])).toBe("base");

        await backend.write(handle, encode("next"), 0);
        expect(decode(retained[0])).toBe("base");
        await backend.release(handle);
        expect(decode(retained[0])).toBe("base");
        expect(decode(await fs.readFile("/capable-retained-noop.txt"))).toBe(
            "next"
        );
    });

    it("keeps capability input protected when an outcome is missing", async () => {
        const openedBytes = encode("base");
        await fs.writeFile("/capable-invalid-outcome.txt", openedBytes.slice());
        const retained: Uint8Array[] = [];
        const committedIds: string[] = [];
        let calls = 0;
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                if (!(source instanceof Uint8Array)) {
                    throw new Error("mount commits must use Uint8Array input");
                }
                calls++;
                retained.push(source);
                const result = await fs.writeFile(path, source, options);
                committedIds.push(result.id);
                if (calls === 1) {
                    const { mountWriteOutcome: _outcome, ...metadata } = result;
                    return metadata;
                }
                return result;
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                readVersionForMount: readVersionAs(fs, openedBytes),
                writeFile,
            })
        );
        const handle = await backend.open("/capable-invalid-outcome.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("old!"), 0);

        await expect(backend.flush(handle)).rejects.toMatchObject({
            code: "EIO",
            message: expect.stringContaining("invalid metadata"),
        });
        await backend.write(handle, encode("new!"), 0);
        expect(decode(retained[0])).toBe("old!");

        await backend.release(handle);
        expect(decode(retained[0])).toBe("old!");
        expect(
            decode(
                await fs.readVersion(
                    "/capable-invalid-outcome.txt",
                    committedIds[1]
                )
            )
        ).toBe("new!");
        expect(
            (await fs.versions("/capable-invalid-outcome.txt")).filter(
                (version) => version.head
            )
        ).toHaveLength(2);
    });

    it("keeps rejected capable input protected before retry", async () => {
        const openedBytes = encode("base");
        await fs.writeFile("/capable-rejection.txt", openedBytes.slice());
        const retained: Uint8Array[] = [];
        let calls = 0;
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                if (!(source instanceof Uint8Array)) {
                    throw new Error("mount commits must use Uint8Array input");
                }
                calls++;
                retained.push(source);
                if (calls === 1) {
                    throw new Error("injected capable rejection");
                }
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                readVersionForMount: readVersionAs(fs, openedBytes),
                writeFile,
            })
        );
        const handle = await backend.open("/capable-rejection.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("old!"), 0);

        await expect(backend.flush(handle)).rejects.toMatchObject({
            code: "EIO",
            message: "injected capable rejection",
        });
        await backend.write(handle, encode("new!"), 0);
        expect(decode(retained[0])).toBe("old!");
        await backend.release(handle);
        expect(decode(retained[0])).toBe("old!");
        expect(decode(await fs.readFile("/capable-rejection.txt"))).toBe(
            "new!"
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

    it("parses numeric open flags with per-platform constants", () => {
        for (const platform of ["linux", "darwin", "win32"] as const) {
            expect(parseFlags(0, platform)).toMatchObject({
                read: true,
                write: false,
            });
            expect(parseFlags(0x1, platform)).toMatchObject({
                read: false,
                write: true,
            });
            expect(parseFlags(0x2, platform)).toMatchObject({
                read: true,
                write: true,
            });
            expect(parseFlags(0x3, platform)).toMatchObject({
                read: false,
                write: false,
            });
        }
        // Linux x64/arm64: WRONLY|CREAT|EXCL|TRUNC|APPEND.
        expect(parseFlags(0o3301, "linux")).toEqual({
            read: false,
            write: true,
            create: true,
            exclusive: true,
            truncate: true,
            append: true,
        });
        // Darwin uses compact O_APPEND but shifts creation flags upward.
        expect(parseFlags(0xe09, "darwin")).toEqual({
            read: false,
            write: true,
            create: true,
            exclusive: true,
            truncate: true,
            append: true,
        });
        // MSVC CRT / WinFsp: WRONLY|CREAT|EXCL|TRUNC|APPEND.
        expect(parseFlags(0x709, "win32")).toEqual({
            read: false,
            write: true,
            create: true,
            exclusive: true,
            truncate: true,
            append: true,
        });
        expect(parseFlags("wx")).toEqual({
            read: false,
            write: true,
            create: true,
            exclusive: true,
            truncate: true,
            append: false,
        });
        expect(parseFlags("ax+")).toEqual({
            read: true,
            write: true,
            create: true,
            exclusive: true,
            truncate: false,
            append: true,
        });
    });

    it("round-trips backend calls through TCP IPC for external adapters", async () => {
        const backend = createSharedFsMountBackend(fs);
        const server = await createSharedFsIpcServer(
            backend,
            "tcp://127.0.0.1:0"
        );
        const client = createIpcV2TestClient(server);
        try {
            expect(server.endpoint).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/);
            await client.mkdir("/tcp");
            const handle = await client.open("/tcp/file.txt", {
                write: true,
                create: true,
                truncate: true,
            });
            await client.write(handle, encode("over tcp"), 0);
            await client.release(handle);

            expect(decode(await fs.readFile("/tcp/file.txt"))).toBe("over tcp");

            const numericFlags =
                process.platform === "darwin"
                    ? 0xe09
                    : process.platform === "win32"
                      ? 0x709
                      : 0o3301;
            const numeric = await client.open(
                "/tcp/numeric-exclusive-append.txt",
                numericFlags
            );
            await client.write(numeric, encode("numeric"), 9999);
            await client.release(numeric);
            expect(
                decode(await fs.readFile("/tcp/numeric-exclusive-append.txt"))
            ).toBe("numeric");
        } finally {
            await client.close();
            await server.close();
        }
    });

    it("closes retained IPC sessions during server shutdown", async () => {
        const backend = createSharedFsMountBackend(fs);
        const server = await createSharedFsIpcServer(
            backend,
            "tcp://127.0.0.1:0"
        );
        const socket = await connectIpcEndpoint(server.endpoint);
        socket.on("error", () => {});
        try {
            // A negotiated adapter connection stays open between requests.
            const { reader, limits } = await negotiateIpcV2(
                socket,
                server.token
            );
            await writeIpcV2Frame(
                socket,
                encodeIpcV2Frame(
                    IpcV2FrameKind.Request,
                    { id: 1, op: "getattr", args: ["/"] },
                    Buffer.alloc(0),
                    limits.maxRequestFrameBytes,
                    limits.maxMetadataBytes
                )
            );
            await expect(
                readIpcV2Response(reader, limits)
            ).resolves.toMatchObject({ metadata: { id: 1, ok: true } });

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
