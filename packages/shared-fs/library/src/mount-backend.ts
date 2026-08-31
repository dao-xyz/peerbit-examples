import { sha256Base64Sync } from "@peerbit/crypto";
import {
    SharedFsError,
    type SharedFsConflict,
    type SharedFsEntryInfo,
    type SharedFsVersionInfo,
    type WriteFileOptions,
} from "./index.js";
import {
    CONFLICTS_DIR,
    basename,
    decodeConflictPathName,
    dirname,
    encodeConflictPathName,
    joinFsPath,
    normalizeFsPath,
    pathSegments,
} from "./path.js";

export type SharedFsMountBackendTarget = {
    readFile(path: string): Promise<Uint8Array | undefined>;
    readVersion(
        path: string,
        versionId: string
    ): Promise<Uint8Array | undefined>;
    writeFile(
        path: string,
        source: Uint8Array | string | AsyncIterable<Uint8Array>,
        options?: WriteFileOptions
    ): Promise<unknown>;
    mkdir(path: string): Promise<unknown>;
    rm(path: string): Promise<unknown>;
    rename(from: string, to: string): Promise<unknown>;
    list(path?: string): Promise<SharedFsEntryInfo[]>;
    versions(path: string): Promise<SharedFsVersionInfo[]>;
    conflicts(
        path?: string,
        options?: { allowPartial?: boolean }
    ): Promise<SharedFsConflict[]>;
    /**
     * Optional artifact-ignore probe (provided by ignore-aware handles).
     * When present, write-intent opens on ignored paths fail EARLY at
     * open() instead of surfacing a late error at flush/release that
     * applications routinely discard.
     */
    ignoreCheck?(path: string): { ignored: boolean };
    /**
     * Optional single-path lookup. When present the backend uses it for
     * getattr/open instead of listing the parent directory.
     */
    stat?(path: string): Promise<SharedFsEntryInfo | undefined>;
};

export type SharedFsOpenFlags =
    | number
    | string
    | {
          read?: boolean;
          write?: boolean;
          create?: boolean;
          truncate?: boolean;
          append?: boolean;
      };

export type SharedFsStat = {
    path: string;
    kind: "directory" | "file";
    size: number;
    mode: number;
    mtimeMs: number;
    ctimeMs: number;
    nlink: number;
};

export type SharedFsDirent = {
    name: string;
    kind: "directory" | "file";
};

export type SharedFsMountBackend = {
    getattr(path: string): Promise<SharedFsStat>;
    readdir(path: string): Promise<SharedFsDirent[]>;
    open(path: string, flags?: SharedFsOpenFlags): Promise<number>;
    read(handle: number, size: number, offset: number): Promise<Uint8Array>;
    write(handle: number, data: Uint8Array, offset: number): Promise<number>;
    /**
     * Resize an open handle (number) or a path (string). Growing zero-fills.
     */
    truncate(target: number | string, size: number): Promise<void>;
    flush(handle: number): Promise<void>;
    fsync(handle: number): Promise<void>;
    release(handle: number): Promise<void>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    unlink(path: string): Promise<void>;
};

export type SharedFsBackendErrorCode =
    | "ENOENT"
    | "EIO"
    | "EEXIST"
    | "EISDIR"
    | "ENOTDIR"
    | "ENOTEMPTY"
    | "EINVAL"
    | "EACCES"
    | "EBADF"
    | "EROFS";

export class SharedFsBackendError extends Error {
    constructor(
        readonly code: SharedFsBackendErrorCode,
        message: string
    ) {
        super(message);
        this.name = "SharedFsBackendError";
    }
}

type OpenHandle = {
    path: string;
    /** Backing store; may be larger than `length`. */
    buffer: Uint8Array;
    /** Logical file length. */
    length: number;
    write: boolean;
    dirty: boolean;
    readOnly: boolean;
    /** Head version ids observed when the handle was opened / last committed. */
    baseVersionIds?: string[];
    /** Content hash of the version the buffer was loaded from. */
    baseContentHash?: string;
    /** Serializes concurrent flush/fsync/release commits for one handle. */
    committing?: Promise<void>;
};

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/**
 * Open-flag bit values differ per platform. The IPC server always runs on the
 * same host as the native adapter, so `process.platform` selects the right
 * table for numeric flags.
 */
const OPEN_FLAG_TABLES: Record<
    "linux" | "darwin" | "win32",
    {
        O_WRONLY: number;
        O_RDWR: number;
        O_CREAT: number;
        O_TRUNC: number;
        O_APPEND: number;
    }
> = {
    linux: {
        O_WRONLY: 0o1,
        O_RDWR: 0o2,
        O_CREAT: 0o100,
        O_TRUNC: 0o1000,
        O_APPEND: 0o2000,
    },
    darwin: {
        O_WRONLY: 0x1,
        O_RDWR: 0x2,
        O_CREAT: 0x200,
        O_TRUNC: 0x400,
        O_APPEND: 0x8,
    },
    // MSVC CRT / WinFsp values used by cgofuse on Windows.
    win32: {
        O_WRONLY: 0x1,
        O_RDWR: 0x2,
        O_CREAT: 0x100,
        O_TRUNC: 0x200,
        O_APPEND: 0x8,
    },
};

const bigintToSize = (value: bigint) => {
    return value > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(value);
};

const nowMs = () => Date.now();

const directoryStat = (path: string, mtimeMs = nowMs()): SharedFsStat => ({
    path,
    kind: "directory",
    size: 0,
    mode: S_IFDIR | 0o755,
    mtimeMs,
    ctimeMs: mtimeMs,
    nlink: 2,
});

const fileStat = (
    path: string,
    size: number,
    mtimeMs = nowMs()
): SharedFsStat => ({
    path,
    kind: "file",
    size,
    mode: S_IFREG | 0o644,
    mtimeMs,
    ctimeMs: mtimeMs,
    nlink: 1,
});

export const parseFlags = (
    flags: SharedFsOpenFlags | undefined,
    platform: NodeJS.Platform = process.platform
) => {
    if (flags == null) {
        return {
            read: true,
            write: false,
            create: false,
            truncate: false,
            append: false,
        };
    }
    if (typeof flags === "string") {
        return {
            read: flags.includes("+") || flags.startsWith("r"),
            write:
                flags.includes("w") ||
                flags.includes("a") ||
                flags.includes("+"),
            create: flags.includes("w") || flags.includes("a"),
            truncate: flags.includes("w"),
            append: flags.includes("a"),
        };
    }
    if (typeof flags === "number") {
        const table =
            OPEN_FLAG_TABLES[platform as keyof typeof OPEN_FLAG_TABLES] ??
            OPEN_FLAG_TABLES.linux;
        const access = flags & 0o3;
        return {
            read: access === 0 || access === table.O_RDWR,
            write: access === table.O_WRONLY || access === table.O_RDWR,
            create: (flags & table.O_CREAT) === table.O_CREAT,
            truncate: (flags & table.O_TRUNC) === table.O_TRUNC,
            append: (flags & table.O_APPEND) === table.O_APPEND,
        };
    }
    return {
        read: flags.read ?? !flags.write,
        write: flags.write ?? false,
        create: flags.create ?? false,
        truncate: flags.truncate ?? false,
        append: flags.append ?? false,
    };
};

const isConflictPath = (path: string) => {
    return pathSegments(path)[0] === CONFLICTS_DIR;
};

const parseConflictPath = (path: string) => {
    const segments = pathSegments(path);
    if (segments[0] !== CONFLICTS_DIR) {
        return undefined;
    }
    if (segments.length === 1) {
        return { kind: "root" as const };
    }
    const filePath = decodeConflictPathName(segments[1]);
    if (segments.length === 2) {
        return { kind: "path" as const, filePath };
    }
    if (segments.length === 3) {
        return { kind: "version" as const, filePath, versionId: segments[2] };
    }
    return { kind: "invalid" as const };
};

const notFound = (path: string) =>
    new SharedFsBackendError("ENOENT", `Path does not exist: ${path}`);

const badHandle = (handle: number) =>
    new SharedFsBackendError("EBADF", `Unknown file handle: ${handle}`);

/** Map library errors onto backend errno codes. */
const toBackendError = (error: unknown): SharedFsBackendError => {
    if (error instanceof SharedFsBackendError) {
        return error;
    }
    if (error instanceof SharedFsError) {
        // Artifact-ignore rejections surface as permission errors until
        // the mount tier gains its local overlay; EXDEV has no slot in
        // the adapter protocol yet either. Watch-layer errors never reach
        // the mount path but the type union must stay total.
        const code: SharedFsBackendErrorCode =
            error.code === "EIGNORED" || error.code === "EXDEV"
                ? "EACCES"
                : error.code === "EWATCHLIMIT" ||
                    error.code === "ETIMEDOUT" ||
                    error.code === "ECLOSED" ||
                    error.code === "ERR_GC_PHASE"
                  ? "EIO"
                  : error.code;
        return new SharedFsBackendError(code, error.message);
    }
    return new SharedFsBackendError(
        "EIO",
        error instanceof Error ? error.message : String(error)
    );
};

const findEntry = async (
    target: SharedFsMountBackendTarget,
    path: string
): Promise<SharedFsEntryInfo | undefined> => {
    const normalized = normalizeFsPath(path);
    if (normalized === "/") {
        return undefined;
    }
    if (target.stat) {
        return target.stat(normalized);
    }
    const entries = await target.list(dirname(normalized));
    return entries.find((entry) => entry.name === basename(normalized));
};

const growTo = (handle: OpenHandle, capacity: number) => {
    if (handle.buffer.byteLength >= capacity) {
        return;
    }
    let next = Math.max(handle.buffer.byteLength * 2, 64 * 1024);
    while (next < capacity) {
        next *= 2;
    }
    const buffer = new Uint8Array(next);
    buffer.set(handle.buffer.subarray(0, handle.length));
    handle.buffer = buffer;
};

const contentOf = (handle: OpenHandle) =>
    handle.buffer.subarray(0, handle.length);

const resizeHandle = (handle: OpenHandle, size: number) => {
    if (size < 0 || !Number.isFinite(size)) {
        throw new SharedFsBackendError("EINVAL", `Invalid size: ${size}`);
    }
    if (size < handle.length) {
        // Zero the tail so a later grow does not resurrect stale bytes.
        handle.buffer.fill(0, size, handle.length);
    } else if (size > handle.length) {
        growTo(handle, size);
        handle.buffer.fill(0, handle.length, size);
    }
    handle.length = size;
    handle.dirty = true;
};

export const createSharedFsMountBackend = (
    target: SharedFsMountBackendTarget
): SharedFsMountBackend => {
    const handles = new Map<number, OpenHandle>();
    let nextHandle = 1;

    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
            return await fn();
        } catch (error) {
            throw toBackendError(error);
        }
    };

    const conflictForPath = async (filePath: string) => {
        const conflicts = await target.conflicts(filePath);
        return conflicts.find((conflict) => conflict.path === filePath);
    };

    const pendingWritableHandle = (path: string) => {
        for (const handle of handles.values()) {
            if (
                handle.path === path &&
                handle.write &&
                !handle.readOnly &&
                handle.dirty
            ) {
                return handle;
            }
        }
        return undefined;
    };

    const getattrConflict = async (path: string): Promise<SharedFsStat> => {
        const parsed = parseConflictPath(path);
        if (!parsed || parsed.kind === "invalid") {
            throw notFound(path);
        }
        if (parsed.kind === "root") {
            return directoryStat(joinFsPath("/", CONFLICTS_DIR));
        }
        const conflict = await conflictForPath(parsed.filePath);
        if (!conflict) {
            throw notFound(path);
        }
        if (parsed.kind === "path") {
            return directoryStat(path);
        }
        const version = conflict.versions.find(
            (candidate) => candidate.id === parsed.versionId
        );
        if (!version || version.deleted) {
            throw notFound(path);
        }
        return fileStat(
            path,
            bigintToSize(version.size),
            Number(version.createdAt)
        );
    };

    const readConflictFile = async (path: string) => {
        const parsed = parseConflictPath(path);
        if (!parsed || parsed.kind !== "version") {
            throw new SharedFsBackendError(
                "EISDIR",
                `Path is not a conflict file: ${path}`
            );
        }
        const bytes = await target.readVersion(
            parsed.filePath,
            parsed.versionId
        );
        if (!bytes) {
            throw notFound(path);
        }
        return bytes;
    };

    const commitNow = async (handle: OpenHandle) => {
        if (!handle.dirty) {
            return;
        }
        if (handle.readOnly) {
            throw new SharedFsBackendError(
                "EROFS",
                `Path is read-only: ${handle.path}`
            );
        }
        const bytes = contentOf(handle);
        const contentHash = sha256Base64Sync(bytes);
        if (
            handle.baseContentHash !== undefined &&
            handle.baseContentHash === contentHash &&
            (handle.baseVersionIds?.length ?? 0) <= 1
        ) {
            // No-op save (editors flush/fsync liberally): do not mint a
            // new version for identical content.
            handle.dirty = false;
            return;
        }
        // Clear before awaiting so writes landing during the commit mark the
        // handle dirty again instead of being lost.
        handle.dirty = false;
        try {
            const result = (await target.writeFile(handle.path, bytes, {
                baseVersionIds: handle.baseVersionIds,
            })) as { id?: string; contentHash?: string } | undefined;
            if (result && typeof result.id === "string") {
                handle.baseVersionIds = [result.id];
            }
            handle.baseContentHash = result?.contentHash ?? contentHash;
        } catch (error) {
            handle.dirty = true;
            throw error;
        }
    };

    const commit = async (handle: OpenHandle) => {
        // Coalesce overlapping flush/fsync/release commits.
        while (handle.committing) {
            await handle.committing;
        }
        if (!handle.dirty) {
            return;
        }
        const run = commitNow(handle).finally(() => {
            if (handle.committing === run) {
                handle.committing = undefined;
            }
        });
        handle.committing = run;
        await run;
    };

    const requireHandle = (handle: number) => {
        const openHandle = handles.get(handle);
        if (!openHandle) {
            throw badHandle(handle);
        }
        return openHandle;
    };

    const openPath = async (
        normalized: string,
        parsedFlags: ReturnType<typeof parseFlags>
    ): Promise<number> => {
        if (isConflictPath(normalized)) {
            if (parsedFlags.write) {
                throw new SharedFsBackendError(
                    "EROFS",
                    `Path is read-only: ${normalized}`
                );
            }
            const buffer = await readConflictFile(normalized);
            const handle = nextHandle++;
            handles.set(handle, {
                path: normalized,
                buffer,
                length: buffer.byteLength,
                write: false,
                dirty: false,
                readOnly: true,
            });
            return handle;
        }
        if (parsedFlags.write && target.ignoreCheck?.(normalized).ignored) {
            // Reject-mode ignore policies must fail at open(), where
            // tools handle errors — a buffered write failing only at
            // flush/release reads as silent data loss.
            throw new SharedFsBackendError(
                "EACCES",
                `Path is artifact-ignored: ${normalized}`
            );
        }
        const entry = await findEntry(target, normalized);
        if (entry?.kind === "directory") {
            throw new SharedFsBackendError(
                "EISDIR",
                `Path is a directory: ${normalized}`
            );
        }
        if (!entry && !parsedFlags.create && !parsedFlags.write) {
            throw notFound(normalized);
        }
        let existing: Uint8Array;
        if (parsedFlags.truncate || !entry) {
            existing = new Uint8Array(0);
        } else {
            existing = (await target.readFile(normalized)) ?? new Uint8Array(0);
        }
        const handle = nextHandle++;
        const dirty =
            parsedFlags.write &&
            (parsedFlags.create || parsedFlags.truncate) &&
            // Opening an existing file with O_CREAT (no O_TRUNC) is not a
            // modification.
            !(entry && !parsedFlags.truncate);
        handles.set(handle, {
            path: normalized,
            buffer: existing,
            length: existing.byteLength,
            write: parsedFlags.write,
            dirty,
            readOnly: false,
            baseVersionIds: entry?.headVersionIds,
            // The no-op-save check compares the FINAL buffer hash against
            // the opened head, so it applies to truncate opens too: shell
            // `> file` / editor rewrite-in-place of identical content must
            // not mint a new version.
            baseContentHash: entry?.contentHash,
        });
        return handle;
    };

    const backend: SharedFsMountBackend = {
        async getattr(path: string) {
            return wrap(async () => {
                const normalized = normalizeFsPath(path);
                if (normalized === "/") {
                    return directoryStat("/");
                }
                if (isConflictPath(normalized)) {
                    return getattrConflict(normalized);
                }
                const pending = pendingWritableHandle(normalized);
                if (pending) {
                    // Uncommitted writes are visible to stat like on a local
                    // filesystem (size reflects the buffer).
                    return fileStat(normalized, pending.length);
                }
                const entry = await findEntry(target, normalized);
                if (!entry) {
                    throw notFound(normalized);
                }
                return entry.kind === "directory"
                    ? directoryStat(normalized, Number(entry.updatedAt))
                    : fileStat(
                          normalized,
                          bigintToSize(entry.size),
                          Number(entry.updatedAt)
                      );
            });
        },

        async readdir(path: string) {
            return wrap(async () => {
                const normalized = normalizeFsPath(path);
                if (isConflictPath(normalized)) {
                    const parsed = parseConflictPath(normalized);
                    if (
                        !parsed ||
                        parsed.kind === "invalid" ||
                        parsed.kind === "version"
                    ) {
                        throw new SharedFsBackendError(
                            "ENOTDIR",
                            `Path is not a directory: ${normalized}`
                        );
                    }
                    if (parsed.kind === "root") {
                        // A mount listing tolerates partial results while
                        // a cold-start bootstrap overlay is active.
                        return (
                            await target.conflicts(undefined, {
                                allowPartial: true,
                            })
                        ).map((conflict) => ({
                            name: encodeConflictPathName(conflict.path),
                            kind: "directory" as const,
                        }));
                    }
                    const conflict = await conflictForPath(parsed.filePath);
                    if (!conflict) {
                        throw notFound(normalized);
                    }
                    return conflict.versions
                        .filter((version) => !version.deleted)
                        .map((version) => ({
                            name: version.id,
                            kind: "file" as const,
                        }));
                }
                const byName = new Map(
                    (await target.list(normalized)).map((entry) => [
                        entry.name,
                        {
                            name: entry.name,
                            kind: entry.kind,
                        },
                    ])
                );
                for (const handle of handles.values()) {
                    if (
                        handle.write &&
                        !handle.readOnly &&
                        handle.dirty &&
                        dirname(handle.path) === normalized
                    ) {
                        byName.set(basename(handle.path), {
                            name: basename(handle.path),
                            kind: "file" as const,
                        });
                    }
                }
                const entries = [...byName.values()];
                if (normalized === "/") {
                    entries.push({ name: CONFLICTS_DIR, kind: "directory" });
                }
                return entries;
            });
        },

        async open(path: string, flags?: SharedFsOpenFlags) {
            return wrap(() =>
                openPath(normalizeFsPath(path), parseFlags(flags))
            );
        },

        async read(handle: number, size: number, offset: number) {
            const openHandle = requireHandle(handle);
            if (offset >= openHandle.length || size <= 0) {
                return new Uint8Array(0);
            }
            const end = Math.min(openHandle.length, offset + size);
            return openHandle.buffer.subarray(offset, end);
        },

        async write(handle: number, data: Uint8Array, offset: number) {
            const openHandle = requireHandle(handle);
            if (!openHandle.write) {
                throw new SharedFsBackendError(
                    "EACCES",
                    `File handle is not writable: ${handle}`
                );
            }
            if (offset < 0) {
                throw new SharedFsBackendError(
                    "EINVAL",
                    `Invalid offset: ${offset}`
                );
            }
            const end = offset + data.byteLength;
            growTo(openHandle, end);
            if (offset > openHandle.length) {
                // Sparse write: zero the gap.
                openHandle.buffer.fill(0, openHandle.length, offset);
            }
            openHandle.buffer.set(data, offset);
            openHandle.length = Math.max(openHandle.length, end);
            openHandle.dirty = true;
            return data.byteLength;
        },

        async truncate(targetRef: number | string, size: number) {
            return wrap(async () => {
                if (typeof targetRef === "number") {
                    const openHandle = requireHandle(targetRef);
                    if (!openHandle.write) {
                        throw new SharedFsBackendError(
                            "EACCES",
                            `File handle is not writable: ${targetRef}`
                        );
                    }
                    resizeHandle(openHandle, size);
                    return;
                }
                const normalized = normalizeFsPath(targetRef);
                if (isConflictPath(normalized)) {
                    throw new SharedFsBackendError(
                        "EROFS",
                        `Path is read-only: ${normalized}`
                    );
                }
                const pending = pendingWritableHandle(normalized);
                if (pending) {
                    resizeHandle(pending, size);
                    return;
                }
                const handle = await openPath(normalized, {
                    read: true,
                    write: true,
                    create: false,
                    truncate: false,
                    append: false,
                });
                const openHandle = requireHandle(handle);
                try {
                    resizeHandle(openHandle, size);
                    await commit(openHandle);
                } finally {
                    handles.delete(handle);
                }
            });
        },

        async flush(handle: number) {
            return wrap(() => commit(requireHandle(handle)));
        },

        async fsync(handle: number) {
            return wrap(() => commit(requireHandle(handle)));
        },

        async release(handle: number) {
            const openHandle = handles.get(handle);
            if (!openHandle) {
                return;
            }
            try {
                await wrap(() => commit(openHandle));
            } finally {
                handles.delete(handle);
            }
        },

        async mkdir(path: string) {
            return wrap(async () => {
                const normalized = normalizeFsPath(path);
                if (isConflictPath(normalized)) {
                    throw new SharedFsBackendError(
                        "EROFS",
                        `Path is read-only: ${normalized}`
                    );
                }
                if (await findEntry(target, normalized)) {
                    throw new SharedFsBackendError(
                        "EEXIST",
                        `Path already exists: ${normalized}`
                    );
                }
                await target.mkdir(normalized);
            });
        },

        async rmdir(path: string) {
            return wrap(async () => {
                const normalized = normalizeFsPath(path);
                if (isConflictPath(normalized)) {
                    throw new SharedFsBackendError(
                        "EROFS",
                        `Path is read-only: ${normalized}`
                    );
                }
                const entry = await findEntry(target, normalized);
                if (!entry) {
                    throw notFound(normalized);
                }
                if (entry.kind !== "directory") {
                    throw new SharedFsBackendError(
                        "ENOTDIR",
                        `Path is not a directory: ${normalized}`
                    );
                }
                await target.rm(normalized);
            });
        },

        async rename(from: string, to: string) {
            return wrap(async () => {
                const fromPath = normalizeFsPath(from);
                const toPath = normalizeFsPath(to);
                if (isConflictPath(fromPath) || isConflictPath(toPath)) {
                    throw new SharedFsBackendError(
                        "EROFS",
                        "Conflict metadata is read-only"
                    );
                }
                await target.rename(fromPath, toPath);
                for (const handle of handles.values()) {
                    if (handle.path === fromPath) {
                        handle.path = toPath;
                    } else if (handle.path.startsWith(fromPath + "/")) {
                        handle.path =
                            toPath + handle.path.slice(fromPath.length);
                    }
                }
            });
        },

        async unlink(path: string) {
            return wrap(async () => {
                const normalized = normalizeFsPath(path);
                if (isConflictPath(normalized)) {
                    throw new SharedFsBackendError(
                        "EROFS",
                        `Path is read-only: ${normalized}`
                    );
                }
                const entry = await findEntry(target, normalized);
                if (!entry) {
                    throw notFound(normalized);
                }
                if (entry.kind !== "file") {
                    throw new SharedFsBackendError(
                        "EISDIR",
                        `Path is a directory: ${normalized}`
                    );
                }
                await target.rm(normalized);
            });
        },
    };

    return backend;
};
