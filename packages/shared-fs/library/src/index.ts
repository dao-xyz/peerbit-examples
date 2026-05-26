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
import { Documents, SearchRequest } from "@peerbit/document";
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
    replicate?: OpenReplicateOptions;
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

type Projection = {
    directories: DirectoryRecord[];
    files: FileRecord[];
    versions: FileVersion[];
    chunks: FileChunk[];
    deletes: DeleteMarker[];
};

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

const latestRecord = <T extends { id: string; updatedAt: bigint }>(
    records: T[]
) => {
    return [...records].sort(newestFirst)[0];
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
        this.replicate = args?.replicate;
        await this.trustGraph?.open({
            replicate: args?.replicate as any,
        });
        await this.entries.open({
            type: SharedFsEntry,
            replicate: args?.replicate as any,
            replicas: { min: 3 },
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

    private async allEntries(): Promise<SharedFsEntry[]> {
        return this.entries.index.search(
            new SearchRequest({
                query: [],
                fetch: 0xffffffff,
            }),
            {
                local: true,
                remote: false,
            } as any
        ) as Promise<SharedFsEntry[]>;
    }

    private async projection(): Promise<Projection> {
        const entries = await this.allEntries();
        return {
            directories: entries.filter(
                (entry): entry is DirectoryRecord =>
                    entry instanceof DirectoryRecord
            ),
            files: entries.filter(
                (entry): entry is FileRecord => entry instanceof FileRecord
            ),
            versions: entries.filter(
                (entry): entry is FileVersion => entry instanceof FileVersion
            ),
            chunks: entries.filter(
                (entry): entry is FileChunk => entry instanceof FileChunk
            ),
            deletes: entries.filter(
                (entry): entry is DeleteMarker => entry instanceof DeleteMarker
            ),
        };
    }

    private currentDirectories(projection: Projection) {
        const byId = new Map<string, DirectoryRecord[]>();
        for (const record of projection.directories) {
            const records = byId.get(record.nodeId) ?? [];
            records.push(record);
            byId.set(record.nodeId, records);
        }
        return [...byId.values()]
            .map(latestRecord)
            .filter((record) => !record.deleted);
    }

    private currentFiles(projection: Projection) {
        const byId = new Map<string, FileRecord[]>();
        for (const record of projection.files) {
            const records = byId.get(record.nodeId) ?? [];
            records.push(record);
            byId.set(record.nodeId, records);
        }
        return [...byId.values()]
            .map(latestRecord)
            .filter((record) => !record.deleted);
    }

    private async resolvePath(
        path: string,
        projection?: Projection
    ): Promise<ResolvedPath | undefined> {
        const state = projection ?? (await this.projection());
        const normalized = normalizeFsPath(path);
        if (normalized === "/") {
            return { kind: "root", nodeId: ROOT_NODE_ID, path: "/" };
        }
        const segments = pathSegments(normalized);
        const directories = this.currentDirectories(state);
        const files = this.currentFiles(state);
        let parentId = ROOT_NODE_ID;
        let currentPath = "/";
        for (let i = 0; i < segments.length; i++) {
            const name = segments[i];
            currentPath = joinFsPath(currentPath, name);
            const isLast = i === segments.length - 1;
            const directory = directories.find(
                (record) => record.parentId === parentId && record.name === name
            );
            if (directory) {
                if (isLast) {
                    return {
                        kind: "directory",
                        record: directory,
                        path: currentPath,
                    };
                }
                parentId = directory.nodeId;
                continue;
            }
            if (isLast) {
                const file = files.find(
                    (record) =>
                        record.parentId === parentId && record.name === name
                );
                if (file) {
                    return { kind: "file", record: file, path: currentPath };
                }
            }
            return undefined;
        }
        return undefined;
    }

    private async resolveParent(path: string, projection?: Projection) {
        const state = projection ?? (await this.projection());
        const parentPath = dirname(path);
        const resolved = await this.resolvePath(parentPath, state);
        if (!resolved) {
            throw new Error(`Parent directory does not exist: ${parentPath}`);
        }
        if (resolved.kind === "file") {
            throw new Error(`Parent path is a file: ${parentPath}`);
        }
        return resolved.kind === "root" ? ROOT_NODE_ID : resolved.record.nodeId;
    }

    private headsForNode(projection: Projection, nodeId: string): FileHead[] {
        const heads = [...projection.versions, ...projection.deletes].filter(
            (entry) => isFileHead(entry) && entry.nodeId === nodeId
        );
        const referenced = new Set<string>();
        for (const head of heads) {
            for (const parentId of head.parentVersionIds) {
                referenced.add(parentId);
            }
        }
        return heads
            .filter((head) => !referenced.has(head.id))
            .sort(newestFirst);
    }

    private visibleFileHead(projection: Projection, nodeId: string) {
        return this.headsForNode(projection, nodeId)[0];
    }

    private pathForRecord(
        record: FileRecord | DirectoryRecord,
        projection: Projection
    ) {
        const names = [record.name];
        let parentId = record.parentId;
        const directories = this.currentDirectories(projection);
        while (parentId !== ROOT_NODE_ID) {
            const parent = directories.find(
                (candidate) => candidate.nodeId === parentId
            );
            if (!parent) {
                break;
            }
            names.unshift(parent.name);
            parentId = parent.parentId;
        }
        return "/" + names.join("/");
    }

    private versionInfo(
        head: FileHead,
        path: string,
        projection: Projection
    ): SharedFsVersionInfo {
        const heads = new Set(
            this.headsForNode(projection, head.nodeId).map((x) => x.id)
        );
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
            head: heads.has(head.id),
        };
    }

    async mkdir(path: string) {
        const normalized = normalizeFsPath(path);
        if (normalized === "/") {
            return;
        }
        const projection = await this.projection();
        if (await this.resolvePath(normalized, projection)) {
            throw new Error(`Path already exists: ${normalized}`);
        }
        const metadata = this.signedMetadata();
        const directory = new DirectoryRecord({
            nodeId: createId("dir"),
            parentId: await this.resolveParent(normalized, projection),
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
            throw new Error("Cannot write to root");
        }
        const bytes = await toBytes(source);
        const projection = await this.projection();
        const existing = await this.resolvePath(normalized, projection);
        if (existing?.kind === "directory") {
            throw new Error(`Path is a directory: ${normalized}`);
        }
        const metadata = this.signedMetadata();
        const parentId = await this.resolveParent(normalized, projection);
        const nodeId =
            existing?.kind === "file"
                ? existing.record.nodeId
                : createId("file");
        const parentVersionIds =
            options.baseVersionIds ??
            (existing?.kind === "file"
                ? this.headsForNode(projection, existing.record.nodeId).map(
                      (head) => head.id
                  )
                : []);
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
        for (const chunk of chunks) {
            await this.entries.put(chunk);
        }
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
        await this.entries.put(version);
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
        return this.versionInfo(version, normalized, {
            ...projection,
            versions: [...projection.versions, version],
            chunks: [...projection.chunks, ...chunks],
        });
    }

    private readFileVersion(
        version: FileVersion,
        normalizedPath: string,
        projection: Projection
    ) {
        const chunks = version.chunkIds.map((id) => {
            const chunk = projection.chunks.find(
                (candidate) => candidate.id === id
            );
            if (!chunk) {
                throw new Error(`Missing chunk ${id} for ${normalizedPath}`);
            }
            if (sha256Base64Sync(chunk.bytes) !== chunk.hash) {
                throw new Error(`Chunk hash mismatch ${id}`);
            }
            return chunk.bytes;
        });
        const bytes = chunks.length === 0 ? new Uint8Array(0) : concat(chunks);
        if (sha256Base64Sync(bytes) !== version.contentHash) {
            throw new Error(`File hash mismatch for ${normalizedPath}`);
        }
        return bytes;
    }

    async readFile(path: string) {
        const normalized = normalizeFsPath(path);
        const projection = await this.projection();
        const resolved = await this.resolvePath(normalized, projection);
        if (!resolved || resolved.kind !== "file") {
            return undefined;
        }
        const head = this.visibleFileHead(projection, resolved.record.nodeId);
        if (!(head instanceof FileVersion)) {
            return undefined;
        }
        return this.readFileVersion(head, normalized, projection);
    }

    async readVersion(path: string, versionId: string) {
        const normalized = normalizeFsPath(path);
        const projection = await this.projection();
        const resolved = await this.resolvePath(normalized, projection);
        if (!resolved || resolved.kind !== "file") {
            return undefined;
        }
        const version = projection.versions.find(
            (candidate) =>
                candidate.nodeId === resolved.record.nodeId &&
                candidate.id === versionId
        );
        return version
            ? this.readFileVersion(version, normalized, projection)
            : undefined;
    }

    async list(path = "/"): Promise<SharedFsEntryInfo[]> {
        const normalized = normalizeFsPath(path);
        const projection = await this.projection();
        const resolved = await this.resolvePath(normalized, projection);
        if (!resolved) {
            throw new Error(`Path does not exist: ${normalized}`);
        }
        if (resolved.kind === "file") {
            throw new Error(`Path is a file: ${normalized}`);
        }
        const parentId =
            resolved.kind === "root" ? ROOT_NODE_ID : resolved.record.nodeId;
        const directories = this.currentDirectories(projection).filter(
            (record) => record.parentId === parentId
        );
        const files = this.currentFiles(projection).filter(
            (record) => record.parentId === parentId
        );
        const directoryInfos = directories.map((record) => ({
            path: joinFsPath(normalized, record.name),
            nodeId: record.nodeId,
            name: record.name,
            kind: "directory" as const,
            size: 0n,
            updatedAt: record.updatedAt,
            authorKey: record.authorKey,
            machineLabel: record.machineLabel,
            conflict: false,
        }));
        const fileInfos: SharedFsEntryInfo[] = [];
        for (const record of files) {
            const head = this.visibleFileHead(projection, record.nodeId);
            if (head instanceof DeleteMarker || !head) {
                continue;
            }
            fileInfos.push({
                path: joinFsPath(normalized, record.name),
                nodeId: record.nodeId,
                name: record.name,
                kind: "file" as const,
                size: head instanceof FileVersion ? head.size : 0n,
                updatedAt: record.updatedAt,
                authorKey: record.authorKey,
                machineLabel: record.machineLabel,
                conflict:
                    this.headsForNode(projection, record.nodeId).length > 1,
            });
        }
        return [...directoryInfos, ...fileInfos].sort((a, b) =>
            a.name.localeCompare(b.name)
        );
    }

    async versions(path: string): Promise<SharedFsVersionInfo[]> {
        const normalized = normalizeFsPath(path);
        const projection = await this.projection();
        const resolved = await this.resolvePath(normalized, projection);
        if (!resolved || resolved.kind !== "file") {
            return [];
        }
        return [...projection.versions, ...projection.deletes]
            .filter(
                (entry) =>
                    isFileHead(entry) && entry.nodeId === resolved.record.nodeId
            )
            .sort(newestFirst)
            .map((entry) => this.versionInfo(entry, normalized, projection));
    }

    async conflicts(path?: string): Promise<SharedFsConflict[]> {
        const projection = await this.projection();
        const files = this.currentFiles(projection);
        const target = path
            ? await this.resolvePath(path, projection)
            : undefined;
        const records =
            target?.kind === "file"
                ? [target.record]
                : files.filter((record) => {
                      if (!path) {
                          return true;
                      }
                      const normalizedPrefix = normalizeFsPath(path);
                      return this.pathForRecord(record, projection).startsWith(
                          normalizedPrefix
                      );
                  });
        return records
            .map((record) => {
                const heads = this.headsForNode(projection, record.nodeId);
                if (heads.length <= 1) {
                    return undefined;
                }
                const recordPath = this.pathForRecord(record, projection);
                return {
                    path: recordPath,
                    nodeId: record.nodeId,
                    versions: heads.map((head) =>
                        this.versionInfo(head, recordPath, projection)
                    ),
                };
            })
            .filter((value): value is SharedFsConflict => value != null);
    }

    async resolveConflict(path: string, versionId: string) {
        const normalized = normalizeFsPath(path);
        const projection = await this.projection();
        const resolved = await this.resolvePath(normalized, projection);
        if (!resolved || resolved.kind !== "file") {
            throw new Error(`Path is not a file: ${normalized}`);
        }
        const selected = projection.versions.find(
            (version) =>
                version.nodeId === resolved.record.nodeId &&
                version.id === versionId
        );
        if (!selected) {
            throw new Error(
                `Version ${versionId} does not exist for ${normalized}`
            );
        }
        const heads = this.headsForNode(projection, resolved.record.nodeId);
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
        await this.entries.put(resolution);
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
        return this.versionInfo(resolution, normalized, {
            ...projection,
            versions: [...projection.versions, resolution],
        });
    }

    async rm(path: string) {
        const normalized = normalizeFsPath(path);
        if (normalized === "/") {
            throw new Error("Cannot remove root");
        }
        const projection = await this.projection();
        const resolved = await this.resolvePath(normalized, projection);
        if (!resolved) {
            return;
        }
        if (resolved.kind === "root") {
            throw new Error("Cannot remove root");
        }
        const metadata = this.signedMetadata();
        if (resolved.kind === "directory") {
            const childCount = (await this.list(normalized)).length;
            if (childCount > 0) {
                throw new Error(`Directory is not empty: ${normalized}`);
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
        const marker = new DeleteMarker({
            id: createId("delete"),
            nodeId: resolved.record.nodeId,
            parentId: resolved.record.parentId,
            name: resolved.record.name,
            parentVersionIds: this.headsForNode(
                projection,
                resolved.record.nodeId
            ).map((head) => head.id),
            createdAt: metadata.timestamp,
            authorKey: metadata.authorKey,
            machineLabel: metadata.machineLabel,
        });
        await this.entries.put(marker);
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
        const projection = await this.projection();
        const resolved = await this.resolvePath(fromPath, projection);
        if (!resolved || resolved.kind === "root") {
            throw new Error(`Path does not exist: ${fromPath}`);
        }
        if (await this.resolvePath(toPath, projection)) {
            throw new Error(`Destination already exists: ${toPath}`);
        }
        const parentId = await this.resolveParent(toPath, projection);
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
    };
    const program = options.address
        ? await options.peerbit.open<SharedFileSystem>(options.address as any, {
              args,
          })
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
