import type {
    SharedFsConflict,
    SharedFsEntryInfo,
    SharedFsVersionInfo,
    WriteFileOptions,
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
    conflicts(path?: string): Promise<SharedFsConflict[]>;
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
    buffer: Uint8Array;
    write: boolean;
    dirty: boolean;
    readOnly: boolean;
};

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;
const O_APPEND = 0o2000;

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

const parseFlags = (flags: SharedFsOpenFlags | undefined) => {
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
        const access = flags & 0o3;
        return {
            read: access === 0 || access === O_RDWR,
            write: access === O_WRONLY || access === O_RDWR,
            create: (flags & O_CREAT) === O_CREAT,
            truncate: (flags & O_TRUNC) === O_TRUNC,
            append: (flags & O_APPEND) === O_APPEND,
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

const findEntry = async (
    target: SharedFsMountBackendTarget,
    path: string
): Promise<SharedFsEntryInfo | undefined> => {
    const normalized = normalizeFsPath(path);
    if (normalized === "/") {
        return undefined;
    }
    const entries = await target.list(dirname(normalized));
    return entries.find((entry) => entry.name === basename(normalized));
};

export const createSharedFsMountBackend = (
    target: SharedFsMountBackendTarget
): SharedFsMountBackend => {
    const handles = new Map<number, OpenHandle>();
    let nextHandle = 1;

    const conflictForPath = async (path: string) => {
        const conflicts = await target.conflicts();
        return conflicts.find((conflict) => conflict.path === path);
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

    const commit = async (handle: OpenHandle) => {
        if (!handle.dirty) {
            return;
        }
        if (handle.readOnly) {
            throw new SharedFsBackendError(
                "EROFS",
                `Path is read-only: ${handle.path}`
            );
        }
        await target.writeFile(handle.path, handle.buffer);
        handle.dirty = false;
    };

    const backend: SharedFsMountBackend = {
        async getattr(path: string) {
            const normalized = normalizeFsPath(path);
            if (normalized === "/") {
                return directoryStat("/");
            }
            if (isConflictPath(normalized)) {
                return getattrConflict(normalized);
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
        },

        async readdir(path: string) {
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
                    return (await target.conflicts()).map((conflict) => ({
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
            const entries = (await target.list(normalized)).map((entry) => ({
                name: entry.name,
                kind: entry.kind,
            }));
            if (normalized === "/") {
                entries.push({ name: CONFLICTS_DIR, kind: "directory" });
            }
            return entries;
        },

        async open(path: string, flags?: SharedFsOpenFlags) {
            const normalized = normalizeFsPath(path);
            const parsedFlags = parseFlags(flags);
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
                    write: false,
                    dirty: false,
                    readOnly: true,
                });
                return handle;
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
            const existing = parsedFlags.truncate
                ? new Uint8Array(0)
                : ((await target.readFile(normalized)) ?? new Uint8Array(0));
            const handle = nextHandle++;
            handles.set(handle, {
                path: normalized,
                buffer: existing,
                write: parsedFlags.write,
                dirty: false,
                readOnly: false,
            });
            return handle;
        },

        async read(handle: number, size: number, offset: number) {
            const openHandle = handles.get(handle);
            if (!openHandle) {
                throw new SharedFsBackendError(
                    "EBADF",
                    `Unknown file handle: ${handle}`
                );
            }
            return openHandle.buffer.subarray(offset, offset + size);
        },

        async write(handle: number, data: Uint8Array, offset: number) {
            const openHandle = handles.get(handle);
            if (!openHandle) {
                throw new SharedFsBackendError(
                    "EBADF",
                    `Unknown file handle: ${handle}`
                );
            }
            if (!openHandle.write) {
                throw new SharedFsBackendError(
                    "EACCES",
                    `File handle is not writable: ${handle}`
                );
            }
            const nextLength = Math.max(
                openHandle.buffer.byteLength,
                offset + data.byteLength
            );
            const nextBuffer = new Uint8Array(nextLength);
            nextBuffer.set(openHandle.buffer);
            nextBuffer.set(data, offset);
            openHandle.buffer = nextBuffer;
            openHandle.dirty = true;
            return data.byteLength;
        },

        async flush(handle: number) {
            const openHandle = handles.get(handle);
            if (!openHandle) {
                throw new SharedFsBackendError(
                    "EBADF",
                    `Unknown file handle: ${handle}`
                );
            }
            await commit(openHandle);
        },

        async fsync(handle: number) {
            const openHandle = handles.get(handle);
            if (!openHandle) {
                throw new SharedFsBackendError(
                    "EBADF",
                    `Unknown file handle: ${handle}`
                );
            }
            await commit(openHandle);
        },

        async release(handle: number) {
            const openHandle = handles.get(handle);
            if (!openHandle) {
                return;
            }
            await commit(openHandle);
            handles.delete(handle);
        },

        async mkdir(path: string) {
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
        },

        async rmdir(path: string) {
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
        },

        async rename(from: string, to: string) {
            const fromPath = normalizeFsPath(from);
            const toPath = normalizeFsPath(to);
            if (isConflictPath(fromPath) || isConflictPath(toPath)) {
                throw new SharedFsBackendError(
                    "EROFS",
                    "Conflict metadata is read-only"
                );
            }
            await target.rename(fromPath, toPath);
        },

        async unlink(path: string) {
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
        },
    };

    return backend;
};
