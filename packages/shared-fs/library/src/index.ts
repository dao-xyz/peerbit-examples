import { deserialize, field, option, variant } from "@dao-xyz/borsh";
import {
    type PublicSignKey,
    PublicSignKey as PublicSignKeyType,
    fromBase64,
    randomBytes,
    sha256Base64Sync,
    sha256Sync,
    toBase64,
    toBase64URL,
} from "@peerbit/crypto";
import {
    BoolQuery,
    Documents,
    Or,
    StringMatch,
    type Query,
} from "@peerbit/document";
import { Program } from "@peerbit/program";
import { TrustedNetwork } from "@peerbit/trusted-network";
import { concat, fromString } from "uint8arrays";
import type { Peerbit } from "peerbit";
import {
    DeleteMarker,
    DirectoryRecord,
    FileChunk,
    FileRecord,
    FileVersion,
    IndexableSharedFsEntry,
    SharedFsEntry,
    isFileHead,
    type FileHead,
} from "./model.js";
import {
    ROOT_NODE_ID,
    basename,
    dirname,
    joinFsPath,
    normalizeFsPath,
    pathSegments,
} from "./path.js";

export * from "./model.js";
export * from "./benchmark.js";
export * from "./ipc.js";
export * from "./mount-backend.js";
export * from "./native-mount.js";
export * from "./path.js";

export const SHARED_FS_EXPERIMENTAL = true;
export const DEFAULT_FILE_CHUNK_SIZE = 512 * 1024;

/**
 * How many chunk documents are appended / fetched concurrently for one file.
 * Keeps large files from serializing hundreds of sequential round trips while
 * bounding memory and outbound queue pressure.
 */
const CHUNK_IO_CONCURRENCY = 4;

/**
 * Bounded wait for a chunk that is not available locally (for example a
 * version whose metadata replicated before its content, or a peer that does
 * not replicate content).
 */
const REMOTE_CHUNK_FETCH_TIMEOUT_MS = 10_000;

/** Number of node ids per batched head query. */
const HEAD_QUERY_BATCH = 64;

type OpenReplicateOptions =
    | false
    | {
          factor?: number;
          limits?: {
              storage?: number;
              cpu?: number | { max: number; monitor?: unknown };
          };
      };

export type SharedFsOpenArgs = {
    machineLabel?: string;
    /**
     * Replication policy for the filesystem entries. Defaults to a full
     * replica (`{ factor: 1 }`) because every mount must be able to serve the
     * whole namespace from its local index. Use `false` for read-mostly peers
     * that should not store content; chunk reads then fall back to remote
     * fetches.
     */
    replicate?: OpenReplicateOptions;
    /**
     * Allow chunk reads to fetch content from remote peers when it is not
     * available locally. Enabled by default.
     */
    remoteChunkFetch?: boolean | { timeoutMs?: number };
};

export type OpenSharedFsOptions = SharedFsOpenArgs & {
    peerbit: Peerbit;
    address?: string | unknown;
    id?: Uint8Array;
    directory?: string;
    rootKey?: PublicSignKey;
};

export type SharedFsEntryInfo = {
    path: string;
    nodeId: string;
    name: string;
    kind: "directory" | "file";
    size: bigint;
    updatedAt: bigint;
    authorKey: string;
    machineLabel: string;
    conflict: boolean;
    /** Visible head version id for files. */
    versionId?: string;
    /** All current head version ids for files (more than one means conflict). */
    headVersionIds?: string[];
    /** Content hash of the visible head version for files. */
    contentHash?: string;
};

export type SharedFsVersionInfo = {
    id: string;
    nodeId: string;
    path: string;
    size: bigint;
    contentHash?: string;
    parentVersionIds: string[];
    createdAt: bigint;
    authorKey: string;
    machineLabel: string;
    deleted: boolean;
    head: boolean;
};

export type SharedFsConflict = {
    path: string;
    nodeId: string;
    versions: SharedFsVersionInfo[];
};

export type WriteFileOptions = {
    /**
     * Allows callers that observed an older base to publish a concurrent version.
     * Normal writes should leave this undefined so the current visible heads are
     * used as parents.
     */
    baseVersionIds?: string[];
    chunkSize?: number;
};

export type SharedFsErrorCode =
    | "ENOENT"
    | "EEXIST"
    | "EISDIR"
    | "ENOTDIR"
    | "ENOTEMPTY"
    | "EINVAL"
    | "EIO";

/**
 * Typed filesystem error so adapters can map failures to POSIX errno values
 * instead of collapsing everything into EIO.
 */
export class SharedFsError extends Error {
    constructor(
        readonly code: SharedFsErrorCode,
        message: string
    ) {
        super(message);
        this.name = "SharedFsError";
    }
}

type NodeRecord = DirectoryRecord | FileRecord;

type ResolvedPath =
    | { kind: "root"; nodeId: typeof ROOT_NODE_ID; path: "/" }
    | { kind: "directory"; record: DirectoryRecord; path: string }
    | { kind: "file"; record: FileRecord; path: string };

const now = () => BigInt(Date.now());

const createId = (prefix: string) =>
    `${prefix}:${toBase64URL(randomBytes(32))}`;

export const encodePublicSignKey = (key: PublicSignKey) => toBase64(key.bytes);

export const decodePublicSignKey = (key: string) =>
    deserialize(fromBase64(key), PublicSignKeyType) as PublicSignKey;

const toBytes = async (
    source: Uint8Array | string | AsyncIterable<Uint8Array>
): Promise<Uint8Array> => {
    if (typeof source === "string") {
        return new TextEncoder().encode(source);
    }
    if (source instanceof Uint8Array) {
        return source;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of source) {
        chunks.push(chunk);
    }
    return chunks.length === 0 ? new Uint8Array(0) : concat(chunks);
};

const chunkBytes = (bytes: Uint8Array, chunkSize = DEFAULT_FILE_CHUNK_SIZE) => {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
        throw new SharedFsError(
            "EINVAL",
            `Invalid chunk size: ${String(chunkSize)}`
        );
    }
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        chunks.push(
            bytes.subarray(
                offset,
                Math.min(offset + chunkSize, bytes.byteLength)
            )
        );
    }
    if (chunks.length === 0) {
        chunks.push(new Uint8Array(0));
    }
    return chunks;
};

const newestFirst = <
    T extends { createdAt?: bigint; updatedAt?: bigint; id: string },
>(
    a: T,
    b: T
) => {
    const aTime = Number(a.updatedAt ?? a.createdAt ?? 0n);
    const bTime = Number(b.updatedAt ?? b.createdAt ?? 0n);
    return bTime - aTime || b.id.localeCompare(a.id);
};

/**
 * Deterministic winner among records that share (parentId, name). Two peers
 * creating the same name concurrently produce two nodes; every peer must pick
 * the same one so the namespace converges. Oldest creation wins, then lowest
 * node id.
 */
const oldestFirst = (a: NodeRecord, b: NodeRecord) => {
    const diff = Number(a.createdAt) - Number(b.createdAt);
    return diff || a.nodeId.localeCompare(b.nodeId);
};

const kindIs = (...kinds: string[]): Query =>
    kinds.length === 1
        ? new StringMatch({ key: "kind", value: kinds[0] })
        : new Or(
              kinds.map((kind) => new StringMatch({ key: "kind", value: kind }))
          );

const NODE_KINDS_QUERY = kindIs("directory", "file");
const HEAD_KINDS_QUERY = kindIs("file-version", "delete-marker");

const mapWithConcurrency = async <T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from(
        { length: Math.min(limit, items.length) },
        async () => {
            while (true) {
                const index = next++;
                if (index >= items.length) {
                    return;
                }
                results[index] = await fn(items[index], index);
            }
        }
    );
    await Promise.all(workers);
    return results;
};

@variant("peerbit_shared_fs")
export class SharedFileSystem extends Program<SharedFsOpenArgs> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: Documents })
    entries: Documents<SharedFsEntry, IndexableSharedFsEntry>;

    @field({ type: option(TrustedNetwork) })
    trustGraph?: TrustedNetwork;

    machineLabel = "unknown-machine";
    replicate: OpenReplicateOptions | undefined;
    remoteChunkFetch: { timeoutMs: number } | false = {
        timeoutMs: REMOTE_CHUNK_FETCH_TIMEOUT_MS,
    };

    constructor(properties: { id?: Uint8Array; rootKey?: PublicSignKey } = {}) {
        super();
        this.id = properties.id ?? randomBytes(32);
        this.trustGraph = properties.rootKey
            ? new TrustedNetwork({
                  id: this.id,
                  rootTrust: properties.rootKey,
              })
            : undefined;
        this.entries = new Documents({
            id: sha256Sync(concat([this.id, fromString("/shared-fs")])),
        });
    }

    async open(args?: SharedFsOpenArgs) {
        this.machineLabel = args?.machineLabel || "unknown-machine";
        // Default to a full replica: every mount serves the whole namespace
        // from its local index, and a writer must never see its own files
        // pruned because it is not a leader for them.
        this.replicate =
            args?.replicate === undefined ? { factor: 1 } : args.replicate;
        if (args?.remoteChunkFetch === false) {
            this.remoteChunkFetch = false;
        } else if (
            typeof args?.remoteChunkFetch === "object" &&
            args.remoteChunkFetch.timeoutMs
        ) {
            this.remoteChunkFetch = {
                timeoutMs: args.remoteChunkFetch.timeoutMs,
            };
        }
        // The trust graph is tiny and gates every write; always keep a full
        // copy so signature checks never depend on which peer holds a relation.
        await this.trustGraph?.open({
            replicate: { factor: 1 } as any,
        });
        await this.entries.open({
            type: SharedFsEntry,
            replicate: this.replicate as any,
            replicas: { min: 3 },
            // Never prune locally authored entries, even when this peer is not
            // a replicator for them (e.g. replicate: false).
            keep: "self",
            canPerform: (operation) => this.canPerformEntry(operation),
            index: {
                type: IndexableSharedFsEntry,
            },
        });
    }

    private authorKey() {
        return encodePublicSignKey(this.node.identity.publicKey);
    }

    private signedMetadata() {
        return {
            authorKey: this.authorKey(),
            machineLabel: this.machineLabel,
            timestamp: now(),
        };
    }

    private entryAuthorKey(entry: unknown) {
        if (
            entry instanceof DirectoryRecord ||
            entry instanceof FileRecord ||
            entry instanceof FileVersion ||
            entry instanceof DeleteMarker
        ) {
            return entry.authorKey;
        }
        return undefined;
    }

    private async canPerformEntry(operation: any) {
        if (!this.trustGraph) {
            return true;
        }
        const keys = await operation.entry.getPublicKeys();
        const trustedKeys: PublicSignKey[] = [];
        for (const key of keys) {
            if (await this.trustGraph.isTrusted(key)) {
                trustedKeys.push(key);
            }
        }
        if (trustedKeys.length === 0) {
            return false;
        }
        if (operation.type === "put") {
            const authorKey = this.entryAuthorKey(operation.value);
            if (authorKey) {
                return trustedKeys.some(
                    (key) => encodePublicSignKey(key) === authorKey
                );
            }
        }
        return true;
    }

    get accessControlled() {
        return !!this.trustGraph;
    }

    get rootKey() {
        return this.trustGraph
            ? encodePublicSignKey(this.trustGraph.rootTrust)
            : undefined;
    }

    get localPublicKey() {
        return this.authorKey();
    }

    async authorizeWriter(publicKey: PublicSignKey) {
        if (!this.trustGraph) {
            throw new Error("Shared filesystem is not access controlled");
        }
        await this.trustGraph.add(publicKey);
    }

    async isTrustedWriter(publicKey: PublicSignKey) {
        return this.trustGraph ? this.trustGraph.isTrusted(publicKey) : true;
    }

    async trustedWriters() {
        return this.trustGraph ? this.trustGraph.getTrusted() : [];
    }

    // ------------------------------------------------------------------
    // Index access. Every lookup is an indexed query on the local sqlite
    // index (kind, nodeId, parentId, name, versionId, deleted) and only
    // resolves the small metadata documents it needs. Chunk bytes are fetched
    // by id, never scanned.
    // ------------------------------------------------------------------

    private async queryDocuments<T extends SharedFsEntry>(
        query: Query[]
    ): Promise<T[]> {
        const results = await this.entries.index
            .iterate({ query }, { local: true, remote: false, resolve: true })
            .all();
        return results as unknown as T[];
    }

    private async getDocument<T extends SharedFsEntry>(
        id: string
    ): Promise<T | undefined> {
        const result = await this.entries.index.get(id, {
            local: true,
            remote: false,
        });
        return (result ?? undefined) as unknown as T | undefined;
    }

    private async nodeRecord(nodeId: string): Promise<NodeRecord | undefined> {
        if (nodeId === ROOT_NODE_ID) {
            return undefined;
        }
        const record = await this.getDocument(nodeId);
        return record instanceof FileRecord || record instanceof DirectoryRecord
            ? record
            : undefined;
    }

    /** Live (non-deleted) child records of a directory node. */
    private async childRecords(parentId: string): Promise<NodeRecord[]> {
        const records = await this.queryDocuments<NodeRecord>([
            new StringMatch({ key: "parentId", value: parentId }),
            NODE_KINDS_QUERY,
            new BoolQuery({ key: "deleted", value: false }),
        ]);
        return records.filter(
            (record): record is NodeRecord =>
                (record instanceof FileRecord ||
                    record instanceof DirectoryRecord) &&
                !record.deleted
        );
    }

    /**
     * Deduplicate same-named children deterministically so every peer exposes
     * the same node at a path even after concurrent creates.
     */
    private dedupeByName(records: NodeRecord[]): NodeRecord[] {
        const byName = new Map<string, NodeRecord>();
        for (const record of records) {
            const existing = byName.get(record.name);
            if (!existing || oldestFirst(record, existing) < 0) {
                byName.set(record.name, record);
            }
        }
        return [...byName.values()];
    }

    private async childByName(
        parentId: string,
        name: string
    ): Promise<NodeRecord | undefined> {
        const records = await this.queryDocuments<NodeRecord>([
            new StringMatch({ key: "parentId", value: parentId }),
            new StringMatch({ key: "name", value: name }),
            NODE_KINDS_QUERY,
            new BoolQuery({ key: "deleted", value: false }),
        ]);
        const live = records.filter(
            (record): record is NodeRecord =>
                (record instanceof FileRecord ||
                    record instanceof DirectoryRecord) &&
                !record.deleted
        );
        if (live.length === 0) {
            return undefined;
        }
        return live.sort(oldestFirst)[0];
    }

    private async resolvePath(path: string): Promise<ResolvedPath | undefined> {
        const normalized = normalizeFsPath(path);
        if (normalized === "/") {
            return { kind: "root", nodeId: ROOT_NODE_ID, path: "/" };
        }
        const segments = pathSegments(normalized);
        let parentId: string = ROOT_NODE_ID;
        let currentPath = "/";
        for (let i = 0; i < segments.length; i++) {
            const name = segments[i];
            currentPath = joinFsPath(currentPath, name);
            const isLast = i === segments.length - 1;
            const record = await this.childByName(parentId, name);
            if (!record) {
                return undefined;
            }
            if (record instanceof DirectoryRecord) {
                if (isLast) {
                    return {
                        kind: "directory",
                        record,
                        path: currentPath,
                    };
                }
                parentId = record.nodeId;
                continue;
            }
            if (isLast) {
                return { kind: "file", record, path: currentPath };
            }
            // A file in the middle of the path.
            return undefined;
        }
        return undefined;
    }

    private async resolveParent(path: string) {
        const parentPath = dirname(path);
        const resolved = await this.resolvePath(parentPath);
        if (!resolved) {
            throw new SharedFsError(
                "ENOENT",
                `Parent directory does not exist: ${parentPath}`
            );
        }
        if (resolved.kind === "file") {
            throw new SharedFsError(
                "ENOTDIR",
                `Parent path is a file: ${parentPath}`
            );
        }
        return resolved.kind === "root" ? ROOT_NODE_ID : resolved.record.nodeId;
    }

    private headsFromDocuments(documents: FileHead[]): FileHead[] {
        const referenced = new Set<string>();
        for (const head of documents) {
            for (const parentId of head.parentVersionIds) {
                referenced.add(parentId);
            }
        }
        return documents
            .filter((head) => !referenced.has(head.id))
            .sort(newestFirst);
    }

    /** All version / delete-marker documents for a node, newest first. */
    private async headDocumentsForNode(nodeId: string): Promise<FileHead[]> {
        const documents = await this.queryDocuments<SharedFsEntry>([
            new StringMatch({ key: "nodeId", value: nodeId }),
            HEAD_KINDS_QUERY,
        ]);
        return documents.filter(isFileHead).sort(newestFirst);
    }

    private async headsForNode(nodeId: string): Promise<FileHead[]> {
        return this.headsFromDocuments(await this.headDocumentsForNode(nodeId));
    }

    /** Heads for many nodes with batched queries. */
    private async headsForNodes(
        nodeIds: string[]
    ): Promise<Map<string, FileHead[]>> {
        const byNode = new Map<string, FileHead[]>();
        for (const nodeId of nodeIds) {
            byNode.set(nodeId, []);
        }
        for (let i = 0; i < nodeIds.length; i += HEAD_QUERY_BATCH) {
            const batch = nodeIds.slice(i, i + HEAD_QUERY_BATCH);
            const documents = await this.queryDocuments<SharedFsEntry>([
                batch.length === 1
                    ? new StringMatch({ key: "nodeId", value: batch[0] })
                    : new Or(
                          batch.map(
                              (nodeId) =>
                                  new StringMatch({
                                      key: "nodeId",
                                      value: nodeId,
                                  })
                          )
                      ),
                HEAD_KINDS_QUERY,
            ]);
            for (const document of documents) {
                if (isFileHead(document)) {
                    byNode.get(document.nodeId)?.push(document);
                }
            }
        }
        for (const [nodeId, documents] of byNode) {
            byNode.set(nodeId, this.headsFromDocuments(documents));
        }
        return byNode;
    }

    private async visibleFileHead(nodeId: string) {
        return (await this.headsForNode(nodeId))[0];
    }

    /**
     * Path of a record by walking parent pointers. Guards against cycles that
     * concurrent cross-peer moves can create; unreachable records resolve to
     * their name under "/".
     */
    private async pathForRecord(
        record: NodeRecord,
        cache?: Map<string, NodeRecord | undefined>
    ) {
        const names = [record.name];
        const visited = new Set<string>([record.nodeId]);
        let parentId = record.parentId;
        while (parentId !== ROOT_NODE_ID) {
            if (visited.has(parentId)) {
                break;
            }
            visited.add(parentId);
            let parent: NodeRecord | undefined;
            if (cache?.has(parentId)) {
                parent = cache.get(parentId);
            } else {
                parent = await this.nodeRecord(parentId);
                cache?.set(parentId, parent);
            }
            if (!parent) {
                break;
            }
            names.unshift(parent.name);
            parentId = parent.parentId;
        }
        return "/" + names.join("/");
    }

    /** True if `ancestorNodeId` is the node or one of its ancestors. */
    private async isWithinSubtree(nodeId: string, ancestorNodeId: string) {
        const visited = new Set<string>();
        let current: string = nodeId;
        while (current !== ROOT_NODE_ID) {
            if (current === ancestorNodeId) {
                return true;
            }
            if (visited.has(current)) {
                return false;
            }
            visited.add(current);
            const record = await this.nodeRecord(current);
            if (!record) {
                return false;
            }
            current = record.parentId;
        }
        return false;
    }

    private versionInfo(
        head: FileHead,
        path: string,
        heads: FileHead[]
    ): SharedFsVersionInfo {
        return {
            id: head.id,
            nodeId: head.nodeId,
            path,
            size: head instanceof FileVersion ? head.size : 0n,
            contentHash:
                head instanceof FileVersion ? head.contentHash : undefined,
            parentVersionIds: head.parentVersionIds,
            createdAt: head.createdAt,
            authorKey: head.authorKey,
            machineLabel: head.machineLabel,
            deleted: head instanceof DeleteMarker,
            head: heads.some((candidate) => candidate.id === head.id),
        };
    }

    private entryInfoFor(
        record: NodeRecord,
        path: string,
        heads?: FileHead[]
    ): SharedFsEntryInfo | undefined {
        if (record instanceof DirectoryRecord) {
            return {
                path,
                nodeId: record.nodeId,
                name: record.name,
                kind: "directory",
                size: 0n,
                updatedAt: record.updatedAt,
                authorKey: record.authorKey,
                machineLabel: record.machineLabel,
                conflict: false,
            };
        }
        const visible = heads?.[0];
        if (!(visible instanceof FileVersion)) {
            // Deleted (delete marker visible) or not yet materialized.
            return undefined;
        }
        return {
            path,
            nodeId: record.nodeId,
            name: record.name,
            kind: "file",
            size: visible.size,
            updatedAt: record.updatedAt,
            authorKey: record.authorKey,
            machineLabel: record.machineLabel,
            conflict: (heads?.length ?? 0) > 1,
            versionId: visible.id,
            headVersionIds: heads?.map((head) => head.id) ?? [],
            contentHash: visible.contentHash,
        };
    }

    // ------------------------------------------------------------------
    // Public filesystem API
    // ------------------------------------------------------------------

    /**
     * Metadata for a single path. `undefined` when the path does not exist.
     * Cost is O(depth) indexed lookups plus one head query for files.
     */
    async stat(path: string): Promise<SharedFsEntryInfo | undefined> {
        const normalized = normalizeFsPath(path);
        const resolved = await this.resolvePath(normalized);
        if (!resolved) {
            return undefined;
        }
        if (resolved.kind === "root") {
            return {
                path: "/",
                nodeId: ROOT_NODE_ID,
                name: "",
                kind: "directory",
                size: 0n,
                updatedAt: 0n,
                authorKey: "",
                machineLabel: "",
                conflict: false,
            };
        }
        if (resolved.kind === "directory") {
            return this.entryInfoFor(resolved.record, resolved.path);
        }
        const heads = await this.headsForNode(resolved.record.nodeId);
        return this.entryInfoFor(resolved.record, resolved.path, heads);
    }

    async mkdir(path: string) {
        const normalized = normalizeFsPath(path);
        if (normalized === "/") {
            return;
        }
        if (await this.resolvePath(normalized)) {
            throw new SharedFsError(
                "EEXIST",
                `Path already exists: ${normalized}`
            );
        }
        const parentId = await this.resolveParent(normalized);
        const metadata = this.signedMetadata();
        const directory = new DirectoryRecord({
            nodeId: createId("dir"),
            parentId,
            name: basename(normalized),
            createdAt: metadata.timestamp,
            authorKey: metadata.authorKey,
            machineLabel: metadata.machineLabel,
        });
        await this.entries.put(directory);
    }

    async writeFile(
        path: string,
        source: Uint8Array | string | AsyncIterable<Uint8Array>,
        options: WriteFileOptions = {}
    ) {
        const normalized = normalizeFsPath(path);
        if (normalized === "/") {
            throw new SharedFsError("EISDIR", "Cannot write to root");
        }
        const bytes = await toBytes(source);
        const existing = await this.resolvePath(normalized);
        if (existing?.kind === "directory") {
            throw new SharedFsError(
                "EISDIR",
                `Path is a directory: ${normalized}`
            );
        }
        const parentId = await this.resolveParent(normalized);
        const metadata = this.signedMetadata();
        const nodeId =
            existing?.kind === "file"
                ? existing.record.nodeId
                : createId("file");
        const currentHeads =
            existing?.kind === "file" ? await this.headsForNode(nodeId) : [];
        const parentVersionIds =
            options.baseVersionIds ?? currentHeads.map((head) => head.id);
        const versionId = createId("version");
        const chunks = chunkBytes(bytes, options.chunkSize).map(
            (chunk, index) =>
                new FileChunk({
                    id: `${versionId}:${index}`,
                    versionId,
                    index,
                    bytes: chunk,
                })
        );
        // Content first, then the version that references it, then the
        // naming record. Chunk ids are fresh, so skip the existing-key lookup.
        await mapWithConcurrency(chunks, CHUNK_IO_CONCURRENCY, (chunk) =>
            this.entries.put(chunk, { unique: true })
        );
        const version = new FileVersion({
            id: versionId,
            nodeId,
            parentId,
            name: basename(normalized),
            parentVersionIds,
            contentHash: sha256Base64Sync(bytes),
            size: BigInt(bytes.byteLength),
            chunkIds: chunks.map((chunk) => chunk.id),
            createdAt: metadata.timestamp,
            authorKey: metadata.authorKey,
            machineLabel: metadata.machineLabel,
        });
        await this.entries.put(version, { unique: true });
        await this.entries.put(
            new FileRecord({
                nodeId,
                parentId,
                name: basename(normalized),
                currentVersionId: versionId,
                createdAt:
                    existing?.kind === "file"
                        ? existing.record.createdAt
                        : metadata.timestamp,
                updatedAt: metadata.timestamp,
                authorKey: metadata.authorKey,
                machineLabel: metadata.machineLabel,
            })
        );
        const referenced = new Set(parentVersionIds);
        const heads = [
            version,
            ...currentHeads.filter((head) => !referenced.has(head.id)),
        ];
        return this.versionInfo(version, normalized, heads);
    }

    private async fetchChunk(
        id: string,
        normalizedPath: string
    ): Promise<FileChunk> {
        let chunk = await this.getDocument<FileChunk>(id);
        if (!chunk && this.remoteChunkFetch) {
            try {
                const remote = await this.entries.index.get(id, {
                    local: true,
                    remote: { timeout: this.remoteChunkFetch.timeoutMs } as any,
                });
                chunk = (remote ?? undefined) as unknown as
                    | FileChunk
                    | undefined;
            } catch {
                chunk = undefined;
            }
        }
        if (!(chunk instanceof FileChunk)) {
            throw new SharedFsError(
                "EIO",
                `Missing chunk ${id} for ${normalizedPath}`
            );
        }
        if (sha256Base64Sync(chunk.bytes) !== chunk.hash) {
            throw new SharedFsError("EIO", `Chunk hash mismatch ${id}`);
        }
        return chunk;
    }

    private async readFileVersion(
        version: FileVersion,
        normalizedPath: string
    ) {
        const chunks = await mapWithConcurrency(
            version.chunkIds,
            CHUNK_IO_CONCURRENCY,
            async (id) => (await this.fetchChunk(id, normalizedPath)).bytes
        );
        const bytes = chunks.length === 0 ? new Uint8Array(0) : concat(chunks);
        if (sha256Base64Sync(bytes) !== version.contentHash) {
            throw new SharedFsError(
                "EIO",
                `File hash mismatch for ${normalizedPath}`
            );
        }
        return bytes;
    }

    async readFile(path: string) {
        const normalized = normalizeFsPath(path);
        const resolved = await this.resolvePath(normalized);
        if (!resolved || resolved.kind !== "file") {
            return undefined;
        }
        const heads = await this.headsForNode(resolved.record.nodeId);
        const visible = heads[0];
        if (!(visible instanceof FileVersion)) {
            return undefined;
        }
        // A version can replicate before its chunks. Prefer the newest head
        // but fall back to the newest complete ancestor version instead of
        // failing the read outright.
        let firstError: unknown;
        const candidates: FileVersion[] = [visible];
        const seen = new Set<string>([visible.id]);
        for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i];
            try {
                return await this.readFileVersion(candidate, normalized);
            } catch (error) {
                firstError = firstError ?? error;
                for (const parentId of candidate.parentVersionIds) {
                    if (seen.has(parentId)) {
                        continue;
                    }
                    seen.add(parentId);
                    const parent =
                        await this.getDocument<SharedFsEntry>(parentId);
                    if (parent instanceof FileVersion) {
                        candidates.push(parent);
                    }
                }
            }
        }
        throw firstError;
    }

    async readVersion(path: string, versionId: string) {
        const normalized = normalizeFsPath(path);
        const resolved = await this.resolvePath(normalized);
        if (!resolved || resolved.kind !== "file") {
            return undefined;
        }
        const version = await this.getDocument<SharedFsEntry>(versionId);
        if (
            !(version instanceof FileVersion) ||
            version.nodeId !== resolved.record.nodeId
        ) {
            return undefined;
        }
        return this.readFileVersion(version, normalized);
    }

    async list(path = "/"): Promise<SharedFsEntryInfo[]> {
        const normalized = normalizeFsPath(path);
        const resolved = await this.resolvePath(normalized);
        if (!resolved) {
            throw new SharedFsError(
                "ENOENT",
                `Path does not exist: ${normalized}`
            );
        }
        if (resolved.kind === "file") {
            throw new SharedFsError("ENOTDIR", `Path is a file: ${normalized}`);
        }
        const parentId =
            resolved.kind === "root" ? ROOT_NODE_ID : resolved.record.nodeId;
        const children = this.dedupeByName(await this.childRecords(parentId));
        const fileNodeIds = children
            .filter((record) => record instanceof FileRecord)
            .map((record) => record.nodeId);
        const heads = await this.headsForNodes(fileNodeIds);
        const infos: SharedFsEntryInfo[] = [];
        for (const record of children) {
            const info = this.entryInfoFor(
                record,
                joinFsPath(normalized, record.name),
                record instanceof FileRecord
                    ? heads.get(record.nodeId)
                    : undefined
            );
            if (info) {
                infos.push(info);
            }
        }
        return infos.sort((a, b) => a.name.localeCompare(b.name));
    }

    async versions(path: string): Promise<SharedFsVersionInfo[]> {
        const normalized = normalizeFsPath(path);
        const resolved = await this.resolvePath(normalized);
        if (!resolved || resolved.kind !== "file") {
            return [];
        }
        const documents = await this.headDocumentsForNode(
            resolved.record.nodeId
        );
        const heads = this.headsFromDocuments(documents);
        return documents.map((entry) =>
            this.versionInfo(entry, normalized, heads)
        );
    }

    async conflicts(path?: string): Promise<SharedFsConflict[]> {
        if (path) {
            const target = await this.resolvePath(path);
            if (target?.kind === "file") {
                const heads = await this.headsForNode(target.record.nodeId);
                if (heads.length <= 1) {
                    return [];
                }
                return [
                    {
                        path: target.path,
                        nodeId: target.record.nodeId,
                        versions: heads.map((head) =>
                            this.versionInfo(head, target.path, heads)
                        ),
                    },
                ];
            }
            if (!target) {
                return [];
            }
        }
        // Whole-tree scan over version metadata (no chunk bytes).
        const documents = await this.queryDocuments<SharedFsEntry>([
            HEAD_KINDS_QUERY,
        ]);
        const byNode = new Map<string, FileHead[]>();
        for (const document of documents) {
            if (!isFileHead(document)) {
                continue;
            }
            const list = byNode.get(document.nodeId) ?? [];
            list.push(document);
            byNode.set(document.nodeId, list);
        }
        const prefix = path ? normalizeFsPath(path) : undefined;
        const recordCache = new Map<string, NodeRecord | undefined>();
        const conflicts: SharedFsConflict[] = [];
        for (const [nodeId, nodeDocuments] of byNode) {
            const heads = this.headsFromDocuments(nodeDocuments);
            if (heads.length <= 1) {
                continue;
            }
            const record = await this.nodeRecord(nodeId);
            if (!(record instanceof FileRecord) || record.deleted) {
                continue;
            }
            const recordPath = await this.pathForRecord(record, recordCache);
            if (
                prefix &&
                prefix !== "/" &&
                recordPath !== prefix &&
                !recordPath.startsWith(prefix + "/")
            ) {
                continue;
            }
            conflicts.push({
                path: recordPath,
                nodeId,
                versions: heads.map((head) =>
                    this.versionInfo(head, recordPath, heads)
                ),
            });
        }
        return conflicts.sort((a, b) => a.path.localeCompare(b.path));
    }

    async resolveConflict(path: string, versionId: string) {
        const normalized = normalizeFsPath(path);
        const resolved = await this.resolvePath(normalized);
        if (!resolved || resolved.kind !== "file") {
            throw new SharedFsError(
                "ENOENT",
                `Path is not a file: ${normalized}`
            );
        }
        const selected = await this.getDocument<SharedFsEntry>(versionId);
        if (
            !(selected instanceof FileVersion) ||
            selected.nodeId !== resolved.record.nodeId
        ) {
            throw new SharedFsError(
                "ENOENT",
                `Version ${versionId} does not exist for ${normalized}`
            );
        }
        const heads = await this.headsForNode(resolved.record.nodeId);
        const metadata = this.signedMetadata();
        const resolution = new FileVersion({
            id: createId("version"),
            nodeId: selected.nodeId,
            parentId: resolved.record.parentId,
            name: resolved.record.name,
            parentVersionIds: heads.map((head) => head.id),
            contentHash: selected.contentHash,
            size: selected.size,
            chunkIds: selected.chunkIds,
            createdAt: metadata.timestamp,
            authorKey: metadata.authorKey,
            machineLabel: metadata.machineLabel,
            conflictResolution: true,
        });
        await this.entries.put(resolution, { unique: true });
        await this.entries.put(
            new FileRecord({
                nodeId: resolved.record.nodeId,
                parentId: resolved.record.parentId,
                name: resolved.record.name,
                currentVersionId: resolution.id,
                createdAt: resolved.record.createdAt,
                updatedAt: metadata.timestamp,
                authorKey: metadata.authorKey,
                machineLabel: metadata.machineLabel,
                deleted: resolved.record.deleted,
            })
        );
        return this.versionInfo(resolution, normalized, [resolution]);
    }

    async rm(path: string) {
        const normalized = normalizeFsPath(path);
        if (normalized === "/") {
            throw new SharedFsError("EINVAL", "Cannot remove root");
        }
        const resolved = await this.resolvePath(normalized);
        if (!resolved) {
            return;
        }
        if (resolved.kind === "root") {
            throw new SharedFsError("EINVAL", "Cannot remove root");
        }
        const metadata = this.signedMetadata();
        if (resolved.kind === "directory") {
            const children = await this.list(normalized);
            if (children.length > 0) {
                throw new SharedFsError(
                    "ENOTEMPTY",
                    `Directory is not empty: ${normalized}`
                );
            }
            await this.entries.put(
                new DirectoryRecord({
                    nodeId: resolved.record.nodeId,
                    parentId: resolved.record.parentId,
                    name: resolved.record.name,
                    createdAt: resolved.record.createdAt,
                    updatedAt: metadata.timestamp,
                    authorKey: metadata.authorKey,
                    machineLabel: metadata.machineLabel,
                    deleted: true,
                })
            );
            return;
        }
        const heads = await this.headsForNode(resolved.record.nodeId);
        const marker = new DeleteMarker({
            id: createId("delete"),
            nodeId: resolved.record.nodeId,
            parentId: resolved.record.parentId,
            name: resolved.record.name,
            parentVersionIds: heads.map((head) => head.id),
            createdAt: metadata.timestamp,
            authorKey: metadata.authorKey,
            machineLabel: metadata.machineLabel,
        });
        await this.entries.put(marker, { unique: true });
        await this.entries.put(
            new FileRecord({
                nodeId: resolved.record.nodeId,
                parentId: resolved.record.parentId,
                name: resolved.record.name,
                currentVersionId: marker.id,
                createdAt: resolved.record.createdAt,
                updatedAt: metadata.timestamp,
                authorKey: metadata.authorKey,
                machineLabel: metadata.machineLabel,
                deleted: true,
            })
        );
    }

    async rename(from: string, to: string) {
        const fromPath = normalizeFsPath(from);
        const toPath = normalizeFsPath(to);
        if (fromPath === toPath) {
            return;
        }
        const resolved = await this.resolvePath(fromPath);
        if (!resolved || resolved.kind === "root") {
            throw new SharedFsError(
                "ENOENT",
                `Path does not exist: ${fromPath}`
            );
        }
        const destination = await this.resolvePath(toPath);
        if (destination) {
            if (destination.kind === "root") {
                throw new SharedFsError(
                    "EINVAL",
                    `Cannot replace root path: ${toPath}`
                );
            }
            if (destination.record.nodeId === resolved.record.nodeId) {
                return;
            }
            if (
                resolved.kind === "directory" ||
                destination.kind === "directory"
            ) {
                throw new SharedFsError(
                    destination.kind === "directory" ? "EISDIR" : "ENOTDIR",
                    `Cannot replace directory path: ${toPath}`
                );
            }
        }
        const parentId = await this.resolveParent(toPath);
        if (
            resolved.kind === "directory" &&
            (parentId === resolved.record.nodeId ||
                (await this.isWithinSubtree(parentId, resolved.record.nodeId)))
        ) {
            throw new SharedFsError(
                "EINVAL",
                `Cannot move a directory into its own subtree: ${fromPath} -> ${toPath}`
            );
        }
        if (destination) {
            await this.rm(toPath);
        }
        const metadata = this.signedMetadata();
        if (resolved.kind === "directory") {
            await this.entries.put(
                new DirectoryRecord({
                    nodeId: resolved.record.nodeId,
                    parentId,
                    name: basename(toPath),
                    createdAt: resolved.record.createdAt,
                    updatedAt: metadata.timestamp,
                    authorKey: metadata.authorKey,
                    machineLabel: metadata.machineLabel,
                    deleted: resolved.record.deleted,
                })
            );
        } else {
            await this.entries.put(
                new FileRecord({
                    nodeId: resolved.record.nodeId,
                    parentId,
                    name: basename(toPath),
                    currentVersionId: resolved.record.currentVersionId,
                    createdAt: resolved.record.createdAt,
                    updatedAt: metadata.timestamp,
                    authorKey: metadata.authorKey,
                    machineLabel: metadata.machineLabel,
                    deleted: resolved.record.deleted,
                })
            );
        }
    }
}

export class SharedFsHandle {
    constructor(readonly program: SharedFileSystem) {}

    get address() {
        return this.program.address?.toString();
    }

    get accessControlled() {
        return this.program.accessControlled;
    }

    get rootKey() {
        return this.program.rootKey;
    }

    get localPublicKey() {
        return this.program.localPublicKey;
    }

    stat(path: string) {
        return this.program.stat(path);
    }

    readFile(path: string) {
        return this.program.readFile(path);
    }

    writeFile(
        path: string,
        source: Uint8Array | string | AsyncIterable<Uint8Array>,
        options?: WriteFileOptions
    ) {
        return this.program.writeFile(path, source, options);
    }

    readVersion(path: string, versionId: string) {
        return this.program.readVersion(path, versionId);
    }

    mkdir(path: string) {
        return this.program.mkdir(path);
    }

    rm(path: string) {
        return this.program.rm(path);
    }

    rename(from: string, to: string) {
        return this.program.rename(from, to);
    }

    list(path?: string) {
        return this.program.list(path);
    }

    versions(path: string) {
        return this.program.versions(path);
    }

    conflicts(path?: string) {
        return this.program.conflicts(path);
    }

    resolveConflict(path: string, versionId: string) {
        return this.program.resolveConflict(path, versionId);
    }

    authorizeWriter(publicKey: PublicSignKey) {
        return this.program.authorizeWriter(publicKey);
    }

    isTrustedWriter(publicKey: PublicSignKey) {
        return this.program.isTrustedWriter(publicKey);
    }

    trustedWriters() {
        return this.program.trustedWriters();
    }
}

export const openSharedFs = async (options: OpenSharedFsOptions) => {
    const args: SharedFsOpenArgs = {
        machineLabel: options.machineLabel,
        replicate: options.replicate,
        remoteChunkFetch: options.remoteChunkFetch,
    };
    const program = options.address
        ? await SharedFileSystem.open(
              options.address as string,
              options.peerbit as any,
              {
                  args,
              }
          )
        : await options.peerbit.open(
              new SharedFileSystem({
                  id: options.id,
                  rootKey: options.rootKey,
              }),
              {
                  existing: "reuse",
                  args,
              }
          );
    return new SharedFsHandle(program);
};
