import { sha256Base64Sync } from "@peerbit/crypto";
import {
    SHARED_FS_MOUNT_READ_SEMANTICS,
    SHARED_FS_MOUNT_NAMESPACE_SEMANTICS,
    SHARED_FS_MOUNT_WRITE_SEMANTICS,
    SharedFsCreateParentMismatchError,
    SharedFsError,
    SharedFsExpectedNamespaceMismatchError,
    SharedFsExpectedNodeMismatchError,
    type SharedFsConflict,
    type SharedFsEntryInfo,
    type SharedFsMountReadSemantics,
    type SharedFsMountReadSnapshot,
    type SharedFsMountNamespaceMutation,
    type SharedFsMountNamespaceMutationResult,
    type SharedFsMountNamespaceSemantics,
    type SharedFsMountWriteOutcome,
    type SharedFsMountWriteSemantics,
    type SharedFsVersionInfo,
    type WriteFileOptions,
} from "./index.js";
import {
    CONFLICTS_DIR,
    ROOT_NODE_ID,
    basename,
    decodeConflictPathName,
    dirname,
    encodeConflictPathName,
    joinFsPath,
    normalizeFsPath,
    pathSegments,
} from "./path.js";

export type SharedFsMountBackendTarget = {
    /** Exact node-bound remove/rename capability used by native mounts. */
    mountNamespaceSemantics?(): SharedFsMountNamespaceSemantics | undefined;
    mutateNamespaceForMount?(
        mutation: SharedFsMountNamespaceMutation
    ): Promise<SharedFsMountNamespaceMutationResult>;
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

export type SharedFsDirentStat = Omit<SharedFsStat, "path" | "kind">;

export type SharedFsDirent = {
    name: string;
    kind: "directory" | "file";
    /**
     * Metadata captured from the same namespace snapshot as this entry. Path
     * and kind are omitted because the parent path, name, and entry kind
     * already carry them. Native adapters may pass the reconstructed complete
     * stat to a readdir-plus callback and avoid a follow-up getattr. Older
     * adapters safely ignore this additive field.
     */
    stat?: SharedFsDirentStat;
};

export type SharedFsReaddirOptions = {
    /** Include compact per-entry metadata for a readdir-plus consumer. */
    includeStats?: boolean;
};

export type SharedFsMountBackend = {
    getattr(path: string): Promise<SharedFsStat>;
    readdir(
        path: string,
        options?: SharedFsReaddirOptions
    ): Promise<SharedFsDirent[]>;
    open(path: string, flags?: SharedFsOpenFlags): Promise<number>;
    /**
     * Returned bytes transfer to the caller. A backend must not later mutate
     * or reuse that view; binary IPC may retain it until the socket write
     * completes rather than adding a file-sized copy.
     */
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

/**
 * Backend-local inode state. Every descriptor for the same observed file node
 * points at this object, so buffered mutations and commit ancestry cannot
 * diverge merely because a process opened the path more than once.
 */
type OpenFileState = {
    path: string;
    /** Stable namespace identity (`null` while an O_CREAT inode is provisional). */
    nodeId?: string | null;
    /** Backing store; may be larger than `length`. */
    buffer: Uint8Array;
    /** Commit snapshot currently borrowing `buffer` from this state. */
    borrowedCommitSnapshot?: CommitSnapshot;
    /** Logical file length. */
    length: number;
    dirty: boolean;
    readOnly: boolean;
    /** O_CREAT|O_EXCL was requested for an initially absent path. */
    exclusiveCreate: boolean;
    /** Backend-local reservation for an initially absent O_CREAT open. */
    createIntent?: symbol;
    /** Confirmed CAS loss; this state can never publish again. */
    terminal?: SharedFsBackendError;
    /** Namespace no longer names this node; buffered fd state is local-only. */
    namespaceDetached?: boolean;
    /**
     * Node observed by a commit-capable open. `null` means the path was
     * absent. Pure reads may leave this undefined; namespace guards bind
     * every descriptor through `nodeId` instead.
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
    /** Serializes every descriptor's commit for this file identity. */
    committing?: Promise<void>;
    /**
     * Advances whenever the buffered contents are mutated. A commit may await
     * metadata while writes continue on the same handle; this generation keeps
     * an older no-op check from clearing the newer write's dirty bit.
     */
    mutationGeneration: number;
    /** Highest local mutation generation known to have crossed writeFile. */
    persistedGeneration: number;
    /** Number of descriptors retaining this state. */
    openHandles: number;
};

/**
 * Exact bytes and causal binding loaded for a legacy state's first writable
 * descriptor. Loading may await remote storage, so it remains staged until
 * namespace admission is checked again.
 */
type PreparedWritableState = {
    path: string;
    nodeId: string;
    buffer: Uint8Array;
    baseVersionIds?: string[];
    openedHeadVersionIds?: string[];
    baseContentHash?: string;
};

type OpenHandle = {
    state: OpenFileState;
    read: boolean;
    write: boolean;
    append: boolean;
    /** Whether a failed release remains retryable or closes this descriptor. */
    releaseFailure: "retain" | "discard";
    /** Shared completion for overlapping release calls on this descriptor. */
    releasing?: Promise<void>;
    /** Set synchronously when release begins; siblings remain writable. */
    closing: boolean;
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

const directoryDirentStat = (mtimeMs = nowMs()): SharedFsDirentStat => ({
    size: 0,
    mode: S_IFDIR | 0o755,
    mtimeMs,
    ctimeMs: mtimeMs,
    nlink: 2,
});

const directoryStat = (path: string, mtimeMs = nowMs()): SharedFsStat => ({
    path,
    kind: "directory",
    ...directoryDirentStat(mtimeMs),
});

const fileDirentStat = (
    size: number,
    mtimeMs = nowMs()
): SharedFsDirentStat => ({
    size,
    mode: S_IFREG | 0o644,
    mtimeMs,
    ctimeMs: mtimeMs,
    nlink: 1,
});

const fileStat = (
    path: string,
    size: number,
    mtimeMs = nowMs()
): SharedFsStat => ({
    path,
    kind: "file",
    ...fileDirentStat(size, mtimeMs),
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

const mapWithBoundedConcurrency = async <T, R>(
    values: T[],
    limit: number,
    visit: (value: T) => Promise<R>
): Promise<R[]> => {
    const results = new Array<R>(values.length);
    let cursor = 0;
    let failed = false;
    let failure: unknown;
    const workers = Array.from(
        { length: Math.min(limit, values.length) },
        async () => {
            while (!failed) {
                const index = cursor++;
                if (index >= values.length) return;
                try {
                    results[index] = await visit(values[index]);
                } catch (error) {
                    if (!failed) {
                        failed = true;
                        failure = error;
                    }
                    return;
                }
            }
        }
    );
    // A failed worker must not release the surrounding namespace transition
    // while sibling lookups are still active. Drain them all; the shared
    // failure flag prevents any worker from claiming another path afterward.
    await Promise.allSettled(workers);
    if (failed) {
        throw (
            failure ??
            new SharedFsBackendError(
                "EIO",
                "Namespace binding revalidation failed without an error"
            )
        );
    }
    return results;
};

const ensureMutableCapacity = (state: OpenFileState, capacity: number) => {
    const borrowedSnapshot = state.borrowedCommitSnapshot;
    const borrowed = borrowedSnapshot?.buffer === state.buffer;
    if (!borrowed && state.buffer.byteLength >= capacity) {
        return;
    }
    let next = state.buffer.byteLength;
    if (next < capacity) {
        next = Math.max(next * 2, 64 * 1024);
        while (next < capacity) {
            next *= 2;
        }
    }
    const buffer = new Uint8Array(next);
    buffer.set(state.buffer.subarray(0, state.length));
    state.buffer = buffer;
    if (borrowed && state.borrowedCommitSnapshot === borrowedSnapshot) {
        state.borrowedCommitSnapshot = undefined;
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

const resizeState = (state: OpenFileState, size: number) => {
    if (size < 0 || !Number.isFinite(size)) {
        throw new SharedFsBackendError("EINVAL", `Invalid size: ${size}`);
    }
    if (size !== state.length) {
        ensureMutableCapacity(state, size);
    }
    if (size < state.length) {
        // Zero the tail so a later grow does not resurrect stale bytes.
        state.buffer.fill(0, size, state.length);
    } else if (size > state.length) {
        state.buffer.fill(0, state.length, size);
    }
    state.length = size;
    state.dirty = true;
    state.mutationGeneration++;
};

export const createSharedFsMountBackend = (
    target: SharedFsMountBackendTarget,
    options: SharedFsMountBackendOptions = {}
): SharedFsMountBackend => {
    const handles = new Map<number, OpenHandle>();
    const activeStates = new Set<OpenFileState>();
    const statesByPath = new Map<string, OpenFileState>();
    const statesByNodeId = new Map<string, OpenFileState>();
    const provisionalStatesByPath = new Map<string, OpenFileState>();
    const openingPaths = new Map<string, Promise<void>>();
    const createIntents = new Map<string, Map<symbol, boolean>>();
    const namespaceTransitions = new Map<symbol, readonly string[]>();
    const openAdmissions = new Map<symbol, string>();
    let nextHandle = 1;
    const delegatesReadVerification =
        target.mountReadSemantics?.() === SHARED_FS_MOUNT_READ_SEMANTICS;
    const delegatesNamespaceMutation =
        target.mountNamespaceSemantics?.() ===
        SHARED_FS_MOUNT_NAMESPACE_SEMANTICS;
    const delegatesWriteHashing =
        target.mountWriteSemantics?.() === SHARED_FS_MOUNT_WRITE_SEMANTICS;

    const requireRemoveMutationResult = (
        value: unknown,
        expectedNodeId: string
    ) => {
        const result = value as Partial<SharedFsMountNamespaceMutationResult>;
        if (
            !result ||
            result.type !== "removed" ||
            result.removedNodeId !== expectedNodeId ||
            typeof result.removeEventId !== "string" ||
            result.removeEventId.length === 0
        ) {
            throw new SharedFsBackendError(
                "EIO",
                "Guarded namespace target returned a malformed remove result"
            );
        }
    };

    const requireRenameMutationResult = (
        value: unknown,
        sourceNodeId: string,
        destinationNodeId: string | null,
        parentNodeId: string
    ) => {
        const result = value as Partial<SharedFsMountNamespaceMutationResult>;
        if (
            !result ||
            result.type !== "renamed" ||
            result.sourceNodeId !== sourceNodeId ||
            result.replacedNodeId !== destinationNodeId ||
            result.destinationParentNodeId !== parentNodeId ||
            typeof result.moveEventId !== "string" ||
            result.moveEventId.length === 0 ||
            (destinationNodeId === null
                ? result.replacementDeleteEventId !== null
                : typeof result.replacementDeleteEventId !== "string" ||
                  result.replacementDeleteEventId.length === 0)
        ) {
            throw new SharedFsBackendError(
                "EIO",
                "Guarded namespace target returned a malformed rename result"
            );
        }
    };

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

    const pendingDirtyState = (path: string) => {
        const state = statesByPath.get(path);
        return state &&
            !state.readOnly &&
            !state.terminal &&
            !state.namespaceDetached &&
            state.dirty
            ? state
            : undefined;
    };

    const removeStatePathIndex = (state: OpenFileState) => {
        if (statesByPath.get(state.path) === state) {
            statesByPath.delete(state.path);
        }
    };

    const indexStatePath = (state: OpenFileState) => {
        if (
            activeStates.has(state) &&
            !state.terminal &&
            !state.namespaceDetached &&
            (typeof state.nodeId === "string" || state.nodeId === null)
        ) {
            const existing = statesByPath.get(state.path);
            if (existing && existing !== state) {
                throw new SharedFsBackendError(
                    "EIO",
                    `Two live file states attempted to claim one path: ${state.path}`
                );
            }
            statesByPath.set(state.path, state);
        }
    };

    const indexStateNode = (state: OpenFileState) => {
        if (
            !activeStates.has(state) ||
            state.terminal ||
            state.namespaceDetached ||
            typeof state.nodeId !== "string"
        ) {
            return;
        }
        const existing = statesByNodeId.get(state.nodeId);
        if (existing && existing !== state) {
            throw new SharedFsBackendError(
                "EIO",
                `Two live file states attempted to claim one node: ${state.nodeId}`
            );
        }
        statesByNodeId.set(state.nodeId, state);
    };

    const rebaseStatePath = (state: OpenFileState, path: string) => {
        const existing = statesByPath.get(path);
        if (existing && existing !== state) {
            throw new SharedFsBackendError(
                "EIO",
                `Cannot rebase a file state onto an occupied path: ${path}`
            );
        }
        removeStatePathIndex(state);
        state.path = path;
        indexStatePath(state);
    };

    const detachNamespaceState = (state: OpenFileState) => {
        if (state.namespaceDetached) return;
        removeStatePathIndex(state);
        state.namespaceDetached = true;
        if (
            typeof state.nodeId === "string" &&
            statesByNodeId.get(state.nodeId) === state
        ) {
            statesByNodeId.delete(state.nodeId);
        }
        if (provisionalStatesByPath.get(state.path) === state) {
            provisionalStatesByPath.delete(state.path);
        }
        clearStateCreateIntent(state);
    };

    const namespaceStates = (path: string, descendants: boolean) => {
        if (!descendants) {
            const state = statesByPath.get(path);
            return state && !state.terminal && !state.namespaceDetached
                ? [state]
                : [];
        }
        return [...activeStates].filter(
            (state) =>
                !state.terminal &&
                !state.namespaceDetached &&
                (state.path === path || state.path.startsWith(path + "/"))
        );
    };

    const reconcileObservedNamespaceScope = (
        rootPath: string,
        observed: SharedFsEntryInfo | undefined,
        affected: OpenFileState[]
    ): OpenFileState | undefined => {
        let firstMismatch: OpenFileState | undefined;
        for (const state of affected) {
            const expectedNodeId =
                state.path === rootPath
                    ? observed?.nodeId
                    : observed?.kind === "directory"
                      ? state.nodeId
                      : undefined;
            if (
                typeof state.nodeId !== "string" ||
                state.nodeId !== expectedNodeId
            ) {
                detachNamespaceState(state);
                if (state.path === rootPath) {
                    firstMismatch ??= state;
                }
            }
        }
        return firstMismatch;
    };

    const requireStateNodeBindings = (
        affected: OpenFileState[],
        expectedNodeAtPath: (state: OpenFileState) => string | undefined
    ): OpenFileState | undefined => {
        let firstMismatch: OpenFileState | undefined;
        for (const state of affected) {
            const expected = expectedNodeAtPath(state);
            if (typeof state.nodeId !== "string" || state.nodeId !== expected) {
                // This fd is already stale relative to the visible namespace.
                // Quarantine it before failing so a later flush cannot repair
                // the name with stale bytes.
                detachNamespaceState(state);
                firstMismatch ??= state;
            }
        }
        return firstMismatch;
    };

    const throwStateBindingMismatch = (
        operation: string,
        mismatch: OpenFileState | undefined
    ) => {
        if (!mismatch) return;
        throw new SharedFsBackendError(
            "EAGAIN",
            `${operation} cannot bind active file state ${mismatch.path} to the visible node`
        );
    };

    /**
     * A typed CAS mismatch proves that the guarded append did not happen in
     * the built-in implementation, but a custom capable delegate may have
     * changed the namespace before surfacing that error. Re-read every
     * affected path while the backend transition is still held and detach
     * only descriptors whose opened node is no longer the visible binding.
     * If the recheck itself is indeterminate, fail closed for all candidates.
     * This helper only detaches; it can never reattach a quarantined handle.
     */
    const revalidateStatesAfterNamespaceMismatch = async (
        affected: OpenFileState[]
    ) => {
        const candidates = [...new Set(affected)].filter(
            (state) => !state.namespaceDetached
        );
        if (candidates.length === 0) return;
        const bindings = new Map<string, SharedFsEntryInfo | undefined>();
        try {
            const paths = [...new Set(candidates.map((state) => state.path))];
            const resolved = await mapWithBoundedConcurrency(paths, 4, (path) =>
                findEntry(target, path)
            );
            paths.forEach((path, index) => bindings.set(path, resolved[index]));
        } catch {
            for (const state of candidates) detachNamespaceState(state);
            return;
        }
        for (const state of candidates) {
            if (
                typeof state.nodeId !== "string" ||
                bindings.get(state.path)?.nodeId !== state.nodeId
            ) {
                detachNamespaceState(state);
            }
        }
    };

    const revalidateOpenDescendantBindings = async (
        rootPath: string,
        affected: OpenFileState[]
    ): Promise<Map<string, string>> => {
        const byPath = new Map<string, OpenFileState[]>();
        for (const state of affected) {
            if (state.namespaceDetached || state.path === rootPath) continue;
            const bucket = byPath.get(state.path) ?? [];
            bucket.push(state);
            byPath.set(state.path, bucket);
        }
        const paths = [...byPath.keys()];
        let visible: (SharedFsEntryInfo | undefined)[];
        try {
            visible = await mapWithBoundedConcurrency(paths, 4, (path) =>
                findEntry(target, path)
            );
        } catch {
            for (const bucket of byPath.values()) {
                for (const state of bucket) detachNamespaceState(state);
            }
            throw new SharedFsBackendError(
                "EAGAIN",
                "Cannot revalidate open descendants for directory rename"
            );
        }
        const bindings = new Map<string, string>();
        paths.forEach((path, index) => {
            const nodeId = visible[index]?.nodeId;
            for (const state of byPath.get(path)!) {
                if (
                    typeof state.nodeId !== "string" ||
                    state.nodeId !== nodeId
                ) {
                    detachNamespaceState(state);
                }
            }
            if (nodeId) bindings.set(path, nodeId);
        });
        return bindings;
    };

    const handleTypedRenameMismatch = async (
        error: SharedFsExpectedNamespaceMismatchError,
        sourceStates: OpenFileState[],
        destinationStates: OpenFileState[]
    ) => {
        if (error.actualNodeId !== error.expectedNodeId) {
            const immediatelyAffected =
                error.role === "source"
                    ? sourceStates
                    : error.role === "open-descendant"
                      ? sourceStates.filter(
                            (state) => state.path === error.path
                        )
                      : destinationStates;
            for (const state of immediatelyAffected) {
                detachNamespaceState(state);
            }
        }
        await revalidateStatesAfterNamespaceMismatch([
            ...sourceStates,
            ...destinationStates,
        ]);
    };

    const isAtOrBelow = (path: string, ancestor: string) =>
        path === ancestor ||
        path.startsWith(ancestor === "/" ? "/" : ancestor + "/");

    const pathsOverlap = (left: string, right: string) =>
        isAtOrBelow(left, right) || isAtOrBelow(right, left);

    const reserveOpenAdmission = (path: string) => {
        for (const transitionPaths of namespaceTransitions.values()) {
            if (
                transitionPaths.some((transitionPath) =>
                    pathsOverlap(path, transitionPath)
                )
            ) {
                throw new SharedFsBackendError(
                    "EAGAIN",
                    `Open overlaps an in-flight namespace transition; retry: ${path}`
                );
            }
        }
        const token = Symbol(path);
        openAdmissions.set(token, path);
        return token;
    };

    const assertNoNamespaceTransition = (path: string) => {
        for (const transitionPaths of namespaceTransitions.values()) {
            if (
                transitionPaths.some((transitionPath) =>
                    pathsOverlap(path, transitionPath)
                )
            ) {
                throw new SharedFsBackendError(
                    "EAGAIN",
                    `Path has an in-flight namespace transition; retry the open: ${path}`
                );
            }
        }
    };

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

    const clearStateCreateIntent = (state: OpenFileState) => {
        if (!state.createIntent) {
            return;
        }
        releaseCreateIntent(state.path, state.createIntent);
        state.createIntent = undefined;
    };

    const terminalizeStateLoss = (
        state: OpenFileState,
        error: SharedFsBackendError
    ) => {
        removeStatePathIndex(state);
        state.terminal = error;
        state.dirty = false;
        if (
            typeof state.nodeId === "string" &&
            statesByNodeId.get(state.nodeId) === state
        ) {
            statesByNodeId.delete(state.nodeId);
        }
        if (provisionalStatesByPath.get(state.path) === state) {
            provisionalStatesByPath.delete(state.path);
        }
        clearStateCreateIntent(state);
    };

    const registerState = (state: OpenFileState) => {
        const pathCollision = statesByPath.get(state.path);
        if (
            pathCollision &&
            pathCollision !== state &&
            (typeof state.nodeId === "string" || state.nodeId === null)
        ) {
            throw new SharedFsBackendError(
                "EIO",
                `Cannot register two live file states at: ${state.path}`
            );
        }
        const nodeCollision =
            typeof state.nodeId === "string"
                ? statesByNodeId.get(state.nodeId)
                : undefined;
        if (nodeCollision && nodeCollision !== state) {
            throw new SharedFsBackendError(
                "EIO",
                `Cannot register two live file states for node: ${state.nodeId}`
            );
        }
        activeStates.add(state);
        indexStatePath(state);
        if (typeof state.nodeId === "string") {
            indexStateNode(state);
        } else if (state.nodeId === null) {
            provisionalStatesByPath.set(state.path, state);
        }
    };

    const unregisterState = (state: OpenFileState) => {
        activeStates.delete(state);
        removeStatePathIndex(state);
        if (
            typeof state.nodeId === "string" &&
            statesByNodeId.get(state.nodeId) === state
        ) {
            statesByNodeId.delete(state.nodeId);
        }
        if (provisionalStatesByPath.get(state.path) === state) {
            provisionalStatesByPath.delete(state.path);
        }
        clearStateCreateIntent(state);
        state.borrowedCommitSnapshot = undefined;
    };

    const attachHandle = (
        state: OpenFileState,
        flags: ReturnType<typeof parseFlags>
    ) => {
        const handle = nextHandle++;
        state.openHandles++;
        handles.set(handle, {
            state,
            read: flags.read,
            write: flags.write,
            append: flags.append,
            releaseFailure: flags.releaseFailure ?? "retain",
            closing: false,
        });
        return handle;
    };

    const detachHandle = (handle: number, openHandle: OpenHandle) => {
        if (handles.get(handle) !== openHandle) return;
        handles.delete(handle);
        openHandle.state.openHandles--;
        if (openHandle.state.openHandles === 0) {
            unregisterState(openHandle.state);
        }
    };

    const withOpenPathLock = async <T>(
        path: string,
        fn: () => Promise<T>
    ): Promise<T> => {
        const previous = openingPaths.get(path) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        openingPaths.set(path, current);
        await previous;
        try {
            return await fn();
        } finally {
            release();
            if (openingPaths.get(path) === current) {
                openingPaths.delete(path);
            }
        }
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
        for (const admittedPath of openAdmissions.values()) {
            if (uniquePaths.some((path) => pathsOverlap(path, admittedPath))) {
                throw new SharedFsBackendError(
                    "EAGAIN",
                    `${operation} overlaps an in-flight open; retry: ${admittedPath}`
                );
            }
        }
        for (const state of activeStates) {
            if (
                !state.namespaceDetached &&
                state.committing &&
                uniquePaths.some((path) => pathsOverlap(path, state.path))
            ) {
                throw new SharedFsBackendError(
                    "EAGAIN",
                    `${operation} overlaps an in-flight file commit; retry: ${state.path}`
                );
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

    const commitNow = async (state: OpenFileState) => {
        if (state.namespaceDetached) {
            // POSIX-style unlinked/replaced descriptors retain their shared
            // inode buffer, but it no longer has a pathname to publish through.
            state.persistedGeneration = state.mutationGeneration;
            state.dirty = false;
            return;
        }
        for (const transitionPaths of namespaceTransitions.values()) {
            if (
                transitionPaths.some((path) => pathsOverlap(path, state.path))
            ) {
                throw new SharedFsBackendError(
                    "EAGAIN",
                    `Commit overlaps an in-flight namespace transition; retry: ${state.path}`
                );
            }
        }
        if (!state.dirty) {
            return;
        }
        assertWriteReady(`Commit for ${state.path}`);
        if (state.readOnly) {
            throw new SharedFsBackendError(
                "EROFS",
                `Path is read-only: ${state.path}`
            );
        }
        if (state.openedNodeId === undefined) {
            throw new SharedFsBackendError(
                "EIO",
                `Writable state has no coherent base snapshot: ${state.path}`
            );
        }
        const snapshot: CommitSnapshot = {
            buffer: state.buffer,
            length: state.length,
            mutationGeneration: state.mutationGeneration,
        };
        const markSnapshotPersisted = () => {
            state.persistedGeneration = Math.max(
                state.persistedGeneration,
                snapshot.mutationGeneration
            );
            state.dirty = state.persistedGeneration < state.mutationGeneration;
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
            state.borrowedCommitSnapshot?.buffer !== snapshot.buffer
        ) {
            // Concurrent mutations detach lazily, keeping these exact bytes
            // stable without copying the whole file on the common path.
            state.borrowedCommitSnapshot = snapshot;
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
                state.baseContentHash !== undefined &&
                state.baseContentHash === contentHash &&
                (state.baseVersionIds?.length ?? 0) <= 1 &&
                state.openedHeadVersionIds !== undefined
            ) {
                // An equal byte buffer is a no-op only while the exact content
                // head snapshot opened by this handle is still current. A
                // same-node concurrent version must not make an explicit
                // rewrite disappear: fall through and publish it as a
                // concurrent head.
                const current = await findEntry(target, state.path);
                const sameNode =
                    typeof state.openedNodeId === "string" &&
                    current?.kind === "file" &&
                    current.nodeId === state.openedNodeId;
                if (!sameNode) {
                    throw new SharedFsBackendError(
                        "EAGAIN",
                        `Path changed after it was opened: ${state.path}`
                    );
                }
                if (
                    current.headVersionIds !== undefined &&
                    sameHeads(
                        state.openedHeadVersionIds,
                        current.headVersionIds
                    )
                ) {
                    // Editors flush/fsync liberally: do not mint a new version
                    // when neither the bytes nor the exact causal snapshot
                    // moved. A write may have detached the backing buffer
                    // while the stat above was in flight. In that case this
                    // snapshot is still a no-op, but the newer buffer must
                    // remain dirty.
                    markSnapshotPersisted();
                    return;
                }
            }
            const writeOptions: WriteFileOptions & {
                expectedNodeId?: string | null;
            } = {
                baseVersionIds: state.baseVersionIds,
                // Atomic path/node compare-and-set in the library closes the
                // gap between open and writeFile's path resolution. `null`
                // means this state created a path that must still be absent.
                expectedNodeId: state.openedNodeId,
                ...(state.openedParentNodeId !== undefined
                    ? { expectedParentNodeId: state.openedParentNodeId }
                    : {}),
                ...(delegatesWriteHashing
                    ? {
                          noOpIfHeadVersionIds: [
                              ...(state.openedHeadVersionIds ?? []),
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
                    state.path,
                    bytes,
                    writeOptions
                );
            } catch (error) {
                const expectedMismatch =
                    error instanceof SharedFsExpectedNodeMismatchError &&
                    error.path === state.path;
                const provisionalMismatch =
                    expectedMismatch && error.expectedNodeId === null;
                const existingMismatch =
                    expectedMismatch &&
                    typeof state.openedNodeId === "string" &&
                    error.expectedNodeId === state.openedNodeId;
                const createParentMismatch =
                    error instanceof SharedFsCreateParentMismatchError &&
                    error.path === state.path
                        ? error
                        : undefined;
                if (
                    state.openedNodeId === null &&
                    (provisionalMismatch || createParentMismatch)
                ) {
                    // The target's atomic expected-node guard identified this
                    // absent create as a path or parent loser. Do not perform
                    // a later stat: either namespace may already be repaired,
                    // but this state must never resurrect its stale buffer.
                    const terminal = createParentMismatch
                        ? new SharedFsBackendError(
                              createParentMismatch.mismatchCode,
                              createParentMismatch.message
                          )
                        : new SharedFsBackendError(
                              state.exclusiveCreate && delegatesWriteHashing
                                  ? "EEXIST"
                                  : "EAGAIN",
                              `Path was created concurrently; the losing file state is closed: ${state.path}`
                          );
                    terminalizeStateLoss(state, terminal);
                    throw terminal;
                }
                if (existingMismatch) {
                    const terminal = new SharedFsBackendError(
                        "EAGAIN",
                        `Path changed while its buffered state was being committed; descriptors are closed: ${state.path}`
                    );
                    terminalizeStateLoss(state, terminal);
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
                    `Mount write capability returned invalid metadata: ${state.path}`
                );
            }
            if (!committed) {
                // Keep custom/legacy adapters that return void correct: reload
                // the committed visible version instead of retaining a null
                // node id or stale causal base on the handle.
                const observed = await findEntry(target, state.path);
                if (
                    observed?.kind !== "file" ||
                    typeof observed.versionId !== "string" ||
                    typeof observed.contentHash !== "string"
                ) {
                    throw new SharedFsBackendError(
                        "EIO",
                        `Committed version metadata is unavailable: ${state.path}`
                    );
                }
                committed = {
                    id: observed.versionId,
                    nodeId: observed.nodeId,
                    contentHash: observed.contentHash,
                };
            }
            if (
                (typeof state.openedNodeId === "string" &&
                    state.openedNodeId !== committed.nodeId) ||
                (!delegatesWriteHashing &&
                    committed.contentHash !== contentHash)
            ) {
                throw new SharedFsBackendError(
                    "EAGAIN",
                    `Path changed while it was being committed: ${state.path}`
                );
            }
            if (delegatesWriteHashing && mountWriteOutcome === "unchanged") {
                const unchangedIsValid =
                    state.baseVersionIds?.length === 1 &&
                    state.openedHeadVersionIds !== undefined &&
                    committed.id === state.baseVersionIds[0] &&
                    typeof state.openedNodeId === "string" &&
                    committed.nodeId === state.openedNodeId;
                if (!unchangedIsValid) {
                    throw new SharedFsBackendError(
                        "EIO",
                        `Mount write capability returned an invalid unchanged result: ${state.path}`
                    );
                }
                // The target has observed `bytes` and the immutable-borrowed
                // contract permits indefinite retention even on a no-op.
                // Keep this buffer protected until the state mutates/unregisters.
                markSnapshotPersisted();
                return;
            }
            if (state.nodeId === null) {
                const nodeCollision = statesByNodeId.get(committed.nodeId);
                if (nodeCollision && nodeCollision !== state) {
                    // The target already reported a successful write with an
                    // impossible reused identity. Quarantine only this
                    // malformed creator before touching any base metadata or
                    // provisional aliases; the existing inode remains live.
                    const terminal = new SharedFsBackendError(
                        "EIO",
                        `Create commit reused an already-open node id: ${committed.nodeId}`
                    );
                    terminalizeStateLoss(state, terminal);
                    throw terminal;
                }
            }
            state.baseVersionIds = [committed.id];
            // The common single-head case remains eligible for a later no-op.
            // If another head raced this commit, the conservative singleton
            // will not match and the next dirty rewrite will publish instead
            // of being incorrectly discarded.
            state.openedHeadVersionIds = [committed.id];
            state.openedNodeId = committed.nodeId;
            state.openedParentNodeId = undefined;
            state.baseContentHash = committed.contentHash;
            // The first successful create commit makes the path visible in
            // the target, so the backend-local absent-path reservation is no
            // longer needed. Later writes use the committed node id.
            if (state.nodeId === null) {
                if (provisionalStatesByPath.get(state.path) === state) {
                    provisionalStatesByPath.delete(state.path);
                }
                state.nodeId = committed.nodeId;
                indexStateNode(state);
            }
            clearStateCreateIntent(state);
            markSnapshotPersisted();
        } catch (error) {
            if (!state.terminal) {
                state.dirty = true;
            }
            throw error;
        } finally {
            if (state.borrowedCommitSnapshot === snapshot && !inputExposed) {
                state.borrowedCommitSnapshot = undefined;
            }
        }
    };

    const commitThrough = async (state: OpenFileState, cutoff: number) => {
        // A fence is bounded by the generation captured synchronously by its
        // caller. Sibling writes admitted later remain for the next fence.
        while (state.persistedGeneration < cutoff) {
            if (state.namespaceDetached) {
                state.persistedGeneration = state.mutationGeneration;
                state.dirty = false;
                return;
            }
            if (state.committing) {
                await state.committing;
                continue;
            }
            if (!state.dirty) {
                throw new SharedFsBackendError(
                    "EIO",
                    `Dirty generation bookkeeping is inconsistent: ${state.path}`
                );
            }
            const run = commitNow(state).finally(() => {
                if (state.committing === run) state.committing = undefined;
            });
            state.committing = run;
            await run;
        }
    };

    const requireHandle = (handle: number) => {
        const openHandle = handles.get(handle);
        if (!openHandle || openHandle.state.terminal) {
            throw badHandle(handle);
        }
        return openHandle;
    };

    const newFileState = (
        path: string,
        nodeId: string | null | undefined,
        buffer: Uint8Array
    ): OpenFileState => ({
        path,
        nodeId,
        buffer,
        length: buffer.byteLength,
        dirty: false,
        readOnly: false,
        exclusiveCreate: false,
        mutationGeneration: 0,
        persistedGeneration: 0,
        openHandles: 0,
    });

    const loadWritableSnapshot = async (
        path: string,
        initialEntry: SharedFsEntryInfo,
        truncate: boolean
    ): Promise<{ bytes: Uint8Array; entry: SharedFsEntryInfo }> => {
        let entry = initialEntry;
        const maxSnapshotAttempts = 3;
        for (let attempt = 0; attempt < maxSnapshotAttempts; attempt++) {
            const versionId = entry.versionId;
            if (entry.kind !== "file" || typeof versionId !== "string") {
                throw new SharedFsBackendError(
                    "EIO",
                    `File has no visible version: ${path}`
                );
            }
            const candidate = entry;
            let exact: Uint8Array | undefined;
            let verifiedRead: unknown;
            let readError: unknown;
            if (!truncate) {
                try {
                    if (delegatesReadVerification) {
                        if (typeof target.readVersionForMount !== "function") {
                            throw new SharedFsBackendError(
                                "EIO",
                                `Mount read capability is missing its exact-version reader: ${path}`
                            );
                        }
                        verifiedRead = await target.readVersionForMount(
                            path,
                            versionId
                        );
                    } else {
                        exact = await target.readVersion(path, versionId);
                    }
                } catch (error) {
                    readError = error;
                }
            }

            const confirmed = await findEntry(target, path);
            if (
                !confirmed ||
                confirmed.kind !== "file" ||
                confirmed.nodeId !== candidate.nodeId
            ) {
                throw new SharedFsBackendError(
                    "EAGAIN",
                    `Path changed while it was being opened: ${path}`
                );
            }
            if (!sameFileSnapshot(candidate, confirmed)) {
                entry = confirmed;
                continue;
            }
            if (readError !== undefined) throw readError;
            if (truncate) {
                return { bytes: new Uint8Array(0), entry: confirmed };
            }

            let contentHash: string;
            if (delegatesReadVerification) {
                if (verifiedRead === undefined) {
                    throw new SharedFsBackendError(
                        "EIO",
                        `Visible version is unavailable: ${path}`
                    );
                }
                const verified = requireVerifiedReadSnapshot(
                    verifiedRead,
                    path,
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
                        `Visible version is unavailable: ${path}`
                    );
                }
                contentHash = sha256Base64Sync(exact);
            }
            return {
                bytes: exact,
                entry: { ...confirmed, contentHash },
            };
        }
        throw new SharedFsBackendError(
            "EAGAIN",
            `File changed repeatedly while it was being opened: ${path}`
        );
    };

    const prepareStateForWrite = async (
        state: OpenFileState,
        entry: SharedFsEntryInfo,
        truncate: boolean
    ): Promise<PreparedWritableState | undefined> => {
        if (state.openedNodeId !== undefined) return;
        const path = state.path;
        const nodeId = state.nodeId;
        if (
            nodeId === null ||
            typeof nodeId !== "string" ||
            nodeId !== entry.nodeId
        ) {
            throw new SharedFsBackendError(
                "EAGAIN",
                `File identity changed before writable attach: ${path}`
            );
        }
        const loaded = await loadWritableSnapshot(path, entry, truncate);
        if (loaded.entry.nodeId !== nodeId) {
            throw new SharedFsBackendError(
                "EAGAIN",
                `File identity changed before writable attach: ${path}`
            );
        }
        return {
            path,
            nodeId,
            buffer: loaded.bytes,
            baseVersionIds: loaded.entry.versionId
                ? [loaded.entry.versionId]
                : loaded.entry.headVersionIds !== undefined
                  ? [...loaded.entry.headVersionIds]
                  : undefined,
            openedHeadVersionIds:
                loaded.entry.headVersionIds !== undefined
                    ? [...loaded.entry.headVersionIds]
                    : undefined,
            baseContentHash: loaded.entry.contentHash,
        };
    };

    const installPreparedWritableState = (
        state: OpenFileState,
        prepared: PreparedWritableState
    ) => {
        state.buffer = prepared.buffer;
        state.length = prepared.buffer.byteLength;
        state.openedNodeId = prepared.nodeId;
        state.baseVersionIds = prepared.baseVersionIds;
        state.openedHeadVersionIds = prepared.openedHeadVersionIds;
        state.baseContentHash = prepared.baseContentHash;
    };

    const openPath = async (
        normalized: string,
        parsedFlags: ReturnType<typeof parseFlags>
    ): Promise<number> => {
        if (!parsedFlags.read && !parsedFlags.write) {
            throw new SharedFsBackendError(
                "EINVAL",
                "Open has no valid access mode: " + normalized
            );
        }
        if (parsedFlags.exclusive && !parsedFlags.create) {
            throw new SharedFsBackendError(
                "EINVAL",
                "O_EXCL requires O_CREAT: " + normalized
            );
        }
        if (parsedFlags.truncate && !parsedFlags.write) {
            throw new SharedFsBackendError(
                "EINVAL",
                "O_TRUNC requires write access: " + normalized
            );
        }
        const mutatingOpen =
            parsedFlags.write || parsedFlags.create || parsedFlags.truncate;
        if (mutatingOpen) {
            assertWriteReady("Mutating open for " + normalized);
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
                    "Path is read-only: " + normalized
                );
            }
            const buffer = await readConflictFile(normalized);
            const state = newFileState(normalized, undefined, buffer);
            state.readOnly = true;
            registerState(state);
            return attachHandle(state, parsedFlags);
        }
        if (mutatingOpen && target.ignoreCheck?.(normalized).ignored) {
            throw new SharedFsBackendError(
                "EACCES",
                "Path is artifact-ignored: " + normalized
            );
        }

        return withOpenPathLock(normalized, async () => {
            assertNoNamespaceTransition(normalized);

            const provisional = provisionalStatesByPath.get(normalized);
            if (provisional && !provisional.terminal) {
                if (parsedFlags.create && parsedFlags.exclusive) {
                    throw new SharedFsBackendError(
                        "EEXIST",
                        "Path already exists locally: " + normalized
                    );
                }
                if (parsedFlags.truncate) {
                    resizeState(provisional, 0);
                }
                return attachHandle(provisional, parsedFlags);
            }

            let createIntent: symbol | undefined;
            let openedParentNodeId: string | undefined;
            try {
                let entry = await findEntry(target, normalized);
                assertNoNamespaceTransition(normalized);
                // Any fresh pathname observation also reconciles older local
                // inode states for that exact name. A remotely removed or
                // replaced node must stop contributing overlays immediately,
                // while its already-open descriptors retain detached bytes.
                const observedScope = namespaceStates(normalized, false);
                const committingMismatch = observedScope.find(
                    (state) =>
                        state.committing && state.nodeId !== entry?.nodeId
                );
                if (committingMismatch) {
                    throw new SharedFsBackendError(
                        "EAGAIN",
                        `Open observed a new namespace binding while the old state is committing; retry: ${normalized}`
                    );
                }
                reconcileObservedNamespaceScope(
                    normalized,
                    entry,
                    observedScope
                );

                if (!entry) {
                    if (!parsedFlags.create) {
                        throw notFound(normalized);
                    }
                    createIntent = reserveCreateIntent(
                        normalized,
                        parsedFlags.exclusive
                    );
                    const parentPath = dirname(normalized);
                    if (parentPath !== "/") {
                        const parent = await findEntry(target, parentPath);
                        if (!parent) {
                            throw new SharedFsBackendError(
                                "ENOENT",
                                "Parent directory does not exist: " + parentPath
                            );
                        }
                        if (parent.kind !== "directory") {
                            throw new SharedFsBackendError(
                                "ENOTDIR",
                                "Parent path is not a directory: " + parentPath
                            );
                        }
                        openedParentNodeId = parent.nodeId;
                    }

                    const confirmed = await findEntry(target, normalized);
                    if (!confirmed) {
                        const state = newFileState(
                            normalized,
                            null,
                            new Uint8Array(0)
                        );
                        state.dirty = true;
                        state.exclusiveCreate = parsedFlags.exclusive;
                        state.createIntent = createIntent;
                        state.openedNodeId = null;
                        state.openedParentNodeId = openedParentNodeId;
                        state.mutationGeneration = 1;
                        registerState(state);
                        createIntent = undefined;
                        return attachHandle(state, parsedFlags);
                    }
                    releaseCreateIntent(normalized, createIntent);
                    createIntent = undefined;
                    openedParentNodeId = undefined;
                    entry = confirmed;
                }

                if (parsedFlags.create && parsedFlags.exclusive) {
                    throw new SharedFsBackendError(
                        "EEXIST",
                        "Path already exists: " + normalized
                    );
                }
                if (entry.kind === "directory") {
                    throw new SharedFsBackendError(
                        "EISDIR",
                        "Path is a directory: " + normalized
                    );
                }

                const attachExisting = async (
                    state: OpenFileState
                ): Promise<number> => {
                    if (state.terminal || state.path !== normalized) {
                        throw new SharedFsBackendError(
                            "EAGAIN",
                            "File identity moved while it was being opened: " +
                                normalized
                        );
                    }
                    // Pin the state across a legacy fallback-to-exact upgrade.
                    // The last older descriptor may release while its exact
                    // version is loading; without this pin it could unregister
                    // the state just before the new descriptor attaches.
                    state.openHandles++;
                    try {
                        let prepared: PreparedWritableState | undefined;
                        try {
                            prepared = parsedFlags.write
                                ? await prepareStateForWrite(
                                      state,
                                      entry!,
                                      parsedFlags.truncate
                                  )
                                : undefined;
                        } catch (error) {
                            // Exact loading may discover a remote rename,
                            // removal, or replacement after the initial stat.
                            // Preserve same-node transient failures, but
                            // detach a state whose pathname binding moved.
                            await revalidateStatesAfterNamespaceMismatch([
                                state,
                            ]);
                            throw error;
                        }
                        assertNoNamespaceTransition(normalized);
                        if (
                            state.terminal ||
                            state.path !== normalized ||
                            state.nodeId !== entry!.nodeId ||
                            (prepared !== undefined &&
                                (prepared.path !== normalized ||
                                    prepared.nodeId !== entry!.nodeId ||
                                    state.openedNodeId !== undefined))
                        ) {
                            throw new SharedFsBackendError(
                                "EAGAIN",
                                "File identity moved while it was being opened: " +
                                    normalized
                            );
                        }
                        // No await may appear between admission above and
                        // installing the exact snapshot/truncate below. A
                        // failed writable upgrade must leave sibling readers'
                        // bytes and causal binding entirely unchanged.
                        if (prepared !== undefined) {
                            installPreparedWritableState(state, prepared);
                        }
                        if (parsedFlags.truncate) {
                            resizeState(state, 0);
                        }
                        return attachHandle(state, parsedFlags);
                    } finally {
                        state.openHandles--;
                        if (state.openHandles === 0) {
                            unregisterState(state);
                        }
                    }
                };

                const shared = statesByNodeId.get(entry.nodeId);
                if (shared) {
                    if (shared.path === normalized) {
                        return attachExisting(shared);
                    }
                    // Shared-fs does not expose hard links. Observing the same
                    // node at a different path means a remote move occurred;
                    // keep the old fd state detached and load a fresh state
                    // bound to the newly observed pathname.
                    if (shared.committing) {
                        throw new SharedFsBackendError(
                            "EAGAIN",
                            `Open observed a remotely moved node while its old state is committing; retry: ${normalized}`
                        );
                    }
                    detachNamespaceState(shared);
                }

                let state: OpenFileState;
                if (parsedFlags.write || delegatesReadVerification) {
                    // An advertised verified reader lets the first descriptor,
                    // including a read-only one, establish the coherent state
                    // later writable siblings can reuse without another load
                    // or hash. Legacy targets retain their readFile fallback.
                    const loaded = await loadWritableSnapshot(
                        normalized,
                        entry,
                        parsedFlags.truncate
                    );
                    state = newFileState(
                        normalized,
                        loaded.entry.nodeId,
                        loaded.bytes
                    );
                    state.openedNodeId = loaded.entry.nodeId;
                    state.baseVersionIds = loaded.entry.versionId
                        ? [loaded.entry.versionId]
                        : loaded.entry.headVersionIds;
                    state.openedHeadVersionIds =
                        loaded.entry.headVersionIds !== undefined
                            ? [...loaded.entry.headVersionIds]
                            : undefined;
                    state.baseContentHash = loaded.entry.contentHash;
                } else {
                    const existing =
                        (await target.readFile(normalized)) ??
                        new Uint8Array(0);
                    state = newFileState(normalized, entry.nodeId, existing);
                }

                assertNoNamespaceTransition(normalized);
                const raced = statesByNodeId.get(state.nodeId as string);
                if (raced) {
                    if (raced.path === normalized) {
                        return attachExisting(raced);
                    }
                    if (raced.committing) {
                        throw new SharedFsBackendError(
                            "EAGAIN",
                            `Open observed a remotely moved node while its old state is committing; retry: ${normalized}`
                        );
                    }
                    detachNamespaceState(raced);
                }
                registerState(state);
                if (parsedFlags.truncate) {
                    resizeState(state, 0);
                }
                return attachHandle(state, parsedFlags);
            } catch (error) {
                if (createIntent) {
                    releaseCreateIntent(normalized, createIntent);
                }
                throw error;
            }
        });
    };

    const openPathAdmitted = async (
        normalized: string,
        parsedFlags: ReturnType<typeof parseFlags>
    ) => {
        // Synchronous admission precedes openPath's first namespace await.
        // Registration (or failure) releases it.
        const admission = reserveOpenAdmission(normalized);
        try {
            return await openPath(normalized, parsedFlags);
        } finally {
            openAdmissions.delete(admission);
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
                const pending = pendingDirtyState(normalized);
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

        async readdir(path: string, options?: SharedFsReaddirOptions) {
            return wrap(async () => {
                const normalized = normalizeFsPath(path);
                const includeStats = options?.includeStats === true;
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
                        ).map((conflict) => {
                            const name = encodeConflictPathName(conflict.path);
                            if (!includeStats) {
                                return {
                                    name,
                                    kind: "directory" as const,
                                };
                            }
                            return {
                                name,
                                kind: "directory" as const,
                                stat: directoryDirentStat(),
                            };
                        });
                    }
                    const conflict = await conflictForPath(parsed.filePath);
                    if (!conflict) {
                        throw notFound(normalized);
                    }
                    return conflict.versions
                        .filter((version) => !version.deleted)
                        .map((version) => {
                            if (!includeStats) {
                                return {
                                    name: version.id,
                                    kind: "file" as const,
                                };
                            }
                            return {
                                name: version.id,
                                kind: "file" as const,
                                stat: fileDirentStat(
                                    bigintToSize(version.size),
                                    Number(version.createdAt)
                                ),
                            };
                        });
                }
                const byName = new Map<string, SharedFsDirent>(
                    (await target.list(normalized)).map((entry) => {
                        if (!includeStats) {
                            return [
                                entry.name,
                                {
                                    name: entry.name,
                                    kind: entry.kind,
                                },
                            ] as const;
                        }
                        return [
                            entry.name,
                            {
                                name: entry.name,
                                kind: entry.kind,
                                stat:
                                    entry.kind === "directory"
                                        ? directoryDirentStat(
                                              Number(entry.updatedAt)
                                          )
                                        : fileDirentStat(
                                              bigintToSize(entry.size),
                                              Number(entry.updatedAt)
                                          ),
                            },
                        ] as const;
                    })
                );
                for (const state of activeStates) {
                    if (
                        !state.readOnly &&
                        !state.terminal &&
                        !state.namespaceDetached &&
                        state.dirty &&
                        dirname(state.path) === normalized
                    ) {
                        const name = basename(state.path);
                        byName.set(
                            name,
                            includeStats
                                ? {
                                      name,
                                      kind: "file" as const,
                                      stat: fileDirentStat(state.length),
                                  }
                                : { name, kind: "file" as const }
                        );
                    }
                }
                const entries = [...byName.values()];
                if (normalized === "/") {
                    entries.push(
                        includeStats
                            ? {
                                  name: CONFLICTS_DIR,
                                  kind: "directory",
                                  stat: directoryDirentStat(),
                              }
                            : {
                                  name: CONFLICTS_DIR,
                                  kind: "directory",
                              }
                    );
                }
                return entries;
            });
        },

        async open(path: string, flags?: SharedFsOpenFlags) {
            return wrap(() =>
                openPathAdmitted(normalizeFsPath(path), parseFlags(flags))
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
            const state = openHandle.state;
            if (offset >= state.length || size <= 0) {
                return new Uint8Array(0);
            }
            const end = Math.min(state.length, offset + size);
            // Reads are snapshots. Returning a subarray would expose the live
            // handle buffer: caller mutation or a later write/truncate could
            // change already-returned bytes without advancing the mutation
            // generation or dirtying the handle.
            return new Uint8Array(state.buffer.subarray(offset, end));
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
            const state = openHandle.state;
            // O_APPEND positions every accepted write at the then-current end
            // of the shared file state. There is no await between observing
            // length and mutating it, so sibling append descriptors allocate
            // non-overlapping local ranges atomically.
            const writeOffset = openHandle.append ? state.length : offset;
            if (writeOffset < 0) {
                throw new SharedFsBackendError(
                    "EINVAL",
                    `Invalid offset: ${writeOffset}`
                );
            }
            if (data.byteLength === 0) {
                // A zero-byte write succeeds without allocating a sparse gap,
                // changing length, or manufacturing a commit generation.
                return 0;
            }
            const end = writeOffset + data.byteLength;
            ensureMutableCapacity(state, end);
            if (writeOffset > state.length) {
                // Sparse write: zero the gap.
                state.buffer.fill(0, state.length, writeOffset);
            }
            state.buffer.set(data, writeOffset);
            state.length = Math.max(state.length, end);
            state.dirty = true;
            state.mutationGeneration++;
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
                    resizeState(openHandle.state, size);
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
                const handle = await openPathAdmitted(normalized, {
                    read: true,
                    write: true,
                    create: false,
                    truncate: false,
                    append: false,
                    exclusive: false,
                });
                const openHandle = requireHandle(handle);
                try {
                    resizeState(openHandle.state, size);
                    const cutoff = openHandle.state.mutationGeneration;
                    await commitThrough(openHandle.state, cutoff);
                } finally {
                    detachHandle(handle, openHandle);
                }
            });
        },

        async flush(handle: number) {
            const openHandle = requireHandle(handle);
            const cutoff = openHandle.state.mutationGeneration;
            return wrap(() => commitThrough(openHandle.state, cutoff));
        },

        async fsync(handle: number) {
            const openHandle = requireHandle(handle);
            const cutoff = openHandle.state.mutationGeneration;
            return wrap(() => commitThrough(openHandle.state, cutoff));
        },

        async release(handle: number) {
            const openHandle = handles.get(handle);
            if (!openHandle) {
                return;
            }
            const state = openHandle.state;
            if (state.terminal) {
                detachHandle(handle, openHandle);
                return;
            }
            if (openHandle.releasing) {
                return openHandle.releasing;
            }
            // Close mutation admission before the first await. Every write or
            // handle truncate accepted before this point has already advanced
            // mutationGeneration; later attempts through this descriptor fail
            // with EBADF. Sibling descriptors keep their own admission state.
            openHandle.closing = true;
            const cutoff = state.mutationGeneration;
            const releasing = wrap(() => commitThrough(state, cutoff))
                .then(
                    () => {
                        detachHandle(handle, openHandle);
                    },
                    (error) => {
                        if (
                            state.terminal ||
                            openHandle.releaseFailure === "discard"
                        ) {
                            detachHandle(handle, openHandle);
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
                        const staleStates = namespaceStates(normalized, false);
                        const existing = await findEntry(target, normalized);
                        reconcileObservedNamespaceScope(
                            normalized,
                            existing,
                            staleStates
                        );
                        if (existing) {
                            throw new SharedFsBackendError(
                                "EEXIST",
                                `Path already exists: ${normalized}`
                            );
                        }
                        try {
                            await target.mkdir(normalized);
                        } catch (error) {
                            // mkdir has no structured commit result. Once the
                            // delegate was invoked, a rejection is
                            // indeterminate and old path-bound descriptors
                            // must not shadow a possibly durable directory.
                            for (const state of staleStates) {
                                detachNamespaceState(state);
                            }
                            throw error;
                        }
                        for (const state of staleStates) {
                            detachNamespaceState(state);
                        }
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
                        const affected = namespaceStates(normalized, true);
                        const entry = await findEntry(target, normalized);
                        reconcileObservedNamespaceScope(
                            normalized,
                            entry,
                            affected
                        );
                        if (!entry) {
                            throw notFound(normalized);
                        }
                        if (entry.kind !== "directory") {
                            throw new SharedFsBackendError(
                                "ENOTDIR",
                                `Path is not a directory: ${normalized}`
                            );
                        }
                        try {
                            if (delegatesNamespaceMutation) {
                                if (!target.mutateNamespaceForMount) {
                                    throw new SharedFsBackendError(
                                        "EIO",
                                        "Target advertises guarded namespace semantics without an implementation"
                                    );
                                }
                                const result =
                                    await target.mutateNamespaceForMount({
                                        type: "remove",
                                        path: normalized,
                                        expectedNodeId: entry.nodeId,
                                        expectedKind: "directory",
                                    });
                                requireRemoveMutationResult(
                                    result,
                                    entry.nodeId
                                );
                            } else {
                                await target.rm(normalized);
                            }
                        } catch (error) {
                            // Even an untyped error can be deterministic
                            // (notably ENOTEMPTY). Re-read every descriptor's
                            // exact binding: preserved bindings stay usable,
                            // post-commit disappearance/replacement detaches,
                            // and an indeterminate lookup fails closed inside
                            // the helper.
                            await revalidateStatesAfterNamespaceMismatch(
                                affected
                            );
                            throw error;
                        }
                        for (const state of affected) {
                            detachNamespaceState(state);
                        }
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
                if (fromPath === toPath) {
                    return;
                }
                return withNamespaceTransition(
                    `rename ${fromPath} to ${toPath}`,
                    [fromPath, toPath],
                    async () => {
                        const sourceScopeStates = namespaceStates(
                            fromPath,
                            true
                        );
                        const destinationScopeStates = namespaceStates(
                            toPath,
                            true
                        );
                        if (delegatesNamespaceMutation) {
                            if (!target.mutateNamespaceForMount) {
                                throw new SharedFsBackendError(
                                    "EIO",
                                    "Target advertises guarded namespace semantics without an implementation"
                                );
                            }
                            const source = await findEntry(target, fromPath);
                            const sourceObservedMismatch =
                                reconcileObservedNamespaceScope(
                                    fromPath,
                                    source,
                                    sourceScopeStates
                                );
                            if (!source) throw notFound(fromPath);
                            const destination = await findEntry(target, toPath);
                            const destinationObservedMismatch =
                                reconcileObservedNamespaceScope(
                                    toPath,
                                    destination,
                                    destinationScopeStates
                                );
                            const sourceStates = sourceScopeStates.filter(
                                (state) =>
                                    !state.namespaceDetached &&
                                    (state.path === fromPath ||
                                        source.kind === "directory")
                            );
                            const sourceRootStates = sourceStates.filter(
                                (state) => state.path === fromPath
                            );
                            const sourceDescendantStates = sourceStates.filter(
                                (state) => state.path !== fromPath
                            );
                            const byPath =
                                source.kind === "directory"
                                    ? await revalidateOpenDescendantBindings(
                                          fromPath,
                                          sourceDescendantStates
                                      )
                                    : new Map<string, string>();
                            // Destination descendants never participate in
                            // the guarded move binding, but stale descriptors
                            // must still be reconciled before any early
                            // preflight error (including a stale root EAGAIN).
                            if (destination?.kind === "directory") {
                                await revalidateOpenDescendantBindings(
                                    toPath,
                                    destinationScopeStates
                                );
                            }
                            const destinationStates =
                                destinationScopeStates.filter(
                                    (state) => !state.namespaceDetached
                                );
                            const destinationRootStates =
                                destinationStates.filter(
                                    (state) => state.path === toPath
                                );
                            const sourceBindingMismatch =
                                sourceObservedMismatch ??
                                requireStateNodeBindings(
                                    sourceRootStates,
                                    () => source.nodeId
                                );
                            const destinationBindingMismatch =
                                destinationObservedMismatch ??
                                requireStateNodeBindings(
                                    destinationRootStates,
                                    () => destination?.nodeId
                                );
                            throwStateBindingMismatch(
                                `rename ${fromPath} to ${toPath}`,
                                sourceBindingMismatch ??
                                    destinationBindingMismatch
                            );
                            // Validate every active source descendant before
                            // consulting the destination parent. A replaced
                            // source directory can otherwise leave stale
                            // descendant descriptors attached when the rename
                            // exits early for an invalid parent.
                            const parentPath = dirname(toPath);
                            const parent =
                                parentPath === "/"
                                    ? undefined
                                    : await findEntry(target, parentPath);
                            if (
                                parentPath !== "/" &&
                                (!parent || parent.kind !== "directory")
                            ) {
                                throw new SharedFsBackendError(
                                    parent ? "ENOTDIR" : "ENOENT",
                                    `Parent directory does not exist: ${parentPath}`
                                );
                            }
                            const parentNodeId = parent?.nodeId ?? ROOT_NODE_ID;
                            try {
                                const result =
                                    await target.mutateNamespaceForMount({
                                        type: "rename",
                                        from: fromPath,
                                        to: toPath,
                                        expectedSourceNodeId: source.nodeId,
                                        expectedDestinationNodeId:
                                            destination?.nodeId ?? null,
                                        expectedDestinationParentNodeId:
                                            parentNodeId,
                                        expectedOpenDescendants: [
                                            ...byPath,
                                        ].map(([path, nodeId]) => ({
                                            path,
                                            nodeId,
                                        })),
                                    });
                                requireRenameMutationResult(
                                    result,
                                    source.nodeId,
                                    destination?.nodeId ?? null,
                                    parentNodeId
                                );
                            } catch (error) {
                                if (
                                    error instanceof
                                    SharedFsExpectedNamespaceMismatchError
                                ) {
                                    await handleTypedRenameMismatch(
                                        error,
                                        sourceStates,
                                        destinationStates
                                    );
                                } else {
                                    await revalidateStatesAfterNamespaceMismatch(
                                        [...sourceStates, ...destinationStates]
                                    );
                                }
                                throw error;
                            }
                            for (const state of destinationStates) {
                                detachNamespaceState(state);
                            }
                            for (const state of sourceStates) {
                                if (state.namespaceDetached) continue;
                                rebaseStatePath(
                                    state,
                                    state.path === fromPath
                                        ? toPath
                                        : toPath +
                                              state.path.slice(fromPath.length)
                                );
                            }
                            return;
                        } else {
                            // Legacy delegates cannot perform the exact
                            // node-bound CAS, but stale local inode state must
                            // still never follow (and later overwrite) a
                            // remotely replaced source or destination.
                            const source = await findEntry(target, fromPath);
                            reconcileObservedNamespaceScope(
                                fromPath,
                                source,
                                sourceScopeStates
                            );
                            const destination = await findEntry(target, toPath);
                            reconcileObservedNamespaceScope(
                                toPath,
                                destination,
                                destinationScopeStates
                            );
                            if (source?.kind === "directory") {
                                await revalidateOpenDescendantBindings(
                                    fromPath,
                                    sourceScopeStates
                                );
                            }
                            if (destination?.kind === "directory") {
                                await revalidateOpenDescendantBindings(
                                    toPath,
                                    destinationScopeStates
                                );
                            }
                            const sourceStates = sourceScopeStates.filter(
                                (state) =>
                                    !state.namespaceDetached &&
                                    (state.path === fromPath ||
                                        source?.kind === "directory")
                            );
                            try {
                                await target.rename(fromPath, toPath);
                            } catch (error) {
                                await revalidateStatesAfterNamespaceMismatch([
                                    ...sourceScopeStates,
                                    ...destinationScopeStates,
                                ]);
                                throw error;
                            }
                            for (const state of destinationScopeStates) {
                                detachNamespaceState(state);
                            }
                            let movedBindings:
                                | {
                                      state: OpenFileState;
                                      path: string;
                                      entry: SharedFsEntryInfo | undefined;
                                  }[]
                                | undefined;
                            try {
                                movedBindings = await mapWithBoundedConcurrency(
                                    sourceStates,
                                    4,
                                    async (state) => {
                                        const path =
                                            state.path === fromPath
                                                ? toPath
                                                : toPath +
                                                  state.path.slice(
                                                      fromPath.length
                                                  );
                                        return {
                                            state,
                                            path,
                                            entry: await findEntry(
                                                target,
                                                path
                                            ),
                                        };
                                    }
                                );
                            } catch {
                                // The delegate already reported success. Do
                                // not turn that into a retryable rename; fail
                                // closed locally when post-move binding cannot
                                // be established.
                                for (const state of sourceStates) {
                                    detachNamespaceState(state);
                                }
                                return;
                            }
                            for (const binding of movedBindings) {
                                const { state } = binding;
                                if (
                                    state.namespaceDetached ||
                                    typeof state.nodeId !== "string" ||
                                    binding.entry?.nodeId !== state.nodeId
                                ) {
                                    detachNamespaceState(state);
                                    continue;
                                }
                                rebaseStatePath(state, binding.path);
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
                        const affected = namespaceStates(normalized, false);
                        const entry = await findEntry(target, normalized);
                        reconcileObservedNamespaceScope(
                            normalized,
                            entry,
                            affected
                        );
                        if (!entry) {
                            throw notFound(normalized);
                        }
                        if (entry.kind !== "file") {
                            throw new SharedFsBackendError(
                                "EISDIR",
                                `Path is a directory: ${normalized}`
                            );
                        }
                        if (delegatesNamespaceMutation) {
                            if (!target.mutateNamespaceForMount) {
                                throw new SharedFsBackendError(
                                    "EIO",
                                    "Target advertises guarded namespace semantics without an implementation"
                                );
                            }
                            throwStateBindingMismatch(
                                `unlink ${normalized}`,
                                requireStateNodeBindings(
                                    affected,
                                    () => entry.nodeId
                                )
                            );
                            try {
                                const result =
                                    await target.mutateNamespaceForMount({
                                        type: "remove",
                                        path: normalized,
                                        expectedNodeId: entry.nodeId,
                                        expectedKind: "file",
                                    });
                                requireRemoveMutationResult(
                                    result,
                                    entry.nodeId
                                );
                            } catch (error) {
                                if (
                                    error instanceof
                                    SharedFsExpectedNamespaceMismatchError
                                ) {
                                    if (
                                        error.actualNodeId !==
                                        error.expectedNodeId
                                    ) {
                                        for (const state of affected) {
                                            detachNamespaceState(state);
                                        }
                                    }
                                }
                                await revalidateStatesAfterNamespaceMismatch(
                                    affected
                                );
                                throw error;
                            }
                        } else {
                            try {
                                await target.rm(normalized);
                            } catch (error) {
                                await revalidateStatesAfterNamespaceMismatch(
                                    affected
                                );
                                throw error;
                            }
                        }
                        for (const state of affected) {
                            detachNamespaceState(state);
                        }
                    }
                );
            });
        },
    };

    return backend;
};
