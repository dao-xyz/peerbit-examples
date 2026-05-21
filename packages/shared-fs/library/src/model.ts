import { field, option, variant, vec } from "@dao-xyz/borsh";
import { sha256Base64Sync } from "@peerbit/crypto";

export type SharedFsEntryKind =
    | "directory"
    | "file"
    | "file-version"
    | "file-chunk"
    | "delete-marker";

export abstract class SharedFsEntry {
    abstract id: string;
    abstract kind: SharedFsEntryKind;
}

export type SignedMetadata = {
    authorKey: string;
    machineLabel: string;
    timestamp: bigint | number;
};

@variant("shared_fs_indexable_entry")
export class IndexableSharedFsEntry {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    kind: string;

    @field({ type: option("string") })
    nodeId?: string;

    @field({ type: option("string") })
    parentId?: string;

    @field({ type: option("string") })
    name?: string;

    @field({ type: option("string") })
    versionId?: string;

    @field({ type: "bool" })
    deleted: boolean;

    constructor(value: SharedFsEntry) {
        this.id = value.id;
        this.kind = value.kind;
        this.deleted = false;
        if (value instanceof DirectoryRecord || value instanceof FileRecord) {
            this.nodeId = value.nodeId;
            this.parentId = value.parentId;
            this.name = value.name;
            this.deleted = value.deleted;
        } else if (value instanceof FileVersion) {
            this.nodeId = value.nodeId;
            this.parentId = value.parentId;
            this.name = value.name;
            this.versionId = value.id;
        } else if (value instanceof FileChunk) {
            this.versionId = value.versionId;
        } else if (value instanceof DeleteMarker) {
            this.nodeId = value.nodeId;
            this.parentId = value.parentId;
            this.name = value.name;
            this.versionId = value.id;
            this.deleted = true;
        }
    }
}

@variant("shared_fs_directory_record")
export class DirectoryRecord extends SharedFsEntry {
    kind: SharedFsEntryKind = "directory";

    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    nodeId: string;

    @field({ type: "string" })
    parentId: string;

    @field({ type: "string" })
    name: string;

    @field({ type: "u64" })
    createdAt: bigint;

    @field({ type: "u64" })
    updatedAt: bigint;

    @field({ type: "string" })
    authorKey: string;

    @field({ type: "string" })
    machineLabel: string;

    @field({ type: "bool" })
    deleted: boolean;

    constructor(properties?: {
        nodeId: string;
        parentId: string;
        name: string;
        createdAt: bigint | number;
        updatedAt?: bigint | number;
        authorKey: string;
        machineLabel: string;
        deleted?: boolean;
    }) {
        super();
        if (properties) {
            this.id = properties.nodeId;
            this.nodeId = properties.nodeId;
            this.parentId = properties.parentId;
            this.name = properties.name;
            this.createdAt = BigInt(properties.createdAt);
            this.updatedAt = BigInt(
                properties.updatedAt ?? properties.createdAt
            );
            this.authorKey = properties.authorKey;
            this.machineLabel = properties.machineLabel;
            this.deleted = properties.deleted ?? false;
        }
    }
}

@variant("shared_fs_file_record")
export class FileRecord extends SharedFsEntry {
    kind: SharedFsEntryKind = "file";

    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    nodeId: string;

    @field({ type: "string" })
    parentId: string;

    @field({ type: "string" })
    name: string;

    @field({ type: option("string") })
    currentVersionId?: string;

    @field({ type: "u64" })
    createdAt: bigint;

    @field({ type: "u64" })
    updatedAt: bigint;

    @field({ type: "string" })
    authorKey: string;

    @field({ type: "string" })
    machineLabel: string;

    @field({ type: "bool" })
    deleted: boolean;

    constructor(properties?: {
        nodeId: string;
        parentId: string;
        name: string;
        currentVersionId?: string;
        createdAt: bigint | number;
        updatedAt?: bigint | number;
        authorKey: string;
        machineLabel: string;
        deleted?: boolean;
    }) {
        super();
        if (properties) {
            this.id = properties.nodeId;
            this.nodeId = properties.nodeId;
            this.parentId = properties.parentId;
            this.name = properties.name;
            this.currentVersionId = properties.currentVersionId;
            this.createdAt = BigInt(properties.createdAt);
            this.updatedAt = BigInt(
                properties.updatedAt ?? properties.createdAt
            );
            this.authorKey = properties.authorKey;
            this.machineLabel = properties.machineLabel;
            this.deleted = properties.deleted ?? false;
        }
    }
}

@variant("shared_fs_file_chunk")
export class FileChunk extends SharedFsEntry {
    kind: SharedFsEntryKind = "file-chunk";

    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    versionId: string;

    @field({ type: "u32" })
    index: number;

    @field({ type: Uint8Array })
    bytes: Uint8Array;

    @field({ type: "string" })
    hash: string;

    constructor(properties?: {
        id: string;
        versionId: string;
        index: number;
        bytes: Uint8Array;
        hash?: string;
    }) {
        super();
        if (properties) {
            this.id = properties.id;
            this.versionId = properties.versionId;
            this.index = properties.index;
            this.bytes = properties.bytes;
            this.hash = properties.hash ?? sha256Base64Sync(properties.bytes);
        }
    }
}

@variant("shared_fs_file_version")
export class FileVersion extends SharedFsEntry {
    kind: SharedFsEntryKind = "file-version";

    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    nodeId: string;

    @field({ type: "string" })
    parentId: string;

    @field({ type: "string" })
    name: string;

    @field({ type: vec("string") })
    parentVersionIds: string[];

    @field({ type: "string" })
    contentHash: string;

    @field({ type: "u64" })
    size: bigint;

    @field({ type: vec("string") })
    chunkIds: string[];

    @field({ type: "u64" })
    createdAt: bigint;

    @field({ type: "string" })
    authorKey: string;

    @field({ type: "string" })
    machineLabel: string;

    @field({ type: "bool" })
    conflictResolution: boolean;

    constructor(properties?: {
        id: string;
        nodeId: string;
        parentId: string;
        name: string;
        parentVersionIds?: string[];
        contentHash: string;
        size: bigint | number;
        chunkIds: string[];
        createdAt: bigint | number;
        authorKey: string;
        machineLabel: string;
        conflictResolution?: boolean;
    }) {
        super();
        if (properties) {
            this.id = properties.id;
            this.nodeId = properties.nodeId;
            this.parentId = properties.parentId;
            this.name = properties.name;
            this.parentVersionIds = properties.parentVersionIds ?? [];
            this.contentHash = properties.contentHash;
            this.size = BigInt(properties.size);
            this.chunkIds = properties.chunkIds;
            this.createdAt = BigInt(properties.createdAt);
            this.authorKey = properties.authorKey;
            this.machineLabel = properties.machineLabel;
            this.conflictResolution = properties.conflictResolution ?? false;
        }
    }
}

@variant("shared_fs_delete_marker")
export class DeleteMarker extends SharedFsEntry {
    kind: SharedFsEntryKind = "delete-marker";

    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    nodeId: string;

    @field({ type: "string" })
    parentId: string;

    @field({ type: "string" })
    name: string;

    @field({ type: vec("string") })
    parentVersionIds: string[];

    @field({ type: "u64" })
    createdAt: bigint;

    @field({ type: "string" })
    authorKey: string;

    @field({ type: "string" })
    machineLabel: string;

    constructor(properties?: {
        id: string;
        nodeId: string;
        parentId: string;
        name: string;
        parentVersionIds?: string[];
        createdAt: bigint | number;
        authorKey: string;
        machineLabel: string;
    }) {
        super();
        if (properties) {
            this.id = properties.id;
            this.nodeId = properties.nodeId;
            this.parentId = properties.parentId;
            this.name = properties.name;
            this.parentVersionIds = properties.parentVersionIds ?? [];
            this.createdAt = BigInt(properties.createdAt);
            this.authorKey = properties.authorKey;
            this.machineLabel = properties.machineLabel;
        }
    }
}

export type FileHead = FileVersion | DeleteMarker;

export const isFileHead = (entry: SharedFsEntry): entry is FileHead =>
    entry instanceof FileVersion || entry instanceof DeleteMarker;
