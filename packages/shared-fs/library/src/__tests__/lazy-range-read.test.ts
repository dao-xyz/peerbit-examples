import { Peerbit } from "peerbit";
import { NotFoundError } from "@peerbit/document";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_FILE_CHUNK_SIZE,
    FIXED_CHUNK_LAYOUT_V1_MARKER_ID,
    FileChunk,
    FileVersion,
    SHARED_FS_MOUNT_RANGE_READ_SEMANTICS,
    SHARED_FS_MOUNT_READ_SEMANTICS,
    SHARED_FS_MOUNT_WRITE_SEMANTICS,
    createSharedFsMountBackend,
    hasFixedChunkLayoutV1,
    openSharedFs,
    type SharedFsHandle,
    type SharedFsMountBackendTarget,
    type SharedFsMountRangeReadSession,
} from "../index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const patternedBytes = (size: number, seed = 0) => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index++) {
        bytes[index] = (index * 17 + seed) % 251;
    }
    return bytes;
};

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

const targetFor = (
    fs: SharedFsHandle,
    overrides: Partial<SharedFsMountBackendTarget> = {}
): SharedFsMountBackendTarget => ({
    mountReadSemantics: () => SHARED_FS_MOUNT_READ_SEMANTICS,
    readVersionForMount: (path, versionId) =>
        fs.readVersionForMount(path, versionId),
    mountRangeReadSemantics: () => SHARED_FS_MOUNT_RANGE_READ_SEMANTICS,
    openVersionRangeForMount: (path, versionId) =>
        fs.openVersionRangeForMount(path, versionId),
    mountWriteSemantics: () => SHARED_FS_MOUNT_WRITE_SEMANTICS,
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

const document = async <T>(fs: SharedFsHandle, id: string): Promise<T> =>
    (fs.program as any).getDocument(id) as Promise<T>;

const hasDocument = async (fs: SharedFsHandle, id: string) =>
    (fs.program as any).hasDocument(id) as Promise<boolean>;

describe("fixed-chunk lazy range reads", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;
    let fakeNow: number;

    beforeEach(async () => {
        fakeNow = Date.now();
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "lazy-range-test",
            clock: () => fakeNow,
        });
    });

    afterEach(async () => {
        await peer.stop().catch(() => {});
    });

    it("marks only new canonical layouts without changing old-reader bytes", async () => {
        const bytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 37);
        const written = await fs.writeFile("/marked.bin", bytes);
        const marked = await document<FileVersion>(fs, written.id);

        expect(marked).toBeInstanceOf(FileVersion);
        expect(hasFixedChunkLayoutV1(marked)).toBe(true);
        expect(marked.chunkIds[0]).toBe(FIXED_CHUNK_LAYOUT_V1_MARKER_ID);
        // The legacy whole-file path concatenates the zero-byte marker and
        // still verifies/returns the identical content.
        expect(await fs.readVersion("/marked.bin", written.id)).toEqual(bytes);

        const legacy = await fs.writeFile("/custom.bin", bytes, {
            chunkSize: 64 * 1024,
        });
        const custom = await document<FileVersion>(fs, legacy.id);
        expect(hasFixedChunkLayoutV1(custom)).toBe(false);
        expect(
            await fs.openVersionRangeForMount("/custom.bin", legacy.id)
        ).toBeUndefined();

        const markedEmptyWrite = await fs.writeFile(
            "/marked-empty.bin",
            new Uint8Array(0)
        );
        const markedEmpty = await document<FileVersion>(
            fs,
            markedEmptyWrite.id
        );
        expect(markedEmpty.chunkIds).toEqual([
            FIXED_CHUNK_LAYOUT_V1_MARKER_ID,
            FIXED_CHUNK_LAYOUT_V1_MARKER_ID,
        ]);
        const emptySession = await fs.openVersionRangeForMount(
            "/marked-empty.bin",
            markedEmptyWrite.id
        );
        expect(await emptySession!.read(0, 4096)).toEqual(new Uint8Array(0));
        expect(await emptySession!.materialize()).toEqual(new Uint8Array(0));
        await emptySession!.close();
        expect(
            await fs.readVersion("/marked-empty.bin", markedEmptyWrite.id)
        ).toEqual(new Uint8Array(0));

        const legacyEmptyWrite = await fs.writeFile(
            "/legacy-empty.bin",
            new Uint8Array(0),
            { chunkSize: 64 * 1024 }
        );
        const legacyEmpty = await document<FileVersion>(
            fs,
            legacyEmptyWrite.id
        );
        expect(legacyEmpty.chunkIds).toEqual([FIXED_CHUNK_LAYOUT_V1_MARKER_ID]);
        expect(hasFixedChunkLayoutV1(legacyEmpty)).toBe(false);
        expect(
            await fs.openVersionRangeForMount(
                "/legacy-empty.bin",
                legacyEmptyWrite.id
            )
        ).toBeUndefined();
    });

    it("rejects a marked manifest beyond the deterministic child-table bound", async () => {
        const written = await fs.writeFile(
            "/layout-bound.bin",
            Uint8Array.of(1)
        );
        const base = await document<FileVersion>(fs, written.id);
        const tooManyPositions = new FileVersion({
            id: "version:too-many-fixed-positions",
            nodeId: base.nodeId,
            parentVersionIds: [base.id],
            causalDepth: base.causalDepth + 1n,
            contentHash: base.contentHash,
            size: 8000n * BigInt(DEFAULT_FILE_CHUNK_SIZE),
            chunkIds: [
                FIXED_CHUNK_LAYOUT_V1_MARKER_ID,
                ...Array(8000).fill(base.chunkIds[1]),
            ],
            createdAt: BigInt(fakeNow),
            authorKey: base.authorKey,
            machineLabel: base.machineLabel,
        });
        await expect(
            fs.program.entries.put(tooManyPositions, { unique: true })
        ).rejects.toThrow();
    });

    it("fetches only touched chunks and shares a bounded warm cache", async () => {
        const bytes = patternedBytes(8 * DEFAULT_FILE_CHUNK_SIZE + 19);
        await fs.writeFile("/large.bin", bytes);
        const program = fs.program as any;
        const fetchedIds: string[] = [];
        const originalFetch = program.fetchChunk.bind(program);
        vi.spyOn(program, "fetchChunk").mockImplementation(
            async (id: string, path: string, ownBytes?: boolean) => {
                fetchedIds.push(id);
                return originalFetch(id, path, ownBytes);
            }
        );

        const backend = createSharedFsMountBackend(targetFor(fs));
        const first = await backend.open("/large.bin", { read: true });
        const offset = 5 * DEFAULT_FILE_CHUNK_SIZE + 123;
        expect(await backend.read(first, 4096, offset)).toEqual(
            bytes.slice(offset, offset + 4096)
        );
        expect(fetchedIds).toHaveLength(2); // marker + one data chunk

        const second = await backend.open("/large.bin", { read: true });
        expect(await backend.read(second, 4096, offset)).toEqual(
            bytes.slice(offset, offset + 4096)
        );
        expect(fetchedIds).toHaveLength(2);
        await backend.release(first);
        expect(await backend.read(second, 32, offset + 7)).toEqual(
            bytes.slice(offset + 7, offset + 39)
        );
        await backend.release(second);

        // A new exact session reuses the program-level verified LRU.
        const third = await backend.open("/large.bin", { read: true });
        expect(await backend.read(third, 64, offset)).toEqual(
            bytes.slice(offset, offset + 64)
        );
        expect(fetchedIds).toHaveLength(2);
        await backend.release(third);
        expect(program.rangeChunkCache.size).toBeLessThanOrEqual(128);
        expect(program.rangeChunkInflight.size).toBe(0);
    });

    it("deduplicates concurrent reads for the same cold chunk", async () => {
        const bytes = patternedBytes(2 * DEFAULT_FILE_CHUNK_SIZE + 3, 12);
        const written = await fs.writeFile("/dedupe.bin", bytes);
        const version = await document<FileVersion>(fs, written.id);
        const dataId = version.chunkIds[2];
        const program = fs.program as any;
        const originalFetch = program.fetchChunk.bind(program);
        const entered = deferred();
        const allowed = deferred();
        let dataFetches = 0;
        vi.spyOn(program, "fetchChunk").mockImplementation(
            async (id: string, path: string, ownBytes?: boolean) => {
                if (id === dataId) {
                    dataFetches++;
                    entered.resolve();
                    await allowed.promise;
                }
                return originalFetch(id, path, ownBytes);
            }
        );
        const session = await fs.openVersionRangeForMount(
            "/dedupe.bin",
            written.id
        );
        expect(session).toBeDefined();
        const offset = DEFAULT_FILE_CHUNK_SIZE + 7;
        const left = session!.read(offset, 4096);
        const right = session!.read(offset + 31, 4096);
        await entered.promise;
        expect(dataFetches).toBe(1);
        allowed.resolve();
        expect(await left).toEqual(bytes.slice(offset, offset + 4096));
        expect(await right).toEqual(
            bytes.slice(offset + 31, offset + 31 + 4096)
        );
        await session!.close();
    });

    it("fails closed on a corrupted fetched chunk", async () => {
        const bytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 9);
        const written = await fs.writeFile("/corrupt.bin", bytes);
        const version = await document<FileVersion>(fs, written.id);
        const corruptId = version.chunkIds[1];
        const program = fs.program as any;
        const originalGet = program.getDocument.bind(program);
        program.remoteChunkFetch = false;
        vi.spyOn(program, "getDocument").mockImplementation(
            async (id: string) => {
                const value = await originalGet(id);
                if (id !== corruptId || !(value instanceof FileChunk)) {
                    return value;
                }
                const corrupted = new Uint8Array(value.bytes);
                corrupted[0] ^= 0xff;
                return new FileChunk({ bytes: corrupted, hash: value.hash });
            }
        );

        const session = await fs.openVersionRangeForMount(
            "/corrupt.bin",
            written.id
        );
        expect(session).toBeDefined();
        await expect(session!.read(0, 4096)).rejects.toThrow(
            /Chunk hash mismatch/
        );
        await session!.close();
    });

    it("rejects malformed range and materialization results at the mount boundary", async () => {
        const bytes = patternedBytes(100_000, 14);
        const written = await fs.writeFile("/bad-session.bin", bytes);
        const malformedReads: [string, () => unknown][] = [
            ["wrong type", () => ({ bytes: bytes.slice(0, 64) })],
            ["short", () => bytes.slice(0, 63)],
            ["overlong", () => bytes.slice(0, 65)],
        ];
        for (const [name, result] of malformedReads) {
            const backend = createSharedFsMountBackend(
                targetFor(fs, {
                    openVersionRangeForMount: async (path, versionId) => {
                        const session = await fs.openVersionRangeForMount(
                            path,
                            versionId
                        );
                        expect(session, name).toBeDefined();
                        return {
                            ...session!,
                            read: async () => result() as Uint8Array,
                        };
                    },
                })
            );
            const handle = await backend.open("/bad-session.bin", {
                read: true,
            });
            await expect(
                backend.read(handle, 64, 0),
                name
            ).rejects.toMatchObject({ code: "EIO" });
            await backend.release(handle);
        }

        const corrupt = new Uint8Array(bytes);
        corrupt[0] ^= 0xff;
        const backend = createSharedFsMountBackend(
            targetFor(fs, {
                openVersionRangeForMount: async (path, versionId) => {
                    const session = await fs.openVersionRangeForMount(
                        path,
                        versionId
                    );
                    return session
                        ? {
                              ...session,
                              materialize: async () => corrupt,
                          }
                        : undefined;
                },
            })
        );
        const reader = await backend.open("/bad-session.bin", { read: true });
        await expect(
            backend.open("/bad-session.bin", { read: true, write: true })
        ).rejects.toMatchObject({
            code: "EIO",
            message: expect.stringContaining("corrupt materialization"),
        });
        expect(await fs.readFile("/bad-session.bin")).toEqual(bytes);
        await backend.release(reader);
        expect(written.id).toBeTruthy();
    });

    it("fails closed when signed layout positions have noncanonical lengths", async () => {
        const written = await fs.writeFile("/length.bin", Uint8Array.of(7));
        const base = await document<FileVersion>(fs, written.id);
        const malformed = new FileVersion({
            id: "version:malformed-fixed-length",
            nodeId: base.nodeId,
            parentVersionIds: [base.id],
            causalDepth: base.causalDepth + 1n,
            contentHash: base.contentHash,
            size: BigInt(DEFAULT_FILE_CHUNK_SIZE),
            chunkIds: [FIXED_CHUNK_LAYOUT_V1_MARKER_ID, base.chunkIds[1]],
            createdAt: BigInt(fakeNow),
            authorKey: base.authorKey,
            machineLabel: base.machineLabel,
        });
        await fs.program.entries.put(malformed, { unique: true });

        const session = await fs.openVersionRangeForMount(
            "/length.bin",
            malformed.id
        );
        expect(session).toBeDefined();
        await expect(session!.read(0, 1)).rejects.toThrow(
            /Chunk length mismatch/
        );
        await session!.close();
    });

    it("falls back explicitly for an unmarked version", async () => {
        const bytes = patternedBytes(100_000);
        await fs.writeFile("/legacy.bin", bytes, { chunkSize: 32 * 1024 });
        const openRange = vi.fn((path: string, versionId: string) =>
            fs.openVersionRangeForMount(path, versionId)
        );
        const fullRead = vi.fn((path: string, versionId: string) =>
            fs.readVersionForMount(path, versionId)
        );
        const backend = createSharedFsMountBackend(
            targetFor(fs, {
                openVersionRangeForMount: openRange,
                readVersionForMount: fullRead,
            })
        );
        const handle = await backend.open("/legacy.bin", { read: true });
        expect(openRange).toHaveBeenCalledOnce();
        expect(fullRead).toHaveBeenCalledOnce();
        expect(await backend.read(handle, 4096, 17)).toEqual(
            bytes.slice(17, 17 + 4096)
        );
        await backend.release(handle);
    });

    it("uses an exact verified fallback when only range semantics are advertised", async () => {
        const bytes = patternedBytes(100_000, 21);
        await fs.writeFile("/range-only-legacy.bin", bytes, {
            chunkSize: 32 * 1024,
        });
        const availabilityRead = vi.fn(async () => Uint8Array.of(99));
        const exactRead = vi.fn((path: string, versionId: string) =>
            fs.readVersion(path, versionId)
        );
        const backend = createSharedFsMountBackend(
            targetFor(fs, {
                mountReadSemantics: () => undefined,
                readFile: availabilityRead,
                readVersion: exactRead,
            })
        );

        const handle = await backend.open("/range-only-legacy.bin", {
            read: true,
        });
        expect(await backend.read(handle, 4096, 17)).toEqual(
            bytes.slice(17, 17 + 4096)
        );
        expect(exactRead).toHaveBeenCalledOnce();
        expect(availabilityRead).not.toHaveBeenCalled();
        await backend.release(handle);
    });

    it("falls back while the full replica resurrection guard is disarmed", async () => {
        const bytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 29, 2);
        const written = await fs.writeFile("/guarded.bin", bytes);
        const program = fs.program as any;
        program.setGuardArmed(false);
        try {
            expect(
                await fs.openVersionRangeForMount("/guarded.bin", written.id)
            ).toBeUndefined();
            const backend = createSharedFsMountBackend(targetFor(fs));
            const handle = await backend.open("/guarded.bin", { read: true });
            expect(await backend.read(handle, 4096, 11)).toEqual(
                bytes.slice(11, 11 + 4096)
            );
            await backend.release(handle);
        } finally {
            program.setGuardArmed(true);
        }
    });

    it("materializes once on read-only to writable attach and skips O_TRUNC", async () => {
        const bytes = patternedBytes(2 * DEFAULT_FILE_CHUNK_SIZE + 11);
        await fs.writeFile("/upgrade.bin", bytes);
        await fs.writeFile("/truncate.bin", bytes);
        const materialize =
            vi.fn<SharedFsMountRangeReadSession["materialize"]>();
        const openRange = async (path: string, versionId: string) => {
            const session = await fs.openVersionRangeForMount(path, versionId);
            if (!session) return undefined;
            const original = session.materialize.bind(session);
            session.materialize = async () => {
                materialize();
                return original();
            };
            return session;
        };
        const backend = createSharedFsMountBackend(
            targetFor(fs, { openVersionRangeForMount: openRange })
        );

        const reader = await backend.open("/upgrade.bin", { read: true });
        await backend.read(reader, 32, DEFAULT_FILE_CHUNK_SIZE + 3);
        expect(materialize).not.toHaveBeenCalled();
        const writer = await backend.open("/upgrade.bin", {
            read: true,
            write: true,
        });
        expect(materialize).toHaveBeenCalledTimes(1);
        const siblingWriter = await backend.open("/upgrade.bin", {
            read: true,
            write: true,
        });
        expect(materialize).toHaveBeenCalledTimes(1);
        await backend.write(writer, Uint8Array.of(99), 0);
        await backend.release(writer);
        await backend.release(siblingWriter);
        await backend.release(reader);

        materialize.mockClear();
        const truncateReader = await backend.open("/truncate.bin", {
            read: true,
        });
        const truncating = await backend.open("/truncate.bin", {
            write: true,
            truncate: true,
        });
        expect(materialize).not.toHaveBeenCalled();
        await backend.release(truncating);
        await backend.release(truncateReader);
    });

    it("never upgrades a stale lazy snapshot into a writable base", async () => {
        const baseBytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 7, 9);
        await fs.writeFile("/head-race.bin", baseBytes);
        const materialize =
            vi.fn<SharedFsMountRangeReadSession["materialize"]>();
        const openRange = async (path: string, versionId: string) => {
            const session = await fs.openVersionRangeForMount(path, versionId);
            if (!session) return undefined;
            const original = session.materialize.bind(session);
            session.materialize = async () => {
                materialize();
                return original();
            };
            return session;
        };
        const backend = createSharedFsMountBackend(
            targetFor(fs, { openVersionRangeForMount: openRange })
        );
        const reader = await backend.open("/head-race.bin", { read: true });
        const newestBytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 7, 10);
        await fs.writeFile("/head-race.bin", newestBytes);

        const writer = await backend.open("/head-race.bin", {
            read: true,
            write: true,
        });
        // The visible version had already advanced before the writable open,
        // so the stale lazy snapshot is not materialized or used as ancestry.
        expect(materialize).not.toHaveBeenCalled();
        await backend.write(writer, Uint8Array.of(77), 0);
        await backend.release(writer);

        expect(await fs.conflicts("/head-race.bin")).toHaveLength(0);
        const expected = new Uint8Array(newestBytes);
        expected[0] = 77;
        expect(await fs.readFile("/head-race.bin")).toEqual(expected);
        expect(await backend.read(reader, 1, 0)).toEqual(Uint8Array.of(77));
        await backend.release(reader);
    });

    it("keeps exact descriptor bytes across rename, replacement, and unlink", async () => {
        await fs.writeFile("/source.txt", Uint8Array.of(1, 2, 3));
        await fs.writeFile("/destination.txt", Uint8Array.of(8, 9));
        const backend = createSharedFsMountBackend(targetFor(fs));
        const source = await backend.open("/source.txt", { read: true });
        const replaced = await backend.open("/destination.txt", { read: true });

        await backend.rename("/source.txt", "/destination.txt");
        expect(await backend.read(source, 3, 0)).toEqual(
            Uint8Array.of(1, 2, 3)
        );
        expect(await backend.read(replaced, 2, 0)).toEqual(Uint8Array.of(8, 9));
        const moved = await backend.open("/destination.txt", { read: true });
        expect(await backend.read(moved, 3, 0)).toEqual(Uint8Array.of(1, 2, 3));

        await backend.unlink("/destination.txt");
        expect(await backend.read(source, 3, 0)).toEqual(
            Uint8Array.of(1, 2, 3)
        );
        await expect(
            backend.open("/destination.txt", { read: true })
        ).rejects.toMatchObject({ code: "ENOENT" });
        await backend.release(source);
        await backend.release(replaced);
        await backend.release(moved);
    });

    it("holds versions and chunks beyond the old TTL until session close", async () => {
        const firstBytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 7, 1);
        const first = await fs.writeFile("/history.bin", firstBytes);
        await fs.writeFile(
            "/history.bin",
            patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 7, 2)
        );
        const oldVersion = await document<FileVersion>(fs, first.id);
        const oldChunkIds = [...new Set(oldVersion.chunkIds)];
        const session = await fs.openVersionRangeForMount(
            "/history.bin",
            first.id
        );
        expect(session).toBeDefined();

        fakeNow += 40 * DAY_MS; // vastly beyond the former 60-second pin
        const held = await fs.collectGarbage({
            keepVersions: 1,
            settleMs: 0,
            chunkSweep: "immediate",
            nowMs: fakeNow,
        });
        expect(held.retiredVersions).toBe(0);
        expect(await hasDocument(fs, first.id)).toBe(true);
        expect(await session!.read(31, 4096)).toEqual(
            firstBytes.slice(31, 31 + 4096)
        );
        for (const id of oldChunkIds) {
            expect(await hasDocument(fs, id)).toBe(true);
        }

        await session!.close();
        const reclaimed = await fs.collectGarbage({
            keepVersions: 1,
            settleMs: 0,
            chunkSweep: "immediate",
            nowMs: fakeNow,
        });
        expect(reclaimed.retiredVersions).toBe(1);
        expect(await hasDocument(fs, first.id)).toBe(false);
    });

    it("blocks deleted-node purge while an unlinked descriptor owns the version", async () => {
        const bytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 13, 3);
        const written = await fs.writeFile("/deleted-open.bin", bytes);
        const backend = createSharedFsMountBackend(targetFor(fs));
        const handle = await backend.open("/deleted-open.bin", { read: true });
        await backend.unlink("/deleted-open.bin");
        fakeNow += 40 * DAY_MS;

        for (let run = 0; run < 2; run++) {
            const held = await fs.collectGarbage({
                keepVersions: 1,
                settleMs: 0,
                minOrphanSpanMs: 0,
                chunkSweep: "immediate",
                nowMs: fakeNow,
            });
            expect(held.purgedNodes).toBe(0);
        }
        expect(await hasDocument(fs, written.id)).toBe(true);
        expect(await backend.read(handle, 64, 19)).toEqual(bytes.slice(19, 83));

        await backend.release(handle);
        await fs.collectGarbage({
            keepVersions: 1,
            settleMs: 0,
            minOrphanSpanMs: 0,
            chunkSweep: "immediate",
            nowMs: fakeNow,
        });
        const purged = await fs.collectGarbage({
            keepVersions: 1,
            settleMs: 0,
            minOrphanSpanMs: 0,
            chunkSweep: "immediate",
            nowMs: fakeNow,
        });
        expect(purged.purgedNodes).toBe(1);
        expect(await hasDocument(fs, written.id)).toBe(false);
    });

    it("retains leases after descriptor release until an in-flight read settles", async () => {
        const bytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 17, 6);
        const written = await fs.writeFile("/inflight.bin", bytes);
        const version = await document<FileVersion>(fs, written.id);
        const dataId = version.chunkIds[1];
        const program = fs.program as any;
        const originalFetch = program.fetchChunk.bind(program);
        const entered = deferred();
        const allowed = deferred();
        vi.spyOn(program, "fetchChunk").mockImplementation(
            async (id: string, path: string, ownBytes?: boolean) => {
                if (id === dataId) {
                    entered.resolve();
                    await allowed.promise;
                }
                return originalFetch(id, path, ownBytes);
            }
        );
        const backend = createSharedFsMountBackend(targetFor(fs));
        const handle = await backend.open("/inflight.bin", { read: true });
        const reading = backend.read(handle, 4096, 0);
        await entered.promise;
        await backend.release(handle);
        expect(program.versionLeases.has(written.id)).toBe(true);
        expect(program.chunkLeases.has(dataId)).toBe(true);

        allowed.resolve();
        expect(await reading).toEqual(bytes.slice(0, 4096));
        await vi.waitFor(() => {
            expect(program.versionLeases.has(written.id)).toBe(false);
            expect(program.chunkLeases.has(dataId)).toBe(false);
        });
    });

    it("fences and joins a session opener that straddles filesystem close", async () => {
        const bytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 21, 7);
        const written = await fs.writeFile("/closing.bin", bytes);
        const program = fs.program as any;
        program.rangeChunkCache.clear();
        program.rangeChunkCacheBytes = 0;
        const originalFetch = program.fetchChunk.bind(program);
        const entered = deferred();
        const allowed = deferred();
        vi.spyOn(program, "fetchChunk").mockImplementation(
            async (id: string, path: string, ownBytes?: boolean) => {
                if (id === FIXED_CHUNK_LAYOUT_V1_MARKER_ID) {
                    entered.resolve();
                    await allowed.promise;
                }
                return originalFetch(id, path, ownBytes);
            }
        );

        const opening = fs.openVersionRangeForMount("/closing.bin", written.id);
        await entered.promise;
        let closeSettled = false;
        const closing = fs.program.close().then(() => {
            closeSettled = true;
        });
        await Promise.resolve();
        expect(closeSettled).toBe(false);
        allowed.resolve();
        await expect(opening).rejects.toMatchObject({ code: "ECLOSED" });
        await closing;
        expect(program.versionLeases.size).toBe(0);
        expect(program.chunkLeases.size).toBe(0);
    });

    it("does not leak lifecycle admission when a runtime path is malformed", async () => {
        const written = await fs.writeFile(
            "/invalid-path.bin",
            Uint8Array.of(1)
        );
        await expect(
            (fs.openVersionRangeForMount as any)({}, written.id)
        ).rejects.toThrow();
        expect((fs.program as any).rangeReadAdmissions).toBe(0);
        await fs.program.close();
    });

    it("keeps Guard D attached while close drains an in-flight leased read", async () => {
        const bytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 23, 13);
        const written = await fs.writeFile("/closing-cut.bin", bytes);
        const version = await document<FileVersion>(fs, written.id);
        const chunkId = version.chunkIds[1];
        const program = fs.program as any;
        program.rangeChunkCache.clear();
        program.rangeChunkCacheBytes = 0;
        const originalFetch = program.fetchChunk.bind(program);
        const entered = deferred();
        const allowed = deferred();
        vi.spyOn(program, "fetchChunk").mockImplementation(
            async (id: string, path: string, ownBytes?: boolean) => {
                if (id === chunkId) {
                    entered.resolve();
                    await allowed.promise;
                }
                return originalFetch(id, path, ownBytes);
            }
        );
        const restored = vi.spyOn(program, "putPreferLinked");
        const backend = createSharedFsMountBackend(targetFor(fs));
        const handle = await backend.open("/closing-cut.bin", { read: true });
        const reading = backend.read(handle, 4096, 0);
        await entered.promise;

        await backend.release(handle);
        const closing = fs.program.close();
        try {
            // beginLifecycleRequest fences new sessions, but the retained
            // listener must outlive the leased operation and its possible
            // remote CUT.
            expect(program.changeListener).toBeDefined();
            await fs.program.entries.del(chunkId);
            await vi.waitFor(async () => {
                expect(
                    restored.mock.calls.some(
                        ([value]) => (value as FileVersion).id === chunkId
                    )
                ).toBe(true);
                expect(await hasDocument(fs, chunkId)).toBe(true);
            });
        } finally {
            // Never strand the lifecycle join if an assertion above fails.
            allowed.resolve();
            await Promise.allSettled([reading, closing]);
        }
        expect(await reading).toEqual(bytes.slice(0, 4096));
        expect(program.changeListener).toBeUndefined();
        expect(program.versionLeases.size).toBe(0);
        expect(program.chunkLeases.size).toBe(0);
    });

    it("restores a version when a lease arrives inside its awaited CUT", async () => {
        const firstBytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 3, 4);
        const first = await fs.writeFile("/version-race.bin", firstBytes);
        await fs.writeFile(
            "/version-race.bin",
            patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 3, 5)
        );
        fakeNow += 40 * DAY_MS;
        const entered = deferred();
        const allowed = deferred();
        const entries = fs.program.entries as any;
        const program = fs.program as any;
        const originalDelete = entries.del.bind(entries);
        const originalPut = entries.put.bind(entries);
        let parked = false;
        vi.spyOn(entries, "del").mockImplementation(async (id: string) => {
            if (id === first.id && !parked) {
                parked = true;
                entered.resolve();
                await allowed.promise;
            }
            return originalDelete(id);
        });
        const recoveryPut = deferred();
        const finishRecoveryPut = deferred();
        let parkRecoveryPut = true;
        vi.spyOn(entries, "put").mockImplementation(
            async (...args: unknown[]) => {
                const result = await originalPut(...args);
                if (
                    (args[0] as FileVersion)?.id === first.id &&
                    parkRecoveryPut
                ) {
                    parkRecoveryPut = false;
                    recoveryPut.resolve();
                    await finishRecoveryPut.promise;
                }
                return result;
            }
        );

        const collecting = fs.collectGarbage({
            keepVersions: 1,
            settleMs: 0,
            chunkSweep: "immediate",
            nowMs: fakeNow,
        });
        await entered.promise;
        const session = await fs.openVersionRangeForMount(
            "/version-race.bin",
            first.id
        );
        expect(session).toBeDefined();
        allowed.resolve();
        await recoveryPut.promise;
        // The local collector CUT consumes exactly one suppression token.
        // Keep the same GC run parked and deliver another CUT: the recovered,
        // lease-owned manifest must no longer be blind to Guard D.
        await vi.waitFor(() => {
            expect(program.gcSuppressed.has(first.id)).toBe(false);
        });
        const guardPut = vi.spyOn(program, "putPreferLinked");
        await entries.del(first.id);
        await vi.waitFor(
            () => {
                expect(
                    guardPut.mock.calls.some(
                        ([value]) => (value as FileVersion).id === first.id
                    )
                ).toBe(true);
            },
            { timeout: 10_000 }
        );
        expect(await hasDocument(fs, first.id)).toBe(true);
        finishRecoveryPut.resolve();
        const report = await collecting;
        expect(report.retiredVersions).toBe(0);
        expect(report.cutRecoveries).toBeGreaterThanOrEqual(1);
        expect(await hasDocument(fs, first.id)).toBe(true);
        expect(await session!.read(0, 64)).toEqual(firstBytes.slice(0, 64));
        await session!.close();
    });

    it("clears a failed GC CUT token before a later leased removal", async () => {
        const firstBytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 3, 31);
        const first = await fs.writeFile("/failed-cut.bin", firstBytes);
        await fs.writeFile(
            "/failed-cut.bin",
            patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 3, 32)
        );
        fakeNow += 40 * DAY_MS;
        const entries = fs.program.entries as any;
        const program = fs.program as any;
        const originalDelete = entries.del.bind(entries);
        const deleteEntered = deferred();
        const failDelete = deferred();
        let failOnce = true;
        vi.spyOn(entries, "del").mockImplementation(async (id: string) => {
            if (id === first.id && failOnce) {
                failOnce = false;
                deleteEntered.resolve();
                await failDelete.promise;
                throw new NotFoundError("simulated competing collector");
            }
            return originalDelete(id);
        });
        const ledgerEntered = deferred();
        const finishLedger = deferred();
        const originalSaveLedger = program.saveGcLedger.bind(program);
        vi.spyOn(program, "saveGcLedger").mockImplementation(
            async (...args: unknown[]) => {
                ledgerEntered.resolve();
                await finishLedger.promise;
                return originalSaveLedger(...args);
            }
        );

        const collecting = fs.collectGarbage({
            keepVersions: 1,
            settleMs: 0,
            chunkSweep: "immediate",
            nowMs: fakeNow,
        });
        await deleteEntered.promise;
        const session = await fs.openVersionRangeForMount(
            "/failed-cut.bin",
            first.id
        );
        expect(session).toBeDefined();
        failDelete.resolve();
        await ledgerEntered.promise;
        try {
            expect(program.gcSuppressed.has(first.id)).toBe(false);

            const guardPut = vi.spyOn(program, "putPreferLinked");
            await entries.del(first.id);
            await vi.waitFor(
                async () => {
                    expect(
                        guardPut.mock.calls.some(
                            ([value]) => (value as FileVersion).id === first.id
                        )
                    ).toBe(true);
                    expect(await hasDocument(fs, first.id)).toBe(true);
                },
                { timeout: 10_000 }
            );
        } finally {
            finishLedger.resolve();
            await Promise.allSettled([collecting]);
        }
        await collecting;
        expect(await session!.read(0, 64)).toEqual(firstBytes.slice(0, 64));
        await session!.close();
    });

    it("restores a chunk when a lease arrives inside its awaited CUT", async () => {
        const bytes = patternedBytes(DEFAULT_FILE_CHUNK_SIZE + 5, 8);
        const written = await fs.writeFile("/chunk-race.bin", bytes);
        const version = await document<FileVersion>(fs, written.id);
        const chunkId = version.chunkIds[1];
        const entered = deferred();
        const allowed = deferred();
        const entries = fs.program.entries as any;
        const originalDelete = entries.del.bind(entries);
        vi.spyOn(entries, "del").mockImplementation(async (id: string) => {
            if (id === chunkId) {
                entered.resolve();
                await allowed.promise;
            }
            return originalDelete(id);
        });
        const report = {
            cutRecoveries: 0,
            deletedChunks: 0,
            reclaimedChunkBytes: 0n,
        };
        const deleting = (fs.program as any).deleteChunkVerified(
            chunkId,
            undefined,
            DEFAULT_FILE_CHUNK_SIZE,
            report
        );
        await entered.promise;
        const session = await fs.openVersionRangeForMount(
            "/chunk-race.bin",
            written.id
        );
        expect(session).toBeDefined();
        allowed.resolve();
        await deleting;
        expect(report).toMatchObject({ cutRecoveries: 1, deletedChunks: 0 });
        expect(await hasDocument(fs, chunkId)).toBe(true);
        expect(await session!.read(0, 64)).toEqual(bytes.slice(0, 64));
        await session!.close();
    });
});
