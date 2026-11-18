import { createHash, randomBytes } from "node:crypto";
import * as hostFs from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
    SharedFsBackendError,
    type parseFlags,
    type SharedFsBackendErrorCode,
    type SharedFsDirent,
    type SharedFsDirentStat,
    type SharedFsMountBackendTarget,
    type SharedFsStat,
} from "./mount-backend.js";
import {
    CONFLICTS_DIR,
    ROOT_NODE_ID,
    dirname,
    fsNameError,
    fsNameErrorMessage,
    joinFsPath,
    pathSegments,
} from "./path.js";

/**
 * A mount's local overlay. Every path at or below a sealed name (such as
 * `node_modules`) or, with an ignore-aware target, an ignored boundary lives
 * in a directory on this machine instead of the shared filesystem: nothing
 * there reaches the log or the block store. Local entries hang off the node
 * id of the shared directory holding the boundary (its anchor), so they
 * follow that directory through renames:
 *
 *     <directory>/meta.json                      {"format":1,"address":...}
 *     <directory>/n/<hex of the anchor node id>/<boundary>/...
 */

/** The storage format this version reads and writes (meta.json). */
const LOCAL_OVERLAY_FORMAT = 1;
/** Anchor paths whose node id is remembered while the namespace is quiet. */
const ANCHOR_CACHE_LIMIT = 4096;
/** Host directories known to be directories, not links, until a change. */
const DIRECTORY_CACHE_LIMIT = 8192;
/** Host lstat calls in flight for one listing. */
const LISTING_STAT_CONCURRENCY = 16;

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/**
 * Every host call the overlay makes, through this object so a test can make
 * one fail.
 * @internal
 */
export const localOverlayHost = {
    open: promisify(hostFs.open),
    close: promisify(hostFs.close),
    closeSync: hostFs.closeSync,
    read: promisify(hostFs.read),
    write: promisify(hostFs.write),
    fstat: promisify(hostFs.fstat),
    ftruncate: promisify(hostFs.ftruncate),
    fsync: promisify(hostFs.fsync),
    lstat: promisify(hostFs.lstat),
    truncate: promisify(hostFs.truncate),
    mkdir: promisify(hostFs.mkdir),
    rmdir: promisify(hostFs.rmdir),
    unlink: promisify(hostFs.unlink),
    rename: promisify(hostFs.rename),
    chmod: promisify(hostFs.chmod),
    lutimes: promisify(hostFs.lutimes),
    symlink: promisify(hostFs.symlink),
    readlink: promisify(hostFs.readlink),
    readdir: promisify(hostFs.readdir),
    readFile: promisify(hostFs.readFile),
    writeFile: promisify(hostFs.writeFile),
};
const host = localOverlayHost;

export type SharedFsLocalOverlayOptions = {
    /** Host directory holding this filesystem's local entries; created (0700) if missing. */
    directory: string;
    /** Filesystem address, recorded in meta.json and checked on every open. */
    address: string;
    /** Names that are always local, byte-exact: normally program.sealedIgnoredNames. */
    sealedNames: readonly string[];
};

/**
 * A directory opened by openMountLocalOverlay, for
 * createSharedFsMountBackend's `localOverlay`. One backend serves from it;
 * do not bind two overlays opened on the same directory at once.
 */
export type SharedFsMountLocalOverlay = {
    readonly directory: string;
    /**
     * How many shared directories holding local entries the target reports
     * deleted. Their entries stay on disk, hidden, until the directory is
     * restored or the entries are deleted by hand.
     */
    detached(
        target: Pick<SharedFsMountBackendTarget, "nodeForMount">
    ): Promise<number>;
};

/** `<stateDirectory>/shared-fs-local-overlay/<first 32 hex of sha256(address)>` */
export const localOverlayDirectory = (
    stateDirectory: string,
    address: string
) =>
    join(
        stateDirectory,
        "shared-fs-local-overlay",
        createHash("sha256").update(address).digest("hex").slice(0, 32)
    );

/** A mount path the overlay serves. */
type LocalRoute = {
    path: string;
    /** The shared directory holding the boundary ("/" at the top). */
    anchorPath: string;
    /** The sealed or ignored name in the anchor. */
    boundary: string;
    /** Names below the boundary. */
    rest: string[];
};

type LocalHandle = {
    fd: number;
    path: string;
    read: boolean;
    write: boolean;
    append: boolean;
};

type OpenFlags = ReturnType<typeof parseFlags>;

type ReadOnlyTarget = Pick<
    SharedFsMountBackendTarget,
    "stat" | "nodeForMount" | "ignoreCheck"
>;

type Binding = {
    /** Lookups only: the overlay never holds a mutator of the target. */
    view: ReadOnlyTarget;
    /** The target has a namespace feed (it clears the anchor cache). */
    feed: boolean;
    /** The backend's handle counter: local and shared handles never collide. */
    allocateHandle(): number;
    /** Move a shared directory's change stamp (its mtime and ctime). */
    bumpStamp(nodeId: string): void;
};

const notFound = (path: string) =>
    new SharedFsBackendError("ENOENT", `Path does not exist: ${path}`);

const invalid = (message: string) =>
    new SharedFsBackendError("EINVAL", message);

const hexOf = (nodeId: string) => Buffer.from(nodeId, "utf8").toString("hex");

/** The node id an attachment directory name encodes, or undefined. */
const attachmentNodeId = (name: string) => {
    if (!/^(?:[0-9a-f]{2})+$/.test(name)) return undefined;
    const nodeId = Buffer.from(name, "hex").toString("utf8");
    return hexOf(nodeId) === name &&
        (nodeId === ROOT_NODE_ID || nodeId.startsWith("dir:"))
        ? nodeId
        : undefined;
};

/**
 * EINVAL, before anything is opened, for an open without an access mode,
 * O_EXCL without O_CREAT, or O_TRUNC without write access.
 * @internal
 */
export const assertValidOpenFlags = (path: string, flags: OpenFlags) => {
    if (!flags.read && !flags.write) {
        throw invalid("Open has no valid access mode: " + path);
    }
    if (flags.exclusive && !flags.create) {
        throw invalid("O_EXCL requires O_CREAT: " + path);
    }
    if (flags.truncate && !flags.write) {
        throw invalid("O_TRUNC requires write access: " + path);
    }
};

/** Host codes the backend reports unchanged. */
const SAME_CODES = new Set<string>([
    "ENOENT",
    "EEXIST",
    "EISDIR",
    "ENOTDIR",
    "ENOTEMPTY",
    "EINVAL",
    "EACCES",
    "EBADF",
    "EROFS",
    "ENAMETOOLONG",
    "EFBIG",
    "EAGAIN",
    "EXDEV",
    "ENOSPC",
    "EDQUOT",
    "EPERM",
]);

/**
 * The backend code for a host fs error, or undefined when it has none (the
 * overlay then reports EIO and logs it). EBUSY (a Windows sharing violation)
 * and ENOTSUP are EPERM, which npm retries; ELOOP (a final symlink under
 * O_NOFOLLOW) and a refused argument are EINVAL.
 * @internal
 */
export const localOverlayErrorCode = (
    error: unknown
): SharedFsBackendErrorCode | undefined => {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (typeof code !== "string") return undefined;
    if (SAME_CODES.has(code)) return code as SharedFsBackendErrorCode;
    switch (code) {
        case "EBUSY":
        case "ENOTSUP":
        case "EOPNOTSUPP":
            return "EPERM";
        case "ELOOP":
        case "ERR_INVALID_ARG_VALUE":
        case "ERR_INVALID_ARG_TYPE":
            return "EINVAL";
    }
    return undefined;
};

const WIN32_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Whether a Windows host cannot hold `name` as given: it has `: * ? " < > |`,
 * ends in a dot or a space, or is a reserved device name (with or without an
 * extension). Always false on other hosts.
 * @internal
 */
export const hostRefusesName = (
    name: string,
    platform: NodeJS.Platform = process.platform
) =>
    platform === "win32" &&
    (/[:*?"<>|]/.test(name) ||
        /[. ]$/.test(name) ||
        WIN32_RESERVED_NAME.test(name));

/**
 * Why a symlink target cannot be stored, or undefined: it must be 1-1023
 * bytes of UTF-8 without NUL, as on shared paths; a Windows host also
 * refuses an absolute target and `\` or `:`, which Node would rewrite.
 * @internal
 */
export const localLinkTargetError = (
    target: string,
    platform: NodeJS.Platform = process.platform
) => {
    const bytes = Buffer.byteLength(target, "utf8");
    if (bytes === 0 || bytes > 1023 || target.includes("\0")) {
        return "A symlink target is 1-1023 bytes of UTF-8 without NUL";
    }
    if (
        platform === "win32" &&
        (target.startsWith("/") ||
            target.includes("\\") ||
            target.includes(":"))
    ) {
        return 'A symlink target on Windows is relative and holds no "\\" or ":"';
    }
    return undefined;
};

/** A host entry's kind, or undefined for anything but these three. */
const kindOf = (stats: {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isFile(): boolean;
}) =>
    stats.isDirectory()
        ? ("directory" as const)
        : stats.isSymbolicLink()
          ? ("symlink" as const)
          : stats.isFile()
            ? ("file" as const)
            : undefined;

/** A host link target as the mount shows it: Node stores "/" as "\" on Windows. */
const mountLinkTarget = (target: string) =>
    process.platform === "win32" ? target.replaceAll("\\", "/") : target;

class MountLocalOverlay implements SharedFsMountLocalOverlay {
    private binding?: Binding;
    private readonly sealed: ReadonlySet<string>;
    private readonly nodesRoot: string;
    private readonly handles = new Map<number, LocalHandle>();
    private readonly anchorIds = new Map<string, string>();
    /** Advanced on every anchor cache clear: a lookup older than it is not cached. */
    private anchorGeneration = 0;
    /**
     * Host paths found to be directories (lstat, so not links), forgotten
     * on every local rename and rmdir: only those can turn one into
     * something else.
     */
    private readonly directories = new Set<string>();
    private readonly logged = new Set<string>();

    constructor(
        readonly directory: string,
        sealedNames: readonly string[],
        /** Node ids with an attachment directory under `n/`. */
        private readonly attachments: Set<string>
    ) {
        this.sealed = new Set(sealedNames);
        this.nodesRoot = join(directory, "n");
    }

    bind(binding: Binding) {
        if (this.binding) {
            throw invalid(
                `The local overlay ${this.directory} already serves a mount backend`
            );
        }
        this.binding = binding;
    }

    async detached(target: Pick<SharedFsMountBackendTarget, "nodeForMount">) {
        let count = 0;
        for (const nodeId of this.attachments) {
            if (nodeId === ROOT_NODE_ID) continue;
            if ((await target.nodeForMount?.(nodeId))?.deleted === true)
                count++;
        }
        return count;
    }

    private get view() {
        return this.binding!.view;
    }

    /**
     * Where `path` (normalized) is served from: a route when it is at or
     * below the shallowest sealed name or ignored boundary, else undefined
     * (shared). Never `/` or the conflict tree. Evaluated per operation, so
     * an ignore rule change applies to the next lookup.
     */
    route(path: string): LocalRoute | undefined {
        if (path === "/") return undefined;
        const segments = path.slice(1).split("/");
        if (segments[0] === CONFLICTS_DIR) return undefined;
        let depth = segments.findIndex((name) => this.sealed.has(name)) + 1;
        const verdict = this.view.ignoreCheck?.(path);
        if (verdict?.ignored) {
            // A casefolded rule set folds the boundary: use only its depth.
            const ignoredDepth = verdict.boundary
                ? pathSegments(verdict.boundary).length
                : segments.length;
            if (
                ignoredDepth >= 1 &&
                ignoredDepth <= segments.length &&
                (depth === 0 || ignoredDepth < depth)
            ) {
                depth = ignoredDepth;
            }
        }
        if (depth === 0) return undefined;
        return {
            path,
            anchorPath: "/" + segments.slice(0, depth - 1).join("/"),
            boundary: segments[depth - 1],
            rest: segments.slice(depth),
        };
    }

    /** Whether `name` in the shared directory `dirPath` is served locally. */
    private hidesChild(dirPath: string, name: string) {
        return (
            this.sealed.has(name) ||
            this.view.ignoreCheck?.(joinFsPath(dirPath, name)).ignored === true
        );
    }

    /** Forget anchor node ids: the shared namespace changed. */
    namespaceChanged() {
        this.anchorIds.clear();
        this.anchorGeneration++;
    }

    owns(handle: number) {
        return this.handles.has(handle);
    }

    private async anchorNodeId(anchorPath: string) {
        if (anchorPath === "/") return ROOT_NODE_ID;
        const cached = this.anchorIds.get(anchorPath);
        if (cached !== undefined) return cached;
        const generation = this.anchorGeneration;
        const entry = await this.view.stat(anchorPath);
        if (!entry) throw notFound(anchorPath);
        if (entry.kind !== "directory") {
            throw new SharedFsBackendError(
                "ENOTDIR",
                `Path is not a directory: ${anchorPath}`
            );
        }
        // Only a namespace feed says when an id goes stale; negative results
        // are never kept.
        if (this.binding!.feed && generation === this.anchorGeneration) {
            if (this.anchorIds.size >= ANCHOR_CACHE_LIMIT)
                this.anchorIds.clear();
            this.anchorIds.set(anchorPath, entry.nodeId);
        }
        return entry.nodeId;
    }

    /**
     * The host path of `route` under the anchor `nodeId`. A Windows host
     * refuses some names: EINVAL when creating, ENOENT when looking up.
     * A created name follows the shared naming rules too.
     */
    private hostPath(route: LocalRoute, nodeId: string, creates: boolean) {
        const names = [route.boundary, ...route.rest];
        for (const name of names) {
            if (hostRefusesName(name)) {
                throw creates
                    ? invalid(
                          `This host cannot hold the name ${JSON.stringify(name)}`
                      )
                    : notFound(route.path);
            }
        }
        if (creates) {
            const name = names.at(-1)!;
            const code = fsNameError(name);
            if (code) {
                throw new SharedFsBackendError(
                    code,
                    fsNameErrorMessage(code, name)
                );
            }
        }
        const path = join(this.nodesRoot, hexOf(nodeId), ...names);
        if (!path.startsWith(this.nodesRoot + sep)) {
            throw creates
                ? invalid(`Invalid path: ${route.path}`)
                : notFound(route.path);
        }
        return path;
    }

    /**
     * The host path of an existing entry: every directory above it, and
     * with `directory` the entry itself, must be a host directory (see
     * throughDirectories).
     */
    private async lookup(route: LocalRoute, directory = false) {
        const nodeId = await this.anchorNodeId(route.anchorPath);
        if (!this.attachments.has(nodeId)) throw notFound(route.path);
        const path = this.hostPath(route, nodeId, false);
        await this.throughDirectories(route, nodeId, directory);
        return { nodeId, path };
    }

    /** Resolve `route` for a create: its attachment exists afterwards. */
    private async creating(route: LocalRoute) {
        const nodeId = await this.anchorNodeId(route.anchorPath);
        const path = this.hostPath(route, nodeId, true);
        if (route.rest.length === 0) {
            if (!this.attachments.has(nodeId)) {
                const attachment = join(this.nodesRoot, hexOf(nodeId));
                await this.onHost("mkdir", route.path, () =>
                    host.mkdir(attachment, { recursive: true, mode: 0o700 })
                );
                this.attachments.add(nodeId);
            }
        } else if (!this.attachments.has(nodeId)) {
            throw new SharedFsBackendError(
                "ENOENT",
                `Parent directory does not exist: ${dirname(route.path)}`
            );
        }
        await this.throughDirectories(route, nodeId, false);
        return { nodeId, path };
    }

    /**
     * ENOTDIR unless every host directory from the attachment down to
     * `route`'s parent, and `route` itself with `self`, is a directory and
     * not a link to one (ENOENT for a missing one). The overlay never
     * follows a host link, so no path reaches outside it through one, also
     * not a stale path a kernel sends after another writer's rename. It
     * checks, then acts: a concurrent local change in between is not
     * covered.
     */
    private async throughDirectories(
        route: LocalRoute,
        nodeId: string,
        self: boolean
    ) {
        const names = [route.boundary, ...route.rest];
        const attachment = join(this.nodesRoot, hexOf(nodeId));
        const count = self ? names.length + 1 : names.length;
        for (let depth = 0; depth < count; depth++) {
            const directory = join(attachment, ...names.slice(0, depth));
            if (this.directories.has(directory)) continue;
            const stats = await this.onHost("lstat", route.path, () =>
                host.lstat(directory)
            );
            if (!stats.isDirectory()) {
                throw new SharedFsBackendError(
                    "ENOTDIR",
                    `Not a directory on this machine: ${joinFsPath(
                        route.anchorPath,
                        ...names.slice(0, depth)
                    )}`
                );
            }
            this.rememberDirectory(directory);
        }
    }

    private rememberDirectory(path: string) {
        if (this.directories.size >= DIRECTORY_CACHE_LIMIT) {
            this.directories.clear();
        }
        this.directories.add(path);
    }

    /** After a change of the anchor's own entries: its mtime moves. */
    private changedAnchor(route: LocalRoute, nodeId: string) {
        if (route.rest.length === 0) this.binding!.bumpStamp(nodeId);
    }

    /** Run a host call, mapping its error (see localOverlayErrorCode). */
    private async onHost<T>(op: string, path: string, call: () => Promise<T>) {
        try {
            return await call();
        } catch (error) {
            throw this.hostError(op, path, error);
        }
    }

    private hostError(op: string, path: string, error: unknown) {
        if (error instanceof SharedFsBackendError) return error;
        const message = error instanceof Error ? error.message : String(error);
        const code = localOverlayErrorCode(error);
        if (code)
            return new SharedFsBackendError(code, `${op} ${path}: ${message}`);
        const hostCode = String(
            (error as { code?: unknown } | undefined)?.code ?? "unknown"
        );
        const key = `${op}\0${hostCode}`;
        if (!this.logged.has(key)) {
            this.logged.add(key);
            console.error(
                `shared-fs local overlay: ${op} ${path}: ${hostCode} ${message}`
            );
        }
        return new SharedFsBackendError("EIO", `${op} ${path}: ${message}`);
    }

    private requireHandle(handle: number) {
        const local = this.handles.get(handle);
        if (!local) {
            throw new SharedFsBackendError(
                "EBADF",
                `Unknown file handle: ${handle}`
            );
        }
        return local;
    }

    private async stat(
        path: string,
        hostPath: string,
        stats: hostFs.Stats
    ): Promise<SharedFsDirentStat & { kind: SharedFsStat["kind"] }> {
        const kind = kindOf(stats);
        if (!kind) {
            throw new SharedFsBackendError(
                "EIO",
                `Not a file, directory or symlink: ${path}`
            );
        }
        let size = stats.size;
        if (kind === "directory") {
            size = 0;
        } else if (
            kind === "symlink" &&
            (process.platform === "win32" || size === 0)
        ) {
            // What readlink returns, and never 0 (the adapter checks it).
            const target = await this.onHost("readlink", path, () =>
                host.readlink(hostPath)
            );
            size = Math.max(1, Buffer.byteLength(mountLinkTarget(target)));
        }
        return {
            kind,
            size,
            mode:
                kind === "symlink"
                    ? S_IFLNK | 0o777
                    : (kind === "directory" ? S_IFDIR : S_IFREG) |
                      (stats.mode & 0o7777),
            mtimeMs: Math.floor(stats.mtimeMs),
            ctimeMs: Math.floor(stats.ctimeMs),
            nlink: Math.max(1, stats.nlink),
        };
    }

    /**
     * The entries of a host directory, at `path` in the mount: files,
     * directories and symlinks whose names a mount can show, kept by `keep`.
     */
    private async listHost(
        hostPath: string,
        path: string,
        includeStats: boolean,
        keep?: (name: string) => boolean
    ): Promise<SharedFsDirent[]> {
        const dirents = await this.onHost("readdir", path, () =>
            host.readdir(hostPath, { withFileTypes: true })
        );
        const shown = dirents.filter(
            (dirent) =>
                fsNameError(dirent.name) === undefined &&
                (keep === undefined || keep(dirent.name))
        );
        const entries = new Array<SharedFsDirent | undefined>(shown.length);
        let next = 0;
        const worker = async () => {
            while (next < shown.length) {
                const index = next++;
                const dirent = shown[index];
                const kind = kindOf(dirent);
                if (!includeStats && kind) {
                    entries[index] = { name: dirent.name, kind };
                    continue;
                }
                const childPath = joinFsPath(path, dirent.name);
                const childHostPath = join(hostPath, dirent.name);
                let stats: hostFs.Stats;
                try {
                    stats = await host.lstat(childHostPath);
                } catch (error) {
                    // Removed since the listing: not shown.
                    if (localOverlayErrorCode(error) === "ENOENT") continue;
                    throw this.hostError("lstat", childPath, error);
                }
                if (!kindOf(stats)) continue;
                const { kind: statKind, ...stat } = await this.stat(
                    childPath,
                    childHostPath,
                    stats
                );
                entries[index] = includeStats
                    ? { name: dirent.name, kind: statKind, stat }
                    : { name: dirent.name, kind: statKind };
            }
        };
        await Promise.all(
            Array.from(
                { length: Math.min(LISTING_STAT_CONCURRENCY, shown.length) },
                worker
            )
        );
        return entries.filter(
            (entry): entry is SharedFsDirent => entry !== undefined
        );
    }

    async getattr(route: LocalRoute): Promise<SharedFsStat> {
        const { path } = await this.lookup(route);
        const stats = await this.onHost("lstat", route.path, () =>
            host.lstat(path)
        );
        return {
            path: route.path,
            ...(await this.stat(route.path, path, stats)),
        };
    }

    async readdir(route: LocalRoute, includeStats: boolean) {
        // A link is never listed through: ENOTDIR, as for any non-directory.
        const { path } = await this.lookup(route, true);
        return this.listHost(path, route.path, includeStats);
    }

    /**
     * A shared directory's listing with the local entries it holds now: the
     * names that route locally (a shared entry with such a name was left out
     * of `entries`). `nodeId` is the directory's, when its listing named it.
     */
    async withLocalEntries(
        dirPath: string,
        nodeId: string | undefined,
        entries: SharedFsDirent[],
        includeStats: boolean
    ) {
        if (this.attachments.size === 0) return entries;
        try {
            nodeId ??= await this.anchorNodeId(dirPath);
        } catch (error) {
            // Gone or replaced since the listing: nothing local to add.
            if (
                error instanceof SharedFsBackendError &&
                (error.code === "ENOENT" || error.code === "ENOTDIR")
            ) {
                return entries;
            }
            throw error;
        }
        if (!this.attachments.has(nodeId)) return entries;
        let local: SharedFsDirent[];
        try {
            local = await this.listHost(
                join(this.nodesRoot, hexOf(nodeId)),
                dirPath,
                includeStats,
                (name) => this.hidesChild(dirPath, name)
            );
        } catch (error) {
            if (
                error instanceof SharedFsBackendError &&
                error.code === "ENOENT"
            ) {
                return entries;
            }
            throw error;
        }
        if (local.length === 0) return entries;
        const byName = new Map(entries.map((entry) => [entry.name, entry]));
        for (const entry of local) byName.set(entry.name, entry);
        return [...byName.values()];
    }

    /**
     * Whether the shared directory `nodeId` at `dirPath` holds local entries
     * a listing shows: then it cannot be removed or replaced (ENOTEMPTY).
     */
    async holdsLocalEntries(dirPath: string, nodeId: string) {
        if (!this.attachments.has(nodeId)) return false;
        let names: string[];
        try {
            names = await host.readdir(join(this.nodesRoot, hexOf(nodeId)));
        } catch (error) {
            if (localOverlayErrorCode(error) === "ENOENT") return false;
            throw this.hostError("readdir", dirPath, error);
        }
        return names.some(
            (name) =>
                fsNameError(name) === undefined &&
                this.hidesChild(dirPath, name)
        );
    }

    /** Whether `route` names an entry (the source check of a refused rename). */
    async exists(route: LocalRoute) {
        let path: string;
        try {
            ({ path } = await this.lookup(route));
        } catch (error) {
            if (
                error instanceof SharedFsBackendError &&
                (error.code === "ENOENT" || error.code === "ENOTDIR")
            ) {
                return false;
            }
            throw error;
        }
        try {
            await host.lstat(path);
            return true;
        } catch (error) {
            const code = localOverlayErrorCode(error);
            if (code === "ENOENT" || code === "ENOTDIR") return false;
            throw this.hostError("lstat", route.path, error);
        }
    }

    async open(route: LocalRoute, flags: OpenFlags, createMode?: number) {
        assertValidOpenFlags(route.path, flags);
        const { nodeId, path } = flags.create
            ? await this.creating(route)
            : await this.lookup(route);
        const win32 = process.platform === "win32";
        if (win32) {
            // No O_NOFOLLOW here: refuse a link or a directory first.
            let stats: hostFs.Stats | undefined;
            try {
                stats = await host.lstat(path);
            } catch (error) {
                if (localOverlayErrorCode(error) !== "ENOENT") {
                    throw this.hostError("lstat", route.path, error);
                }
            }
            if (stats && flags.create && flags.exclusive) {
                throw new SharedFsBackendError(
                    "EEXIST",
                    `Path already exists: ${route.path}`
                );
            }
            if (stats?.isSymbolicLink()) {
                throw invalid(`Path is a symlink: ${route.path}`);
            }
            if (stats?.isDirectory()) {
                throw new SharedFsBackendError(
                    "EISDIR",
                    `Path is a directory: ${route.path}`
                );
            }
        }
        const { constants } = hostFs;
        const hostFlags =
            (flags.read && flags.write
                ? constants.O_RDWR
                : flags.write
                  ? constants.O_WRONLY
                  : constants.O_RDONLY) |
            (flags.create ? constants.O_CREAT : 0) |
            (flags.exclusive ? constants.O_EXCL : 0) |
            (flags.truncate ? constants.O_TRUNC : 0) |
            (flags.append ? constants.O_APPEND : 0) |
            (win32 ? 0 : constants.O_NOFOLLOW);
        const fd = await this.onHost("open", route.path, () =>
            host.open(path, hostFlags, createMode ?? 0o666)
        );
        if (!(flags.create && flags.exclusive)) {
            // A read-only open of a directory succeeds on POSIX hosts.
            let refusal: SharedFsBackendError | undefined;
            try {
                const stats = await host.fstat(fd);
                if (stats.isDirectory()) {
                    refusal = new SharedFsBackendError(
                        "EISDIR",
                        `Path is a directory: ${route.path}`
                    );
                } else if (!stats.isFile()) {
                    refusal = new SharedFsBackendError(
                        "EIO",
                        `Not a regular file: ${route.path}`
                    );
                }
            } catch (error) {
                refusal = this.hostError("fstat", route.path, error);
            }
            if (refusal) {
                await host.close(fd).catch(() => {});
                throw refusal;
            }
        }
        const handle = this.binding!.allocateHandle();
        this.handles.set(handle, {
            fd,
            path: route.path,
            read: flags.read,
            write: flags.write,
            append: flags.append,
        });
        if (flags.create) this.changedAnchor(route, nodeId);
        return handle;
    }

    async read(handle: number, size: number, offset: number) {
        const local = this.requireHandle(handle);
        if (!local.read) {
            throw new SharedFsBackendError(
                "EBADF",
                `File handle is not readable: ${handle}`
            );
        }
        if (size <= 0) return new Uint8Array(0);
        // A fresh allocation: the bytes transfer to the caller.
        const buffer = Buffer.allocUnsafeSlow(size);
        const { bytesRead } = await this.onHost("read", local.path, () =>
            host.read(local.fd, buffer, 0, size, offset)
        );
        return buffer.subarray(0, bytesRead);
    }

    async write(handle: number, data: Uint8Array, offset: number) {
        const local = this.requireHandle(handle);
        if (!local.write) {
            throw new SharedFsBackendError(
                "EBADF",
                `File handle is not writable: ${handle}`
            );
        }
        let written = 0;
        while (written < data.byteLength) {
            const { bytesWritten } = await this.onHost(
                "write",
                local.path,
                () =>
                    host.write(
                        local.fd,
                        data,
                        written,
                        data.byteLength - written,
                        // An append handle writes at the host file's end.
                        local.append ? null : offset + written
                    )
            );
            if (bytesWritten === 0) break;
            written += bytesWritten;
        }
        return written;
    }

    async truncateHandle(handle: number, size: number) {
        const local = this.requireHandle(handle);
        if (!local.write) {
            throw new SharedFsBackendError(
                "EBADF",
                `File handle is not writable: ${handle}`
            );
        }
        if (!Number.isSafeInteger(size) || size < 0) {
            throw invalid(`Invalid size: ${size}`);
        }
        await this.onHost("truncate", local.path, () =>
            host.ftruncate(local.fd, size)
        );
    }

    async truncatePath(route: LocalRoute, size: number) {
        if (!Number.isSafeInteger(size) || size < 0) {
            throw invalid(`Invalid size: ${size}`);
        }
        const { path } = await this.lookup(route);
        if (process.platform === "win32") {
            const stats = await this.onHost("lstat", route.path, () =>
                host.lstat(path)
            );
            if (stats.isSymbolicLink()) {
                throw invalid(`Path is a symlink: ${route.path}`);
            }
            if (stats.isDirectory()) {
                throw new SharedFsBackendError(
                    "EISDIR",
                    `Path is a directory: ${route.path}`
                );
            }
            await this.onHost("truncate", route.path, () =>
                host.truncate(path, size)
            );
            return;
        }
        const fd = await this.onHost("truncate", route.path, () =>
            host.open(
                path,
                hostFs.constants.O_WRONLY | hostFs.constants.O_NOFOLLOW
            )
        );
        try {
            await this.onHost("truncate", route.path, () =>
                host.ftruncate(fd, size)
            );
        } finally {
            await host.close(fd).catch(() => {});
        }
    }

    async flush(handle: number) {
        // Writes already reached the host descriptor.
        this.requireHandle(handle);
    }

    async fsync(handle: number) {
        const local = this.requireHandle(handle);
        await this.onHost("fsync", local.path, () => host.fsync(local.fd));
    }

    async release(handle: number) {
        const local = this.handles.get(handle);
        if (!local) return;
        this.handles.delete(handle);
        await this.onHost("close", local.path, () => host.close(local.fd));
    }

    async mkdir(route: LocalRoute) {
        const { nodeId, path } = await this.creating(route);
        await this.onHost("mkdir", route.path, () => host.mkdir(path));
        this.rememberDirectory(path);
        this.changedAnchor(route, nodeId);
    }

    async rmdir(route: LocalRoute) {
        const { nodeId, path } = await this.lookup(route);
        await this.onHost("rmdir", route.path, () => host.rmdir(path));
        // Something else may take its name: check again.
        this.directories.clear();
        this.changedAnchor(route, nodeId);
    }

    async unlink(route: LocalRoute) {
        const { nodeId, path } = await this.lookup(route);
        await this.onHost("unlink", route.path, () => host.unlink(path));
        this.changedAnchor(route, nodeId);
    }

    async rename(from: LocalRoute, to: LocalRoute) {
        const source = await this.lookup(from);
        const destination = await this.creating(to);
        await this.onHost("rename", from.path, () =>
            host.rename(source.path, destination.path)
        );
        // A moved or replaced directory: check again.
        this.directories.clear();
        this.changedAnchor(from, source.nodeId);
        this.changedAnchor(to, destination.nodeId);
    }

    /** chmod keeps every permission bit; a symlink's mode never changes. */
    async setattr(
        route: LocalRoute,
        attrs: { mode?: number; mtimeMs?: number }
    ) {
        const { mode, mtimeMs } = attrs;
        if (
            mtimeMs !== undefined &&
            !(
                Number.isFinite(mtimeMs) &&
                mtimeMs >= 0 &&
                mtimeMs <= Number.MAX_SAFE_INTEGER
            )
        ) {
            throw invalid(`Invalid mtime: ${mtimeMs}`);
        }
        const { path } = await this.lookup(route);
        const stats = await this.onHost("lstat", route.path, () =>
            host.lstat(path)
        );
        if (mode !== undefined && !stats.isSymbolicLink()) {
            await this.onHost("chmod", route.path, () =>
                host.chmod(path, mode & 0o7777)
            );
        }
        if (mtimeMs !== undefined) {
            // Never follows a link: a link's own time changes.
            await this.onHost("utimens", route.path, () =>
                host.lutimes(path, stats.atimeMs / 1000, mtimeMs / 1000)
            );
        }
    }

    async symlink(target: string, route: LocalRoute) {
        const error =
            typeof target === "string"
                ? localLinkTargetError(target)
                : "A symlink target is a string";
        if (error) throw invalid(`${error}: ${route.path}`);
        const { nodeId, path } = await this.creating(route);
        // The type only matters to a Windows host; the mount resolves links
        // through readlink.
        await this.onHost("symlink", route.path, () =>
            host.symlink(target, path, "file")
        );
        this.changedAnchor(route, nodeId);
    }

    async readlink(route: LocalRoute) {
        const { path } = await this.lookup(route);
        return mountLinkTarget(
            await this.onHost("readlink", route.path, () => host.readlink(path))
        );
    }

    /**
     * Close every local descriptor at shutdown. Local data is already on
     * disk, so none is reported unsaved; a failed close is printed.
     */
    async drain() {
        for (const [handle, local] of [...this.handles]) {
            this.handles.delete(handle);
            try {
                await host.close(local.fd);
            } catch (error) {
                console.error(
                    `shared-fs local overlay: close ${local.path}: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }
        }
    }

    dispose() {
        for (const local of this.handles.values()) {
            try {
                host.closeSync(local.fd);
            } catch {
                // Already closed.
            }
        }
        this.handles.clear();
    }
}

/** The overlay type a backend serves from once bound. @internal */
export type BoundMountLocalOverlay = MountLocalOverlay;

/**
 * Bind `overlay` to the backend over `target`. The overlay keeps only
 * `target`'s lookups (stat, nodeForMount, ignoreCheck); a second bind fails
 * with EINVAL.
 * @internal
 */
export const bindMountLocalOverlay = (
    overlay: SharedFsMountLocalOverlay,
    target: SharedFsMountBackendTarget,
    backend: Pick<Binding, "allocateHandle" | "bumpStamp">
): BoundMountLocalOverlay => {
    if (!(overlay instanceof MountLocalOverlay)) {
        throw invalid("localOverlay must come from openMountLocalOverlay");
    }
    const view: ReadOnlyTarget = { stat: (path) => target.stat(path) };
    if (typeof target.nodeForMount === "function") {
        view.nodeForMount = (nodeId) => target.nodeForMount!(nodeId);
    }
    if (typeof target.ignoreCheck === "function") {
        view.ignoreCheck = (path) => target.ignoreCheck!(path);
    }
    overlay.bind({
        view,
        feed: typeof target.onNamespaceChange === "function",
        ...backend,
    });
    return overlay;
};

/**
 * `target` with writeFile, setMetadata, mkdir and mutateNamespaceForMount
 * refusing (EACCES, without calling through) any path `isLocal` claims:
 * nothing kept local reaches the shared log, even if routing raced an
 * ignore rule change. Every other property is the target's own.
 * writeNodeForMount saves a shared node by id and stays open.
 * @internal
 */
export const guardSharedMutations = (
    target: SharedFsMountBackendTarget,
    isLocal: (path: string) => boolean
): SharedFsMountBackendTarget => {
    const refuse = (...paths: Array<string | undefined>) => {
        for (const path of paths) {
            if (path !== undefined && isLocal(path)) {
                throw new SharedFsBackendError(
                    "EACCES",
                    `kept local by this mount: ${path}`
                );
            }
        }
    };
    const guarded: Partial<SharedFsMountBackendTarget> = {
        writeFile: async (path, source, options) => {
            refuse(path);
            return target.writeFile(path, source, options);
        },
        setMetadata: async (path, patch, options) => {
            refuse(path);
            return target.setMetadata(path, patch, options);
        },
        mkdir: async (path) => {
            refuse(path);
            return target.mkdir(path);
        },
        mutateNamespaceForMount: async (mutation) => {
            if (mutation.type === "rename") refuse(mutation.from, mutation.to);
            else refuse(mutation.path);
            return target.mutateNamespaceForMount(mutation);
        },
    };
    const bound = new Map<PropertyKey, { source: unknown; fn: unknown }>();
    return new Proxy(target, {
        get(original, property) {
            if (Object.hasOwn(guarded, property)) {
                return guarded[property as keyof typeof guarded];
            }
            const value = Reflect.get(original, property, original);
            if (typeof value !== "function") return value;
            const cached = bound.get(property);
            if (cached && cached.source === value) return cached.fn;
            const fn = value.bind(original);
            bound.set(property, { source: value, fn });
            return fn;
        },
    });
};

/**
 * Open (creating it, mode 0700, if missing) the local overlay directory of
 * the filesystem `address`. Its meta.json must name `address` and format 1:
 * otherwise EINVAL. Empty attachment directories are removed; nothing else
 * is ever deleted automatically.
 */
export const openMountLocalOverlay = async (
    options: SharedFsLocalOverlayOptions
): Promise<SharedFsMountLocalOverlay> => {
    const { address, sealedNames } = options;
    if (typeof options.directory !== "string" || options.directory === "") {
        throw invalid("A local overlay needs a directory");
    }
    if (typeof address !== "string" || address === "") {
        throw invalid("A local overlay needs a filesystem address");
    }
    if (
        !Array.isArray(sealedNames) ||
        sealedNames.some(
            (name) =>
                typeof name !== "string" || fsNameError(name) !== undefined
        )
    ) {
        throw invalid("A local overlay's sealed names must be valid names");
    }
    const directory = resolve(options.directory);
    const openError = (error: unknown) =>
        new SharedFsBackendError(
            localOverlayErrorCode(error) ?? "EIO",
            `Cannot open the local overlay ${directory}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    const opened = <T>(call: () => Promise<T>) =>
        call().catch((error): never => {
            throw openError(error);
        });
    await opened(() => host.mkdir(directory, { recursive: true, mode: 0o700 }));
    const metaPath = join(directory, "meta.json");
    let text: string | undefined;
    try {
        text = await host.readFile(metaPath, "utf8");
    } catch (error) {
        if (localOverlayErrorCode(error) !== "ENOENT") throw openError(error);
    }
    if (text === undefined) {
        const temporary = `${metaPath}.${randomBytes(6).toString("hex")}.tmp`;
        await opened(async () => {
            await host.writeFile(
                temporary,
                JSON.stringify({ format: LOCAL_OVERLAY_FORMAT, address }) +
                    "\n",
                { mode: 0o600 }
            );
            await host.rename(temporary, metaPath);
        });
    } else {
        let meta: { format?: unknown; address?: unknown } | undefined;
        try {
            meta = JSON.parse(text);
        } catch {
            meta = undefined;
        }
        if (meta?.format !== LOCAL_OVERLAY_FORMAT) {
            throw invalid(
                `this local overlay has format ${JSON.stringify(meta?.format ?? null)}; this version reads format ${LOCAL_OVERLAY_FORMAT}: move or delete ${directory}`
            );
        }
        if (meta.address !== address) {
            throw invalid(
                `this local overlay holds the filesystem ${JSON.stringify(meta.address)}, not ${address}: move or delete ${directory}`
            );
        }
    }
    const nodesRoot = join(directory, "n");
    await opened(() => host.mkdir(nodesRoot, { recursive: true, mode: 0o700 }));
    const attachments = new Set<string>();
    const listed = await opened(() =>
        host.readdir(nodesRoot, { withFileTypes: true })
    );
    for (const dirent of listed) {
        const nodeId = attachmentNodeId(dirent.name);
        // A file or a link (never followed) is no attachment.
        if (nodeId === undefined || !dirent.isDirectory()) continue;
        const attachment = join(nodesRoot, dirent.name);
        let held: string[];
        try {
            held = await host.readdir(attachment);
        } catch {
            continue; // gone since the listing
        }
        if (held.length === 0) {
            // Holds no data: the only removal the overlay makes itself.
            await host.rmdir(attachment).catch(() => {});
            continue;
        }
        attachments.add(nodeId);
    }
    return new MountLocalOverlay(directory, sealedNames, attachments);
};
