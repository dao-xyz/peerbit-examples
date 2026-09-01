import { sha256Base64Sync } from "@peerbit/crypto";
import {
    SHARED_FS_MOUNT_READ_SEMANTICS,
    SHARED_FS_MOUNT_WRITE_SEMANTICS,
    SharedFsCreateParentMismatchError,
    SharedFsError,
    SharedFsExpectedNodeMismatchError,
    type SharedFsConflict,
    type SharedFsEntryInfo,
    type SharedFsMountReadSemantics,
    type SharedFsMountReadSnapshot,
    type SharedFsMountWriteOutcome,
    type SharedFsMountWriteSemantics,
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
    /**
     * Explicit, versioned exact-read handshake. Implementations advertising
     * this value must return the exact requested version from
     * `readVersionForMount`, after verifying both its content-addressed chunks
     * and assembled whole-file hash. The returned bytes must be a fresh,
     * mutable allocation that the mount owns.
     */
    mountReadSemantics?(): SharedFsMountReadSemantics | undefined;
    readVersionForMount?(
        path: string,
        versionId: string
    ): Promise<SharedFsMountReadSnapshot | undefined>;
    /**
     * Explicit, versioned write handshake. Implementations advertising this
     * value must hash input themselves, honor `noOpIfHeadVersionIds` as a
     * conditional exact-head no-op (mismatch still writes), and return
     * `mountWriteOutcome`.
     */
    mountWriteSemantics?(): SharedFsMountWriteSemantics;
    readFile(path: string): Promise<Uint8Array | undefined>;
    readVersion(
        path: string,
        versionId: string
    ): Promise<Uint8Array | undefined>;
    /**
     * Implementations honoring `expectedNodeId` must throw
     * SharedFsExpectedNodeMismatchError for that atomic mismatch. Untyped
     * EAGAIN failures are treated as transient and remain retryable. Built-in
     * null-guarded creates also throw SharedFsCreateParentMismatchError when
     * their parent becomes invalid or fails `expectedParentNodeId` at the
     * naming fence.
     */
    writeFile(
        path: string,
        source: Uint8Array | string | AsyncIterable<Uint8Array>,
        options?: WriteFileOptions
    ): Promise<
        | (Pick<SharedFsVersionInfo, "id" | "nodeId" | "contentHash"> & {
              mountWriteOutcome?: SharedFsMountWriteOutcome;
          })
        | void
    >;
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
    /**
     * Optional cold-join readiness probe. A writable open is rejected before
     * any path/content lookup while this reports `writeReady: false`; reads
     * remain available from the bootstrap overlay.
     */
    bootstrapStatus?(): {
        phase?: string;
        writeReady?: boolean;
    };
};

export type SharedFsMountBackendOptions = {
    /**
     * Avoid an eager file-sized commit copy by giving `writeFile` an immutable
     * Uint8Array view. The target may retain that view indefinitely, but must
     * never mutate it; the backend detaches before any later handle mutation.
     * Unknown/custom targets keep the isolated-copy default for backwards
     * compatibility.
     */
    writeFileInput?: "immutable-borrowed";
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
          exclusive?: boolean;
          /**
           * Internal one-shot adapter policy. `discard` closes an empty create
           * handle after a failed release because the adapter cannot retry it.
           */
          releaseFailure?: "retain" | "discard";
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
    | "EAGAIN"
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
    /** Commit snapshot currently borrowing `buffer` from this handle. */
    borrowedCommitSnapshot?: CommitSnapshot;
    /** Logical file length. */
    length: number;
    read: boolean;
    write: boolean;
    append: boolean;
    dirty: boolean;
    readOnly: boolean;
    /** O_CREAT|O_EXCL was requested for an initially absent path. */
    exclusiveCreate: boolean;
    /** Backend-local reservation for an initially absent O_CREAT open. */
    createIntent?: symbol;
    /** Confirmed absent-path CAS loss; this handle can never publish again. */
    terminal?: SharedFsBackendError;
    /** Whether a failed release remains retryable or must close this handle. */
    releaseFailure: "retain" | "discard";
    /**
     * Node observed by a commit-capable open. `null` means the path was
     * absent. Pure reads leave this undefined; read-only O_CREAT handles use
     * null because their empty-file creation commits at the close fence.
     */
    openedNodeId?: string | null;
    /** Exact non-root parent directory observed for an absent nested create. */
    openedParentNodeId?: string;
    /** Exact version whose bytes seeded the writable buffer / last commit. */
    baseVersionIds?: string[];
    /** All content heads observed in the coherent writable-open snapshot. */
    openedHeadVersionIds?: string[];
    /** Content hash of the version the buffer was loaded from. */
    baseContentHash?: string;
    /** Serializes concurrent flush/fsync/release commits for one handle. */
    committing?: Promise<void>;
    /** Shared completion for overlapping release calls. */
    releasing?: Promise<void>;
    /**
     * Set synchronously when release begins. Mutations admitted before this
     * transition are drained; later mutations fail instead of becoming dirty
     * after the handle has been removed.
     */
    closing: boolean;
    /**
     * Advances whenever the buffered contents are mutated. A commit may await
     * metadata while writes continue on the same handle; this generation keeps
     * an older no-op check from clearing the newer write's dirty bit.
     */
    mutationGeneration: number;
};

type CommitSnapshot = {
    buffer: Uint8Array;
    length: number;
    mutationGeneration: number;
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
        O_EXCL: number;
        O_TRUNC: number;
        O_APPEND: number;
    }
> = {
    // Values shared by the released Linux x64 and arm64 adapters.
    linux: {
        O_WRONLY: 0o1,
        O_RDWR: 0o2,
        O_CREAT: 0o100,
        O_EXCL: 0o200,
        O_TRUNC: 0o1000,
        O_APPEND: 0o2000,
    },
    darwin: {
        O_WRONLY: 0x1,
        O_RDWR: 0x2,
        O_CREAT: 0x200,
        O_EXCL: 0x800,
        O_TRUNC: 0x400,
        O_APPEND: 0x8,
    },
    // MSVC CRT / WinFsp values used by cgofuse on Windows.
    win32: {
        O_WRONLY: 0x1,
        O_RDWR: 0x2,
        O_CREAT: 0x100,
        O_EXCL: 0x400,
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

type ParsedSharedFsOpenFlags = {
    read: boolean;
    write: boolean;
    create: boolean;
    truncate: boolean;
    append: boolean;
    exclusive: boolean;
    releaseFailure?: "retain" | "discard";
};

export const parseFlags = (
    flags: SharedFsOpenFlags | undefined,
    platform: NodeJS.Platform = process.platform
): ParsedSharedFsOpenFlags => {
    if (flags == null) {
        return {
            read: true,
            write: false,
            create: false,
            truncate: false,
            append: false,
            exclusive: false,
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
            exclusive: flags.includes("x"),
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
            exclusive: (flags & table.O_EXCL) === table.O_EXCL,
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
        exclusive: flags.exclusive ?? false,
        ...(flags.releaseFailure
            ? { releaseFailure: flags.releaseFailure }
            : {}),
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

const ensureMutableCapacity = (handle: OpenHandle, capacity: number) => {
    const borrowedSnapshot = handle.borrowedCommitSnapshot;
    const borrowed = borrowedSnapshot?.buffer === handle.buffer;
    if (!borrowed && handle.buffer.byteLength >= capacity) {
        return;
    }
    let next = handle.buffer.byteLength;
    if (next < capacity) {
        next = Math.max(next * 2, 64 * 1024);
        while (next < capacity) {
            next *= 2;
        }
    }
    const buffer = new Uint8Array(next);
    buffer.set(handle.buffer.subarray(0, handle.length));
    handle.buffer = buffer;
    if (borrowed && handle.borrowedCommitSnapshot === borrowedSnapshot) {
        handle.borrowedCommitSnapshot = undefined;
    }
};

const sameHeads = (left?: string[], right?: string[]) => {
    if (left === undefined || right === undefined) {
        return left === right;
    }
    if (left.length !== right.length) {
        return false;
    }
    const rightIds = new Set(right);
    return left.every((id) => rightIds.has(id));
};

const sameFileSnapshot = (left: SharedFsEntryInfo, right: SharedFsEntryInfo) =>
    left.kind === "file" &&
    right.kind === "file" &&
    left.nodeId === right.nodeId &&
    left.versionId === right.versionId &&
    sameHeads(left.headVersionIds, right.headVersionIds);

const requireVerifiedReadSnapshot = (
    value: unknown,
    path: string,
    requestedVersionId: string,
    candidate: SharedFsEntryInfo,
    confirmed: SharedFsEntryInfo
): SharedFsMountReadSnapshot => {
    const snapshot = value as Partial<SharedFsMountReadSnapshot> | undefined;
    const valid =
        snapshot !== undefined &&
        snapshot !== null &&
        snapshot.bytes instanceof Uint8Array &&
        typeof snapshot.versionId === "string" &&
        snapshot.versionId.length > 0 &&
        typeof snapshot.nodeId === "string" &&
        snapshot.nodeId.length > 0 &&
        typeof snapshot.contentHash === "string" &&
        snapshot.contentHash.length > 0 &&
        typeof snapshot.size === "bigint" &&
        snapshot.versionId === requestedVersionId &&
        snapshot.versionId === candidate.versionId &&
        snapshot.versionId === confirmed.versionId &&
        snapshot.nodeId === candidate.nodeId &&
        snapshot.nodeId === confirmed.nodeId &&
        snapshot.contentHash === candidate.contentHash &&
        snapshot.contentHash === confirmed.contentHash &&
        snapshot.size === candidate.size &&
        snapshot.size === confirmed.size &&
        snapshot.size === BigInt(snapshot.bytes.byteLength);
    if (!valid) {
        throw new SharedFsBackendError(
            "EIO",
            `Mount read capability returned an invalid verified snapshot: ${path}`
        );
    }
    return snapshot as SharedFsMountReadSnapshot;
};

const resizeHandle = (handle: OpenHandle, size: number) => {
    if (size < 0 || !Number.isFinite(size)) {
        throw new SharedFsBackendError("EINVAL", `Invalid size: ${size}`);
    }
    if (size !== handle.length) {
        ensureMutableCapacity(handle, size);
    }
    if (size < handle.length) {
        // Zero the tail so a later grow does not resurrect stale bytes.
        handle.buffer.fill(0, size, handle.length);
    } else if (size > handle.length) {
        handle.buffer.fill(0, handle.length, size);
    }
    handle.length = size;
    handle.dirty = true;
    handle.mutationGeneration++;
};

export const createSharedFsMountBackend = (
    target: SharedFsMountBackendTarget,
    options: SharedFsMountBackendOptions = {}
): SharedFsMountBackend => {
    const handles = new Map<number, OpenHandle>();
    const createIntents = new Map<string, Map<symbol, boolean>>();
    const namespaceTransitions = new Map<symbol, readonly string[]>();
    let nextHandle = 1;
    const delegatesReadVerification =
        target.mountReadSemantics?.() === SHARED_FS_MOUNT_READ_SEMANTICS;
    const delegatesWriteHashing =
        target.mountWriteSemantics?.() === SHARED_FS_MOUNT_WRITE_SEMANTICS;

    const assertWriteReady = (operation: string) => {
        const readiness = target.bootstrapStatus?.();
        if (readiness?.writeReady === false) {
            throw new SharedFsBackendError(
                "EAGAIN",
                `${operation} is unavailable until the initial filesystem view settles${readiness.phase ? ` (bootstrap phase: ${readiness.phase})` : ""}; await write readiness and retry`
            );
        }
    };

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

    const pendingDirtyHandle = (path: string) => {
        for (const handle of handles.values()) {
            if (
                handle.path === path &&
                !handle.readOnly &&
                !handle.terminal &&
                !handle.closing &&
                handle.dirty
            ) {
                return handle;
            }
        }
        return undefined;
    };

    const isAtOrBelow = (path: string, ancestor: string) =>
        path === ancestor ||
        path.startsWith(ancestor === "/" ? "/" : ancestor + "/");

    const reserveCreateIntent = (path: string, exclusive: boolean) => {
        for (const transitionPaths of namespaceTransitions.values()) {
            for (const transitionPath of transitionPaths) {
                if (isAtOrBelow(path, transitionPath)) {
                    // Namespace operations reserve every affected path before
                    // their first await. Otherwise an O_CREAT lookup already
                    // in flight could attach a reservation while a path is
                    // moving, being created, or being removed.
                    throw new SharedFsBackendError(
                        "EAGAIN",
                        `Path has an in-flight namespace transition; retry the create: ${path}`
                    );
                }
            }
        }
        const active = createIntents.get(path);
        if (active && active.size > 0) {
            // This backend cannot attach a second handle to a not-yet-
            // committed inode. Let ordinary callers retry after the local
            // creator's commit fence instead of letting two expected-null
            // commits publish distinct nodes and both report success.
            throw new SharedFsBackendError(
                exclusive ? "EEXIST" : "EAGAIN",
                `Path already has a pending creator: ${path}`
            );
        }
        const token = Symbol(path);
        const intents = active ?? new Map<symbol, boolean>();
        intents.set(token, exclusive);
        if (!active) {
            createIntents.set(path, intents);
        }
        return token;
    };

    const releaseCreateIntent = (path: string, token: symbol) => {
        const intents = createIntents.get(path);
        if (!intents) {
            return;
        }
        intents.delete(token);
        if (intents.size === 0) {
            createIntents.delete(path);
        }
    };

    const clearHandleCreateIntent = (handle: OpenHandle) => {
        if (!handle.createIntent) {
            return;
        }
        releaseCreateIntent(handle.path, handle.createIntent);
        handle.createIntent = undefined;
    };

    const terminalizeCreateLoss = (
        handle: OpenHandle,
        error: SharedFsBackendError
    ) => {
        handle.terminal = error;
        handle.dirty = false;
        clearHandleCreateIntent(handle);
    };

    const hasCreateIntentAtOrBelow = (path: string) => {
        for (const intentPath of createIntents.keys()) {
            if (isAtOrBelow(intentPath, path)) {
                return true;
            }
        }
        return false;
    };

    const withNamespaceTransition = async <T>(
        operation: string,
        paths: readonly string[],
        fn: () => Promise<T>
    ): Promise<T> => {
        const uniquePaths = [...new Set(paths)];
        for (const path of uniquePaths) {
            if (hasCreateIntentAtOrBelow(path)) {
                throw new SharedFsBackendError(
                    "EAGAIN",
                    `${operation} conflicts with a pending creator at or below: ${path}`
                );
            }
        }
        for (const activePaths of namespaceTransitions.values()) {
            for (const path of uniquePaths) {
                if (
                    activePaths.some(
                        (activePath) =>
                            isAtOrBelow(path, activePath) ||
                            isAtOrBelow(activePath, path)
                    )
                ) {
                    throw new SharedFsBackendError(
                        "EAGAIN",
                        `${operation} overlaps an in-flight namespace transition; retry: ${path}`
                    );
                }
            }
        }
        // No await may appear between the preflight above and this token. An
        // in-flight absent-path lookup must either reserve first (and make the
        // preflight fail) or observe this transition and retry.
        const token = Symbol(operation);
        namespaceTransitions.set(token, uniquePaths);
        try {
            return await fn();
        } finally {
            namespaceTransitions.delete(token);
        }
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
        assertWriteReady(`Commit for ${handle.path}`);
        if (handle.readOnly) {
            throw new SharedFsBackendError(
                "EROFS",
                `Path is read-only: ${handle.path}`
            );
        }
        const snapshot: CommitSnapshot = {
            buffer: handle.buffer,
            length: handle.length,
            mutationGeneration: handle.mutationGeneration,
        };
        // A subarray would retain unused geometric-growth capacity forever in
        // targets that keep chunk views. Borrow only exact-sized buffers;
        // otherwise preserve the legacy exact-length copy.
        const borrowInput =
            options.writeFileInput === "immutable-borrowed" &&
            snapshot.buffer.byteLength === snapshot.length &&
            snapshot.buffer.byteOffset === 0 &&
            snapshot.buffer.buffer instanceof ArrayBuffer &&
            snapshot.buffer.buffer.byteLength === snapshot.length;
        if (
            borrowInput &&
            handle.borrowedCommitSnapshot?.buffer !== snapshot.buffer
        ) {
            // Concurrent mutations detach lazily, keeping these exact bytes
            // stable without copying the whole file on the common path.
            handle.borrowedCommitSnapshot = snapshot;
        }
        let inputExposed = false;
        try {
            const bytes = borrowInput
                ? snapshot.buffer.subarray(0, snapshot.length)
                : snapshot.buffer.slice(0, snapshot.length);
            const contentHash = delegatesWriteHashing
                ? undefined
                : sha256Base64Sync(bytes);
            if (
                !delegatesWriteHashing &&
                handle.baseContentHash !== undefined &&
                handle.baseContentHash === contentHash &&
                (handle.baseVersionIds?.length ?? 0) <= 1 &&
                handle.openedHeadVersionIds !== undefined
            ) {
                // An equal byte buffer is a no-op only while the exact content
                // head snapshot opened by this handle is still current. A
                // same-node concurrent version must not make an explicit
                // rewrite disappear: fall through and publish it as a
                // concurrent head.
                const current = await findEntry(target, handle.path);
                const sameNode =
                    typeof handle.openedNodeId === "string" &&
                    current?.kind === "file" &&
                    current.nodeId === handle.openedNodeId;
                if (!sameNode) {
                    throw new SharedFsBackendError(
                        "EAGAIN",
                        `Path changed after it was opened: ${handle.path}`
                    );
                }
                if (
                    current.headVersionIds !== undefined &&
                    sameHeads(
                        handle.openedHeadVersionIds,
                        current.headVersionIds
                    )
                ) {
                    // Editors flush/fsync liberally: do not mint a new version
                    // when neither the bytes nor the exact causal snapshot
                    // moved. A write may have detached the backing buffer
                    // while the stat above was in flight. In that case this
                    // snapshot is still a no-op, but the newer buffer must
                    // remain dirty.
                    if (
                        handle.mutationGeneration ===
                        snapshot.mutationGeneration
                    ) {
                        handle.dirty = false;
                    }
                    return;
                }
            }
            // Clear before awaiting only when this snapshot's generation is
            // still current. The same-head validation above may itself have
            // awaited while a newer write mutated the handle; that newer
            // generation must remain dirty.
            if (handle.mutationGeneration === snapshot.mutationGeneration) {
                handle.dirty = false;
            }
            const writeOptions: WriteFileOptions & {
                expectedNodeId?: string | null;
            } = {
                baseVersionIds: handle.baseVersionIds,
                // Atomic path/node compare-and-set in the library closes the
                // gap between open and writeFile's path resolution. `null`
                // means this handle created a path that must still be absent.
                expectedNodeId: handle.openedNodeId,
                ...(handle.openedParentNodeId !== undefined
                    ? { expectedParentNodeId: handle.openedParentNodeId }
                    : {}),
                ...(delegatesWriteHashing
                    ? {
                          noOpIfHeadVersionIds: [
                              ...(handle.openedHeadVersionIds ?? []),
                          ],
                      }
                    : {}),
            };
            inputExposed = borrowInput;
            let result: Awaited<
                ReturnType<SharedFsMountBackendTarget["writeFile"]>
            >;
            try {
                result = await target.writeFile(
                    handle.path,
                    bytes,
                    writeOptions
                );
            } catch (error) {
                const expectedMismatch =
                    error instanceof SharedFsExpectedNodeMismatchError &&
                    error.expectedNodeId === null &&
                    error.path === handle.path;
                const createParentMismatch =
                    error instanceof SharedFsCreateParentMismatchError &&
                    error.path === handle.path
                        ? error
                        : undefined;
                if (
                    handle.openedNodeId === null &&
                    (expectedMismatch || createParentMismatch)
                ) {
                    // The target's atomic expected-node guard identified this
                    // absent create as a path or parent loser. Do not perform
                    // a later stat: either namespace may already be repaired,
                    // but this handle must never resurrect its stale buffer.
                    const terminal = createParentMismatch
                        ? new SharedFsBackendError(
                              createParentMismatch.mismatchCode,
                              createParentMismatch.message
                          )
                        : new SharedFsBackendError(
                              handle.exclusiveCreate && delegatesWriteHashing
                                  ? "EEXIST"
                                  : "EAGAIN",
                              `Path was created concurrently; the losing handle is closed: ${handle.path}`
                          );
                    terminalizeCreateLoss(handle, terminal);
                    throw terminal;
                }
                throw error;
            }
            let committed =
                result &&
                typeof result.id === "string" &&
                typeof result.nodeId === "string" &&
                typeof result.contentHash === "string"
                    ? result
                    : undefined;
            const mountWriteOutcome = committed?.mountWriteOutcome;
            if (
                delegatesWriteHashing &&
                (!committed ||
                    (mountWriteOutcome !== "unchanged" &&
                        mountWriteOutcome !== "created"))
            ) {
                throw new SharedFsBackendError(
                    "EIO",
                    `Mount write capability returned invalid metadata: ${handle.path}`
                );
            }
            if (!committed) {
                // Keep custom/legacy adapters that return void correct: reload
                // the committed visible version instead of retaining a null
                // node id or stale causal base on the handle.
                const observed = await findEntry(target, handle.path);
                if (
                    observed?.kind !== "file" ||
                    typeof observed.versionId !== "string" ||
                    typeof observed.contentHash !== "string"
                ) {
                    throw new SharedFsBackendError(
                        "EIO",
                        `Committed version metadata is unavailable: ${handle.path}`
                    );
                }
                committed = {
                    id: observed.versionId,
                    nodeId: observed.nodeId,
                    contentHash: observed.contentHash,
                };
            }
            if (
                (typeof handle.openedNodeId === "string" &&
                    handle.openedNodeId !== committed.nodeId) ||
                (!delegatesWriteHashing &&
                    committed.contentHash !== contentHash)
            ) {
                throw new SharedFsBackendError(
                    "EAGAIN",
                    `Path changed while it was being committed: ${handle.path}`
                );
            }
            if (delegatesWriteHashing && mountWriteOutcome === "unchanged") {
                const unchangedIsValid =
                    handle.baseVersionIds?.length === 1 &&
                    handle.openedHeadVersionIds !== undefined &&
                    committed.id === handle.baseVersionIds[0] &&
                    typeof handle.openedNodeId === "string" &&
                    committed.nodeId === handle.openedNodeId;
                if (!unchangedIsValid) {
                    throw new SharedFsBackendError(
                        "EIO",
                        `Mount write capability returned an invalid unchanged result: ${handle.path}`
                    );
                }
                // The target has observed `bytes` and the immutable-borrowed
                // contract permits indefinite retention even on a no-op.
                // Keep this buffer protected until the handle detaches.
                return;
            }
            handle.baseVersionIds = [committed.id];
            // The common single-head case remains eligible for a later no-op.
            // If another head raced this commit, the conservative singleton
            // will not match and the next dirty rewrite will publish instead
            // of being incorrectly discarded.
            handle.openedHeadVersionIds = [committed.id];
            handle.openedNodeId = committed.nodeId;
            handle.openedParentNodeId = undefined;
            handle.baseContentHash = committed.contentHash;
            // The first successful create commit makes the path visible in
            // the target, so the backend-local absent-path reservation is no
            // longer needed. Later writes use the committed node id.
            clearHandleCreateIntent(handle);
        } catch (error) {
            if (!handle.terminal) {
                handle.dirty = true;
            }
            throw error;
        } finally {
            if (handle.borrowedCommitSnapshot === snapshot && !inputExposed) {
                handle.borrowedCommitSnapshot = undefined;
            }
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

    const commitStable = async (handle: OpenHandle) => {
        // A write is allowed to overlap one ordinary flush pass, but fsync and
        // release are fences: if the buffer changed while a frozen snapshot was
        // being committed, immediately commit the newer generation as well.
        // The final comparison is synchronous, so a mutation admitted after it
        // belongs to the next fence.
        for (;;) {
            const mutationGeneration = handle.mutationGeneration;
            await commit(handle);
            if (
                !handle.dirty &&
                handle.mutationGeneration === mutationGeneration
            ) {
                return;
            }
        }
    };

    const requireHandle = (handle: number) => {
        const openHandle = handles.get(handle);
        if (!openHandle || openHandle.terminal) {
            throw badHandle(handle);
        }
        return openHandle;
    };

    const openPath = async (
        normalized: string,
        parsedFlags: ReturnType<typeof parseFlags>
    ): Promise<number> => {
        if (!parsedFlags.read && !parsedFlags.write) {
            throw new SharedFsBackendError(
                "EINVAL",
                `Open has no valid access mode: ${normalized}`
            );
        }
        if (parsedFlags.exclusive && !parsedFlags.create) {
            throw new SharedFsBackendError(
                "EINVAL",
                `O_EXCL requires O_CREAT: ${normalized}`
            );
        }
        if (parsedFlags.truncate && !parsedFlags.write) {
            // POSIX leaves O_RDONLY|O_TRUNC unspecified. Fail closed instead
            // of silently ignoring the requested destructive operation.
            throw new SharedFsBackendError(
                "EINVAL",
                `O_TRUNC requires write access: ${normalized}`
            );
        }
        const mutatingOpen =
            parsedFlags.write || parsedFlags.create || parsedFlags.truncate;
        if (mutatingOpen) {
            assertWriteReady(`Mutating open for ${normalized}`);
        }
        if (normalized === "/") {
            if (parsedFlags.create && parsedFlags.exclusive) {
                throw new SharedFsBackendError(
                    "EEXIST",
                    "Path already exists: /"
                );
            }
            throw new SharedFsBackendError("EISDIR", "Path is a directory: /");
        }
        if (isConflictPath(normalized)) {
            if (mutatingOpen) {
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
                read: true,
                write: false,
                append: false,
                dirty: false,
                readOnly: true,
                exclusiveCreate: false,
                releaseFailure: "retain",
                closing: false,
                mutationGeneration: 0,
            });
            return handle;
        }
        if (mutatingOpen && target.ignoreCheck?.(normalized).ignored) {
            // Reject-mode ignore policies must fail at open(), where
            // tools handle errors — a buffered write failing only at
            // flush/release reads as silent data loss.
            throw new SharedFsBackendError(
                "EACCES",
                `Path is artifact-ignored: ${normalized}`
            );
        }
        let createIntent: symbol | undefined;
        let openedParentNodeId: string | undefined;
        try {
            let entry = await findEntry(target, normalized);
            if (entry && parsedFlags.create && parsedFlags.exclusive) {
                throw new SharedFsBackendError(
                    "EEXIST",
                    `Path already exists: ${normalized}`
                );
            }
            if (entry?.kind === "directory") {
                throw new SharedFsBackendError(
                    "EISDIR",
                    `Path is a directory: ${normalized}`
                );
            }
            if (!entry && !parsedFlags.create) {
                throw notFound(normalized);
            }
            if (!entry) {
                // Reserve synchronously after the first absent lookup. This
                // closes the same-backend gap between concurrent async opens
                // without changing the distributed naming protocol.
                createIntent = reserveCreateIntent(
                    normalized,
                    parsedFlags.exclusive
                );
                const parentPath = dirname(normalized);
                if (parentPath !== "/") {
                    // Validate while the child intent is held. Mount namespace
                    // removals/renames at this parent now fail EAGAIN, and any
                    // validation failure unwinds through the intent cleanup.
                    const parent = await findEntry(target, parentPath);
                    if (!parent) {
                        throw new SharedFsBackendError(
                            "ENOENT",
                            `Parent directory does not exist: ${parentPath}`
                        );
                    }
                    if (parent.kind !== "directory") {
                        throw new SharedFsBackendError(
                            "ENOTDIR",
                            `Parent path is not a directory: ${parentPath}`
                        );
                    }
                    openedParentNodeId = parent.nodeId;
                }
            }

            let existing: Uint8Array = new Uint8Array(0);
            if (!parsedFlags.write) {
                // Read-only opens deliberately retain readFile's newest-
                // complete-ancestor fallback while a visible version's chunks
                // replicate. An absent O_CREAT handle starts as an empty,
                // readable buffer and materializes it at its commit fence.
                existing = entry
                    ? ((await target.readFile(normalized)) ?? new Uint8Array(0))
                    : new Uint8Array(0);
            } else {
                // A writable handle must never seed its buffer from readFile's
                // ancestor fallback and then claim the visible head as its
                // base. Take a coherent {node, visible version, all heads}
                // snapshot, fetch exactly that visible version, and re-check
                // the snapshot. Same-node content races retry;
                // replacement/removal fails closed.
                const maxSnapshotAttempts = 3;
                let opened = false;
                for (
                    let attempt = 0;
                    attempt < maxSnapshotAttempts;
                    attempt++
                ) {
                    if (!entry) {
                        const confirmed = await findEntry(target, normalized);
                        if (!confirmed) {
                            existing = new Uint8Array(0);
                            opened = true;
                            break;
                        }
                        if (parsedFlags.create && parsedFlags.exclusive) {
                            throw new SharedFsBackendError(
                                "EEXIST",
                                `Path already exists: ${normalized}`
                            );
                        }
                        if (confirmed.kind === "directory") {
                            throw new SharedFsBackendError(
                                "EISDIR",
                                `Path is a directory: ${normalized}`
                            );
                        }
                        if (createIntent) {
                            releaseCreateIntent(normalized, createIntent);
                            createIntent = undefined;
                        }
                        openedParentNodeId = undefined;
                        entry = confirmed;
                        continue;
                    }

                    const candidate = entry;
                    const versionId = candidate.versionId;
                    if (!versionId) {
                        throw new SharedFsBackendError(
                            "EIO",
                            `File has no visible version: ${normalized}`
                        );
                    }

                    let exact: Uint8Array | undefined;
                    let verifiedRead: unknown;
                    let readError: unknown;
                    if (!parsedFlags.truncate) {
                        try {
                            if (delegatesReadVerification) {
                                if (
                                    typeof target.readVersionForMount !==
                                    "function"
                                ) {
                                    throw new SharedFsBackendError(
                                        "EIO",
                                        `Mount read capability is missing its exact-version reader: ${normalized}`
                                    );
                                }
                                verifiedRead = await target.readVersionForMount(
                                    normalized,
                                    versionId
                                );
                            } else {
                                exact = await target.readVersion(
                                    normalized,
                                    versionId
                                );
                            }
                        } catch (error) {
                            readError = error;
                        }
                    }

                    const confirmed = await findEntry(target, normalized);
                    if (
                        !confirmed ||
                        confirmed.kind !== "file" ||
                        confirmed.nodeId !== candidate.nodeId
                    ) {
                        throw new SharedFsBackendError(
                            "EAGAIN",
                            `Path changed while it was being opened: ${normalized}`
                        );
                    }
                    if (!sameFileSnapshot(candidate, confirmed)) {
                        entry = confirmed;
                        continue;
                    }
                    if (readError !== undefined) {
                        throw readError;
                    }
                    if (!parsedFlags.truncate) {
                        let contentHash: string;
                        if (delegatesReadVerification) {
                            if (verifiedRead === undefined) {
                                throw new SharedFsBackendError(
                                    "EIO",
                                    `Visible version is unavailable: ${normalized}`
                                );
                            }
                            const verified = requireVerifiedReadSnapshot(
                                verifiedRead,
                                normalized,
                                versionId,
                                candidate,
                                confirmed
                            );
                            exact = verified.bytes;
                            contentHash = verified.contentHash;
                        } else {
                            if (exact === undefined) {
                                throw new SharedFsBackendError(
                                    "EIO",
                                    `Visible version is unavailable: ${normalized}`
                                );
                            }
                            // Legacy/custom targets do not attest that the
                            // exact read was verified. Preserve the local hash
                            // that binds fallback no-op detection to the opened
                            // bytes.
                            contentHash = sha256Base64Sync(exact);
                        }
                        existing = exact;
                        entry = {
                            ...confirmed,
                            contentHash,
                        };
                    } else {
                        // O_TRUNC deliberately bypasses all exact-version
                        // reads; its new buffer starts empty while confirmed
                        // version metadata remains the no-op baseline.
                        existing = new Uint8Array(0);
                        entry = confirmed;
                    }
                    opened = true;
                    break;
                }
                if (!opened) {
                    throw new SharedFsBackendError(
                        "EAGAIN",
                        `File changed repeatedly while it was being opened: ${normalized}`
                    );
                }
            }
            const handle = nextHandle++;
            const dirty =
                parsedFlags.truncate || (parsedFlags.create && !entry);
            const mayCommit = parsedFlags.write || dirty;
            handles.set(handle, {
                path: normalized,
                buffer: existing,
                length: existing.byteLength,
                read: parsedFlags.read,
                write: parsedFlags.write,
                append: parsedFlags.append,
                dirty,
                readOnly: false,
                exclusiveCreate:
                    parsedFlags.create && parsedFlags.exclusive && !entry,
                createIntent,
                releaseFailure: parsedFlags.releaseFailure ?? "retain",
                closing: false,
                openedNodeId: mayCommit ? (entry?.nodeId ?? null) : undefined,
                openedParentNodeId:
                    mayCommit && !entry ? openedParentNodeId : undefined,
                // Editing the deterministic visible version is not an
                // implicit conflict-resolution operation. Base only on the
                // exact version whose bytes seeded the buffer, leaving other
                // heads preserved.
                baseVersionIds:
                    mayCommit && entry?.versionId
                        ? [entry.versionId]
                        : mayCommit
                          ? entry?.headVersionIds
                          : undefined,
                openedHeadVersionIds:
                    mayCommit && entry?.headVersionIds !== undefined
                        ? [...entry.headVersionIds]
                        : undefined,
                // The no-op-save check compares the FINAL buffer hash against
                // the opened head, so it applies to truncate opens too: shell
                // `> file` / editor rewrite-in-place of identical content must
                // not mint a new version.
                baseContentHash: mayCommit ? entry?.contentHash : undefined,
                mutationGeneration: 0,
            });
            return handle;
        } catch (error) {
            if (createIntent) {
                releaseCreateIntent(normalized, createIntent);
            }
            throw error;
        }
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
                const pending = pendingDirtyHandle(normalized);
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
                        !handle.readOnly &&
                        !handle.terminal &&
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
            if (!openHandle.read) {
                throw new SharedFsBackendError(
                    "EBADF",
                    `File handle is not readable: ${handle}`
                );
            }
            if (offset >= openHandle.length || size <= 0) {
                return new Uint8Array(0);
            }
            const end = Math.min(openHandle.length, offset + size);
            // Reads are snapshots. Returning a subarray would expose the live
            // handle buffer: caller mutation or a later write/truncate could
            // change already-returned bytes without advancing the mutation
            // generation or dirtying the handle.
            return new Uint8Array(openHandle.buffer.subarray(offset, end));
        },

        async write(handle: number, data: Uint8Array, offset: number) {
            const openHandle = requireHandle(handle);
            if (openHandle.closing) {
                throw badHandle(handle);
            }
            if (!openHandle.write) {
                throw new SharedFsBackendError(
                    "EBADF",
                    `File handle is not writable: ${handle}`
                );
            }
            assertWriteReady(`Write on handle ${handle}`);
            // O_APPEND positions every accepted write at the then-current end
            // of this handle. There is no await between observing length and
            // mutating it, so concurrent calls on one backend serialize here.
            const writeOffset = openHandle.append ? openHandle.length : offset;
            if (writeOffset < 0) {
                throw new SharedFsBackendError(
                    "EINVAL",
                    `Invalid offset: ${writeOffset}`
                );
            }
            const end = writeOffset + data.byteLength;
            if (data.byteLength > 0 || writeOffset > openHandle.length) {
                ensureMutableCapacity(openHandle, end);
            }
            if (writeOffset > openHandle.length) {
                // Sparse write: zero the gap.
                openHandle.buffer.fill(0, openHandle.length, writeOffset);
            }
            openHandle.buffer.set(data, writeOffset);
            openHandle.length = Math.max(openHandle.length, end);
            openHandle.dirty = true;
            openHandle.mutationGeneration++;
            return data.byteLength;
        },

        async truncate(targetRef: number | string, size: number) {
            return wrap(async () => {
                if (typeof targetRef === "number") {
                    const openHandle = requireHandle(targetRef);
                    if (openHandle.closing) {
                        throw badHandle(targetRef);
                    }
                    if (!openHandle.write) {
                        throw new SharedFsBackendError(
                            "EBADF",
                            `File handle is not writable: ${targetRef}`
                        );
                    }
                    assertWriteReady(`Truncate on handle ${targetRef}`);
                    resizeHandle(openHandle, size);
                    return;
                }
                const normalized = normalizeFsPath(targetRef);
                assertWriteReady(`Truncate ${normalized}`);
                if (isConflictPath(normalized)) {
                    throw new SharedFsBackendError(
                        "EROFS",
                        `Path is read-only: ${normalized}`
                    );
                }
                const pending = pendingDirtyHandle(normalized);
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
                    exclusive: false,
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
            return wrap(() => commitStable(requireHandle(handle)));
        },

        async release(handle: number) {
            const openHandle = handles.get(handle);
            if (!openHandle) {
                return;
            }
            if (openHandle.terminal) {
                clearHandleCreateIntent(openHandle);
                handles.delete(handle);
                return;
            }
            if (openHandle.releasing) {
                return openHandle.releasing;
            }
            // Close mutation admission before the first await. Every write or
            // handle truncate accepted before this point has already advanced
            // mutationGeneration; later attempts fail with EBADF.
            openHandle.closing = true;
            const releasing = wrap(() => commitStable(openHandle))
                .then(
                    () => {
                        handles.delete(handle);
                    },
                    (error) => {
                        if (
                            openHandle.terminal ||
                            openHandle.releaseFailure === "discard"
                        ) {
                            clearHandleCreateIntent(openHandle);
                            openHandle.dirty = false;
                            handles.delete(handle);
                        }
                        throw error;
                    }
                )
                .finally(() => {
                    if (
                        handles.get(handle) === openHandle &&
                        openHandle.releasing === releasing
                    ) {
                        // A failed commit leaves the closing, dirty handle
                        // available for a release/fsync retry instead of
                        // silently discarding buffered data.
                        openHandle.releasing = undefined;
                    }
                });
            openHandle.releasing = releasing;
            return releasing;
        },

        async mkdir(path: string) {
            return wrap(async () => {
                const normalized = normalizeFsPath(path);
                assertWriteReady(`mkdir ${normalized}`);
                if (isConflictPath(normalized)) {
                    throw new SharedFsBackendError(
                        "EROFS",
                        `Path is read-only: ${normalized}`
                    );
                }
                return withNamespaceTransition(
                    `mkdir ${normalized}`,
                    [normalized],
                    async () => {
                        if (await findEntry(target, normalized)) {
                            throw new SharedFsBackendError(
                                "EEXIST",
                                `Path already exists: ${normalized}`
                            );
                        }
                        await target.mkdir(normalized);
                    }
                );
            });
        },

        async rmdir(path: string) {
            return wrap(async () => {
                const normalized = normalizeFsPath(path);
                assertWriteReady(`rmdir ${normalized}`);
                if (isConflictPath(normalized)) {
                    throw new SharedFsBackendError(
                        "EROFS",
                        `Path is read-only: ${normalized}`
                    );
                }
                return withNamespaceTransition(
                    `rmdir ${normalized}`,
                    [normalized],
                    async () => {
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
                    }
                );
            });
        },

        async rename(from: string, to: string) {
            return wrap(async () => {
                const fromPath = normalizeFsPath(from);
                const toPath = normalizeFsPath(to);
                assertWriteReady(`rename ${fromPath} to ${toPath}`);
                if (isConflictPath(fromPath) || isConflictPath(toPath)) {
                    throw new SharedFsBackendError(
                        "EROFS",
                        "Conflict metadata is read-only"
                    );
                }
                return withNamespaceTransition(
                    `rename ${fromPath} to ${toPath}`,
                    [fromPath, toPath],
                    async () => {
                        await target.rename(fromPath, toPath);
                        for (const handle of handles.values()) {
                            if (handle.path === fromPath) {
                                handle.path = toPath;
                            } else if (handle.path.startsWith(fromPath + "/")) {
                                handle.path =
                                    toPath + handle.path.slice(fromPath.length);
                            }
                        }
                    }
                );
            });
        },

        async unlink(path: string) {
            return wrap(async () => {
                const normalized = normalizeFsPath(path);
                assertWriteReady(`unlink ${normalized}`);
                if (isConflictPath(normalized)) {
                    throw new SharedFsBackendError(
                        "EROFS",
                        `Path is read-only: ${normalized}`
                    );
                }
                return withNamespaceTransition(
                    `unlink ${normalized}`,
                    [normalized],
                    async () => {
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
                    }
                );
            });
        },
    };

    return backend;
};
