import { field, fixedArray, option, variant, vec } from "@dao-xyz/borsh";
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
    | "naming"
    | "file-version"
    | "file-chunk"
    | "bootstrap-manifest"
    | "changeset-manifest";

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
        } else if (value instanceof BootstrapManifest) {
            // Explicit, NOT the value.kind fallback: `kind` on the class is
            // a plain initializer, which borsh bypasses on deserialization
            // — a replicated manifest would index as kind undefined (the
            // row insert throws), leaving other authors' manifests
            // invisible to every kind query on non-author replicas.
            this.kind = "bootstrap-manifest";
        } else if (value instanceof ChangesetManifest) {
            this.kind = "changeset-manifest";
            // NOTE: authorKey is ADVISORY attribution on naming/version rows
            // but AUTHENTICATED here — canPerform enforces equality with the
            // manifest's inner signature before the row exists.
            this.changesetId = value.changesetId;
            this.authorKey = value.authorKey;
            this.createdAt = value.createdAtWallMs;
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

// ---------------------------------------------------------------------
// Cold-start bootstrap snapshots
// ---------------------------------------------------------------------

export const SNAPSHOT_FORMAT_VERSION = 1;

/** One content-addressed snapshot shard in the block store. */
export class SegmentRef {
    /** Block-store CID of the serialized SnapshotSegment. */
    @field({ type: "string" })
    cid: string;

    /**
     * sha256 (base64) of the segment bytes, bound by the manifest
     * signature — a joiner re-hashes what it fetched and never trusts the
     * transport or the CID computation alone.
     */
    @field({ type: "string" })
    sha256: string;

    @field({ type: "u32" })
    docCount: number;

    @field({ type: "u64" })
    byteLength: bigint;

    constructor(properties?: {
        cid: string;
        sha256: string;
        docCount: number;
        byteLength: bigint | number;
    }) {
        if (properties) {
            this.cid = properties.cid;
            this.sha256 = properties.sha256;
            this.docCount = properties.docCount;
            this.byteLength = BigInt(properties.byteLength);
        }
    }
}

export class SnapshotCounts {
    @field({ type: "u64" })
    nodes: bigint;

    @field({ type: "u64" })
    docs: bigint;

    @field({ type: "u64" })
    bytes: bigint;

    constructor(properties?: {
        nodes: bigint | number;
        docs: bigint | number;
        bytes: bigint | number;
    }) {
        if (properties) {
            this.nodes = BigInt(properties.nodes);
            this.docs = BigInt(properties.docs);
            this.bytes = BigInt(properties.bytes);
        }
    }
}

/**
 * The signed body of a bootstrap manifest: which segments make up one
 * head-state snapshot of the filesystem. Contains no log heads — a
 * joiner's convergence is tracked per document, not against prunable log
 * state.
 */
export class SnapshotManifestPayload {
    @field({ type: "u32" })
    formatVersion: number;

    /** The program id (salt input): binds a manifest to one filesystem. */
    @field({ type: fixedArray("u8", 32) })
    storeId: Uint8Array;

    /** Per-author monotonic sequence; meaningless across authors. */
    @field({ type: "u64" })
    snapshotSeq: bigint;

    /** Wall clock at materialization; ranks candidates across authors. */
    @field({ type: "u64" })
    createdAtWallMs: bigint;

    @field({ type: SnapshotCounts })
    counts: SnapshotCounts;

    @field({ type: vec(SegmentRef) })
    segments: SegmentRef[];

    /**
     * The publisher's effective artifact-ignore pattern list at
     * publication time — ADVISORY: a joiner installs it into its local
     * matcher for the bootstrap window (before /.artifactignore is
     * readable) and it only ever influences local write/view behavior,
     * never document acceptance, GC, or resurrection.
     */
    @field({ type: option(vec("string")) })
    advisoryIgnorePatterns?: string[];

    constructor(properties?: {
        storeId: Uint8Array;
        snapshotSeq: bigint | number;
        createdAtWallMs: bigint | number;
        counts: SnapshotCounts;
        segments: SegmentRef[];
        advisoryIgnorePatterns?: string[];
    }) {
        if (properties) {
            this.formatVersion = SNAPSHOT_FORMAT_VERSION;
            this.storeId = properties.storeId;
            this.snapshotSeq = BigInt(properties.snapshotSeq);
            this.createdAtWallMs = BigInt(properties.createdAtWallMs);
            this.counts = properties.counts;
            this.segments = properties.segments;
            this.advisoryIgnorePatterns = properties.advisoryIgnorePatterns;
        }
    }
}

/**
 * One snapshot shard: full naming/version HEAD documents (deletes
 * included, never chunks), reusing the exact variant-tagged classes and
 * decoder used everywhere else. Serialized standalone into the block
 * store; unchanged shards re-serialize to identical bytes and dedup
 * across snapshots.
 */
export class SnapshotSegment {
    @field({ type: "u32" })
    formatVersion: number;

    @field({ type: vec(SharedFsEntry) })
    entries: SharedFsEntry[];

    constructor(properties?: { entries: SharedFsEntry[] }) {
        if (properties) {
            this.formatVersion = SNAPSHOT_FORMAT_VERSION;
            this.entries = properties.entries;
        }
    }
}

/**
 * A signed pointer to the newest snapshot, published as an ordinary
 * document (one per author, superseded in place). The inner signature
 * covers payloadBytes, so a joiner verifies the snapshot against its OWN
 * trust graph without trusting whichever peer served the document.
 */
@variant("shared_fs_bootstrap_manifest")
export class BootstrapManifest extends SharedFsEntry {
    kind: SharedFsEntryKind = "bootstrap-manifest";

    /** "bootstrap:" + the author key encoding the signature must match. */
    @field({ type: "string" })
    id: string;

    /** Serialized SnapshotManifestPayload. */
    @field({ type: Uint8Array })
    payloadBytes: Uint8Array;

    /** Serialized SignatureWithKey over payloadBytes. */
    @field({ type: Uint8Array })
    signatureBytes: Uint8Array;

    constructor(properties?: {
        id: string;
        payloadBytes: Uint8Array;
        signatureBytes: Uint8Array;
    }) {
        super();
        if (properties) {
            this.id = properties.id;
            this.payloadBytes = properties.payloadBytes;
            this.signatureBytes = properties.signatureBytes;
        }
    }
}

export const CHANGESET_MANIFEST_FORMAT_VERSION = 1;

/**
 * The exact membership of one write-set (turn): the ids of every member
 * document a reader must observe admitted before the turn is complete on
 * its replica. Member ids are 32 unguessable random bytes bound under the
 * inner signature — no other writer can satisfy or extend a manifest-scoped
 * barrier.
 */
export class ChangesetManifestPayload {
    @field({ type: "u32" })
    formatVersion: number;

    /** Program id: binds the manifest to one filesystem (no replay). */
    @field({ type: fixedArray("u8", 32) })
    storeId: Uint8Array;

    /** The write-set identity; 1..256 chars. */
    @field({ type: "string" })
    changesetId: string;

    /** Writer wall clock at commit; ingest-bounded to <= now + 1h skew. */
    @field({ type: "u64" })
    createdAtWallMs: bigint;

    /**
     * Raw 32-byte suffixes of member FileVersion ids ("version:<b64url>"),
     * in commit order; adopted satisfier ids appended.
     */
    @field({ type: vec(fixedArray("u8", 32)) })
    versionMembers: Uint8Array[];

    /**
     * Raw 32-byte suffixes of member NamingEvent ids ("naming:<b64url>"),
     * order: created dirs, creates, deletes last; adopted ids appended.
     */
    @field({ type: vec(fixedArray("u8", 32)) })
    namingMembers: Uint8Array[];

    /**
     * sha256 over (0x01 || versionMembers || 0x02 || namingMembers) in
     * payload order — comparison anchor; the signature binds the lists.
     */
    @field({ type: fixedArray("u8", 32) })
    membershipDigest: Uint8Array;

    constructor(properties?: {
        storeId: Uint8Array;
        changesetId: string;
        createdAtWallMs: bigint;
        versionMembers: Uint8Array[];
        namingMembers: Uint8Array[];
        membershipDigest: Uint8Array;
    }) {
        this.formatVersion = CHANGESET_MANIFEST_FORMAT_VERSION;
        if (properties) {
            this.storeId = properties.storeId;
            this.changesetId = properties.changesetId;
            this.createdAtWallMs = properties.createdAtWallMs;
            this.versionMembers = properties.versionMembers;
            this.namingMembers = properties.namingMembers;
            this.membershipDigest = properties.membershipDigest;
        } else {
            this.versionMembers = [];
            this.namingMembers = [];
        }
    }
}

/**
 * One write-set's membership record, published as an ordinary document —
 * content-addressed (id = hash of the payload) and inner-signed, so
 * authorKey on THIS kind is authenticated, unlike the advisory authorKey
 * on naming/version documents.
 */
@variant("shared_fs_changeset_manifest")
export class ChangesetManifest extends SharedFsEntry {
    kind: SharedFsEntryKind = "changeset-manifest";

    /** "changeset-manifest:" + sha256Base64(payloadBytes) — self-certifying. */
    @field({ type: "string" })
    id: string;

    /** Index mirror of payload.changesetId (canPerform enforces equality). */
    @field({ type: "string" })
    changesetId: string;

    /** Index mirror of the inner signer (canPerform enforces equality). */
    @field({ type: "string" })
    authorKey: string;

    /** Index mirror of payload.createdAtWallMs (canPerform enforces equality). */
    @field({ type: "u64" })
    createdAtWallMs: bigint;

    /** Serialized ChangesetManifestPayload. */
    @field({ type: Uint8Array })
    payloadBytes: Uint8Array;

    /** Serialized SignatureWithKey over payloadBytes. */
    @field({ type: Uint8Array })
    signatureBytes: Uint8Array;

    constructor(properties?: {
        id: string;
        changesetId: string;
        authorKey: string;
        createdAtWallMs: bigint;
        payloadBytes: Uint8Array;
        signatureBytes: Uint8Array;
    }) {
        super();
        if (properties) {
            this.id = properties.id;
            this.changesetId = properties.changesetId;
            this.authorKey = properties.authorKey;
            this.createdAtWallMs = properties.createdAtWallMs;
            this.payloadBytes = properties.payloadBytes;
            this.signatureBytes = properties.signatureBytes;
        }
    }
}
