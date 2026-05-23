import { field, option, variant } from "@dao-xyz/borsh";
import { sha256Base64Sync } from "@peerbit/crypto";

const encodeStringList = (values?: string[]) => JSON.stringify(values ?? []);

const decodeStringList = (value?: string) => {
    if (!value) {
        return [];
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((item): item is string => typeof item === "string")
            : [];
    } catch {
        return [];
    }
};

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

    constructor(value?: SharedFsEntry) {
        if (!value) {
            this.id = "";
            this.kind = "";
            this.deleted = false;
            return;
        }
        this.id = value.id;
        this.deleted = false;
        if (value instanceof DirectoryRecord) {
            this.kind = "directory";
            this.nodeId = value.nodeId;
            this.parentId = value.parentId;
            this.name = value.name;
            this.deleted = value.deleted;
        } else if (value instanceof FileRecord) {
            this.kind = "file";
            this.nodeId = value.nodeId;
            this.parentId = value.parentId;
            this.name = value.name;
            this.deleted = value.deleted;
        } else if (value instanceof FileVersion) {
            this.kind = "file-version";
            this.nodeId = value.nodeId;
            this.parentId = value.parentId;
            this.name = value.name;
            this.versionId = value.id;
        } else if (value instanceof FileChunk) {
            this.kind = "file-chunk";
            this.versionId = value.versionId;
        } else if (value instanceof DeleteMarker) {
            this.kind = "delete-marker";
            this.nodeId = value.nodeId;
            this.parentId = value.parentId;
            this.name = value.name;
            this.versionId = value.id;
            this.deleted = true;
        } else {
            this.kind = value.kind;
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

    @field({ type: "string" })
    parentVersionIdsJson: string;

    @field({ type: "string" })
    contentHash: string;

    @field({ type: "u64" })
    size: bigint;

    @field({ type: "string" })
    chunkIdsJson: string;

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

    get parentVersionIds() {
        return decodeStringList(this.parentVersionIdsJson);
    }

    set parentVersionIds(value: string[]) {
        this.parentVersionIdsJson = encodeStringList(value);
    }

    get chunkIds() {
        return decodeStringList(this.chunkIdsJson);
    }

    set chunkIds(value: string[]) {
        this.chunkIdsJson = encodeStringList(value);
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

    @field({ type: "string" })
    parentVersionIdsJson: string;

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

    get parentVersionIds() {
        return decodeStringList(this.parentVersionIdsJson);
    }

    set parentVersionIds(value: string[]) {
        this.parentVersionIdsJson = encodeStringList(value);
    }
}

export type FileHead = FileVersion | DeleteMarker;

export const isFileHead = (entry: SharedFsEntry): entry is FileHead =>
    entry instanceof FileVersion || entry instanceof DeleteMarker;
