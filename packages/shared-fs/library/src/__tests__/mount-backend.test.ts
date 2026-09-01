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
    SharedFsError,
    SharedFsHandle,
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

const capableMountTarget = (
    fs: SharedFsHandle,
    overrides: Partial<SharedFsMountBackendTarget> = {}
): SharedFsMountBackendTarget =>
    mountTarget(fs, {
        mountWriteSemantics: () => fs.mountWriteSemantics(),
        ...overrides,
    });

const verifiedReadMountTarget = (
    fs: SharedFsHandle,
    overrides: Partial<SharedFsMountBackendTarget> = {}
): SharedFsMountBackendTarget =>
    mountTarget(fs, {
        mountReadSemantics: () => fs.mountReadSemantics(),
        readVersionForMount: (path, versionId) =>
            fs.readVersionForMount(path, versionId),
        ...overrides,
    });

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
            readVersion: async () => openedBytes,
            writeFile,
        }),
        { writeFileInput: "immutable-borrowed" }
    );
    return { backend, firstStarted, firstAllowed, inputs, writeFile };
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

    it("uses a target-verified exact snapshot without calling the legacy reader", async () => {
        const written = await fs.writeFile("/verified-open.txt", "verified");
        const readVersion = vi.fn(async () => {
            throw new Error("legacy reader must not run");
        });
        const readVersionForMount = vi.fn((path: string, versionId: string) =>
            fs.readVersionForMount(path, versionId)
        );
        const backend = createSharedFsMountBackend(
            verifiedReadMountTarget(fs, {
                readVersion,
                readVersionForMount,
            })
        );

        const handle = await backend.open("/verified-open.txt", {
            read: true,
            write: true,
        });
        expect(decode(await backend.read(handle, 1024, 0))).toBe("verified");
        await backend.release(handle);

        expect(readVersion).not.toHaveBeenCalled();
        expect(readVersionForMount).toHaveBeenCalledOnce();
        expect(readVersionForMount).toHaveBeenCalledWith(
            "/verified-open.txt",
            written.id
        );
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
                verifiedReadMountTarget(fs, {
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

    it("requires an advertised exact reader but lets O_TRUNC bypass it", async () => {
        await fs.writeFile("/missing-capability-reader.txt", "old");
        const readVersion = vi.fn((path: string, versionId: string) =>
            fs.readVersion(path, versionId)
        );
        const target = verifiedReadMountTarget(fs, {
            readVersion,
            readVersionForMount: undefined,
        });
        const backend = createSharedFsMountBackend(target);

        await expect(
            backend.open("/missing-capability-reader.txt", {
                read: true,
                write: true,
            })
        ).rejects.toMatchObject({
            code: "EIO",
            message: expect.stringContaining(
                "missing its exact-version reader"
            ),
        });
        expect(readVersion).not.toHaveBeenCalled();

        const truncated = await backend.open("/missing-capability-reader.txt", {
            write: true,
            truncate: true,
        });
        await backend.write(truncated, encode("new"), 0);
        await backend.release(truncated);
        expect(readVersion).not.toHaveBeenCalled();
        expect(
            decode(await fs.readFile("/missing-capability-reader.txt"))
        ).toBe("new");
    });

    it("ignores an unknown read handshake and preserves the legacy fallback", async () => {
        const written = await fs.writeFile("/future-read.txt", "legacy");
        const readVersion = vi.fn((path: string, versionId: string) =>
            fs.readVersion(path, versionId)
        );
        const readVersionForMount = vi.fn(async () => {
            throw new Error("unknown capability must not run");
        });
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                mountReadSemantics: () =>
                    "verified-exact-version-snapshot-v2" as any,
                readVersion,
                readVersionForMount,
            })
        );

        const handle = await backend.open("/future-read.txt", {
            read: true,
            write: true,
        });
        await backend.release(handle);
        expect(readVersion).toHaveBeenCalledOnce();
        expect(readVersion).toHaveBeenCalledWith(
            "/future-read.txt",
            written.id
        );
        expect(readVersionForMount).not.toHaveBeenCalled();
    });

    it("does not let an inherited capability bypass an overridden exact reader", async () => {
        class ReadWrapper extends SharedFsHandle {
            override readVersion(path: string, versionId: string) {
                return super.readVersion(path, versionId);
            }
        }

        const written = await fs.writeFile("/wrapped-read.txt", "wrapped");
        const wrapped = new ReadWrapper(fs.program);
        expect(wrapped.mountReadSemantics()).toBeUndefined();
        const readVersion = vi.spyOn(wrapped, "readVersion");
        const readVersionForMount = vi.spyOn(wrapped, "readVersionForMount");

        const backend = createSharedFsMountBackend(wrapped);
        const handle = await backend.open("/wrapped-read.txt", {
            read: true,
            write: true,
        });
        await backend.release(handle);

        expect(readVersion).toHaveBeenCalledWith(
            "/wrapped-read.txt",
            written.id
        );
        expect(readVersionForMount).not.toHaveBeenCalled();
    });

    it("does not let an inherited capability bypass an overridden verified handle reader", async () => {
        class VerifiedReadWrapper extends SharedFsHandle {
            override readVersionForMount(path: string, versionId: string) {
                return super.readVersionForMount(path, versionId);
            }
        }

        const written = await fs.writeFile(
            "/wrapped-verified-read.txt",
            "wrapped"
        );
        const wrapped = new VerifiedReadWrapper(fs.program);
        expect(wrapped.mountReadSemantics()).toBeUndefined();
        const readVersion = vi.spyOn(wrapped, "readVersion");
        const readVersionForMount = vi.spyOn(wrapped, "readVersionForMount");

        const backend = createSharedFsMountBackend(wrapped);
        const handle = await backend.open("/wrapped-verified-read.txt", {
            read: true,
            write: true,
        });
        await backend.release(handle);

        expect(readVersion).toHaveBeenCalledWith(
            "/wrapped-verified-read.txt",
            written.id
        );
        expect(readVersionForMount).not.toHaveBeenCalled();
    });

    it("does not let an inherited capability bypass an overridden program reader", async () => {
        const written = await fs.writeFile(
            "/program-verified-read.txt",
            "program"
        );
        const programReadVersionForMount = vi.spyOn(
            fs.program,
            "readVersionForMount"
        );
        expect(fs.mountReadSemantics()).toBeUndefined();

        const backend = createSharedFsMountBackend(fs);
        const readVersion = vi.spyOn(fs, "readVersion");
        const handle = await backend.open("/program-verified-read.txt", {
            read: true,
            write: true,
        });
        await backend.release(handle);

        expect(readVersion).toHaveBeenCalledWith(
            "/program-verified-read.txt",
            written.id
        );
        // The custom program implementation may still run behind the legacy
        // reader; the mount nevertheless retains its own binding hash.
        expect(programReadVersionForMount).toHaveBeenCalledWith(
            "/program-verified-read.txt",
            written.id
        );
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
            verifiedReadMountTarget(fs, { readVersionForMount })
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
            code: "EAGAIN",
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
        await expect(
            backend.open("/ordinary-pending.txt", {
                write: true,
                create: true,
            })
        ).rejects.toMatchObject({ code: "EAGAIN" });
        await expect(
            backend.open("/ordinary-pending.txt", {
                write: true,
                create: true,
                exclusive: true,
            })
        ).rejects.toMatchObject({ code: "EEXIST" });
        await backend.release(ordinary);

        const exclusive = await backend.open("/exclusive-pending.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await expect(
            backend.open("/exclusive-pending.txt", {
                write: true,
                create: true,
            })
        ).rejects.toMatchObject({ code: "EAGAIN" });
        await expect(
            backend.open("/exclusive-pending.txt", {
                write: true,
                create: true,
                exclusive: true,
            })
        ).rejects.toMatchObject({ code: "EEXIST" });
        await backend.release(exclusive);
    });

    it("rejects an ancestor rename while a descendant create intent is pending", async () => {
        await fs.mkdir("/source");
        const rename = vi.fn((from: string, to: string) => fs.rename(from, to));
        const backend = createSharedFsMountBackend(mountTarget(fs, { rename }));
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
        expect(rename).not.toHaveBeenCalled();
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
        expect(rename).toHaveBeenCalledOnce();
        expect(decode(await fs.readFile("/moved/pending.txt"))).toBe("pending");
    });

    it("gates exact and descendant create intents at rename destinations", async () => {
        await fs.writeFile("/source.txt", "source");
        await fs.mkdir("/source-dir");
        await fs.mkdir("/destination-dir");
        const rename = vi.fn((from: string, to: string) => fs.rename(from, to));
        const rm = vi.fn((path: string) => fs.rm(path));
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { rename, rm })
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
        expect(rename).not.toHaveBeenCalled();
        expect(rm).not.toHaveBeenCalled();
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
        expect(rename).not.toHaveBeenCalled();
        await backend.release(descendant);
    });

    it("serializes overlapping renames so an open handle follows the retry", async () => {
        await fs.mkdir("/a");
        await fs.writeFile("/a/file.txt", "original");
        const firstMoved = deferred();
        const firstAllowed = deferred();
        let calls = 0;
        const rename = vi.fn(async (from: string, to: string) => {
            calls++;
            await fs.rename(from, to);
            if (calls === 1) {
                firstMoved.resolve();
                await firstAllowed.promise;
            }
        });
        const backend = createSharedFsMountBackend(mountTarget(fs, { rename }));
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
            expect(rename).toHaveBeenCalledOnce();
        } finally {
            firstAllowed.resolve();
        }
        await firstRename;

        await backend.rename("/b", "/c");
        await backend.release(handle);
        expect(rename).toHaveBeenCalledTimes(2);
        expect(await fs.stat("/a")).toBeUndefined();
        expect(await fs.stat("/b")).toBeUndefined();
        expect(decode(await fs.readFile("/c/file.txt"))).toBe("updated!");
    });

    it("gates an in-flight create lookup below a rename destination", async () => {
        await fs.mkdir("/source");
        const statEntered = deferred();
        const statAllowed = deferred();
        const renameEntered = deferred();
        const renameAllowed = deferred();
        let gatedStat = true;
        const stat = vi.fn(async (path: string) => {
            if (path === "/destination/racing.txt" && gatedStat) {
                gatedStat = false;
                statEntered.resolve();
                await statAllowed.promise;
            }
            return fs.stat(path);
        });
        const rename = vi.fn(async (from: string, to: string) => {
            renameEntered.resolve();
            await renameAllowed.promise;
            return fs.rename(from, to);
        });
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { stat, rename })
        );

        const opening = backend.open("/destination/racing.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await statEntered.promise;
        const renaming = backend.rename("/source", "/destination");
        await renameEntered.promise;

        statAllowed.resolve();
        try {
            await expect(opening).rejects.toMatchObject({ code: "EAGAIN" });
        } finally {
            renameAllowed.resolve();
        }
        await renaming;
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
        const makingDirectory = backend.mkdir("/node");
        await mkdirEntered.promise;

        statAllowed.resolve();
        try {
            await expect(opening).rejects.toMatchObject({ code: "EAGAIN" });
        } finally {
            mkdirAllowed.resolve();
        }
        await makingDirectory;
        expect((await fs.stat("/node"))?.kind).toBe("directory");

        await backend.rmdir("/node");
        const fresh = await backend.open("/node", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.release(fresh);
    });

    it("rejects rmdir while a descendant create intent is pending", async () => {
        await fs.mkdir("/tree");
        const rm = vi.fn((path: string) => fs.rm(path));
        const backend = createSharedFsMountBackend(mountTarget(fs, { rm }));
        const handle = await backend.open("/tree/pending.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(handle, encode("pending"), 0);

        await expect(backend.rmdir("/tree")).rejects.toMatchObject({
            code: "EAGAIN",
        });
        expect(rm).not.toHaveBeenCalled();
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
        const rmFinished = deferred();
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
        const rm = vi.fn(async (path: string) => {
            await fs.rm(path);
            rmFinished.resolve();
            await rmAllowed.promise;
        });
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { stat, rm })
        );

        const opening = backend.open("/removed.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await statEntered.promise;
        const unlinking = backend.unlink("/removed.txt");
        await rmFinished.promise;

        statAllowed.resolve();
        try {
            await expect(opening).rejects.toMatchObject({ code: "EAGAIN" });
        } finally {
            rmAllowed.resolve();
        }
        await unlinking;
        expect(await fs.stat("/removed.txt")).toBeUndefined();
    });

    it("gates a descendant create lookup while rmdir removes its namespace", async () => {
        await fs.mkdir("/tree");
        const statEntered = deferred();
        const statAllowed = deferred();
        const rmFinished = deferred();
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
        const rm = vi.fn(async (path: string) => {
            await fs.rm(path);
            rmFinished.resolve();
            await rmAllowed.promise;
        });
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { stat, rm })
        );

        const opening = backend.open("/tree/racing.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await statEntered.promise;
        const removing = backend.rmdir("/tree");
        await rmFinished.promise;

        statAllowed.resolve();
        try {
            await expect(opening).rejects.toMatchObject({ code: "EAGAIN" });
        } finally {
            rmAllowed.resolve();
        }
        await removing;
        expect(await fs.stat("/tree")).toBeUndefined();

        await backend.mkdir("/tree");
        const fresh = await backend.open("/tree/racing.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.release(fresh);
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
        const rename = vi.fn(async (from: string, to: string) => {
            renameEntered.resolve();
            await renameAllowed.promise;
            return fs.rename(from, to);
        });
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { stat, rename })
        );

        const opening = backend.open("/source/racing.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await statEntered.promise;
        const renaming = backend.rename("/source", "/moved");
        await renameEntered.promise;

        statAllowed.resolve();
        try {
            await expect(opening).rejects.toMatchObject({ code: "EAGAIN" });
        } finally {
            renameAllowed.resolve();
        }
        await renaming;

        expect(rename).toHaveBeenCalledOnce();
        expect(await fs.stat("/source")).toBeUndefined();
        expect((await fs.stat("/moved"))?.kind).toBe("directory");

        // Both the rename gate and the failed open's create intent must be
        // gone once the operations settle.
        const moved = await backend.open("/moved/fresh.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.release(moved);
        await fs.mkdir("/source");
        const oldPath = await backend.open("/source/racing.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.release(oldPath);
    });

    it("rejects a second ordinary creator while the first commit is in flight", async () => {
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
        const releasing = backend.release(first);
        await commitEntered.promise;
        try {
            await expect(
                backend.open("/ordinary-race.txt", {
                    write: true,
                    create: true,
                })
            ).rejects.toMatchObject({ code: "EAGAIN" });
            expect(writeFile).toHaveBeenCalledOnce();
            expect(await fs.stat("/ordinary-race.txt")).toBeUndefined();
        } finally {
            commitAllowed.resolve();
        }
        await releasing;
        expect(decode(await fs.readFile("/ordinary-race.txt"))).toBe("left");

        const retry = await backend.open("/ordinary-race.txt", {
            write: true,
            create: true,
            truncate: true,
        });
        await backend.write(retry, encode("right"), 0);
        await backend.release(retry);
        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(decode(await fs.readFile("/ordinary-race.txt"))).toBe("right");
    });

    it("terminalizes an advertised O_EXCL loser as EEXIST", async () => {
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
            capableMountTarget(fs, { writeFile })
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

    it("preserves EAGAIN for a custom target's O_EXCL CAS loss", async () => {
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                await fs.writeFile(path, "racer");
                return fs.writeFile(path, source, options);
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/custom-exclusive-race.txt", {
            write: true,
            create: true,
            exclusive: true,
        });
        await backend.write(handle, encode("ours"), 0);

        await expect(backend.flush(handle)).rejects.toMatchObject({
            code: "EAGAIN",
        });
        await expect(
            backend.write(handle, encode("resurrected"), 0)
        ).rejects.toMatchObject({ code: "EBADF" });
        await backend.release(handle);
        expect(writeFile).toHaveBeenCalledOnce();
        expect(decode(await fs.readFile("/custom-exclusive-race.txt"))).toBe(
            "racer"
        );
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

    it("keeps an in-flight append snapshot stable and drains it at fsync", async () => {
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
            mountTarget(fs, { writeFile }),
            { writeFileInput: "immutable-borrowed" }
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
        expect(decode(await fs.readFile("/append-fence.txt"))).toBe("baseAB");
        expect(writeFile).toHaveBeenCalledTimes(2);
        await backend.release(handle);
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
            capableMountTarget(fs, {
                readVersion: async () => openedBytes,
                writeFile,
            }),
            { writeFileInput: "immutable-borrowed" }
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
        // and then clear the already-exposed protection token on their no-op
        // commit path.
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
            mountTarget(fs, { writeFile }),
            { writeFileInput: "immutable-borrowed" }
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
                readVersion: async () => openedBytes,
                writeFile,
            }),
            { writeFileInput: "immutable-borrowed" }
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

    it("isolates custom targets that mutate and retain commit input by default", async () => {
        const openedBytes = encode("base");
        await fs.writeFile("/isolated-target.txt", openedBytes.slice());
        let retained: Uint8Array | undefined;
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                if (!(source instanceof Uint8Array)) {
                    throw new Error("mount commits must use Uint8Array input");
                }
                retained = source;
                const result = await fs.writeFile(path, source, options);
                source.fill("x".charCodeAt(0));
                return result;
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, {
                readVersion: async () => openedBytes,
                writeFile,
            })
        );
        const handle = await backend.open("/isolated-target.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("save"), 0);
        await backend.flush(handle);

        expect(retained?.buffer).not.toBe(openedBytes.buffer);
        expect(decode(retained)).toBe("xxxx");
        expect(decode(await backend.read(handle, 4, 0))).toBe("save");
        retained?.fill("y".charCodeAt(0));
        expect(decode(await backend.read(handle, 4, 0))).toBe("save");

        await backend.release(handle);
        expect(writeFile).toHaveBeenCalledOnce();
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

    it("retains local hash validation for legacy custom targets", async () => {
        const writeFile = vi.fn(
            async (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => {
                const result = await fs.writeFile(path, source, options);
                return { ...result, contentHash: "not-the-source-hash" };
            }
        );
        const backend = createSharedFsMountBackend(
            mountTarget(fs, { writeFile })
        );
        const handle = await backend.open("/legacy-hash-check.txt", {
            write: true,
            create: true,
            exclusive: true,
            truncate: true,
        });
        await backend.write(handle, encode("checked"), 0);

        await expect(backend.flush(handle)).rejects.toMatchObject({
            // Post-write integrity validation is not an absent-path race and
            // must not be translated to O_EXCL's EEXIST.
            code: "EAGAIN",
        });
        expect(writeFile).toHaveBeenCalledOnce();
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

    it("does not mint a new version when flushing unchanged content", async () => {
        const writeFile = vi.fn(
            (
                path: string,
                source: Uint8Array | string | AsyncIterable<Uint8Array>,
                options?: WriteFileOptions
            ) => fs.writeFile(path, source, options)
        );
        const backend = createSharedFsMountBackend(
            capableMountTarget(fs, { writeFile })
        );
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
        expect(writeFile).toHaveBeenCalledTimes(3);
        expect(writeFile.mock.calls[0]?.[2]).toMatchObject({
            noOpIfHeadVersionIds: expect.any(Array),
        });
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
            capableMountTarget(fs, { writeFile })
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
            capableMountTarget(fs, { writeFile }),
            { writeFileInput: "immutable-borrowed" }
        );
        const handle = await backend.open("/capable-buffer-race.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("base"), 0);

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
            capableMountTarget(fs, {
                readVersion: async () => openedBytes,
                writeFile,
            }),
            { writeFileInput: "immutable-borrowed" }
        );
        const handle = await backend.open("/capable-retained-noop.txt", {
            read: true,
            write: true,
        });
        await backend.write(handle, encode("base"), 0);
        await backend.flush(handle);
        expect(writeFile).toHaveBeenCalledOnce();
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
            capableMountTarget(fs, {
                readVersion: async () => openedBytes,
                writeFile,
            }),
            { writeFileInput: "immutable-borrowed" }
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
            capableMountTarget(fs, {
                readVersion: async () => openedBytes,
                writeFile,
            }),
            { writeFileInput: "immutable-borrowed" }
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
