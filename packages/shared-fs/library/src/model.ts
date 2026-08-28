import { field, option, variant, vec } from "@dao-xyz/borsh";
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

export type SharedFsEntryKind = "naming" | "file-version" | "file-chunk";

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

    @field({ type: "bool" })
    deleted: boolean;

    /**
     * Distinct chunk ids referenced by a file-version row (empty for other
     * kinds). Queryable reverse index: chunk refcounts and dedup freshness
     * probes are indexed membership queries, never document resolutions.
     */
    @field({ type: vec("string") })
    chunkRefs: string[];

    /** Author createdAt for naming/version rows; 0 for chunks. */
    @field({ type: "u64" })
    createdAt: bigint;

    /**
     * Causal parent ids (version parents for file-version rows, naming
     * parents for naming rows). Together with causalDepth this makes head
     * computation a pure function of index ROWS — the hot metadata paths
     * (stat, list, path resolution, head selection) never resolve documents.
     */
    @field({ type: vec("string") })
    causalRefs: string[];

    @field({ type: "u64" })
    causalDepth: bigint;

    /** Content size for file-version rows; 0 otherwise. */
    @field({ type: "u64" })
    size: bigint;

    /** Content hash for file-version rows. */
    @field({ type: option("string") })
    contentHash?: string;

    @field({ type: option("string") })
    authorKey?: string;

    @field({ type: option("string") })
    machineLabel?: string;

    /** Write-set identity for naming/version rows; queryable. */
    @field({ type: option("string") })
    changesetId?: string;

    constructor(value?: SharedFsEntry) {
        this.chunkRefs = [];
        this.createdAt = 0n;
        this.causalRefs = [];
        this.causalDepth = 0n;
        this.size = 0n;
        if (!value) {
            this.id = "";
            this.kind = "";
            this.deleted = false;
            return;
        }
        this.id = value.id;
        this.deleted = false;
        if (value instanceof NamingEvent) {
            this.kind = "naming";
            this.nodeId = value.nodeId;
            this.parentId = value.parentId;
            this.name = value.name;
            this.deleted = value.deleted;
            this.createdAt = value.createdAt;
            this.causalRefs = value.parentNamingIds;
            this.causalDepth = value.causalDepth;
            this.authorKey = value.authorKey;
            this.machineLabel = value.machineLabel;
            this.changesetId = value.changesetId;
        } else if (value instanceof FileVersion) {
            this.kind = "file-version";
            this.nodeId = value.nodeId;
            this.chunkRefs = [...new Set(value.chunkIds)];
            this.createdAt = value.createdAt;
            this.causalRefs = value.parentVersionIds;
            this.causalDepth = value.causalDepth;
            this.size = value.size;
            this.contentHash = value.contentHash;
            this.authorKey = value.authorKey;
            this.machineLabel = value.machineLabel;
            this.changesetId = value.changesetId;
        } else if (value instanceof FileChunk) {
            this.kind = "file-chunk";
        } else {
            this.kind = value.kind;
        }
    }
}

/**
 * One immutable placement assertion for a node: "node N is (or is not) at
 * (parentId, name)". Naming is the sole authority for placement and deletion;
 * content documents carry no location. Events form a per-node causal DAG via
 * parentNamingIds (exactly like FileVersion.parentVersionIds), so the visible
 * naming state is a pure function of the replicated set — no wall clocks.
 * Events are append-only and never re-put.
 */
@variant("shared_fs_naming_event")
export class NamingEvent extends SharedFsEntry {
    kind: SharedFsEntryKind = "naming";

    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    nodeId: string;

    @field({ type: "string" })
    parentId: string;

    @field({ type: "string" })
    name: string;

    @field({ type: "bool" })
    deleted: boolean;

    /**
     * Author-asserted causal depth: 1 + max(depth of locally-present
     * parents). Winner selection reads this STORED depth so compacting
     * (deleting) ancestors can never change winners on any peer.
     */
    @field({ type: "u64" })
    causalDepth: bigint;

    @field({ type: "string" })
    parentNamingIdsJson: string;

    /**
     * Content head version ids the author observed when deleting a file
     * node; lets peers distinguish "delete confirmed everything" from
     * "delete raced a concurrent edit" (delete-vs-edit conflicts). Empty for
     * non-delete events and directories.
     */
    @field({ type: "string" })
    observedContentHeadsJson: string;

    /** Wall clock, display only — never part of winner selection. */
    @field({ type: "u64" })
    createdAt: bigint;

    @field({ type: "string" })
    authorKey: string;

    @field({ type: "string" })
    machineLabel: string;

    /** Optional write-set identity (see FileVersion.changesetId). */
    @field({ type: option("string") })
    changesetId?: string;

    constructor(properties?: {
        id: string;
        nodeId: string;
        parentId: string;
        name: string;
        deleted?: boolean;
        causalDepth: bigint | number;
        parentNamingIds?: string[];
        observedContentHeads?: string[];
        createdAt: bigint | number;
        authorKey: string;
        machineLabel: string;
        changesetId?: string;
    }) {
        super();
        if (properties) {
            this.id = properties.id;
            this.nodeId = properties.nodeId;
            this.parentId = properties.parentId;
            this.name = properties.name;
            this.deleted = properties.deleted ?? false;
            this.causalDepth = BigInt(properties.causalDepth);
            this.parentNamingIds = properties.parentNamingIds ?? [];
            this.observedContentHeads = properties.observedContentHeads ?? [];
            this.createdAt = BigInt(properties.createdAt);
            this.authorKey = properties.authorKey;
            this.machineLabel = properties.machineLabel;
            this.changesetId = properties.changesetId;
        }
    }

    get parentNamingIds() {
        return decodeStringList(this.parentNamingIdsJson);
    }

    set parentNamingIds(value: string[]) {
        this.parentNamingIdsJson = encodeStringList(value);
    }

    get observedContentHeads() {
        return decodeStringList(this.observedContentHeadsJson);
    }

    set observedContentHeads(value: string[]) {
        this.observedContentHeadsJson = encodeStringList(value);
    }
}

/** Content-addressed chunk id: derived from the chunk bytes alone. */
export const chunkIdForBytes = (bytes: Uint8Array) =>
    `chunk:${sha256Base64Sync(bytes)}`;

/**
 * A content-addressed block of file bytes. The id is derived from the bytes
 * (`chunk:<sha256>`), so identical content — across versions of one file or
 * across different files — is stored exactly once and shared by every
 * FileVersion that references it. Ordering and multiplicity live in
 * FileVersion.chunkIds, not in the chunk itself.
 */
@variant("shared_fs_file_chunk")
export class FileChunk extends SharedFsEntry {
    kind: SharedFsEntryKind = "file-chunk";

    @field({ type: "string" })
    id: string;

    @field({ type: Uint8Array })
    bytes: Uint8Array;

    @field({ type: "string" })
    hash: string;

    constructor(properties?: { bytes: Uint8Array; hash?: string }) {
        super();
        if (properties) {
            this.hash = properties.hash ?? sha256Base64Sync(properties.bytes);
            this.id = `chunk:${this.hash}`;
            this.bytes = properties.bytes;
        }
    }
}

/**
 * One immutable content state of a file node. Location lives in naming
 * events only.
 */
@variant("shared_fs_file_version")
export class FileVersion extends SharedFsEntry {
    kind: SharedFsEntryKind = "file-version";

    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    nodeId: string;

    @field({ type: "string" })
    parentVersionIdsJson: string;

    /**
     * Author-asserted causal depth: 1 + max(depth of locally-present
     * parents). Winner selection reads this STORED depth so retiring
     * ancestors can never change the visible head on any peer.
     */
    @field({ type: "u64" })
    causalDepth: bigint;

    @field({ type: "string" })
    contentHash: string;

    @field({ type: "u64" })
    size: bigint;

    @field({ type: "string" })
    chunkIdsJson: string;

    /** Wall clock, display only — never part of winner selection. */
    @field({ type: "u64" })
    createdAt: bigint;

    @field({ type: "string" })
    authorKey: string;

    @field({ type: "string" })
    machineLabel: string;

    @field({ type: "bool" })
    conflictResolution: boolean;

    /**
     * Optional write-set identity: every version applied by one writeBatch
     * carries the same changesetId, giving callers a queryable commit-like
     * handle over multi-file changes.
     */
    @field({ type: option("string") })
    changesetId?: string;

    constructor(properties?: {
        id: string;
        nodeId: string;
        parentVersionIds?: string[];
        causalDepth: bigint | number;
        contentHash: string;
        size: bigint | number;
        chunkIds: string[];
        createdAt: bigint | number;
        authorKey: string;
        machineLabel: string;
        conflictResolution?: boolean;
        changesetId?: string;
    }) {
        super();
        if (properties) {
            this.id = properties.id;
            this.nodeId = properties.nodeId;
            this.parentVersionIds = properties.parentVersionIds ?? [];
            this.causalDepth = BigInt(properties.causalDepth);
            this.contentHash = properties.contentHash;
            this.size = BigInt(properties.size);
            this.chunkIds = properties.chunkIds;
            this.createdAt = BigInt(properties.createdAt);
            this.authorKey = properties.authorKey;
            this.machineLabel = properties.machineLabel;
            this.conflictResolution = properties.conflictResolution ?? false;
            this.changesetId = properties.changesetId;
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

export type FileHead = FileVersion;

export const isFileHead = (entry: SharedFsEntry): entry is FileHead =>
    entry instanceof FileVersion;
