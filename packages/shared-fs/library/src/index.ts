import {
    deserialize,
    field,
    option,
    serialize,
    variant,
    vec,
} from "@dao-xyz/borsh";
import {
    type PublicSignKey,
    PublicSignKey as PublicSignKeyType,
    SignatureWithKey,
    fromBase64,
    randomBytes,
    sha256Base64Sync,
    sha256Sync,
    toBase64,
    fromBase64URL,
    toBase64URL,
    verify,
} from "@peerbit/crypto";
import {
    Compare,
    Documents,
    IntegerCompare,
    NotFoundError,
    Or,
    StringMatch,
    type Query,
} from "@peerbit/document";
import { Program } from "@peerbit/program";
import { TrustedNetwork } from "@peerbit/trusted-network";
import { concat, fromString } from "uint8arrays";
import type { Peerbit } from "peerbit";
import {
    BootstrapManifest,
    CHANGESET_MANIFEST_FORMAT_VERSION,
    ChangesetManifest,
    ChangesetManifestPayload,
    FileChunk,
    FileVersion,
    IndexableSharedFsEntry,
    NamingEvent,
    SegmentRef,
    SharedFsEntry,
    SnapshotCounts,
    SnapshotManifestPayload,
    SnapshotSegment,
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
import { compileIgnoreRules } from "./ignore/patterns.js";
import { IgnorePolicyEngine, type IgnorePolicy } from "./ignore/policy.js";
import {
    WatchHub,
    type FsWatcher,
    type FsWatchOptions,
    type WatchHost,
} from "./watch.js";
import {
    ChangesetBarrierHub,
    type AwaitChangesetOptions,
    type ChangesetHost,
    type ChangesetStatus,
    type ChangesetWatcher,
} from "./changeset.js";

export * from "./model.js";
export {
    type FsWatcher,
    type FsWatchOptions,
    type FsWatchEvent,
    type FsWatchEventType,
    type FsWatchCause,
} from "./watch.js";
export {
    type AwaitChangesetOptions,
    type ChangesetEvent,
    type ChangesetManifestStatus,
    type ChangesetStatus,
    type ChangesetVerdict,
    type ChangesetWatcher,
} from "./changeset.js";
export * from "./ignore/patterns.js";
export * from "./ignore/policy.js";
// Value imported dynamically in openSharedFs: the wrapper extends
// SharedFsHandle, so an eager re-export would evaluate it before this
// module finishes defining the base class.
export type { IgnoreAwareFs } from "./ignore/ignore-fs.js";
export * from "./benchmark.js";
export * from "./ipc.js";
export * from "./mount-backend.js";
export * from "./native-mount.js";
export * from "./path.js";

/**
 * Re-export the Peerbit client so embedders (including the CLI) construct the
 * client from the same physical module graph as the filesystem program.
 * Hoisted installs can otherwise give the client and the program separate
 * copies of the same @peerbit/* versions, whose message classes fail identity
 * checks — peers then connect but never exchange replication info.
 */
export { Peerbit } from "peerbit";

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

/** Number of node ids per batched history query. */
const HEAD_QUERY_BATCH = 64;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Garbage-collection defaults. Every window has a floor of hours by design;
 * the dangerous clock-skew direction (a fast GC clock) is bounded by the
 * smallest of these windows.
 */
const GC_DEFAULTS = {
    keepVersions: 10,
    retentionMs: 30 * DAY_MS,
    graceMs: 3 * DAY_MS,
    chunkGraceMs: 1 * DAY_MS,
    namingGraceMs: 14 * DAY_MS,
    settleMs: 5_000,
    minOrphanSpanMs: 60 * 60 * 1000,
} as const;

/**
 * Writers may skip re-putting a chunk only when a version referencing it is
 * younger than this horizon: such a witness version cannot be retired by any
 * peer for at least retentionMs − skipHorizonMs, so the chunk's refcount
 * stays above zero everywhere while the new version propagates.
 */
const DEFAULT_SKIP_HORIZON_MS = GC_DEFAULTS.retentionMs / 2;

/** TTL for in-process version pins taken by reads and versions(). */
const GC_PIN_TTL_MS = 60_000;

export type GcOptions = {
    /** Newest versions always kept per node. Default 10. */
    keepVersions?: number;
    /** Versions younger than this are always kept. Default 30 days. */
    retentionMs?: number;
    /** Nothing is retired unless causally superseded for this long. Default 3 days. */
    graceMs?: number;
    /** Unreferenced chunks must be at least this old. Default 1 day. */
    chunkGraceMs?: number;
    /** Naming events compact only when every head is older. Default 14 days. */
    namingGraceMs?: number;
    /** Settle wait before re-validating the plan. Default 5 s. */
    settleMs?: number;
    /** Minimum span between recording and executing chunk/purge candidates. Default 1 h. */
    minOrphanSpanMs?: number;
    /**
     * "ledger" (default): chunks and purges are recorded on one run and
     * executed on a later run after minOrphanSpanMs — the barrier that makes
     * a freshly-bootstrapped or long-offline runner collect nothing until
     * replication has settled. "immediate" collapses the barrier (tests /
     * operators who know the replica is warm; Guard D still backstops it).
     */
    chunkSweep?: "ledger" | "immediate";
    /** Restrict version/naming retirement to paths under this prefix. */
    scope?: string;
    /** Plan and report without mutating anything. */
    dryRun?: boolean;
    /** Injected clock for tests. */
    nowMs?: number;
};

export type GcReport = {
    dryRun: boolean;
    healedChunks: number;
    damagedNodeIds: string[];
    retiredVersions: number;
    compactedNamingEvents: number;
    purgedNodes: number;
    deletedChunks: number;
    reclaimedChunkBytes: bigint;
    chunkCandidatesRecorded: number;
    purgeCandidatesRecorded: number;
    conflictedNodes: number;
    cutRecoveries: number;
    /** Changeset manifests retired by local arrival age. */
    manifestsRetired: number;
    warnings: string[];
};

type GcLedger = {
    chunkCandidates: Record<string, { firstSeenMs: number }>;
    purgeCandidates: Record<
        string,
        { firstSeenMs: number; winnerEventId: string }
    >;
    lastRunMs: number;
};

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
    /** Injected clock (ms). Tests use this to control GC windows. */
    clock?: () => number;
    /**
     * Dedup-skip witness horizon: a chunk put may be skipped only when a
     * version younger than this references it. Smaller horizons enable
     * shorter GC retention (retention is clamped to horizon + grace) at the
     * cost of more re-puts. All writers of a filesystem should use the same
     * value. Default 15 days; floor 5 minutes.
     */
    dedupSkipHorizonMs?: number;
    /**
     * Cold-start bootstrap behavior when opening an existing filesystem
     * with an empty local store. "auto" (default): fetch and verify the
     * newest trusted snapshot, serve reads from it immediately, and
     * converge to a normal full replica in the background — falling back
     * silently to a plain join on any failure. "require" throws instead of
     * falling back. "off" (or false) keeps today's plain join.
     */
    bootstrap?: false | "auto" | BootstrapOptions;
    /** Snapshot publication policy for trusted full replicas. */
    snapshot?: SnapshotPublishOptions;
};

export type BootstrapOptions = {
    mode?: "auto" | "require" | "off";
    /** Reject snapshots older than this (default 2h). */
    maxSnapshotAgeMs?: number;
    /** How long to look for (and verify) manifest candidates (default 5s). */
    discoveryTimeoutMs?: number;
    segmentFetchConcurrency?: number;
    /**
     * How long the read-through overlay may wait for per-document
     * convergence before retiring unverified (default 15min).
     */
    retirementTimeoutMs?: number;
};

export type SnapshotPublishOptions = {
    /** Periodic publication interval for trusted full replicas (default 30min). */
    publishIntervalMs?: number;
    /** Skip a scheduled publication when fewer documents changed (default 50). */
    minChangesBetween?: number;
    /** Disable automatic publication (snapshotWrite() stays available). */
    disabled?: boolean;
};

export type BootstrapPhase =
    | "off"
    | "fetching"
    | "overlay-active"
    | "converged"
    | "unverified";

export type BootstrapStatus = {
    phase: BootstrapPhase;
    manifest?: {
        authorKey: string;
        snapshotSeq: bigint;
        createdAtWallMs: bigint;
        ageMs: number;
        docs: bigint;
    };
    /** Snapshot documents not yet covered by arrival/removal/supersession. */
    pendingDocs: number;
    guardArmed: boolean;
    /** Why the last bootstrap fell back to a plain join, when it did. */
    lastFailure?: string;
    /**
     * Milliseconds since the last document arrival (Infinity when none
     * yet); a settle signal for callers that need a quiet store.
     */
    msSinceLastArrival: number;
};

export type SnapshotWriteResult = {
    snapshotSeq: bigint;
    createdAtWallMs: bigint;
    nodes: bigint;
    docs: bigint;
    bytes: bigint;
    segments: number;
    manifestId: string;
};

/**
 * Thrown by whole-store conflict/changeset queries while a bootstrap
 * overlay is active: those scans bypass the overlay's read points and
 * would otherwise report a different world than the tree view. Pass
 * `{ allowPartial: true }` to accept partial-index results.
 */
export class BootstrapPendingError extends Error {
    constructor(operation: string) {
        super(
            `${operation} is unavailable while the cold-start bootstrap overlay is active; pass { allowPartial: true } for partial-index results or await bootstrap convergence`
        );
    }
}

export type OpenSharedFsOptions = SharedFsOpenArgs & {
    peerbit: Peerbit;
    address?: string | unknown;
    id?: Uint8Array;
    directory?: string;
    rootKey?: PublicSignKey;
    /**
     * Sealed ingest-tier artifact-ignore directory names for NEWLY
     * CREATED filesystems (immutable once created; ignored when opening
     * an existing address). Defaults to DEFAULT_SEALED_IGNORED_NAMES.
     */
    sealedIgnoredNames?: string[];
    /**
     * Tier 1 artifact-ignore policy for this open handle. When set, the
     * returned handle enforces writes (reject mode) and filters views;
     * the shared store itself never consults these rules.
     */
    ignore?: IgnorePolicy;
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
    /**
     * True when this node's naming has unresolved concurrent assertions
     * (multiple naming heads) or the path slot has shadowed claimants.
     */
    namingConflict?: boolean;
    /**
     * Set by the artifact-ignore layer: this entry exists in the SHARED
     * store although the effective local policy ignores its path (written
     * by a peer without the rule, or before the rule existed).
     */
    ignoredLeak?: boolean;
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
    /** @deprecated Deletion lives in naming events now; always false. */
    deleted: boolean;
    head: boolean;
};

export type SharedFsConflict = {
    path: string;
    nodeId: string;
    versions: SharedFsVersionInfo[];
};

export type SharedFsNamingConflict = {
    type: "multi-head" | "duplicate-name" | "delete-vs-edit" | "unreachable";
    /** Node the conflict is on (for duplicate-name: the visible winner). */
    nodeId: string;
    /** Best-effort path (former path for deleted/unreachable nodes). */
    path: string;
    /** For duplicate-name: shadowed claimant node ids (losers). */
    shadowedNodeIds?: string[];
    /** Naming head event ids involved. */
    eventIds: string[];
    /** For delete-vs-edit: content versions the delete did not observe. */
    recoverableVersionIds?: string[];
};

export type ResolveNamingAction =
    | { type: "keep" }
    | { type: "restore" }
    | { type: "delete" }
    | { type: "move"; to: string };

export type WriteFileOptions = {
    /**
     * Allows callers that observed an older base to publish a concurrent version.
     * Normal writes should leave this undefined so the current visible heads are
     * used as parents.
     */
    baseVersionIds?: string[];
    chunkSize?: number;
    /**
     * "verify" (default): dedup-skip a chunk only when a fresh witness
     * version references it, and re-verify presence after the version lands.
     * "off": always re-put every chunk (partition-proof mode).
     */
    dedup?: "verify" | "off";
};

export type WriteBatchEntry =
    | {
          path: string;
          content: Uint8Array | string;
          chunkSize?: number;
      }
    /**
     * File-only: deleting a directory throws EISDIR (use rmdir/rm), and a
     * path that does not resolve to a file is a no-op (idempotent deletes).
     */
    | { path: string; delete: true };

export type WriteBatchOptions = {
    /**
     * Identity (1-256 chars) recorded on every version and naming event
     * this batch applies; queryable afterwards via versionsByChangeset.
     * Generated when omitted. Reusing an id — in later batches, or from
     * another peer — appends to the same logical changeset: the identity is
     * advisory attribution among trusted writers, not authenticated, so
     * callers that need their own writes only must filter the returned
     * versions by authorKey.
     */
    changesetId?: string;
    dedup?: "verify" | "off";
    /**
     * Artifact-ignore behavior for batch entries (consumed by the ignore
     * layer): "reject" (default) fails the whole batch on the first
     * ignored entry; "skip" drops ignored entries and reports them in
     * WriteBatchResult.skipped.
     */
    onIgnored?: "reject" | "skip";
    /**
     * Publish a changeset manifest recording this batch's exact membership
     * (committed AFTER every member document), enabling awaitChangeset /
     * changesetStatus / watchChangesets on every replica. Default false.
     */
    manifest?: boolean;
};

export type WriteBatchResult = {
    changesetId: string;
    /**
     * Present iff options.manifest: the admitted manifest and its member
     * count. memberCount === 0 means the batch required no propagation
     * (the barrier completes immediately everywhere); it certifies only
     * that, never prior batches' propagation.
     */
    manifest?: { manifestId: string; memberCount: number };
    /**
     * Entries dropped by the artifact-ignore layer under
     * `onIgnored: "skip"` — explicit, never conflated with the undefined
     * no-op slots in `results`.
     */
    skipped?: { index: number; path: string; rule?: string }[];
    /**
     * Per input entry, in order: the resulting version info for writes, or
     * undefined for an applied delete, a delete whose path resolved to
     * nothing, and a no-op write over unchanged content. Entries reflect
     * the pre-commit snapshot: under concurrent writes to the same nodes,
     * head:true is best-effort — conflicts surface via versions() and
     * namingConflicts().
     */
    results: (SharedFsVersionInfo | undefined)[];
};

export type SharedFsErrorCode =
    | "ENOENT"
    | "EEXIST"
    | "EISDIR"
    | "ENOTDIR"
    | "ENOTEMPTY"
    | "EINVAL"
    | "EIO"
    /** The path is artifact-ignored by the effective policy. */
    | "EIGNORED"
    /** The operation crosses an artifact-ignore boundary. */
    | "EXDEV"
    /** A watch subscription's materialized view exceeded its node budget. */
    | "EWATCHLIMIT"
    /** An awaited operation exceeded its timeout. */
    | "ETIMEDOUT"
    /** The store closed while an awaited operation was pending. */
    | "ECLOSED";

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

type ResolvedPath =
    | { kind: "root"; nodeId: typeof ROOT_NODE_ID; path: "/" }
    | {
          kind: "directory" | "file";
          nodeId: string;
          winner: NamingLike;
          state: NodeNamingState;
          /** True when other claimants are shadowed at this path slot. */
          contested: boolean;
          path: string;
      };

const now = () => BigInt(Date.now());

const createId = (prefix: string) =>
    `${prefix}:${toBase64URL(randomBytes(32))}`;

const nodeKindOf = (nodeId: string): "directory" | "file" =>
    nodeId.startsWith("dir:") ? "directory" : "file";

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

/**
 * Convergence-relevant string order: plain code-unit comparison (ids are
 * ASCII, so this equals byte order and is identical on every platform —
 * unlike localeCompare, which is banned from winner logic).
 */
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const compareBigint = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

const maxDepth = (parents: { causalDepth: bigint }[]): bigint => {
    let max = 0n;
    for (const parent of parents) {
        if (parent.causalDepth > max) {
            max = parent.causalDepth;
        }
    }
    return 1n + max;
};

/**
 * Heads and depths of a causal DAG restricted to the locally present
 * document set. References to absent ids are ignored, and reference cycles
 * (malformed documents) are treated as absent edges — both keep the result a
 * pure, order-independent function of the replicated set.
 */
const computeDag = <T extends { id: string }>(
    docs: T[],
    parentsOf: (doc: T) => string[]
): { heads: T[]; depths: Map<string, number> } => {
    const byId = new Map(docs.map((doc) => [doc.id, doc]));
    const referenced = new Set<string>();
    for (const doc of docs) {
        for (const parent of parentsOf(doc)) {
            if (byId.has(parent)) {
                referenced.add(parent);
            }
        }
    }
    const heads = docs.filter((doc) => !referenced.has(doc.id));
    const depths = new Map<string, number>();
    const visiting = new Set<string>();
    const depthOf = (doc: T): number => {
        const memo = depths.get(doc.id);
        if (memo !== undefined) {
            return memo;
        }
        if (visiting.has(doc.id)) {
            // Back-edge from a malformed reference; treat as absent.
            return 0;
        }
        visiting.add(doc.id);
        let depth = 1;
        for (const parentId of parentsOf(doc)) {
            const parent = byId.get(parentId);
            if (parent) {
                depth = Math.max(depth, 1 + depthOf(parent));
            }
        }
        visiting.delete(doc.id);
        depths.set(doc.id, depth);
        return depth;
    };
    for (const doc of docs) {
        depthOf(doc);
    }
    return { heads, depths };
};

/**
 * Structural shapes served straight from index rows. Both the full borsh
 * documents and the resolve:false rows satisfy them, so every naming/head
 * computation runs on whichever the caller has — hot paths use rows and
 * never resolve documents.
 */
type NamingLike = {
    id: string;
    nodeId: string;
    parentId: string;
    name: string;
    deleted: boolean;
    causalDepth: bigint;
    createdAt: bigint;
    parentNamingIds: string[];
    authorKey?: string;
    machineLabel?: string;
    changesetId?: string;
};

type VersionLike = {
    id: string;
    nodeId: string;
    causalDepth: bigint;
    createdAt: bigint;
    size: bigint;
    contentHash?: string;
    parentVersionIds: string[];
    authorKey?: string;
    machineLabel?: string;
    changesetId?: string;
};

const namingRowOf = (raw: any): NamingLike => ({
    id: raw.id,
    nodeId: raw.nodeId,
    parentId: raw.parentId,
    name: raw.name,
    deleted: raw.deleted,
    causalDepth: BigInt(raw.causalDepth ?? 0),
    createdAt: BigInt(raw.createdAt ?? 0),
    // Index rows carry causalRefs; full documents carry parentNamingIds.
    parentNamingIds: raw.causalRefs ?? raw.parentNamingIds ?? [],
    authorKey: raw.authorKey,
    machineLabel: raw.machineLabel,
    changesetId: raw.changesetId,
});

const versionRowOf = (raw: any): VersionLike => ({
    id: raw.id,
    nodeId: raw.nodeId,
    causalDepth: BigInt(raw.causalDepth ?? 0),
    createdAt: BigInt(raw.createdAt ?? 0),
    size: BigInt(raw.size ?? 0),
    contentHash: raw.contentHash,
    // Index rows carry causalRefs; full documents carry parentVersionIds.
    parentVersionIds: raw.causalRefs ?? raw.parentVersionIds ?? [],
    authorKey: raw.authorKey,
    machineLabel: raw.machineLabel,
    changesetId: raw.changesetId,
});

type NodeNamingState = {
    nodeId: string;
    events: NamingLike[];
    heads: NamingLike[];
    winner: NamingLike;
    depths: Map<string, number>;
    /** Multiple heads with genuinely different payloads. */
    conflicted: boolean;
};

/** One served child of a directory: the slot winner plus, for files, its
 *  content heads — the shared output of the list()/watch winner pipeline. */
type SlotChildRecord = {
    name: string;
    nodeId: string;
    kind: "directory" | "file";
    state: NodeNamingState;
    contested: boolean;
    heads?: VersionLike[];
};

/** A resolved path plus the slot chain that produced it. */
type ResolvedPathDetailed = {
    resolved: ResolvedPath;
    spine: { parentId: string; name: string; nodeId: string }[];
};

const samePayload = (a: NamingLike, b: NamingLike) =>
    a.parentId === b.parentId && a.name === b.name && a.deleted === b.deleted;

const computeNamingState = (
    nodeId: string,
    events: NamingLike[]
): NodeNamingState | undefined => {
    if (events.length === 0) {
        return undefined;
    }
    const { heads, depths } = computeDag(
        events,
        (event) => event.parentNamingIds
    );
    // Winner order reads the STORED causalDepth (author-asserted, validated
    // ≥1 at ingest), not the locally computed depth: deleting (compacting)
    // ancestors must never change winners on any peer.
    const sorted = [...heads].sort((a, b) => {
        const depthDiff = compareBigint(b.causalDepth, a.causalDepth);
        if (depthDiff !== 0) {
            return depthDiff;
        }
        // Data-preserving bias: a non-delete head beats a delete head.
        if (a.deleted !== b.deleted) {
            return a.deleted ? 1 : -1;
        }
        return compareIds(a.id, b.id);
    });
    const winner = sorted[0];
    const conflicted =
        sorted.length > 1 && !sorted.every((head) => samePayload(head, winner));
    return { nodeId, events, heads: sorted, winner, depths, conflicted };
};

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

const VALID_NAME = (name: string) =>
    name.length > 0 && !name.includes("/") && name !== "." && name !== "..";

const decodesToStringArray = (value: string) => {
    try {
        const parsed = JSON.parse(value);
        return (
            Array.isArray(parsed) &&
            parsed.every((item) => typeof item === "string")
        );
    } catch {
        return false;
    }
};

// Enforced at ingest, not just in writeBatch: the cap bounds the indexed
// scalar column against remote writers, and "" would be a queryable
// non-value.
const validChangesetId = (value: string | undefined) =>
    value === undefined || (value.length > 0 && value.length <= 256);

/** How long a negative trust verdict may be served from cache. */
const TRUST_NEGATIVE_TTL_MS = 1000;

/**
 * Default sealed artifact-ignore directory names. Deliberately minimal:
 * sealing is irreversible per store, and names like "build" or "dist"
 * are common legitimate directories — those belong in the mutable
 * Tier 1 starter patterns instead.
 */
export const DEFAULT_SEALED_IGNORED_NAMES: readonly string[] = ["node_modules"];

/** Names under this prefix are reserved for control surfaces (mount). */
const RESERVED_NAME_PREFIX = ".peerbit-";

// ---------------------------------------------------------------------
// Cold-start bootstrap constants
// ---------------------------------------------------------------------

const SNAPSHOT_MAX_SEGMENT_COUNT = 256;
const SNAPSHOT_TARGET_SEGMENT_BYTES = 384_000;
const SNAPSHOT_EST_DOC_BYTES = 384;
const MANIFEST_PAYLOAD_CAP_BYTES = 100_000;
/** Members per changeset manifest, versions+naming combined. 12k x 36B is
 *  ~432KB payload — under the 512KiB chunk envelope, the largest document
 *  the store demonstrably ships. A manifest:true batch above this throws
 *  EINVAL before anything is put. */
const CHANGESET_MANIFEST_MAX_MEMBERS = 12_000;
const CHANGESET_MANIFEST_PAYLOAD_CAP_BYTES = 460_800; // 450 KiB
/** Future-dated createdAtWallMs bound at ingest: a forged future stamp can
 *  neither dodge the GC sweep indefinitely nor stall the historic verdict
 *  beyond this skew. */
const CHANGESET_MANIFEST_MAX_CLOCK_SKEW_MS = 3_600_000; // 1h
/** Adoption horizon: no-op satisfiers younger than this are adopted into
 *  membership (48h = the GC grace floor, so adopted ids are unretirable on
 *  every conforming replica); older satisfiers are settled pre-history. */
const CHANGESET_ADOPTION_HORIZON_MS = 172_800_000; // 48h
const BOOTSTRAP_DEFAULTS = {
    maxSnapshotAgeMs: 2 * 60 * 60 * 1000,
    discoveryTimeoutMs: 5_000,
    segmentFetchConcurrency: 16,
    retirementTimeoutMs: 15 * 60 * 1000,
};
const SNAPSHOT_DEFAULTS = {
    publishIntervalMs: 30 * 60 * 1000,
    minChangesBetween: 50,
};
/** Overlay supersession sweep cadence while bootstrap is active. */
const SUPERSESSION_SWEEP_MS = 5_000;
/** Double-check delay before verified retirement (one guard-coalescing window). */
const RETIRE_DOUBLE_CHECK_MS = 300;
/** Post-timeout arming: no arrivals for this long counts as quiescent... */
const QUIESCENCE_WINDOW_MS = 60_000;
/** ...on two consecutive checks this far apart. */
const QUIESCENCE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
    a.byteLength === b.byteLength && a.every((value, i) => value === b[i]);

/**
 * Structural, state-independent document validation shared by ingest
 * (canPerform) and bootstrap segment installation: acceptance must never
 * depend on replication order or local history.
 */
const structurallyValidEntry = (value: SharedFsEntry): boolean => {
    if (value instanceof FileChunk) {
        // Content-addressed chunks are self-certifying: the bytes must
        // hash to the id, regardless of who signed the entry.
        const hash = sha256Base64Sync(value.bytes);
        return hash === value.hash && value.id === `chunk:${hash}`;
    }
    if (value instanceof NamingEvent) {
        return (
            value.id.startsWith("naming:") &&
            (value.nodeId.startsWith("dir:") ||
                value.nodeId.startsWith("file:")) &&
            (value.parentId === ROOT_NODE_ID ||
                value.parentId.startsWith("dir:")) &&
            VALID_NAME(value.name) &&
            // Reserved control-surface names never enter the shared tree
            // (the mount virtualizes them; a store entry would shadow).
            !value.name.startsWith(RESERVED_NAME_PREFIX) &&
            decodesToStringArray(value.parentNamingIdsJson) &&
            decodesToStringArray(value.observedContentHeadsJson) &&
            value.causalDepth >= 1n &&
            validChangesetId(value.changesetId)
        );
    }
    if (value instanceof FileVersion) {
        return (
            value.id.startsWith("version:") &&
            value.nodeId.startsWith("file:") &&
            value.causalDepth >= 1n &&
            validChangesetId(value.changesetId)
        );
    }
    return true;
};

@variant("peerbit_shared_fs")
export class SharedFileSystem extends Program<SharedFsOpenArgs> {
    @field({ type: Uint8Array })
    id: Uint8Array;

    @field({ type: Documents })
    entries: Documents<SharedFsEntry, IndexableSharedFsEntry>;

    @field({ type: option(TrustedNetwork) })
    trustGraph?: TrustedNetwork;

    /**
     * Sealed artifact-ignore tier: DIRECTORY basenames rejected at ingest
     * on every peer. Part of the serialized program — and therefore of
     * the store address — so the list is immutable and identical
     * everywhere forever: acceptance stays independent of replication
     * order and local history. Changing it means a new filesystem.
     * File nodes with these names stay legal (only directories are
     * banned); everything mutable lives in the Tier 1 policy layer.
     */
    @field({ type: vec("string") })
    sealedIgnoredNames: string[];

    machineLabel = "unknown-machine";
    replicate: OpenReplicateOptions | undefined;
    remoteChunkFetch: { timeoutMs: number } | false = {
        timeoutMs: REMOTE_CHUNK_FETCH_TIMEOUT_MS,
    };
    clock: () => number = Date.now;
    skipHorizonMs = DEFAULT_SKIP_HORIZON_MS;
    /** In-process version pins (reads in flight); pinned ids survive GC. */
    private versionPins = new Map<string, number>();
    /** Ids this process is currently deleting on purpose; Guard D skips them. */
    private gcSuppressed = new Set<string>();
    /** In-memory GC ledger fallback for directory-less (in-memory) peers. */
    private memoryLedger: GcLedger | undefined;
    /**
     * Per-node metadata row caches, maintained from change events (and
     * upserted directly by local writes). Head selection and path
     * resolution become in-memory computations for warm nodes — the
     * flat-latency backbone for high-churn multi-party workloads.
     */
    private versionRowCache = new Map<string, Map<string, VersionLike>>();
    private namingRowCache = new Map<string, Map<string, NamingLike>>();
    /**
     * Per-node change counters (bumped for added AND removed, whether or
     * not a bucket exists) plus a global epoch bumped on evictions: a cache
     * fill only installs its snapshot when nothing changed for that node
     * during the fill's awaits — otherwise the node stays cold and the next
     * access re-queries. Closes the fill/event race that would otherwise
     * leave a warm bucket stale forever.
     */
    private cacheEpochs = new Map<string, number>();
    private cacheGlobalEpoch = 0;
    /**
     * Per-directory naming-event sweeps ("which events ever asserted a
     * placement under parent P"). A sweep only changes when a naming event
     * with that parentId is added or removed, so invalidation is exact.
     */
    private slotSweepCache = new Map<string, Map<string, NamingLike>>();
    private changeListener: ((event: any) => void) | undefined;
    /** Memoized isTrusted verdicts; see canPerformEntry. */
    private trustVerdicts = new Map<string, { ok: boolean; at: number }>();
    private trustChangeListener: (() => void) | undefined;
    /** Serializes writeBatch calls; see the writeBatch docstring. */
    private writeBatchChain: Promise<unknown> = Promise.resolve();
    /** Row queries issued; tests assert warm paths issue none. */
    rowQueries = 0;
    // --- Cold-start bootstrap state (all re-initialized in open()) ---
    private bootstrapPhase: BootstrapPhase = "off";
    /**
     * Guard D arming: false from the moment a bootstrap is decided until
     * verified retirement (or post-timeout quiescence), so a partial
     * replica can never resurrect history network-wide.
     */
    private guardArmed = true;
    /**
     * Read-through overlay over the snapshot's head documents. HARD
     * INVARIANT: visible ONLY to the five enumerated metadata read points
     * (namingStatesForNodes, sweepRows, headsForNodes, getDocument-on-miss
     * for naming/version ids, versionDocumentsForNode) — never to
     * touchChunks, hasDocument, GC planning, or Guard D. Nothing in the
     * overlay ever enters the log, index, or block store.
     */
    private overlayNaming = new Map<string, Map<string, NamingLike>>();
    private overlayVersions = new Map<string, Map<string, VersionLike>>();
    private overlaySweep = new Map<string, Map<string, NamingLike>>();
    private overlayDocs = new Map<string, SharedFsEntry>();
    private overlayPending = new Map<
        string,
        { nodeId: string; kind: "naming" | "file-version" }
    >();
    private bootstrapConfig = {
        mode: "off" as "auto" | "require" | "off",
        ...BOOTSTRAP_DEFAULTS,
    };
    private snapshotConfig = { ...SNAPSHOT_DEFAULTS, disabled: false };
    private bootstrapManifestMeta: BootstrapStatus["manifest"];
    private lastArrivalMs = 0;
    private docsSinceSnapshot = 0;
    private quiescentChecks = 0;
    private bootstrapTimers: ReturnType<typeof setTimeout>[] = [];
    private snapshotTimer: ReturnType<typeof setInterval> | undefined;
    private supersessionTimer: ReturnType<typeof setInterval> | undefined;
    private quiescenceTimer: ReturnType<typeof setInterval> | undefined;
    private bootstrapWaiters: Array<(result: { verified: boolean }) => void> =
        [];
    /** Settles once the bootstrap decision (run, fall back, resume) is made. */
    private bootstrapDecision: Promise<void> = Promise.resolve();
    /** True only after a VERIFIED retirement (never for quiescence arming). */
    private bootstrapVerified = false;
    /** Human-readable summary of the last bootstrap fallback, for status. */
    private bootstrapFailure: string | undefined;
    /** Serializes bootstrap state-file writes. */
    private stateWriteChain: Promise<unknown> = Promise.resolve();
    private snapshotRunning = false;
    private sweepRunning = false;
    /** Last arrival authored by ANOTHER peer (local writes excluded). */
    private lastRemoteArrivalMs = 0;
    /**
     * Advisory ignore patterns the automatic snapshot publisher embeds in
     * manifests (set by the policy layer; explicit snapshotWrite options
     * win).
     */
    advisoryIgnorePublish: string[] | undefined;
    /**
     * Advisory ignore patterns carried by the ACCEPTED bootstrap
     * manifest, valid-compiled; the policy layer reads these to cover the
     * bootstrap window until /.artifactignore is readable.
     */
    bootstrapAdvisoryIgnorePatterns: string[] | undefined;

    constructor(
        properties: {
            id?: Uint8Array;
            rootKey?: PublicSignKey;
            /**
             * Sealed ingest-tier artifact-ignore directory names —
             * IMMUTABLE once the filesystem exists (they are part of the
             * address). Defaults to DEFAULT_SEALED_IGNORED_NAMES; pass []
             * to opt out entirely.
             */
            sealedIgnoredNames?: string[];
        } = {}
    ) {
        super();
        this.id = properties.id ?? randomBytes(32);
        this.trustGraph = properties.rootKey
            ? new TrustedNetwork({
                  id: this.id,
                  rootTrust: properties.rootKey,
              })
            : undefined;
        this.sealedIgnoredNames = [
            ...new Set(
                properties.sealedIgnoredNames ?? DEFAULT_SEALED_IGNORED_NAMES
            ),
        ].sort();
        // v8: artifact ignores (sealed names on the program, manifest
        // advisory patterns) — the salt bump guarantees older peers can
        // never attach to the same log and fail confusingly
        // mid-replication.
        this.entries = new Documents({
            id: sha256Sync(concat([this.id, fromString("/shared-fs/v9")])),
        });
    }

    async open(args?: SharedFsOpenArgs) {
        this.machineLabel = args?.machineLabel || "unknown-machine";
        // Default to a full replica: every mount serves the whole namespace
        // from its local index, and a writer must never see its own files
        // pruned because it is not a leader for them.
        this.replicate =
            args?.replicate === undefined ? { factor: 1 } : args.replicate;
        // Unconditional (borsh bypasses field initializers on
        // address-opened programs — a conditional assignment here left
        // remote chunk fetch silently DISABLED for every peer that opened
        // an existing address with default options).
        this.remoteChunkFetch = { timeoutMs: REMOTE_CHUNK_FETCH_TIMEOUT_MS };
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
        this.clock = args?.clock ?? Date.now;
        this.skipHorizonMs = Math.max(
            5 * 60 * 1000,
            args?.dedupSkipHorizonMs ?? DEFAULT_SKIP_HORIZON_MS
        );
        // Borsh deserialization bypasses the constructor, so per-instance
        // state must be (re)initialized here, not in field initializers.
        this.versionPins = new Map();
        this.gcSuppressed = new Set();
        this.memoryLedger = undefined;
        this.versionRowCache = new Map();
        this.namingRowCache = new Map();
        this.cacheEpochs = new Map();
        this.cacheGlobalEpoch = 0;
        this.slotSweepCache = new Map();
        this.writeBatchChain = Promise.resolve();
        this.trustVerdicts = new Map();
        this.pendingGuardVersions = new Map();
        this.pendingGuardNaming = new Map();
        this.bootstrapPhase = "off";
        this.guardArmed = true;
        this.overlayNaming = new Map();
        this.overlayVersions = new Map();
        this.overlaySweep = new Map();
        this.overlayDocs = new Map();
        this.overlayPending = new Map();
        this.bootstrapManifestMeta = undefined;
        this.lastArrivalMs = 0;
        this.lastRemoteArrivalMs = 0;
        this.docsSinceSnapshot = 0;
        this.quiescentChecks = 0;
        this.clearBootstrapTimers();
        this.bootstrapWaiters = [];
        this.bootstrapVerified = false;
        this.bootstrapFailure = undefined;
        this.stateWriteChain = Promise.resolve();
        this.snapshotRunning = false;
        this.sweepRunning = false;
        this.advisoryIgnorePublish = undefined;
        this.bootstrapAdvisoryIgnorePatterns = undefined;
        const bootstrapArg = args?.bootstrap;
        this.bootstrapConfig = {
            ...BOOTSTRAP_DEFAULTS,
            ...(typeof bootstrapArg === "object" ? bootstrapArg : {}),
            mode:
                bootstrapArg === false
                    ? ("off" as const)
                    : typeof bootstrapArg === "object"
                      ? (bootstrapArg.mode ?? "auto")
                      : "auto",
        };
        this.snapshotConfig = {
            ...SNAPSHOT_DEFAULTS,
            disabled: false,
            ...(args?.snapshot ?? {}),
        };
        if (this.guardFlushTimer) {
            clearTimeout(this.guardFlushTimer);
            this.guardFlushTimer = undefined;
        }
        // ANY trust-graph change flushes every memoized verdict, so
        // revocations apply with zero added latency and newly trusted
        // writers stop paying the negative-verdict TTL. Deduped like the
        // entries change listener below.
        if (this.trustGraph) {
            if (this.trustChangeListener) {
                this.trustGraph.trustGraph.events.removeEventListener(
                    "change",
                    this.trustChangeListener
                );
            }
            this.trustChangeListener = () => this.trustVerdicts.clear();
            this.trustGraph.trustGraph.events.addEventListener(
                "change",
                this.trustChangeListener
            );
        }
        // The persisted state is read BEFORE the entries store opens: an
        // interrupted-bootstrap marker must disarm the resurrection guard
        // ahead of any listener registration or ingest, REGARDLESS of the
        // configured bootstrap mode — a partial store must never judge
        // removals.
        const persisted = await this.readBootstrapState();
        const marker = persisted.bootstrap;
        if (marker !== undefined) {
            this.guardArmed = false;
        }
        const bootstrapCandidate =
            this.bootstrapConfig.mode !== "off" && this.isFullReplica();
        // Replication is ALWAYS announced at open. An earlier design
        // deferred the announcement until the snapshot overlay installed
        // (to keep ingest off the install's critical path), but an
        // observer-to-replicator upgrade broadcast over a still-forming
        // relayed mesh proved lossy in cross-network interop — the joiner
        // stayed a silent observer. The overlay install runs beside the
        // ingest instead; it is chunked with yields and still lands in
        // low single-digit seconds.
        await this.entries.open({
            type: SharedFsEntry,
            replicate: this.replicate as any,
            replicas: { min: 3 },
            // Never prune locally authored entries, even when this peer is
            // not a replicator for them (e.g. replicate: false).
            keep: "self",
            canPerform: (operation) => this.canPerformEntry(operation),
            // Raw exchange-heads: senders ship raw entry blocks and the
            // receiver batch-computes CIDs and batch-verifies signatures
            // (via the wasm verifier when available), marking entries
            // preverified — canPerform still runs per entry. Negotiated
            // per connection with a compatible fallback, this is the
            // cheap half of fast cold joins.
            sync: { rawExchangeHeads: true },
            index: {
                type: IndexableSharedFsEntry,
            },
        });
        // Cache maintenance runs on every peer; the resurrection guard only
        // on full replicas (and only while armed — see guardArmed).
        // Registering a change consumer also makes Documents materialize
        // removed VALUES on delete. Deduped so a close→reopen of the same
        // instance never stacks listeners.
        if (this.changeListener) {
            this.entries.events.removeEventListener(
                "change",
                this.changeListener
            );
        }
        this.changeListener = (event: any) => {
            const added = event?.detail?.added ?? [];
            const removed = event?.detail?.removed ?? [];
            this.lastArrivalMs = this.clock();
            const localKey = this.authorKey();
            for (const value of added) {
                if (
                    value instanceof NamingEvent ||
                    value instanceof FileVersion
                ) {
                    // Only metadata counts toward "documents changed";
                    // remote arrivals (not our own writes) drive the
                    // supersession-sweep pacing.
                    this.docsSinceSnapshot++;
                    if (value.authorKey !== localKey) {
                        this.lastRemoteArrivalMs = this.clock();
                    }
                }
            }
            this.applyCacheChanges(added, removed);
            this.watchHub?.ingest(added, removed);
            this.changesetHub?.ingest(added, removed);
            if (this.overlayPending.size > 0) {
                for (const value of [...added, ...removed]) {
                    const id = (value as any)?.id;
                    if (typeof id === "string") {
                        this.overlayPending.delete(id);
                    }
                }
            }
            if (this.guardArmed && this.isFullReplica()) {
                void this.guardAgainstLiveRemovals(removed).catch(() => {});
            }
        };
        this.entries.events.addEventListener("change", this.changeListener);
        this.bootstrapDecision = Promise.resolve();
        if (bootstrapCandidate) {
            if (this.bootstrapConfig.mode === "require") {
                // "require" surfaces the failing stage to the opener
                // instead of falling back silently.
                await this.startBootstrap(marker);
            } else {
                const run = this.startBootstrap(marker).catch(() => {
                    // startBootstrap chooses its posture on expected
                    // failures; an unexpected throw keeps the safe side:
                    // a resumed (marker-bearing) store must stay gated.
                    if (
                        this.bootstrapPhase === "fetching" ||
                        this.bootstrapPhase === "off"
                    ) {
                        if (marker !== undefined) {
                            this.enterUnverified();
                        } else {
                            this.abandonBootstrap();
                        }
                    }
                });
                this.bootstrapDecision = run;
            }
        } else if (marker !== undefined) {
            // An unfinished bootstrap on disk, but this open is not a
            // candidate (mode off, or a partial replica): hold the
            // unverified posture until the store settles.
            this.bootstrapPhase = "unverified";
            this.startQuiescenceChecker();
        }
        // Stamp the warm-reopen marker (never clears the bootstrap key).
        void this.writeBootstrapState({ openedBefore: true }).catch(() => {});
        this.startSnapshotPublisher();
        if (this.isFullReplica()) {
            // Warm the chunkRefs child-table index so the first writeFile's
            // dedup freshness probe is a planned indexed join, not a scan.
            void this.entries.index
                .iterate(
                    {
                        query: [
                            new StringMatch({
                                key: "chunkRefs",
                                value: "chunk:warmup",
                            }),
                        ],
                    },
                    { local: true, remote: false, resolve: false }
                )
                .all()
                .catch(() => {});
            if (this.trustGraph) {
                void this.isTrustedWriter(this.node.identity.publicKey).then(
                    (trusted) => {
                        if (!trusted) {
                            console.warn(
                                "shared-fs: this peer's key is not a trusted writer; garbage collection and the resurrection guard are inert here."
                            );
                        }
                    },
                    () => {}
                );
            }
        }
    }

    private isFullReplica() {
        return this.replicate !== false && this.replicate?.factor === 1;
    }

    private authorKey() {
        return encodePublicSignKey(this.node.identity.publicKey);
    }

    /**
     * Friendly SDK-side mirror of the ingest-tier name rules: reserved
     * control names are invalid everywhere; sealed artifact names are
     * rejected for directories (ingest would bounce them fleet-wide
     * anyway — this just makes the error local and typed).
     */
    private assertWritableName(name: string, kind: "file" | "directory") {
        if (name.startsWith(RESERVED_NAME_PREFIX)) {
            throw new SharedFsError("EINVAL", `Name is reserved: ${name}`);
        }
        if (kind === "directory" && this.sealedIgnoredNames.includes(name)) {
            throw new SharedFsError(
                "EIGNORED",
                `Directory name is a sealed artifact-ignore on this filesystem: ${name}`
            );
        }
    }

    private signedMetadata() {
        return {
            authorKey: this.authorKey(),
            machineLabel: this.machineLabel,
            timestamp: now(),
        };
    }

    private async canPerformEntry(operation: any) {
        // Structural, state-independent validation — acceptance must never
        // depend on replication order or local history.
        if (operation?.type === "put") {
            const value = operation.value;
            if (!structurallyValidEntry(value)) {
                return false;
            }
            // Sealed artifact-ignore tier: DIRECTORY basenames on the
            // sealed list bounce at ingest on every peer identically.
            // Legal despite reading instance state because the sealed
            // list is serialized into the program — part of the store
            // address, immutable, identical everywhere — so the verdict
            // stays independent of replication order and local history.
            if (
                value instanceof NamingEvent &&
                value.nodeId.startsWith("dir:") &&
                this.sealedIgnoredNames.includes(value.name)
            ) {
                return false;
            }
            if (value instanceof BootstrapManifest) {
                // A signed snapshot pointer: the payload is bounded, the
                // id is bound to the INNER signer, the inner signature
                // verifies, the payload decodes and names THIS store, and
                // (when access-controlled) the inner signer is trusted —
                // so a joiner can verify a manifest against its own trust
                // graph without trusting whichever peer served it.
                if (
                    value.payloadBytes.byteLength > MANIFEST_PAYLOAD_CAP_BYTES
                ) {
                    return false;
                }
                let signature: SignatureWithKey;
                let payload: SnapshotManifestPayload;
                try {
                    signature = deserialize(
                        value.signatureBytes,
                        SignatureWithKey
                    );
                    payload = deserialize(
                        value.payloadBytes,
                        SnapshotManifestPayload
                    );
                } catch {
                    return false;
                }
                if (
                    value.id !==
                        `bootstrap:${encodePublicSignKey(signature.publicKey)}` ||
                    !equalBytes(payload.storeId, this.id) ||
                    !(await verify(signature, value.payloadBytes))
                ) {
                    return false;
                }
                if (
                    this.trustGraph &&
                    !(await this.trustGraph.isTrusted(signature.publicKey))
                ) {
                    return false;
                }
            }
            if (value instanceof ChangesetManifest) {
                // A write-set membership record: self-certifying id (hash
                // of the payload), inner-signed, bounded, bound to THIS
                // store, with index mirrors enforced equal to the payload —
                // the mirrors are what the index and the turn barrier
                // trust, so authorKey on this kind is authenticated.
                if (
                    value.payloadBytes.byteLength >
                    CHANGESET_MANIFEST_PAYLOAD_CAP_BYTES
                ) {
                    return false;
                }
                let signature: SignatureWithKey;
                let payload: ChangesetManifestPayload;
                try {
                    signature = deserialize(
                        value.signatureBytes,
                        SignatureWithKey
                    );
                    payload = deserialize(
                        value.payloadBytes,
                        ChangesetManifestPayload
                    );
                } catch {
                    return false;
                }
                if (
                    value.id !==
                        `changeset-manifest:${sha256Base64Sync(value.payloadBytes)}` ||
                    payload.formatVersion !==
                        CHANGESET_MANIFEST_FORMAT_VERSION ||
                    !equalBytes(payload.storeId, this.id) ||
                    !validChangesetId(payload.changesetId) ||
                    value.changesetId !== payload.changesetId ||
                    value.createdAtWallMs !== payload.createdAtWallMs ||
                    value.authorKey !==
                        encodePublicSignKey(signature.publicKey) ||
                    payload.createdAtWallMs >
                        BigInt(
                            Math.floor(this.clock()) +
                                CHANGESET_MANIFEST_MAX_CLOCK_SKEW_MS
                        ) ||
                    payload.versionMembers.length +
                        payload.namingMembers.length >
                        CHANGESET_MANIFEST_MAX_MEMBERS ||
                    !(await verify(signature, value.payloadBytes))
                ) {
                    return false;
                }
                if (
                    this.trustGraph &&
                    !(await this.trustGraph.isTrusted(signature.publicKey))
                ) {
                    return false;
                }
            }
        }
        if (!this.trustGraph) {
            return true;
        }
        const keys = await operation.entry.getPublicKeys();
        const now = this.clock();
        for (const key of keys) {
            // Memoized trust verdicts: the trust-graph BFS runs per entry
            // on the replication ingest path, so a cold join pays it tens
            // of thousands of times for a handful of signers. Positive
            // verdicts live until ANY trust-graph change flushes the cache
            // (revocations apply immediately); negatives expire quickly so
            // a writer whose trust relation is still replicating gets
            // retried by the sender's retry schedule.
            const id = key.hashcode();
            const cached = this.trustVerdicts.get(id);
            if (
                cached &&
                (cached.ok || now - cached.at < TRUST_NEGATIVE_TTL_MS)
            ) {
                if (cached.ok) {
                    return true;
                }
                continue;
            }
            const ok = await this.trustGraph.isTrusted(key);
            if (this.trustVerdicts.size > 10_000) {
                this.trustVerdicts.clear();
            }
            this.trustVerdicts.set(id, { ok, at: now });
            if (ok) {
                // Any trusted signer may append. The stored authorKey is
                // advisory attribution, not an authentication binding:
                // documents are immutable and id-addressed, and
                // resurrection/recovery flows legitimately re-append other
                // authors' documents under the local key.
                return true;
            }
        }
        return false;
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

    /**
     * Remove THIS identity's trust edge to a writer (directional
     * ownership: only the truster who granted an edge can revoke it, so a
     * machine's de-provisioning is executed by whoever authorized it —
     * typically the root identity). Idempotent; a writer trusted through
     * ANOTHER live path (root -> A -> B) stays trusted until every path is
     * revoked — check isTrustedWriter afterwards. Revocation applies to
     * NEW writes as each replica's trust graph copy converges: documents a
     * lagging replica admitted in the race window are not retroactively
     * re-validated (upstream revocation-epoch work tracks that gap).
     */
    async revokeWriter(publicKey: PublicSignKey) {
        if (!this.trustGraph) {
            throw new Error("Shared filesystem is not access controlled");
        }
        await this.trustGraph.revoke(publicKey);
    }

    async isTrustedWriter(publicKey: PublicSignKey) {
        return this.trustGraph ? this.trustGraph.isTrusted(publicKey) : true;
    }

    async trustedWriters() {
        return this.trustGraph ? this.trustGraph.getTrusted() : [];
    }

    // ------------------------------------------------------------------
    // Index access. Every lookup is an indexed query on the local index
    // (kind, nodeId, parentId, name, deleted) and only resolves the small
    // metadata documents it needs. Chunk bytes are fetched by id, only on
    // reads.
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
        if (
            result == null &&
            this.bootstrapPhase === "overlay-active" &&
            (id.startsWith("naming:") || id.startsWith("version:"))
        ) {
            // Overlay read point: metadata documents only — chunk lookups
            // (and with them touchChunks/hasDocument/GC/Guard D, which
            // never see the overlay) are structurally excluded.
            return this.overlayDocs.get(id) as unknown as T | undefined;
        }
        return (result ?? undefined) as unknown as T | undefined;
    }

    /**
     * Re-put that links the live head when the id currently exists (keeping
     * one linear chain a future CUT can prune) and forks a fresh chain only
     * when the row is genuinely absent.
     */
    private async putPreferLinked(value: SharedFsEntry) {
        if (await this.hasDocument(value.id)) {
            await this.entries.put(value);
        } else {
            await this.entries.put(value, { unique: true });
        }
    }

    /** Index-only presence probe: never resolves document bytes. */
    private async hasDocument(id: string): Promise<boolean> {
        const result = await this.entries.index.get(id, {
            local: true,
            remote: false,
            resolve: false,
        });
        return result != null;
    }

    // ------------------------------------------------------------------
    // Naming layer
    // ------------------------------------------------------------------

    /** Bound the caches so pathological trees cannot grow memory forever. */
    private static CACHE_NODE_LIMIT = 50_000;

    private bumpEpoch(nodeId: string) {
        this.cacheEpochs.set(nodeId, (this.cacheEpochs.get(nodeId) ?? 0) + 1);
    }

    private epochOf(nodeId: string) {
        return `${this.cacheGlobalEpoch}:${this.cacheEpochs.get(nodeId) ?? 0}`;
    }

    /** Evict the oldest ~10% (Map iteration order) instead of thrashing. */
    private boundCache(cache: Map<string, unknown>) {
        if (cache.size <= SharedFileSystem.CACHE_NODE_LIMIT) {
            return;
        }
        this.cacheGlobalEpoch++;
        const evict = Math.ceil(cache.size / 10);
        let count = 0;
        for (const key of cache.keys()) {
            cache.delete(key);
            if (++count >= evict) {
                break;
            }
        }
    }

    private applyCacheChanges(added: unknown[], removed: unknown[]) {
        for (const value of added) {
            if (value instanceof FileVersion) {
                this.bumpEpoch(value.nodeId);
                const bucket = this.versionRowCache.get(value.nodeId);
                if (bucket) {
                    bucket.set(value.id, versionRowOf(value));
                }
            } else if (value instanceof NamingEvent) {
                this.bumpEpoch(value.nodeId);
                const bucket = this.namingRowCache.get(value.nodeId);
                if (bucket) {
                    bucket.set(value.id, namingRowOf(value));
                }
                this.bumpEpoch(`slot:${value.parentId}`);
                const sweep = this.slotSweepCache.get(value.parentId);
                if (sweep) {
                    sweep.set(value.id, namingRowOf(value));
                }
            }
        }
        // Removals (GC) invalidate conservatively: the next access re-reads
        // the index.
        for (const value of removed) {
            if (value instanceof FileVersion) {
                this.bumpEpoch(value.nodeId);
                this.versionRowCache.delete(value.nodeId);
            } else if (value instanceof NamingEvent) {
                this.bumpEpoch(value.nodeId);
                this.namingRowCache.delete(value.nodeId);
                this.bumpEpoch(`slot:${value.parentId}`);
                this.slotSweepCache.delete(value.parentId);
            }
        }
        this.boundCache(this.versionRowCache);
        this.boundCache(this.namingRowCache);
        this.boundCache(this.slotSweepCache);
    }

    /** Upsert a locally written document into a warm cache immediately. */
    private cacheLocalWrite(value: SharedFsEntry) {
        this.applyCacheChanges([value], []);
    }

    /** Index-only rows for a query; never resolves documents. */
    private async queryRows(query: Query[]): Promise<any[]> {
        this.rowQueries++;
        return (await this.entries.index
            .iterate({ query }, { local: true, remote: false, resolve: false })
            .all()) as any[];
    }

    /**
     * Full naming histories for many nodes, batched — served entirely from
     * index rows: no document resolution on the path-resolution hot path.
     */
    private async namingStatesForNodes(
        nodeIds: string[]
    ): Promise<Map<string, NodeNamingState>> {
        const unique = [...new Set(nodeIds)];
        const byNode = new Map<string, NamingLike[]>();
        const misses: string[] = [];
        const fillEpochs = new Map<string, string>();
        for (const nodeId of unique) {
            const cached = this.namingRowCache.get(nodeId);
            if (cached) {
                byNode.set(nodeId, [...cached.values()]);
            } else {
                byNode.set(nodeId, []);
                misses.push(nodeId);
                fillEpochs.set(nodeId, this.epochOf(nodeId));
            }
        }
        for (let i = 0; i < misses.length; i += HEAD_QUERY_BATCH) {
            const batch = misses.slice(i, i + HEAD_QUERY_BATCH);
            const rows = await this.queryRows([
                new StringMatch({ key: "kind", value: "naming" }),
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
            ]);
            for (const raw of rows) {
                const row = namingRowOf(raw);
                byNode.get(row.nodeId)?.push(row);
            }
        }
        for (const nodeId of misses) {
            // Install only if nothing changed for the node during the
            // fill's awaits — otherwise the bucket stays cold and the next
            // access re-queries (a stale install would drop a just-arrived
            // superseding event for as long as the bucket stays warm).
            if (this.epochOf(nodeId) !== fillEpochs.get(nodeId)) {
                continue;
            }
            this.namingRowCache.set(
                nodeId,
                new Map((byNode.get(nodeId) ?? []).map((row) => [row.id, row]))
            );
        }
        this.boundCache(this.namingRowCache);
        const states = new Map<string, NodeNamingState>();
        for (const [nodeId, events] of byNode) {
            // Bootstrap overlay union happens AFTER the cache install
            // above: overlay rows are merged into the returned view only,
            // never into the real caches or index.
            const state = computeNamingState(
                nodeId,
                this.overlayUnionNaming(nodeId, events)
            );
            if (state) {
                states.set(nodeId, state);
            }
        }
        return states;
    }

    private async namingStateForNode(
        nodeId: string
    ): Promise<NodeNamingState | undefined> {
        return (await this.namingStatesForNodes([nodeId])).get(nodeId);
    }

    /** Cache-first per-directory naming sweep; epoch-gated fill. */
    private async sweepRows(parentId: string): Promise<NamingLike[]> {
        const cached = this.slotSweepCache.get(parentId);
        if (cached) {
            return this.overlayUnionSweep(parentId, [...cached.values()]);
        }
        const epochKey = `slot:${parentId}`;
        const fillEpoch = this.epochOf(epochKey);
        const rows = (
            await this.queryRows([
                new StringMatch({ key: "kind", value: "naming" }),
                new StringMatch({ key: "parentId", value: parentId }),
            ])
        ).map(namingRowOf);
        if (this.epochOf(epochKey) === fillEpoch) {
            this.slotSweepCache.set(
                parentId,
                new Map(rows.map((row) => [row.id, row]))
            );
            this.boundCache(this.slotSweepCache);
        }
        // Overlay union after the cache install: read view only.
        return this.overlayUnionSweep(parentId, rows);
    }

    /**
     * The visible node at (parentId, name): every node that ever asserted
     * this placement is a candidate; a node claims the slot when its current
     * winning event still places it here, live; among claimants the one
     * whose winning head sorts first (depth desc, id asc) is visible, the
     * rest are shadowed (surfaced as duplicate-name conflicts).
     */
    private async slotResolution(
        parentId: string,
        name: string
    ): Promise<
        | {
              nodeId: string;
              state: NodeNamingState;
              shadowed: string[];
          }
        | undefined
    > {
        const slotRows = (await this.sweepRows(parentId)).filter(
            (row) => row.name === name
        );
        const candidates = [...new Set(slotRows.map((row) => row.nodeId))];
        if (candidates.length === 0) {
            return undefined;
        }
        const states = await this.namingStatesForNodes(candidates);
        return this.pickSlotWinner(parentId, name, states);
    }

    private pickSlotWinner(
        parentId: string,
        name: string,
        states: Map<string, NodeNamingState>
    ):
        | { nodeId: string; state: NodeNamingState; shadowed: string[] }
        | undefined {
        const claimants = [...states.values()].filter(
            (state) =>
                state.winner.parentId === parentId &&
                state.winner.name === name &&
                !state.winner.deleted
        );
        if (claimants.length === 0) {
            return undefined;
        }
        claimants.sort((a, b) => {
            const depthDiff = compareBigint(
                b.winner.causalDepth,
                a.winner.causalDepth
            );
            if (depthDiff !== 0) {
                return depthDiff;
            }
            return compareIds(a.winner.id, b.winner.id);
        });
        return {
            nodeId: claimants[0].nodeId,
            state: claimants[0],
            shadowed: claimants.slice(1).map((state) => state.nodeId),
        };
    }

    private async resolvePath(path: string): Promise<ResolvedPath | undefined> {
        return (await this.resolvePathDetailed(path))?.resolved;
    }

    /** resolvePath plus the slot chain walked to get there — the spine the
     *  watch layer uses to detect ancestor placement changes. */
    private async resolvePathDetailed(
        path: string
    ): Promise<ResolvedPathDetailed | undefined> {
        const normalized = normalizeFsPath(path);
        if (normalized === "/") {
            return {
                resolved: { kind: "root", nodeId: ROOT_NODE_ID, path: "/" },
                spine: [],
            };
        }
        const segments = pathSegments(normalized);
        const spine: ResolvedPathDetailed["spine"] = [];
        let parentId: string = ROOT_NODE_ID;
        let currentPath = "/";
        for (let i = 0; i < segments.length; i++) {
            const name = segments[i];
            currentPath = joinFsPath(currentPath, name);
            const isLast = i === segments.length - 1;
            const slot = await this.slotResolution(parentId, name);
            if (!slot) {
                return undefined;
            }
            spine.push({ parentId, name, nodeId: slot.nodeId });
            const kind = nodeKindOf(slot.nodeId);
            if (kind === "directory") {
                if (isLast) {
                    return {
                        resolved: {
                            kind,
                            nodeId: slot.nodeId,
                            winner: slot.state.winner,
                            state: slot.state,
                            contested: slot.shadowed.length > 0,
                            path: currentPath,
                        },
                        spine,
                    };
                }
                parentId = slot.nodeId;
                continue;
            }
            if (isLast) {
                return {
                    resolved: {
                        kind,
                        nodeId: slot.nodeId,
                        winner: slot.state.winner,
                        state: slot.state,
                        contested: slot.shadowed.length > 0,
                        path: currentPath,
                    },
                    spine,
                };
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
        return resolved.kind === "root" ? ROOT_NODE_ID : resolved.nodeId;
    }

    /**
     * Best-effort path of a node by walking winner parents upward. Used by
     * conflict reporting only; unreachable chains resolve under "/".
     */
    private async pathForNode(
        nodeId: string,
        stateCache: Map<string, NodeNamingState>
    ): Promise<string> {
        const names: string[] = [];
        const visited = new Set<string>();
        let current: string = nodeId;
        while (current !== ROOT_NODE_ID) {
            if (visited.has(current)) {
                break;
            }
            visited.add(current);
            let state = stateCache.get(current);
            if (!state) {
                state = await this.namingStateForNode(current);
                if (state) {
                    stateCache.set(current, state);
                }
            }
            if (!state) {
                break;
            }
            names.unshift(state.winner.name);
            current = state.winner.parentId;
        }
        return "/" + names.join("/");
    }

    /** True if `ancestorNodeId` is the node or one of its winner ancestors. */
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
            const state = await this.namingStateForNode(current);
            if (!state || state.winner.deleted) {
                return false;
            }
            current = state.winner.parentId;
        }
        return false;
    }

    private async appendNamingEvent(properties: {
        nodeId: string;
        parentId: string;
        name: string;
        deleted?: boolean;
        /** Current head events this event causally supersedes. */
        parentHeads: NamingLike[];
        observedContentHeads?: string[];
    }) {
        const metadata = this.signedMetadata();
        if (properties.parentHeads.length > 8000) {
            throw new SharedFsError(
                "EINVAL",
                "too many concurrent naming heads to supersede in one event"
            );
        }
        const event = new NamingEvent({
            id: createId("naming"),
            nodeId: properties.nodeId,
            parentId: properties.parentId,
            name: properties.name,
            deleted: properties.deleted ?? false,
            causalDepth: maxDepth(properties.parentHeads),
            parentNamingIds: properties.parentHeads.map((head) => head.id),
            observedContentHeads: properties.observedContentHeads ?? [],
            createdAt: metadata.timestamp,
            authorKey: metadata.authorKey,
            machineLabel: metadata.machineLabel,
        });
        await this.entries.put(event, { unique: true });
        this.cacheLocalWrite(event);
        return event;
    }

    // ------------------------------------------------------------------
    // Content layer
    // ------------------------------------------------------------------

    /**
     * W1 dedup rule. A chunk put may be skipped only when BOTH hold: this is
     * a full replica, and a version younger than the skip horizon references
     * the chunk — such a witness cannot be retired by any collector for at
     * least retentionMs − skipHorizonMs, so the chunk stays referenced
     * everywhere while the new version propagates. Otherwise the chunk is
     * re-put NON-unique: the put links the existing head, which refreshes
     * its modified time (the age shield every collector honors) and gives
     * the old entry a non-CUT child that stops an in-flight delete's
     * recursive prune. Partial replicas always re-put so keep:"self"
     * protects the writer's own content.
     */
    private async touchChunks(
        chunks: FileChunk[],
        dedup: "verify" | "off" | undefined
    ) {
        const fullReplica = this.isFullReplica();
        const horizonFloor = BigInt(
            Math.max(0, Math.floor(this.clock() - this.skipHorizonMs))
        );
        await mapWithConcurrency(
            chunks,
            CHUNK_IO_CONCURRENCY,
            async (chunk) => {
                if (dedup === "off" || !fullReplica) {
                    await this.entries.put(chunk);
                    return;
                }
                if (!(await this.hasDocument(chunk.id))) {
                    // Absence just verified; a fresh chain with no
                    // existing-key lookup. Duplicate-id races are idempotent
                    // by construction under content addressing.
                    await this.entries.put(chunk, { unique: true });
                    return;
                }
                const iterator = this.entries.index.iterate(
                    {
                        query: [
                            new StringMatch({
                                key: "kind",
                                value: "file-version",
                            }),
                            new StringMatch({
                                key: "chunkRefs",
                                value: chunk.id,
                            }),
                            new IntegerCompare({
                                key: "createdAt",
                                compare: Compare.GreaterOrEqual,
                                value: horizonFloor,
                            }),
                        ],
                    },
                    { local: true, remote: false, resolve: false }
                );
                let witnessed: boolean;
                try {
                    witnessed = (await iterator.next(1)).length > 0;
                } finally {
                    await (iterator as any).close?.();
                }
                if (witnessed) {
                    return;
                }
                await this.entries.put(chunk);
            }
        );
    }

    /** All version documents for a node. */
    private async versionDocumentsForNode(
        nodeId: string
    ): Promise<FileVersion[]> {
        const documents = await this.queryDocuments<SharedFsEntry>([
            new StringMatch({ key: "nodeId", value: nodeId }),
            new StringMatch({ key: "kind", value: "file-version" }),
        ]);
        const versions = documents.filter(isFileHead);
        if (this.bootstrapPhase !== "overlay-active") {
            return versions;
        }
        // Overlay read point: union the snapshot's full version documents
        // for this node (read view only; nothing enters the store).
        const bucket = this.overlayVersions.get(nodeId);
        if (!bucket || bucket.size === 0) {
            return versions;
        }
        const seen = new Set(versions.map((doc) => doc.id));
        for (const id of bucket.keys()) {
            if (!seen.has(id)) {
                const doc = this.overlayDocs.get(id);
                if (doc instanceof FileVersion) {
                    versions.push(doc);
                }
            }
        }
        return versions;
    }

    private contentHeads<T extends VersionLike>(documents: T[]): T[] {
        const { heads } = computeDag(documents, (doc) => doc.parentVersionIds);
        // Stored depth, same rationale as naming winners: retiring ancestors
        // must never change the visible head.
        return [...heads].sort((a, b) => {
            const depthDiff = compareBigint(b.causalDepth, a.causalDepth);
            return depthDiff !== 0 ? depthDiff : compareIds(a.id, b.id);
        });
    }

    /**
     * Content heads served from index rows: per-operation cost is flat in
     * the number of retained versions' SIZE (rows are tiny), and no
     * documents are resolved. Callers needing bytes resolve exactly the
     * winning version document.
     */
    private async headsForNode(nodeId: string): Promise<VersionLike[]> {
        return (await this.headsForNodes([nodeId])).get(nodeId) ?? [];
    }

    /** Content heads for many nodes with batched row queries. */
    private async headsForNodes(
        nodeIds: string[]
    ): Promise<Map<string, VersionLike[]>> {
        const byNode = new Map<string, VersionLike[]>();
        const misses: string[] = [];
        const fillEpochs = new Map<string, string>();
        for (const nodeId of nodeIds) {
            const cached = this.versionRowCache.get(nodeId);
            if (cached) {
                byNode.set(nodeId, [...cached.values()]);
            } else {
                byNode.set(nodeId, []);
                misses.push(nodeId);
                fillEpochs.set(nodeId, this.epochOf(nodeId));
            }
        }
        for (let i = 0; i < misses.length; i += HEAD_QUERY_BATCH) {
            const batch = misses.slice(i, i + HEAD_QUERY_BATCH);
            const rows = await this.queryRows([
                new StringMatch({ key: "kind", value: "file-version" }),
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
            ]);
            for (const raw of rows) {
                const row = versionRowOf(raw);
                byNode.get(row.nodeId)?.push(row);
            }
        }
        for (const nodeId of misses) {
            // Epoch-gated install; see namingStatesForNodes.
            if (this.epochOf(nodeId) !== fillEpochs.get(nodeId)) {
                continue;
            }
            this.versionRowCache.set(
                nodeId,
                new Map((byNode.get(nodeId) ?? []).map((row) => [row.id, row]))
            );
        }
        this.boundCache(this.versionRowCache);
        const result = new Map<string, VersionLike[]>();
        for (const [nodeId, rows] of byNode) {
            // Overlay union after the cache install: read view only.
            result.set(
                nodeId,
                this.contentHeads(this.overlayUnionVersions(nodeId, rows))
            );
        }
        return result;
    }

    private versionInfo(
        head: VersionLike,
        path: string,
        heads: VersionLike[]
    ): SharedFsVersionInfo {
        return {
            id: head.id,
            nodeId: head.nodeId,
            path,
            size: head.size,
            contentHash: head.contentHash,
            parentVersionIds: head.parentVersionIds,
            createdAt: head.createdAt,
            authorKey: head.authorKey ?? "",
            machineLabel: head.machineLabel ?? "",
            deleted: false,
            head: heads.some((candidate) => candidate.id === head.id),
        };
    }

    private entryInfoFor(
        winner: NamingLike,
        path: string,
        options: {
            heads?: VersionLike[];
            namingConflict?: boolean;
        } = {}
    ): SharedFsEntryInfo | undefined {
        const kind = nodeKindOf(winner.nodeId);
        if (kind === "directory") {
            return {
                path,
                nodeId: winner.nodeId,
                name: winner.name,
                kind,
                size: 0n,
                updatedAt: winner.createdAt,
                authorKey: winner.authorKey ?? "",
                machineLabel: winner.machineLabel ?? "",
                conflict: false,
                namingConflict: options.namingConflict || undefined,
            };
        }
        const visible = options.heads?.[0];
        if (!visible) {
            // File node without any replicated content yet.
            return undefined;
        }
        return {
            path,
            nodeId: winner.nodeId,
            name: winner.name,
            kind,
            size: visible.size,
            updatedAt: visible.createdAt,
            authorKey: winner.authorKey ?? "",
            machineLabel: winner.machineLabel ?? "",
            conflict: (options.heads?.length ?? 0) > 1,
            versionId: visible.id,
            headVersionIds: options.heads?.map((head) => head.id) ?? [],
            contentHash: visible.contentHash,
            namingConflict: options.namingConflict || undefined,
        };
    }

    // ------------------------------------------------------------------
    // Public filesystem API
    // ------------------------------------------------------------------

    /**
     * Metadata for a single path. `undefined` when the path does not exist.
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
        const namingConflict = resolved.state.conflicted || resolved.contested;
        if (resolved.kind === "directory") {
            return this.entryInfoFor(resolved.winner, resolved.path, {
                namingConflict,
            });
        }
        const heads = await this.headsForNode(resolved.nodeId);
        return this.entryInfoFor(resolved.winner, resolved.path, {
            heads,
            namingConflict,
        });
    }

    async mkdir(path: string) {
        const normalized = normalizeFsPath(path);
        if (normalized === "/") {
            return;
        }
        this.assertWritableName(basename(normalized), "directory");
        if (await this.resolvePath(normalized)) {
            throw new SharedFsError(
                "EEXIST",
                `Path already exists: ${normalized}`
            );
        }
        const parentId = await this.resolveParent(normalized);
        await this.appendNamingEvent({
            nodeId: createId("dir"),
            parentId,
            name: basename(normalized),
            parentHeads: [],
        });
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
        this.assertWritableName(basename(normalized), "file");
        const bytes = await toBytes(source);
        const resolved = await this.resolvePath(normalized);
        if (resolved?.kind === "directory" || resolved?.kind === "root") {
            throw new SharedFsError(
                "EISDIR",
                `Path is a directory: ${normalized}`
            );
        }
        const existingNodeId = resolved?.nodeId;
        const currentHeads = existingNodeId
            ? await this.headsForNode(existingNodeId)
            : [];
        const contentHash = sha256Base64Sync(bytes);
        // Idempotent save: identical content over a single unchanged head is
        // a no-op — no new version, no new chunks, nothing to replicate.
        // Explicit baseVersionIds (conflict flows) and explicit chunk sizes
        // (re-chunking migrations) always create a version.
        if (
            options.baseVersionIds === undefined &&
            options.chunkSize === undefined &&
            currentHeads.length === 1 &&
            currentHeads[0].contentHash === contentHash
        ) {
            return this.versionInfo(currentHeads[0], normalized, currentHeads);
        }
        if ((options.baseVersionIds?.length ?? 0) > 8000) {
            // The indexer's batched child-table insert has a bound-variable
            // ceiling (~8191 rows), same as chunk references.
            throw new SharedFsError(
                "EINVAL",
                "too many base versions for one write"
            );
        }
        let parentVersionIds: string[];
        let parentVersions: VersionLike[];
        if (options.baseVersionIds !== undefined) {
            parentVersionIds = options.baseVersionIds;
            parentVersions = [];
            for (const parentId of parentVersionIds) {
                const parent = await this.getDocument<SharedFsEntry>(parentId);
                if (parent instanceof FileVersion) {
                    parentVersions.push(parent);
                }
            }
        } else {
            parentVersionIds = currentHeads.map((head) => head.id);
            parentVersions = currentHeads;
        }
        const versionId = createId("version");
        // Content-addressed chunks: identical bytes — across versions of
        // this file or across entirely different files — share one chunk
        // document. Only chunks the store has not seen (or cannot prove
        // fresh) are re-put; see touchChunks for the dedup safety rules.
        const orderedChunks = chunkBytes(bytes, options.chunkSize).map(
            (chunk) => new FileChunk({ bytes: chunk })
        );
        const uniqueChunks = [
            ...new Map(
                orderedChunks.map((chunk) => [chunk.id, chunk])
            ).values(),
        ];
        if (uniqueChunks.length > 8000) {
            // The indexer's batched child-table insert has a bound-variable
            // ceiling (~8191 rows). Larger files need a larger chunk size.
            throw new SharedFsError(
                "EINVAL",
                `File has ${uniqueChunks.length} unique chunks; raise chunkSize (default ${DEFAULT_FILE_CHUNK_SIZE} bytes supports ~4 GiB per version)`
            );
        }
        await this.touchChunks(uniqueChunks, options.dedup);
        const metadata = this.signedMetadata();
        const nodeId = existingNodeId ?? createId("file");
        const version = new FileVersion({
            id: versionId,
            nodeId,
            parentVersionIds,
            causalDepth: maxDepth(parentVersions),
            contentHash,
            size: BigInt(bytes.byteLength),
            chunkIds: orderedChunks.map((chunk) => chunk.id),
            createdAt: metadata.timestamp,
            authorKey: metadata.authorKey,
            machineLabel: metadata.machineLabel,
        });
        await this.entries.put(version, { unique: true });
        this.cacheLocalWrite(version);
        // W2: the version now references the chunks; re-verify every chunk
        // is still present and re-put from memory any that a concurrently
        // executing collector removed inside the probe window.
        if (options.dedup !== "off") {
            await mapWithConcurrency(
                uniqueChunks,
                CHUNK_IO_CONCURRENCY,
                async (chunk) => {
                    if (!(await this.hasDocument(chunk.id))) {
                        await this.putPreferLinked(chunk);
                    }
                }
            );
        }
        if (!existingNodeId) {
            // Brand-new path: content first, then the naming event that
            // makes it visible. Writes to existing files never touch naming
            // — a concurrent rename can no longer be reverted by a save.
            const parentId = await this.resolveParent(normalized);
            await this.appendNamingEvent({
                nodeId,
                parentId,
                name: basename(normalized),
                parentHeads: [],
            });
        }
        const referenced = new Set(parentVersionIds);
        const heads = [
            version,
            ...currentHeads.filter((head) => !referenced.has(head.id)),
        ];
        return this.versionInfo(version, normalized, heads);
    }

    /**
     * Apply many file operations as one write-set. Far cheaper than
     * sequential writeFile calls (parents resolved once against a shared
     * overlay, chunk-dedup probes and chunk IO batched across the whole
     * set), and every applied document carries one changesetId — a
     * queryable, commit-like handle over the multi-file change.
     *
     * Missing parent directories are created. Atomicity contract: per file
     * always (content chunks land before the version that references them,
     * and a NEW file's naming event lands last, so a crashed or replicated
     * prefix never shows a partially present new file). Across entries the
     * batch is NOT transactional: an edit to an existing file becomes
     * visible as soon as its version lands, a crash mid-batch can leave a
     * prefix of edits applied, and remote peers apply the batch's documents
     * incrementally. Delete events are appended after all creates so every
     * intermediate state is data-preserving — a rename expressed as
     * delete+create never transiently shows neither file.
     *
     * Batches are serialized per instance; concurrent batches from OTHER
     * peers that create the same new directory converge to one visible
     * winner, with the loser surfaced via namingConflicts().
     */
    async writeBatch(
        entries: WriteBatchEntry[],
        options: WriteBatchOptions = {}
    ): Promise<WriteBatchResult> {
        // Serialized per instance: two in-flight batches would otherwise
        // each mint a fresh directory node for the same new path segment
        // (the overlay is per call), manufacturing duplicate-name conflicts
        // from a single process.
        const run = this.writeBatchChain.then(() =>
            this.writeBatchInner(entries, options)
        );
        this.writeBatchChain = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    private async writeBatchInner(
        entries: WriteBatchEntry[],
        options: WriteBatchOptions = {}
    ): Promise<WriteBatchResult> {
        const changesetId = options.changesetId ?? createId("changeset");
        if (changesetId.length === 0 || changesetId.length > 256) {
            throw new SharedFsError(
                "EINVAL",
                "changesetId must be 1-256 characters"
            );
        }
        if (entries.length === 0) {
            if (options.manifest) {
                const manifest = await this.publishChangesetManifest(
                    changesetId,
                    [],
                    []
                );
                return { changesetId, manifest, results: [] };
            }
            return { changesetId, results: [] };
        }
        if (entries.length > 10_000) {
            throw new SharedFsError(
                "EINVAL",
                "writeBatch is limited to 10000 entries"
            );
        }
        const normalizedEntries = entries.map((entry) => ({
            ...entry,
            path: normalizeFsPath(entry.path),
        }));
        const seenPaths = new Set<string>();
        for (const entry of normalizedEntries) {
            if (entry.path === "/") {
                throw new SharedFsError("EISDIR", "Cannot write to root");
            }
            if (!("delete" in entry)) {
                this.assertWritableName(basename(entry.path), "file");
            }
            if (seenPaths.has(entry.path)) {
                throw new SharedFsError(
                    "EINVAL",
                    `Duplicate path in batch: ${entry.path}`
                );
            }
            seenPaths.add(entry.path);
        }
        // No entry's path may lie under another entry's path: the shorter
        // path claims a file (or delete) slot while the longer one needs it
        // as a directory — sequential writes would throw ENOTDIR, and a
        // batch that applied both would mint two nodes for one (parent,
        // name) slot, silently shadowing one of its own writes.
        for (const entry of normalizedEntries) {
            for (
                let ancestor = dirname(entry.path);
                ancestor !== "/";
                ancestor = dirname(ancestor)
            ) {
                if (seenPaths.has(ancestor)) {
                    throw new SharedFsError(
                        "ENOTDIR",
                        `Conflicting paths in batch: ${entry.path} lies under ${ancestor}, which the batch also writes`
                    );
                }
            }
        }
        const metadata = this.signedMetadata();
        // Directories created by this batch, keyed by normalized path.
        const createdDirs = new Map<
            string,
            { nodeId: string; event: NamingEvent }
        >();
        const resolveParentWithOverlay = async (
            path: string
        ): Promise<string> => {
            const parentPath = dirname(path);
            if (parentPath === "/") {
                return ROOT_NODE_ID;
            }
            const segments = pathSegments(parentPath);
            let parentId: string = ROOT_NODE_ID;
            let currentPath = "/";
            for (const name of segments) {
                currentPath = joinFsPath(currentPath, name);
                const made = createdDirs.get(currentPath);
                if (made) {
                    parentId = made.nodeId;
                    continue;
                }
                // Auto-created ancestors are directories: sealed and
                // reserved names must bounce here too.
                this.assertWritableName(name, "directory");
                const slot = await this.slotResolution(parentId, name);
                if (slot) {
                    if (nodeKindOf(slot.nodeId) === "file") {
                        throw new SharedFsError(
                            "ENOTDIR",
                            `Parent path is a file: ${currentPath}`
                        );
                    }
                    parentId = slot.nodeId;
                    continue;
                }
                const nodeId = createId("dir");
                const event = new NamingEvent({
                    id: createId("naming"),
                    nodeId,
                    parentId,
                    name,
                    causalDepth: 1n,
                    parentNamingIds: [],
                    createdAt: metadata.timestamp,
                    authorKey: metadata.authorKey,
                    machineLabel: metadata.machineLabel,
                    changesetId,
                });
                createdDirs.set(currentPath, { nodeId, event });
                parentId = nodeId;
            }
            return parentId;
        };

        const results: (SharedFsVersionInfo | undefined)[] = new Array(
            normalizedEntries.length
        );
        // Adoption closure (manifest batches only): no-op entries adopt the
        // young documents that already satisfy them — the matching head
        // version, the node's winning naming event, and young ancestor
        // directory winners — so a same-changesetId retry after a crash
        // certifies exactly the real turn's documents instead of a
        // zero-member manifest that completes remote barriers early.
        const adoptVersionIds = new Set<string>();
        const adoptNamingIds = new Set<string>();
        const adoptionNow = BigInt(Math.floor(this.clock()));
        const youngEnough = (createdAt: bigint) =>
            adoptionNow - createdAt <= BigInt(CHANGESET_ADOPTION_HORIZON_MS);
        const adoptAncestorWinners = async (path: string) => {
            if (!options.manifest) return;
            const parentPath = dirname(path);
            if (parentPath === "/") return;
            let parentId: string = ROOT_NODE_ID;
            let currentPath = "/";
            for (const name of pathSegments(parentPath)) {
                currentPath = joinFsPath(currentPath, name);
                if (createdDirs.has(currentPath)) return; // fresh members
                const slot = await this.slotResolution(parentId, name);
                if (!slot || nodeKindOf(slot.nodeId) === "file") return;
                if (youngEnough(slot.state.winner.createdAt)) {
                    adoptNamingIds.add(slot.state.winner.id);
                }
                parentId = slot.nodeId;
            }
        };
        const versions: FileVersion[] = [];
        const createNamingEvents: NamingEvent[] = [];
        const deleteNamingEvents: NamingEvent[] = [];
        const allChunks = new Map<string, FileChunk>();

        for (let i = 0; i < normalizedEntries.length; i++) {
            const entry = normalizedEntries[i];
            const resolved = await this.resolvePath(entry.path);
            if ("delete" in entry) {
                if (
                    resolved?.kind === "directory" ||
                    resolved?.kind === "root"
                ) {
                    // rm() handles directories (with an empty check); a
                    // silent skip here would be indistinguishable from an
                    // applied delete.
                    throw new SharedFsError(
                        "EISDIR",
                        `Batch deletes are file-only: ${entry.path} is a directory`
                    );
                }
                if (!resolved) {
                    results[i] = undefined; // delete of nothing is a no-op
                    if (options.manifest) {
                        // A young winning tombstone for a node formerly at
                        // this path satisfies the delete: adopt it so a
                        // retry certifies the real removal.
                        const tombstone = await this.youngTombstoneAt(
                            entry.path,
                            youngEnough
                        );
                        if (tombstone) {
                            adoptNamingIds.add(tombstone);
                            await adoptAncestorWinners(entry.path);
                        }
                    }
                    continue;
                }
                if (resolved.state.heads.length > 8000) {
                    // Same indexer bound appendNamingEvent enforces; throw
                    // before any document is put.
                    throw new SharedFsError(
                        "EINVAL",
                        "too many concurrent naming heads to supersede in one event"
                    );
                }
                const contentHeads = await this.headsForNode(resolved.nodeId);
                deleteNamingEvents.push(
                    new NamingEvent({
                        id: createId("naming"),
                        nodeId: resolved.nodeId,
                        parentId: resolved.winner.parentId,
                        name: resolved.winner.name,
                        deleted: true,
                        causalDepth: maxDepth(resolved.state.heads),
                        parentNamingIds: resolved.state.heads.map(
                            (head) => head.id
                        ),
                        observedContentHeads: contentHeads.map(
                            (head) => head.id
                        ),
                        createdAt: metadata.timestamp,
                        authorKey: metadata.authorKey,
                        machineLabel: metadata.machineLabel,
                        changesetId,
                    })
                );
                results[i] = undefined;
                if (options.manifest) {
                    await adoptAncestorWinners(entry.path);
                }
                continue;
            }
            if (resolved?.kind === "directory" || resolved?.kind === "root") {
                throw new SharedFsError(
                    "EISDIR",
                    `Path is a directory: ${entry.path}`
                );
            }
            const bytes = await toBytes(entry.content);
            const contentHash = sha256Base64Sync(bytes);
            const existingNodeId = resolved?.nodeId;
            const currentHeads = existingNodeId
                ? await this.headsForNode(existingNodeId)
                : [];
            if (
                entry.chunkSize === undefined &&
                currentHeads.length === 1 &&
                currentHeads[0].contentHash === contentHash
            ) {
                results[i] = undefined; // unchanged content: no-op
                if (options.manifest && resolved) {
                    if (youngEnough(currentHeads[0].createdAt)) {
                        adoptVersionIds.add(currentHeads[0].id);
                    }
                    if (youngEnough(resolved.winner.createdAt)) {
                        adoptNamingIds.add(resolved.winner.id);
                    }
                    await adoptAncestorWinners(entry.path);
                }
                continue;
            }
            const orderedChunks = chunkBytes(bytes, entry.chunkSize).map(
                (chunk) => new FileChunk({ bytes: chunk })
            );
            const uniqueChunkIds = new Set(
                orderedChunks.map((chunk) => chunk.id)
            );
            if (uniqueChunkIds.size > 8000) {
                // The indexer bound is per version row's chunkRefs (see
                // writeFile); the batch as a whole probes and puts chunks
                // one document at a time, so its total is unbounded.
                throw new SharedFsError(
                    "EINVAL",
                    `File has ${uniqueChunkIds.size} unique chunks; raise chunkSize (default ${DEFAULT_FILE_CHUNK_SIZE} bytes supports ~4 GiB per version): ${entry.path}`
                );
            }
            for (const chunk of orderedChunks) {
                allChunks.set(chunk.id, chunk);
            }
            const nodeId = existingNodeId ?? createId("file");
            const version = new FileVersion({
                id: createId("version"),
                nodeId,
                parentVersionIds: currentHeads.map((head) => head.id),
                causalDepth: maxDepth(currentHeads),
                contentHash,
                size: BigInt(bytes.byteLength),
                chunkIds: orderedChunks.map((chunk) => chunk.id),
                createdAt: metadata.timestamp,
                authorKey: metadata.authorKey,
                machineLabel: metadata.machineLabel,
                changesetId,
            });
            versions.push(version);
            if (existingNodeId && options.manifest && resolved) {
                // Applied EDIT: a reader needs the node's naming winner and
                // its ancestors to SEE the new version — adopt the young
                // ones so a reordered replica cannot certify an invisible
                // file (adoption closure rule c).
                if (youngEnough(resolved.winner.createdAt)) {
                    adoptNamingIds.add(resolved.winner.id);
                }
                await adoptAncestorWinners(entry.path);
            }
            if (!existingNodeId) {
                await adoptAncestorWinners(entry.path);
                const parentId = await resolveParentWithOverlay(entry.path);
                createNamingEvents.push(
                    new NamingEvent({
                        id: createId("naming"),
                        nodeId,
                        parentId,
                        name: basename(entry.path),
                        causalDepth: 1n,
                        parentNamingIds: [],
                        createdAt: metadata.timestamp,
                        authorKey: metadata.authorKey,
                        machineLabel: metadata.machineLabel,
                        changesetId,
                    })
                );
            }
            const referenced = new Set(version.parentVersionIds);
            results[i] = this.versionInfo(versionRowOf(version), entry.path, [
                versionRowOf(version),
                ...currentHeads.filter((head) => !referenced.has(head.id)),
            ]);
        }

        const namingEvents = [
            ...[...createdDirs.values()].map((made) => made.event),
            ...createNamingEvents,
            ...deleteNamingEvents,
        ];
        // Manifest membership + caps settle BEFORE anything is put: an
        // over-cap batch fails with nothing committed.
        let manifestMembers:
            | { versionIds: string[]; namingIds: string[] }
            | undefined;
        if (options.manifest) {
            const freshVersionIds = versions.map((version) => version.id);
            const freshNamingIds = namingEvents.map((event) => event.id);
            const freshVersionSet = new Set(freshVersionIds);
            const freshNamingSet = new Set(freshNamingIds);
            manifestMembers = {
                versionIds: [
                    ...freshVersionIds,
                    ...[...adoptVersionIds].filter(
                        (id) => !freshVersionSet.has(id)
                    ),
                ],
                namingIds: [
                    ...freshNamingIds,
                    ...[...adoptNamingIds].filter(
                        (id) => !freshNamingSet.has(id)
                    ),
                ],
            };
            const memberCount =
                manifestMembers.versionIds.length +
                manifestMembers.namingIds.length;
            if (memberCount > CHANGESET_MANIFEST_MAX_MEMBERS) {
                throw new SharedFsError(
                    "EINVAL",
                    `manifest member cap (${CHANGESET_MANIFEST_MAX_MEMBERS}) exceeded (${memberCount}); split the turn into smaller batches`
                );
            }
        }
        // Content first, then versions, then naming (directories, creates,
        // deletes last), then the manifest LAST: a crashed or replicated
        // prefix never shows a partially present NEW file, never loses
        // data — and never certifies: local manifest durability implies
        // every member was durably committed first. Edits to existing
        // files become visible at the versions phase (see the docstring).
        await this.touchChunks([...allChunks.values()], options.dedup);
        if (versions.length > 0) {
            await this.entries.putMany(versions, { unique: true });
        }
        if (options.dedup !== "off" && allChunks.size > 0) {
            await mapWithConcurrency(
                [...allChunks.values()],
                CHUNK_IO_CONCURRENCY,
                async (chunk) => {
                    if (!(await this.hasDocument(chunk.id))) {
                        await this.putPreferLinked(chunk);
                    }
                }
            );
        }
        if (namingEvents.length > 0) {
            await this.entries.putMany(namingEvents, { unique: true });
        }
        let manifestResult: WriteBatchResult["manifest"];
        if (manifestMembers) {
            manifestResult = await this.publishChangesetManifest(
                changesetId,
                manifestMembers.versionIds,
                manifestMembers.namingIds
            );
        }
        for (const version of versions) {
            this.cacheLocalWrite(version);
        }
        for (const event of namingEvents) {
            this.cacheLocalWrite(event);
        }
        return { changesetId, manifest: manifestResult, results };
    }

    /** A young winning delete tombstone for whatever node last held a path
     *  (adoption closure for no-op deletes). */
    private async youngTombstoneAt(
        path: string,
        youngEnough: (createdAt: bigint) => boolean
    ): Promise<string | undefined> {
        const parentPath = dirname(path);
        const name = basename(path);
        const parent = await this.resolvePath(parentPath);
        if (!parent || parent.kind === "file") return undefined;
        const parentId = parent.kind === "root" ? ROOT_NODE_ID : parent.nodeId;
        const slotRows = await this.sweepRows(parentId);
        const nodeIds = [
            ...new Set(
                slotRows
                    .filter((row) => row.name === name)
                    .map((row) => row.nodeId)
            ),
        ];
        if (nodeIds.length === 0) return undefined;
        const states = await this.namingStatesForNodes(nodeIds);
        for (const nodeId of nodeIds) {
            const state = states.get(nodeId);
            if (
                state?.winner.deleted &&
                state.winner.parentId === parentId &&
                state.winner.name === name &&
                youngEnough(state.winner.createdAt)
            ) {
                return state.winner.id;
            }
        }
        return undefined;
    }

    /** Build, sign, and commit a changeset manifest AFTER its members. */
    private async publishChangesetManifest(
        changesetId: string,
        versionIds: string[],
        namingIds: string[]
    ): Promise<{ manifestId: string; memberCount: number }> {
        const decodeSuffix = (id: string, prefix: string): Uint8Array => {
            const raw = fromBase64URL(id.slice(prefix.length));
            if (raw.byteLength !== 32) {
                throw new SharedFsError(
                    "EINVAL",
                    `member id is not a 32-byte identity: ${id}`
                );
            }
            return raw;
        };
        const versionMembers = versionIds.map((id) =>
            decodeSuffix(id, "version:")
        );
        const namingMembers = namingIds.map((id) =>
            decodeSuffix(id, "naming:")
        );
        const membershipDigest = sha256Sync(
            concat([
                Uint8Array.of(1),
                ...versionMembers,
                Uint8Array.of(2),
                ...namingMembers,
            ])
        );
        const payload = new ChangesetManifestPayload({
            storeId: this.id,
            changesetId,
            createdAtWallMs: BigInt(Math.floor(this.clock())),
            versionMembers,
            namingMembers,
            membershipDigest,
        });
        const payloadBytes = serialize(payload);
        if (payloadBytes.byteLength > CHANGESET_MANIFEST_PAYLOAD_CAP_BYTES) {
            throw new SharedFsError(
                "EINVAL",
                `manifest payload exceeds ${CHANGESET_MANIFEST_PAYLOAD_CAP_BYTES} bytes; split the turn`
            );
        }
        const signature = await this.node.identity.sign(payloadBytes);
        const manifest = new ChangesetManifest({
            id: `changeset-manifest:${sha256Base64Sync(payloadBytes)}`,
            changesetId,
            authorKey: encodePublicSignKey(signature.publicKey),
            createdAtWallMs: payload.createdAtWallMs,
            payloadBytes,
            signatureBytes: serialize(signature),
        });
        await this.putPreferLinked(manifest);
        return {
            manifestId: manifest.id,
            memberCount: versionMembers.length + namingMembers.length,
        };
    }

    /**
     * The versions (and naming event ids) currently stored under one
     * changesetId, with best-effort current paths. The record is a view
     * over retained history, not a durable commit object: GC retires
     * superseded versions without regard to changesetId, so it shrinks as
     * the batch's files are overwritten and retention windows pass. The id
     * is advisory attribution among trusted writers — any peer may stamp
     * it — so filter the returned versions by authorKey when only one
     * writer's rows are wanted. The first call builds the (kind,
     * changesetId) index lazily; subsequent calls are indexed lookups.
     */
    async versionsByChangeset(
        changesetId: string,
        options: { allowPartial?: boolean } = {}
    ): Promise<{
        versions: SharedFsVersionInfo[];
        namingEventIds: string[];
    }> {
        this.assertNotBootstrapPartial(
            "versionsByChangeset",
            options.allowPartial
        );
        const versionRows = (
            await this.queryRows([
                new StringMatch({ key: "kind", value: "file-version" }),
                new StringMatch({ key: "changesetId", value: changesetId }),
            ])
        ).map(versionRowOf);
        const namingRows = await this.queryRows([
            new StringMatch({ key: "kind", value: "naming" }),
            new StringMatch({ key: "changesetId", value: changesetId }),
        ]);
        const heads = await this.headsForNodes(
            versionRows.map((row) => row.nodeId)
        );
        const stateCache = new Map<string, NodeNamingState>();
        const versions: SharedFsVersionInfo[] = [];
        for (const row of versionRows) {
            const path = await this.pathForNode(row.nodeId, stateCache);
            versions.push(
                this.versionInfo(row, path, heads.get(row.nodeId) ?? [])
            );
        }
        return {
            versions,
            namingEventIds: namingRows.map((row) => row.id as string),
        };
    }

    /**
     * Content addressing makes integrity a pure function of the id: served
     * bytes must hash to the id the version asked for.
     */
    private verifyChunk(chunk: unknown, id: string): FileChunk | undefined {
        if (!(chunk instanceof FileChunk)) {
            return undefined;
        }
        const hash = sha256Base64Sync(chunk.bytes);
        if (hash !== chunk.hash || `chunk:${hash}` !== id) {
            return undefined;
        }
        return chunk;
    }

    private async fetchChunk(
        id: string,
        normalizedPath: string
    ): Promise<FileChunk> {
        const local = await this.getDocument<FileChunk>(id);
        let verified = this.verifyChunk(local, id);
        // Missing locally — or locally corrupt: verification is trustless
        // (any responder either supplies bytes that hash to the id or is
        // rejected), so a remote copy can heal either case. The configured
        // timeout is a BUDGET: a remote answer can come back empty fast
        // while the serving peer is saturated (a cold start's background
        // log ingest, most visibly), so empty answers are retried with
        // backoff until the budget is spent — re-checking locally between
        // attempts, since the ongoing sync may deliver the chunk itself.
        if (!verified && this.remoteChunkFetch) {
            const budgetMs = this.remoteChunkFetch.timeoutMs;
            const deadline = this.clock() + budgetMs;
            let attempt = 0;
            while (!verified) {
                try {
                    const remote = await this.entries.index.get(id, {
                        local: false,
                        // Remaining budget, so retries can never overrun
                        // the configured timeout.
                        remote: {
                            timeout: Math.max(
                                1,
                                Math.floor(deadline - this.clock())
                            ),
                        } as any,
                    });
                    verified = this.verifyChunk(remote ?? undefined, id);
                } catch {
                    verified = undefined;
                }
                if (verified || this.clock() >= deadline) {
                    break;
                }
                await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(250 * 2 ** attempt++, 2_000))
                );
                verified = this.verifyChunk(
                    await this.getDocument<FileChunk>(id),
                    id
                );
            }
        }
        if (!verified) {
            throw new SharedFsError(
                "EIO",
                local
                    ? `Chunk hash mismatch ${id}`
                    : `Missing chunk ${id} for ${normalizedPath}`
            );
        }
        return verified;
    }

    private async readFileVersion(
        version: FileVersion,
        normalizedPath: string
    ) {
        // A file can reference the same content-addressed chunk many times
        // (repeated blocks); fetch each distinct chunk once.
        const chunkIds = version.chunkIds;
        const uniqueIds = [...new Set(chunkIds)];
        const fetched = await mapWithConcurrency(
            uniqueIds,
            CHUNK_IO_CONCURRENCY,
            async (id) => (await this.fetchChunk(id, normalizedPath)).bytes
        );
        const byId = new Map(
            uniqueIds.map((id, index) => [id, fetched[index]])
        );
        const chunks = chunkIds.map((id) => byId.get(id)!);
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
        const heads = await this.headsForNode(resolved.nodeId);
        const visible = heads[0];
        if (!visible) {
            return undefined;
        }
        // A version can replicate before its chunks. Prefer the visible head
        // but fall back to the newest complete ancestor version instead of
        // failing the read outright. Only the candidates actually read are
        // resolved; head selection itself ran on index rows.
        let firstError: unknown;
        const seen = new Set<string>([visible.id]);
        this.pinVersions(heads.map((head) => head.id));
        // Walk candidate ids ancestor-ward; a missing version DOCUMENT does
        // not dead-end the walk because the row graph still supplies its
        // parents.
        const rowsByIds = new Map(
            (await this.headsForNode(resolved.nodeId)).map((row) => [
                row.id,
                row,
            ])
        );
        const allRows = this.versionRowCache.get(resolved.nodeId);
        const rowParents = (id: string): string[] =>
            allRows?.get(id)?.parentVersionIds ??
            rowsByIds.get(id)?.parentVersionIds ??
            [];
        const candidates: FileVersion[] = [];
        const idQueue: string[] = [visible.id];
        while (idQueue.length > 0 && candidates.length === 0) {
            const id = idQueue.shift()!;
            const doc = await this.getDocument<SharedFsEntry>(id);
            if (doc instanceof FileVersion) {
                candidates.push(doc);
                break;
            }
            firstError =
                firstError ??
                new SharedFsError(
                    "EIO",
                    `Missing version document ${id} for ${normalized}`
                );
            for (const parentId of rowParents(id)) {
                if (!seen.has(parentId)) {
                    seen.add(parentId);
                    idQueue.push(parentId);
                }
            }
        }
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
            version.nodeId !== resolved.nodeId
        ) {
            return undefined;
        }
        this.pinVersions([version.id]);
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
            resolved.kind === "root" ? ROOT_NODE_ID : resolved.nodeId;
        const children = await this.listByParentId(parentId);
        const infos: SharedFsEntryInfo[] = [];
        for (const child of children) {
            const info = this.entryInfoFor(
                child.state.winner,
                joinFsPath(normalized, child.name),
                {
                    heads: child.heads,
                    namingConflict: child.state.conflicted || child.contested,
                }
            );
            if (info) {
                infos.push(info);
            }
        }
        return infos.sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * The slot winners a directory currently serves, with content heads for
     * file winners. This is the single winner pipeline behind list() and the
     * watch layer's view diffs — both must always agree with it.
     */
    private async listByParentId(parentId: string): Promise<SlotChildRecord[]> {
        // Every event that ever asserted a placement under this directory is
        // a candidate; slot resolution filters to current live winners.
        const slotRows = await this.sweepRows(parentId);
        const nodesByName = new Map<string, Set<string>>();
        for (const row of slotRows) {
            const set = nodesByName.get(row.name) ?? new Set<string>();
            set.add(row.nodeId);
            nodesByName.set(row.name, set);
        }
        const allNodeIds = [...new Set(slotRows.map((row) => row.nodeId))];
        const states = await this.namingStatesForNodes(allNodeIds);
        const winners: SlotChildRecord[] = [];
        for (const [name, nodeIds] of nodesByName) {
            const scoped = new Map<string, NodeNamingState>();
            for (const nodeId of nodeIds) {
                const state = states.get(nodeId);
                if (state) {
                    scoped.set(nodeId, state);
                }
            }
            const slot = this.pickSlotWinner(parentId, name, scoped);
            if (slot) {
                winners.push({
                    name,
                    nodeId: slot.nodeId,
                    kind: nodeKindOf(slot.nodeId),
                    state: slot.state,
                    contested: slot.shadowed.length > 0,
                });
            }
        }
        const fileNodeIds = winners
            .filter((winner) => winner.kind === "file")
            .map((winner) => winner.nodeId);
        const heads = await this.headsForNodes(fileNodeIds);
        for (const winner of winners) {
            if (winner.kind === "file") {
                winner.heads = heads.get(winner.nodeId);
            }
        }
        return winners;
    }

    async versions(path: string): Promise<SharedFsVersionInfo[]> {
        const normalized = normalizeFsPath(path);
        const resolved = await this.resolvePath(normalized);
        if (!resolved || resolved.kind !== "file") {
            return [];
        }
        const documents = await this.versionDocumentsForNode(resolved.nodeId);
        const heads = this.contentHeads(documents);
        this.pinVersions(documents.map((document) => document.id));
        return documents
            .sort(
                (a, b) =>
                    Number(b.createdAt) - Number(a.createdAt) ||
                    compareIds(b.id, a.id)
            )
            .map((entry) => this.versionInfo(entry, normalized, heads));
    }

    async conflicts(
        path?: string,
        options: { allowPartial?: boolean } = {}
    ): Promise<SharedFsConflict[]> {
        if (path) {
            // The single-file branch reads only overlay-aware points
            // (resolvePath, headsForNode) — same world as the tree view,
            // so it stays available during a bootstrap overlay.
            const target = await this.resolvePath(path);
            if (target?.kind === "file") {
                const heads = await this.headsForNode(target.nodeId);
                if (heads.length <= 1) {
                    return [];
                }
                return [
                    {
                        path: target.path,
                        nodeId: target.nodeId,
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
        this.assertNotBootstrapPartial("conflicts", options.allowPartial);
        // Whole-tree scan over version metadata (no chunk bytes).
        const documents = await this.queryDocuments<SharedFsEntry>([
            new StringMatch({ key: "kind", value: "file-version" }),
        ]);
        const byNode = new Map<string, FileVersion[]>();
        for (const document of documents) {
            if (!isFileHead(document)) {
                continue;
            }
            const list = byNode.get(document.nodeId) ?? [];
            list.push(document);
            byNode.set(document.nodeId, list);
        }
        const prefix = path ? normalizeFsPath(path) : undefined;
        const stateCache = new Map<string, NodeNamingState>();
        const conflicts: SharedFsConflict[] = [];
        for (const [nodeId, nodeDocuments] of byNode) {
            const heads = this.contentHeads(nodeDocuments);
            if (heads.length <= 1) {
                continue;
            }
            const state =
                stateCache.get(nodeId) ??
                (await this.namingStateForNode(nodeId));
            if (!state || state.winner.deleted) {
                continue;
            }
            stateCache.set(nodeId, state);
            const recordPath = await this.pathForNode(nodeId, stateCache);
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
            selected.nodeId !== resolved.nodeId
        ) {
            throw new SharedFsError(
                "ENOENT",
                `Version ${versionId} does not exist for ${normalized}`
            );
        }
        const heads = await this.headsForNode(resolved.nodeId);
        const metadata = this.signedMetadata();
        const resolution = new FileVersion({
            id: createId("version"),
            nodeId: selected.nodeId,
            parentVersionIds: heads.map((head) => head.id),
            causalDepth: maxDepth(heads),
            contentHash: selected.contentHash,
            size: selected.size,
            chunkIds: selected.chunkIds,
            createdAt: metadata.timestamp,
            authorKey: metadata.authorKey,
            machineLabel: metadata.machineLabel,
            conflictResolution: true,
        });
        await this.entries.put(resolution, { unique: true });
        this.cacheLocalWrite(resolution);
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
        if (resolved.kind === "directory") {
            const children = await this.list(normalized);
            if (children.length > 0) {
                throw new SharedFsError(
                    "ENOTEMPTY",
                    `Directory is not empty: ${normalized}`
                );
            }
            await this.appendNamingEvent({
                nodeId: resolved.nodeId,
                parentId: resolved.winner.parentId,
                name: resolved.winner.name,
                deleted: true,
                parentHeads: resolved.state.heads,
            });
            return;
        }
        // Record which content the delete observed, so a concurrent edit is
        // detectable (and recoverable) as a delete-vs-edit conflict instead
        // of silently vanishing.
        const contentHeads = await this.headsForNode(resolved.nodeId);
        await this.appendNamingEvent({
            nodeId: resolved.nodeId,
            parentId: resolved.winner.parentId,
            name: resolved.winner.name,
            deleted: true,
            parentHeads: resolved.state.heads,
            observedContentHeads: contentHeads.map((head) => head.id),
        });
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
        this.assertWritableName(
            basename(toPath),
            resolved.kind === "directory" ? "directory" : "file"
        );
        const destination = await this.resolvePath(toPath);
        if (destination) {
            if (destination.kind === "root") {
                throw new SharedFsError(
                    "EINVAL",
                    `Cannot replace root path: ${toPath}`
                );
            }
            if (destination.nodeId === resolved.nodeId) {
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
            (parentId === resolved.nodeId ||
                (await this.isWithinSubtree(parentId, resolved.nodeId)))
        ) {
            throw new SharedFsError(
                "EINVAL",
                `Cannot move a directory into its own subtree: ${fromPath} -> ${toPath}`
            );
        }
        if (destination) {
            await this.rm(toPath);
        }
        await this.appendNamingEvent({
            nodeId: resolved.nodeId,
            parentId,
            name: basename(toPath),
            parentHeads: resolved.state.heads,
        });
    }

    // ------------------------------------------------------------------
    // Naming conflict surfacing and resolution
    // ------------------------------------------------------------------

    async namingConflicts(
        path?: string,
        options: { allowPartial?: boolean } = {}
    ): Promise<SharedFsNamingConflict[]> {
        this.assertNotBootstrapPartial("namingConflicts", options.allowPartial);
        const documents = await this.queryDocuments<NamingEvent>([
            new StringMatch({ key: "kind", value: "naming" }),
        ]);
        const byNode = new Map<string, NamingEvent[]>();
        for (const event of documents) {
            const list = byNode.get(event.nodeId) ?? [];
            list.push(event);
            byNode.set(event.nodeId, list);
        }
        const states = new Map<string, NodeNamingState>();
        for (const [nodeId, events] of byNode) {
            const state = computeNamingState(nodeId, events);
            if (state) {
                states.set(nodeId, state);
            }
        }
        const conflicts: SharedFsNamingConflict[] = [];
        const stateCache = states;

        // (a) multi-head: unresolved concurrent naming assertions on a node.
        for (const state of states.values()) {
            if (state.conflicted) {
                conflicts.push({
                    type: "multi-head",
                    nodeId: state.nodeId,
                    path: await this.pathForNode(state.nodeId, stateCache),
                    eventIds: state.heads.map((head) => head.id),
                });
            }
        }

        // (b) duplicate-name: multiple live claimants at one slot.
        const bySlot = new Map<string, NodeNamingState[]>();
        for (const state of states.values()) {
            if (state.winner.deleted) {
                continue;
            }
            const key = `${state.winner.parentId} ${state.winner.name}`;
            const list = bySlot.get(key) ?? [];
            list.push(state);
            bySlot.set(key, list);
        }
        for (const claimants of bySlot.values()) {
            if (claimants.length <= 1) {
                continue;
            }
            const slot = this.pickSlotWinner(
                claimants[0].winner.parentId,
                claimants[0].winner.name,
                new Map(claimants.map((state) => [state.nodeId, state]))
            );
            if (!slot) {
                continue;
            }
            conflicts.push({
                type: "duplicate-name",
                nodeId: slot.nodeId,
                path: await this.pathForNode(slot.nodeId, stateCache),
                shadowedNodeIds: slot.shadowed,
                eventIds: claimants.map((state) => state.winner.id),
            });
        }

        // (c) delete-vs-edit: winner is a delete that did not observe all
        // current content heads — the unobserved versions are recoverable.
        const deletedFileNodes = [...states.values()].filter(
            (state) =>
                state.winner.deleted && nodeKindOf(state.nodeId) === "file"
        );
        if (deletedFileNodes.length > 0) {
            const heads = await this.headsForNodes(
                deletedFileNodes.map((state) => state.nodeId)
            );
            for (const state of deletedFileNodes) {
                const observed = new Set(
                    (state.winner as NamingEvent).observedContentHeads
                );
                const recoverable = (heads.get(state.nodeId) ?? []).filter(
                    (head) => !observed.has(head.id)
                );
                if (recoverable.length > 0) {
                    conflicts.push({
                        type: "delete-vs-edit",
                        nodeId: state.nodeId,
                        path: await this.pathForNode(state.nodeId, stateCache),
                        eventIds: [state.winner.id],
                        recoverableVersionIds: recoverable.map(
                            (head) => head.id
                        ),
                    });
                }
            }
        }

        // (d) unreachable: a live node whose winner parent chain never
        // reaches the root (deleted/missing parent, or a move cycle).
        for (const state of states.values()) {
            if (state.winner.deleted) {
                continue;
            }
            const visited = new Set<string>();
            let current = state.winner.parentId;
            let verdict: "reachable" | "unreachable" = "reachable";
            while (current !== ROOT_NODE_ID) {
                if (visited.has(current)) {
                    verdict = "unreachable";
                    break;
                }
                visited.add(current);
                const parent = states.get(current);
                if (!parent || parent.winner.deleted) {
                    verdict = "unreachable";
                    break;
                }
                current = parent.winner.parentId;
            }
            if (verdict === "unreachable") {
                conflicts.push({
                    type: "unreachable",
                    nodeId: state.nodeId,
                    path: await this.pathForNode(state.nodeId, stateCache),
                    eventIds: state.heads.map((head) => head.id),
                });
            }
        }

        const prefix = path ? normalizeFsPath(path) : undefined;
        const filtered =
            prefix && prefix !== "/"
                ? conflicts.filter(
                      (conflict) =>
                          conflict.path === prefix ||
                          conflict.path.startsWith(prefix + "/")
                  )
                : conflicts;
        return filtered.sort(
            (a, b) =>
                compareIds(a.nodeId, b.nodeId) || a.type.localeCompare(b.type)
        );
    }

    /**
     * Settle a naming conflict on a node by appending one event that
     * causally dominates every current head. No-op when the heads already
     * agree with the asserted payload (quiescence — concurrent identical
     * resolutions converge without ping-pong).
     */
    async resolveNamingConflict(nodeId: string, action: ResolveNamingAction) {
        const state = await this.namingStateForNode(nodeId);
        if (!state) {
            throw new SharedFsError("ENOENT", `Unknown node: ${nodeId}`);
        }
        let payload: {
            parentId: string;
            name: string;
            deleted: boolean;
            observedContentHeads?: string[];
        };
        switch (action.type) {
            case "keep": {
                payload = {
                    parentId: state.winner.parentId,
                    name: state.winner.name,
                    deleted: state.winner.deleted,
                };
                break;
            }
            case "restore": {
                if (
                    nodeKindOf(nodeId) === "file" &&
                    (await this.versionDocumentsForNode(nodeId)).length === 0
                ) {
                    // Never produce a contentless ghost: if every version of
                    // this node has been reclaimed, say so loudly.
                    throw new SharedFsError(
                        "ENOENT",
                        "no recoverable content survives for this node"
                    );
                }
                payload = {
                    parentId: state.winner.parentId,
                    name: state.winner.name,
                    deleted: false,
                };
                break;
            }
            case "delete": {
                const heads =
                    nodeKindOf(nodeId) === "file"
                        ? await this.headsForNode(nodeId)
                        : [];
                payload = {
                    parentId: state.winner.parentId,
                    name: state.winner.name,
                    deleted: true,
                    observedContentHeads: heads.map((head) => head.id),
                };
                break;
            }
            case "move": {
                const toPath = normalizeFsPath(action.to);
                const parentId = await this.resolveParent(toPath);
                if (
                    nodeKindOf(nodeId) === "directory" &&
                    (parentId === nodeId ||
                        (await this.isWithinSubtree(parentId, nodeId)))
                ) {
                    throw new SharedFsError(
                        "EINVAL",
                        `Cannot move a directory into its own subtree: ${toPath}`
                    );
                }
                payload = {
                    parentId,
                    name: basename(toPath),
                    deleted: false,
                };
                break;
            }
        }
        const settled =
            state.heads.length === 1 &&
            state.winner.parentId === payload.parentId &&
            state.winner.name === payload.name &&
            state.winner.deleted === payload.deleted;
        if (settled) {
            return;
        }
        await this.appendNamingEvent({
            nodeId,
            parentId: payload.parentId,
            name: payload.name,
            deleted: payload.deleted,
            parentHeads: state.heads,
            observedContentHeads: payload.observedContentHeads,
        });
        if (action.type === "restore" && nodeKindOf(nodeId) === "file") {
            // A restore must carry content: append a resolution version
            // re-referencing the visible head and re-put/touch its chunks,
            // so the restored file is race-proof against a concurrent chunk
            // sweep exactly like a fresh edit is.
            const docs = await this.versionDocumentsForNode(nodeId);
            const heads = this.contentHeads(docs);
            const visibleDoc = heads[0];
            if (!(visibleDoc instanceof FileVersion)) {
                throw new SharedFsError(
                    "EIO",
                    "restored node's winning version document is unavailable"
                );
            }
            {
                const visible = visibleDoc;
                const chunkDocs: FileChunk[] = [];
                for (const chunkId of new Set(visible.chunkIds)) {
                    const chunk = await this.getDocument<FileChunk>(chunkId);
                    if (chunk instanceof FileChunk) {
                        chunkDocs.push(chunk);
                    }
                }
                await this.touchChunks(chunkDocs, "off");
                const metadata = this.signedMetadata();
                const resolution = new FileVersion({
                    id: createId("version"),
                    nodeId,
                    parentVersionIds: heads.map((head) => head.id),
                    causalDepth: maxDepth(heads),
                    contentHash: visible.contentHash,
                    size: visible.size,
                    chunkIds: visible.chunkIds,
                    createdAt: metadata.timestamp,
                    authorKey: metadata.authorKey,
                    machineLabel: metadata.machineLabel,
                    conflictResolution: true,
                });
                await this.entries.put(resolution, { unique: true });
                this.cacheLocalWrite(resolution);
            }
        }
    }

    // ------------------------------------------------------------------
    // Cold-start bootstrap
    // ------------------------------------------------------------------

    private clearBootstrapTimers() {
        // Borsh bypasses field initializers on address-opened programs;
        // this also runs from open() before per-instance re-init.
        for (const timer of this.bootstrapTimers ?? []) {
            clearTimeout(timer);
        }
        this.bootstrapTimers = [];
        if (this.supersessionTimer) {
            clearInterval(this.supersessionTimer);
            this.supersessionTimer = undefined;
        }
        if (this.quiescenceTimer) {
            clearInterval(this.quiescenceTimer);
            this.quiescenceTimer = undefined;
        }
        if (this.snapshotTimer) {
            clearInterval(this.snapshotTimer);
            this.snapshotTimer = undefined;
        }
    }

    async close(from?: any): Promise<boolean> {
        this.watchHub?.closeAll();
        this.changesetHub?.close();
        // A reopened instance gets fresh hubs: bootstrap resync latches
        // must not persist across open generations.
        this.watchHub = undefined;
        this.changesetHub = undefined;
        this.clearBootstrapTimers();
        this.resolveBootstrapWaiters({ verified: false });
        return super.close(from);
    }

    /**
     * Subscribe to filesystem-shaped change events for a path or subtree.
     * Events describe transitions of the view this program's read API
     * serves; see the README's watch section for the delivery contract.
     */
    watch(path = "/", options?: FsWatchOptions): FsWatcher {
        this.watchHub ??= new WatchHub(this.watchHost());
        return this.watchHub.watch(path, options);
    }

    private watchHost(): WatchHost {
        return {
            resolvePathDetailed: (path) => this.resolvePathDetailed(path),
            listByParentId: (parentId) => this.listByParentId(parentId),
            headsForNodes: (nodeIds) => this.headsForNodes(nodeIds),
            namingStatesForNodes: (nodeIds) =>
                this.namingStatesForNodes(nodeIds),
            localAuthorKey: () => this.authorKey(),
            clock: () => this.clock(),
            guardPendingFor: (nodeId) =>
                this.guardFlushBusy ||
                this.pendingGuardVersions.has(nodeId) ||
                this.pendingGuardNaming.has(nodeId),
            makeError: (code, message) =>
                new SharedFsError(code as SharedFsErrorCode, message),
            nodeKindOf: (nodeId) => nodeKindOf(nodeId),
        };
    }

    /**
     * Resolve when every member of changeset X (per its admitted
     * manifests, scoped by manifestId/authors) has been observed admitted
     * on this replica. See the README's write-set barrier section for the
     * exact contract, including the unscoped-reuse exposure and the
     * collected-or-incomplete verdict for historic turns.
     */
    awaitChangeset(
        changesetId: string,
        options?: AwaitChangesetOptions
    ): Promise<ChangesetStatus> {
        if (!validChangesetId(changesetId)) {
            return Promise.reject(
                new SharedFsError("EINVAL", "changesetId must be 1-256 chars")
            );
        }
        this.changesetHub ??= new ChangesetBarrierHub(this.changesetHost());
        return this.changesetHub.await(changesetId, options);
    }

    /** Instant per-replica snapshot of a changeset's arrival state. */
    async changesetStatus(
        changesetId: string,
        options: { allowPartial?: boolean } = {}
    ): Promise<ChangesetStatus> {
        this.assertNotBootstrapPartial("changesetStatus", options.allowPartial);
        this.changesetHub ??= new ChangesetBarrierHub(this.changesetHost());
        await this.changesetHub.ensure(changesetId);
        return this.changesetHub.status(changesetId);
    }

    /** Subscribe to manifest arrivals and turn completions. */
    watchChangesets(options?: {
        changesetId?: string;
        signal?: AbortSignal;
    }): ChangesetWatcher {
        this.changesetHub ??= new ChangesetBarrierHub(this.changesetHost());
        return this.changesetHub.watch(options);
    }

    private changesetHost(): ChangesetHost {
        return {
            manifestsFor: async (changesetId) => {
                const rows = await this.queryRows([
                    new StringMatch({
                        key: "kind",
                        value: "changeset-manifest",
                    }),
                    new StringMatch({ key: "changesetId", value: changesetId }),
                ]);
                const out: {
                    manifest: ChangesetManifest;
                    localArrivalMs?: number;
                }[] = [];
                for (const row of rows) {
                    const doc = await this.getDocument<ChangesetManifest>(
                        row.id
                    );
                    if (doc instanceof ChangesetManifest) {
                        out.push({
                            manifest: doc,
                            localArrivalMs: this.contextModifiedMs(
                                row.__context
                            ),
                        });
                    }
                }
                return out;
            },
            arrivedMemberIds: async (changesetId) => {
                const ids = new Set<string>();
                for (const kind of ["file-version", "naming"]) {
                    const rows = await this.queryRows([
                        new StringMatch({ key: "kind", value: kind }),
                        new StringMatch({
                            key: "changesetId",
                            value: changesetId,
                        }),
                    ]);
                    for (const row of rows) ids.add(row.id as string);
                }
                return ids;
            },
            hasDocumentId: (id) => this.hasDocument(id),
            bootstrapPhase: () => this.bootstrapPhase,
            overlayActive: () => this.bootstrapPhase === "overlay-active",
            awaitBootstrapConverged: () => this.awaitBootstrapConverged(),
            clock: () => this.clock(),
            makeError: (code, message) =>
                new SharedFsError(code as SharedFsErrorCode, message),
        };
    }

    /** Fire the deferred replication announcement (idempotent). */
    private async bootstrapStatePath(): Promise<string | undefined> {
        const directory = (this.node as any)?.directory as string | undefined;
        if (!directory) {
            return undefined;
        }
        const { mkdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const dir = join(directory, "shared-fs-bootstrap");
        await mkdir(dir, { recursive: true });
        return join(dir, `${this.address?.toString() ?? "unaddressed"}.json`);
    }

    /**
     * Persisted per-address open state: whether this directory has opened
     * the address before (governs announce deferral — a warm reopen must
     * never unreplicate its persisted ranges), and the bootstrap marker
     * that keeps Guard D disarmed and GC gated across a crash. An
     * UNREADABLE state file (not merely absent) fails SAFE: treated as an
     * interrupted bootstrap on a previously opened store.
     */
    private async readBootstrapState(): Promise<{
        openedBefore: boolean;
        bootstrap?: "active" | "unverified";
    }> {
        const path = await this.bootstrapStatePath();
        if (!path) {
            return { openedBefore: false };
        }
        try {
            const { readFile } = await import("node:fs/promises");
            const parsed = JSON.parse(await readFile(path, "utf8"));
            return {
                openedBefore: parsed?.openedBefore === true,
                bootstrap:
                    parsed?.bootstrap === "active" ||
                    parsed?.bootstrap === "unverified"
                        ? parsed.bootstrap
                        : undefined,
            };
        } catch (error: any) {
            if (error?.code === "ENOENT") {
                return { openedBefore: false };
            }
            return { openedBefore: true, bootstrap: "active" };
        }
    }

    /** Serialized read-merge-write so concurrent patches never clobber. */
    private writeBootstrapState(patch: {
        openedBefore?: boolean;
        bootstrap?: "active" | "unverified" | null;
    }): Promise<void> {
        const run = this.stateWriteChain.then(async () => {
            const path = await this.bootstrapStatePath();
            if (!path) {
                return;
            }
            try {
                const current = await this.readBootstrapState();
                const next: any = {
                    openedBefore:
                        patch.openedBefore ?? current.openedBefore ?? false,
                    bootstrap:
                        patch.bootstrap === null
                            ? undefined
                            : (patch.bootstrap ?? current.bootstrap),
                };
                const { writeFile } = await import("node:fs/promises");
                await writeFile(path, JSON.stringify(next));
            } catch {
                // In-memory or read-only peers proceed without crash
                // safety; an interrupted bootstrap there restarts from an
                // empty store.
            }
        });
        this.stateWriteChain = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    /**
     * Decide and run the cold-start bootstrap. Eligibility: an empty local
     * store, or a persisted marker from an interrupted bootstrap (which
     * also keeps Guard D disarmed and GC gated across the reopen — a
     * partial store must never resurrect retired history network-wide).
     * A failure over a fresh empty store falls back to today's plain
     * join; a failure over a resumed partial store takes the unverified
     * posture instead — guard down and GC gated until the store settles.
     */
    private async startBootstrap(marker: "active" | "unverified" | undefined) {
        if (marker === "unverified") {
            // A previous bootstrap retired on timeout: no overlay, but
            // Guard D stays disarmed and GC gated until quiescence.
            this.bootstrapPhase = "unverified";
            this.guardArmed = false;
            this.startQuiescenceChecker();
            return;
        }
        const iterator = this.entries.index.iterate(
            { query: [] },
            { local: true, remote: false, resolve: false }
        );
        let empty: boolean;
        try {
            empty = (await iterator.next(1)).length === 0;
        } finally {
            await (iterator as any).close?.();
        }
        if (!empty && !marker) {
            return;
        }
        // A resumed bootstrap (marker, or non-empty store) holds a
        // PARTIAL doc set: its failure path must never arm the guard.
        const resumed = marker !== undefined && !empty;
        this.bootstrapPhase = "fetching";
        this.guardArmed = false;
        await this.writeBootstrapState({ bootstrap: "active" });
        let installed = false;
        let failure: unknown;
        try {
            installed = await this.fetchAndInstallOverlay();
        } catch (error) {
            failure = error;
        }
        if (!installed) {
            if (resumed) {
                this.enterUnverified();
            } else {
                this.abandonBootstrap();
            }
            if (this.bootstrapConfig.mode === "require") {
                throw (
                    failure ??
                    new SharedFsError(
                        "EIO",
                        `cold-start bootstrap failed: ${this.bootstrapFailure ?? "no usable snapshot manifest was found in time"}`
                    )
                );
            }
            return;
        }
        this.bootstrapPhase = "overlay-active";
        this.events.dispatchEvent(
            new CustomEvent("bootstrap:ready", {
                detail: this.bootstrapStatus(),
            })
        );
        // The overlay union switches on with zero feed traffic; watchers
        // attached earlier must re-snapshot or they serve a near-empty view
        // for the whole overlay window.
        this.watchHub?.resyncAll("snapshot", "bootstrap:ready");
        this.startRetirementTracking();
    }

    /**
     * Fall back to a plain join over a FRESH store; clears any partial
     * overlay state and re-arms the guard. Never valid for a resumed
     * partial store — that path takes enterUnverified().
     */
    private abandonBootstrap() {
        this.overlayNaming = new Map();
        this.overlayVersions = new Map();
        this.overlaySweep = new Map();
        this.overlayDocs = new Map();
        this.overlayPending = new Map();
        this.bootstrapManifestMeta = undefined;
        this.bootstrapPhase = "off";
        this.guardArmed = true;
        void this.writeBootstrapState({ bootstrap: null }).catch(() => {});
        this.resolveBootstrapWaiters({ verified: false });
    }

    /**
     * The safety posture for any partial store that cannot verify: guard
     * disarmed, GC gated, marker persisted, arming deferred to the
     * quiescence checker.
     */
    private enterUnverified() {
        this.overlayNaming = new Map();
        this.overlayVersions = new Map();
        this.overlaySweep = new Map();
        this.overlayDocs = new Map();
        this.overlayPending = new Map();
        this.bootstrapManifestMeta = undefined;
        this.bootstrapPhase = "unverified";
        this.guardArmed = false;
        void this.writeBootstrapState({ bootstrap: "unverified" }).catch(
            () => {}
        );
        this.startQuiescenceChecker();
        this.resolveBootstrapWaiters({ verified: false });
    }

    /**
     * Discover, verify, fetch and install the newest trusted snapshot.
     * Returns false when no usable manifest exists (caller falls back).
     */
    private async fetchAndInstallOverlay(): Promise<boolean> {
        const config = this.bootstrapConfig;
        const results = await this.entries.index
            .iterate(
                {
                    query: [
                        new StringMatch({
                            key: "kind",
                            value: "bootstrap-manifest",
                        }),
                    ],
                },
                {
                    local: true,
                    remote: { timeout: config.discoveryTimeoutMs } as any,
                    resolve: true,
                }
            )
            .all();
        const deadline = this.clock() + config.discoveryTimeoutMs;
        type Candidate = {
            payload: SnapshotManifestPayload;
            signerKey: PublicSignKey;
            authorKey: string;
        };
        // Per-stage rejection tally: surfaced in bootstrapStatus and the
        // "require" error so clock-skew or trust failures are diagnosable
        // instead of a silent fallback.
        let invalid = 0;
        let stale = 0;
        const candidates: Candidate[] = [];
        for (const raw of results) {
            if (!(raw instanceof BootstrapManifest)) {
                continue;
            }
            // The manifest arrived via query, pre-canPerform: verify it
            // here against OUR trust graph — never trust the serving peer.
            let signature: SignatureWithKey;
            let payload: SnapshotManifestPayload;
            try {
                signature = deserialize(raw.signatureBytes, SignatureWithKey);
                payload = deserialize(
                    raw.payloadBytes,
                    SnapshotManifestPayload
                );
            } catch {
                invalid++;
                continue;
            }
            const authorKey = encodePublicSignKey(signature.publicKey);
            if (
                raw.payloadBytes.byteLength > MANIFEST_PAYLOAD_CAP_BYTES ||
                raw.id !== `bootstrap:${authorKey}` ||
                !equalBytes(payload.storeId, this.id) ||
                !(await verify(signature, raw.payloadBytes))
            ) {
                invalid++;
                continue;
            }
            const age = this.clock() - Number(payload.createdAtWallMs);
            if (age > config.maxSnapshotAgeMs) {
                stale++;
                continue;
            }
            candidates.push({
                payload,
                signerKey: signature.publicKey,
                authorKey,
            });
        }
        if (candidates.length === 0) {
            this.bootstrapFailure =
                invalid + stale === 0
                    ? "no snapshot manifest candidates were discovered in time"
                    : `no usable snapshot manifest (${invalid} invalid, ${stale} older than the staleness cap — check clock skew if unexpected)`;
            return false;
        }
        // Trust-race tolerance: the trust graph may still be replicating,
        // so an untrusted verdict is final only at the deadline.
        const trusted: Candidate[] = [];
        while (trusted.length === 0) {
            for (const candidate of candidates) {
                if (
                    !this.trustGraph ||
                    (await this.trustGraph.isTrusted(candidate.signerKey))
                ) {
                    trusted.push(candidate);
                }
            }
            if (trusted.length > 0 || this.clock() >= deadline) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (trusted.length === 0) {
            this.bootstrapFailure = `${candidates.length} snapshot candidate(s) found, none from a trusted signer by the discovery deadline`;
            return false;
        }
        // Rank by wall clock across authors (snapshotSeq is per-author).
        // Future-dated timestamps are clamped to now so an author with a
        // fast clock cannot permanently dominate ranking.
        const now = BigInt(Math.floor(this.clock()));
        const rankOf = (candidate: Candidate) =>
            candidate.payload.createdAtWallMs > now
                ? now
                : candidate.payload.createdAtWallMs;
        trusted.sort((a, b) => compareBigint(rankOf(b), rankOf(a)));
        const chosen = trusted[0];
        this.bootstrapFailure = undefined;
        // Manifest-carried ADVISORY ignore patterns: installed into the
        // local slot at accept time — before any segment or chunk fetch —
        // so the bootstrap window is covered until /.artifactignore is
        // readable. Advisory only (write/view behavior of THIS peer);
        // invalid pattern lists are dropped, never partially applied.
        if (chosen.payload.advisoryIgnorePatterns) {
            try {
                compileIgnoreRules(chosen.payload.advisoryIgnorePatterns);
                this.bootstrapAdvisoryIgnorePatterns = [
                    ...chosen.payload.advisoryIgnorePatterns,
                ];
                this.events.dispatchEvent(
                    new CustomEvent("ignore:advisory-available", {
                        detail: {
                            patterns: this.bootstrapAdvisoryIgnorePatterns,
                        },
                    })
                );
            } catch (error: any) {
                console.warn(
                    "shared-fs: dropping invalid advisory ignore patterns from snapshot manifest:",
                    error?.message ?? error
                );
            }
        }
        // Restrict block fetches to CURRENTLY CONNECTED peers: the
        // replicator-derived provider set can contain dead ex-members
        // (machines join and leave constantly in this workload). Upstream
        // rotates past stale provider candidates since peerbit 5.3.34,
        // which removes the total-unavailability failure — but measured
        // 2026-08-31, 1 in 4 unrestricted joins after a peer crash still
        // hit an ~80s delivery-timeout tail, while this restriction holds
        // joins at a consistent ~2s. Tail beats median here; keep it.
        const connectedPeers = [
            ...(((this.node.services.pubsub as any)?.peers?.keys?.() ??
                []) as Iterable<string>),
        ].slice(0, 16);
        const segments = await mapWithConcurrency(
            chosen.payload.segments,
            config.segmentFetchConcurrency,
            async (ref) => {
                const bytes = (await (this.node.services.blocks as any).get(
                    ref.cid,
                    {
                        remote: {
                            timeout: config.discoveryTimeoutMs * 4,
                            ...(connectedPeers.length > 0
                                ? { from: connectedPeers }
                                : {}),
                        },
                    }
                )) as Uint8Array | undefined;
                if (!bytes) {
                    throw new SharedFsError(
                        "EIO",
                        `bootstrap segment unavailable: ${ref.cid}`
                    );
                }
                // Bind fetched bytes to the SIGNED manifest, not transport.
                if (sha256Base64Sync(bytes) !== ref.sha256) {
                    throw new SharedFsError(
                        "EIO",
                        `bootstrap segment hash mismatch: ${ref.cid}`
                    );
                }
                const segment = deserialize(bytes, SnapshotSegment);
                if (segment.entries.length !== ref.docCount) {
                    throw new SharedFsError(
                        "EIO",
                        `bootstrap segment count mismatch: ${ref.cid}`
                    );
                }
                return segment;
            }
        );
        // Install, chunked with OCCASIONAL yields: each burst is tens of
        // milliseconds of pure CPU, and yielding per segment would make
        // the install queue 256 macrotask hops behind the concurrently
        // running log ingest.
        let sinceYield = 0;
        for (const segment of segments) {
            for (const doc of segment.entries) {
                if (
                    !(doc instanceof NamingEvent) &&
                    !(doc instanceof FileVersion)
                ) {
                    throw new SharedFsError(
                        "EIO",
                        "bootstrap segment contains a non-metadata document"
                    );
                }
                if (!structurallyValidEntry(doc)) {
                    throw new SharedFsError(
                        "EIO",
                        "bootstrap segment contains a structurally invalid document"
                    );
                }
                if (
                    doc instanceof NamingEvent &&
                    doc.nodeId.startsWith("dir:") &&
                    this.sealedIgnoredNames.includes(doc.name)
                ) {
                    // A converged donor cannot hold sealed-name dirs
                    // (its own ingest bounces them); a snapshot carrying
                    // one is invalid.
                    throw new SharedFsError(
                        "EIO",
                        "bootstrap segment contains a sealed artifact-ignore directory"
                    );
                }
                this.installOverlayDoc(doc);
            }
            if (++sinceYield >= 16) {
                sinceYield = 0;
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
        this.bootstrapManifestMeta = {
            authorKey: chosen.authorKey,
            snapshotSeq: chosen.payload.snapshotSeq,
            createdAtWallMs: chosen.payload.createdAtWallMs,
            ageMs: this.clock() - Number(chosen.payload.createdAtWallMs),
            docs: chosen.payload.counts.docs,
        };
        return true;
    }

    private installOverlayDoc(doc: NamingEvent | FileVersion) {
        if (this.overlayDocs.has(doc.id)) {
            return; // idempotent across marker resumes
        }
        this.overlayDocs.set(doc.id, doc);
        if (doc instanceof NamingEvent) {
            const row = namingRowOf(doc);
            let bucket = this.overlayNaming.get(doc.nodeId);
            if (!bucket) {
                bucket = new Map();
                this.overlayNaming.set(doc.nodeId, bucket);
            }
            bucket.set(doc.id, row);
            let sweep = this.overlaySweep.get(doc.parentId);
            if (!sweep) {
                sweep = new Map();
                this.overlaySweep.set(doc.parentId, sweep);
            }
            sweep.set(doc.id, row);
            this.overlayPending.set(doc.id, {
                nodeId: doc.nodeId,
                kind: "naming",
            });
        } else {
            let bucket = this.overlayVersions.get(doc.nodeId);
            if (!bucket) {
                bucket = new Map();
                this.overlayVersions.set(doc.nodeId, bucket);
            }
            bucket.set(doc.id, versionRowOf(doc));
            this.overlayPending.set(doc.id, {
                nodeId: doc.nodeId,
                kind: "file-version",
            });
        }
    }

    // Overlay union helpers: called ONLY from the enumerated read points.
    private overlayUnionNaming(
        nodeId: string,
        rows: NamingLike[]
    ): NamingLike[] {
        if (this.bootstrapPhase !== "overlay-active") {
            return rows;
        }
        const bucket = this.overlayNaming.get(nodeId);
        if (!bucket || bucket.size === 0) {
            return rows;
        }
        const seen = new Set(rows.map((row) => row.id));
        const merged = [...rows];
        for (const [id, row] of bucket) {
            if (!seen.has(id)) {
                merged.push(row);
            }
        }
        return merged;
    }

    private overlayUnionVersions(
        nodeId: string,
        rows: VersionLike[]
    ): VersionLike[] {
        if (this.bootstrapPhase !== "overlay-active") {
            return rows;
        }
        const bucket = this.overlayVersions.get(nodeId);
        if (!bucket || bucket.size === 0) {
            return rows;
        }
        const seen = new Set(rows.map((row) => row.id));
        const merged = [...rows];
        for (const [id, row] of bucket) {
            if (!seen.has(id)) {
                merged.push(row);
            }
        }
        return merged;
    }

    private overlayUnionSweep(
        parentId: string,
        rows: NamingLike[]
    ): NamingLike[] {
        if (this.bootstrapPhase !== "overlay-active") {
            return rows;
        }
        const bucket = this.overlaySweep.get(parentId);
        if (!bucket || bucket.size === 0) {
            return rows;
        }
        const seen = new Set(rows.map((row) => row.id));
        const merged = [...rows];
        for (const [id, row] of bucket) {
            if (!seen.has(id)) {
                merged.push(row);
            }
        }
        return merged;
    }

    /**
     * Convergence tracking: a snapshot document is covered by arrival or
     * removal (change events drain overlayPending directly) or by
     * supersession — the pending id appears in the ancestor closure of a
     * locally present row (a descendant proves it was superseded and may
     * legitimately have been retired network-wide); a bare strictly-
     * deeper row counts only for single-head nodes, where the one branch
     * makes depth imply descent. Known limitation: a node PURGED
     * network-wide between snapshot and join leaves its pending entries
     * undrainable and takes the retirement-timeout path — unreachable
     * under default configs (GC grace 3d >> snapshot staleness cap 2h);
     * deployments shortening graceMs below maxSnapshotAgeMs +
     * retirementTimeoutMs accept that detour.
     */
    private startRetirementTracking() {
        this.supersessionTimer = setInterval(() => {
            void this.supersessionSweep().catch(() => {});
        }, SUPERSESSION_SWEEP_MS);
        (this.supersessionTimer as any)?.unref?.();
        this.bootstrapTimers.push(
            setTimeout(() => {
                if (this.bootstrapPhase === "overlay-active") {
                    this.retireOverlay(false);
                }
            }, this.bootstrapConfig.retirementTimeoutMs)
        );
    }

    private async supersessionSweep() {
        if (this.bootstrapPhase !== "overlay-active" || this.sweepRunning) {
            return;
        }
        if (this.overlayPending.size === 0) {
            this.maybeRetireVerified();
            return;
        }
        // While REMOTE arrivals are streaming, coverage comes from change
        // events for free; the batched query sweep only runs once the
        // stream is quiet or the residue is small. The joiner's own
        // writes must not postpone it.
        if (
            this.overlayPending.size > 5000 &&
            this.clock() - this.lastRemoteArrivalMs < SUPERSESSION_SWEEP_MS
        ) {
            return;
        }
        this.sweepRunning = true;
        try {
            await this.supersessionSweepInner();
        } finally {
            this.sweepRunning = false;
        }
    }

    private async supersessionSweepInner() {
        const byNode = new Map<string, Map<string, string>>(); // nodeId -> pendingId -> kind
        for (const [id, pending] of this.overlayPending) {
            let bucket = byNode.get(pending.nodeId);
            if (!bucket) {
                bucket = new Map();
                byNode.set(pending.nodeId, bucket);
            }
            bucket.set(id, pending.kind);
        }
        const nodeIds = [...byNode.keys()];
        for (let i = 0; i < nodeIds.length; i += HEAD_QUERY_BATCH) {
            if (this.bootstrapPhase !== "overlay-active") {
                return;
            }
            const batch = nodeIds.slice(i, i + HEAD_QUERY_BATCH);
            const rows = await this.queryRows([
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
            ]);
            const present = new Set<string>();
            const rowsByNodeKind = new Map<string, any[]>();
            for (const row of rows) {
                present.add(row.id);
                const key = `${row.nodeId}:${row.kind}`;
                let bucket = rowsByNodeKind.get(key);
                if (!bucket) {
                    bucket = [];
                    rowsByNodeKind.set(key, bucket);
                }
                bucket.push(row);
            }
            // Ancestor closure of the locally present rows: every id a
            // present row references, walked transitively through present
            // intermediates. Membership proves the pending head was
            // superseded by a DESCENDANT (a deeper row on a sibling
            // branch proves nothing — genuine conflict heads must wait
            // for the arrival cover).
            const closureOf = (key: string): Set<string> => {
                const bucket = rowsByNodeKind.get(key) ?? [];
                const byId = new Map(bucket.map((row) => [row.id, row]));
                const referenced = new Set<string>();
                const queue: any[] = [...bucket];
                while (queue.length > 0) {
                    const row = queue.pop();
                    for (const ref of row.causalRefs ?? []) {
                        if (referenced.has(ref)) {
                            continue;
                        }
                        referenced.add(ref);
                        const parent = byId.get(ref);
                        if (parent) {
                            queue.push(parent);
                        }
                    }
                }
                return referenced;
            };
            const closures = new Map<string, Set<string>>();
            for (const nodeId of batch) {
                for (const [pendingId, kind] of byNode.get(nodeId) ?? []) {
                    const rowKind =
                        kind === "naming" ? "naming" : "file-version";
                    const key = `${nodeId}:${rowKind}`;
                    let closure = closures.get(key);
                    if (!closure) {
                        closure = closureOf(key);
                        closures.set(key, closure);
                    }
                    // A compacted chain can break the closure walk; the
                    // depth fallback stays sound only when the node has a
                    // SINGLE union head (one branch: strictly deeper
                    // implies descendant).
                    const overlayRow =
                        kind === "naming"
                            ? this.overlayNaming.get(nodeId)?.get(pendingId)
                            : this.overlayVersions.get(nodeId)?.get(pendingId);
                    let depthCovered = false;
                    if (overlayRow) {
                        const localRows = rowsByNodeKind.get(key) ?? [];
                        const union = [
                            ...localRows.map((row) =>
                                kind === "naming"
                                    ? namingRowOf(row)
                                    : versionRowOf(row)
                            ),
                            ...((kind === "naming"
                                ? [
                                      ...(this.overlayNaming
                                          .get(nodeId)
                                          ?.values() ?? []),
                                  ]
                                : [
                                      ...(this.overlayVersions
                                          .get(nodeId)
                                          ?.values() ?? []),
                                  ]) as any[]),
                        ];
                        const deduped = [
                            ...new Map(
                                union.map((row) => [row.id, row])
                            ).values(),
                        ];
                        const heads =
                            kind === "naming"
                                ? (computeNamingState(nodeId, deduped as any)
                                      ?.heads ?? [])
                                : this.contentHeads(deduped as any);
                        if (heads.length === 1) {
                            const localMax = localRows.reduce(
                                (max: bigint, row: any) => {
                                    const depth = BigInt(row.causalDepth ?? 0);
                                    return depth > max ? depth : max;
                                },
                                0n
                            );
                            depthCovered = localMax > overlayRow.causalDepth;
                        }
                    }
                    if (
                        present.has(pendingId) ||
                        closure.has(pendingId) ||
                        depthCovered
                    ) {
                        this.overlayPending.delete(pendingId);
                    }
                }
            }
            await new Promise((resolve) => setImmediate(resolve));
        }
        if (this.overlayPending.size === 0) {
            this.maybeRetireVerified();
        }
    }

    private maybeRetireVerified() {
        if (this.bootstrapPhase !== "overlay-active") {
            return;
        }
        // One guard-coalescing window plus a double check: retirement must
        // not race a burst of arrivals.
        this.bootstrapTimers.push(
            setTimeout(() => {
                if (
                    this.bootstrapPhase === "overlay-active" &&
                    this.overlayPending.size === 0
                ) {
                    this.retireOverlay(true);
                }
            }, RETIRE_DOUBLE_CHECK_MS)
        );
    }

    private retireOverlay(verified: boolean) {
        this.overlayNaming = new Map();
        this.overlayVersions = new Map();
        this.overlaySweep = new Map();
        this.overlayDocs = new Map();
        this.overlayPending = new Map();
        // The row caches were filled from union reads while the overlay
        // was active; an epoch bump alone is not enough (warm buckets are
        // never re-validated on read), so clear them outright.
        this.versionRowCache = new Map();
        this.namingRowCache = new Map();
        this.slotSweepCache = new Map();
        this.cacheGlobalEpoch++;
        if (this.supersessionTimer) {
            clearInterval(this.supersessionTimer);
            this.supersessionTimer = undefined;
        }
        if (verified) {
            this.bootstrapPhase = "converged";
            this.bootstrapVerified = true;
            this.guardArmed = true;
            void this.writeBootstrapState({ bootstrap: null }).catch(() => {});
            this.events.dispatchEvent(
                new CustomEvent("bootstrap:converged", {
                    detail: { verified: true },
                })
            );
            this.resolveBootstrapWaiters({ verified: true });
            // Verified retirement is view-neutral by the coverage rules;
            // the resync is insurance against the outright cache clear.
            this.watchHub?.resyncAll("data", "bootstrap:end");
            this.changesetHub?.overlayRetired();
        } else {
            // Timeout: the local store is a valid lagging-replica view —
            // no worse than a plain join mid-sync — but Guard D stays
            // disarmed and GC gated until the store is quiescent.
            this.bootstrapPhase = "unverified";
            void this.writeBootstrapState({ bootstrap: "unverified" }).catch(
                () => {}
            );
            this.startQuiescenceChecker();
            this.events.dispatchEvent(
                new CustomEvent("bootstrap:converged", {
                    detail: { verified: false },
                })
            );
            this.resolveBootstrapWaiters({ verified: false });
            // Honest view shrink: unproven overlay docs left the served
            // tree. Latched — the quiescence path dispatches this too.
            this.watchHub?.resyncAll("overlay-timeout", "bootstrap:end");
            this.changesetHub?.overlayRetired();
        }
    }

    /**
     * Post-timeout arming: Guard D and GC come back only when the store
     * has been quiet (no document arrivals for a full window) on two
     * consecutive checks — an honest heuristic, still strictly stronger
     * than today's config-only arming.
     */
    private startQuiescenceChecker() {
        this.quiescentChecks = 0;
        this.quiescenceTimer = setInterval(() => {
            if (this.bootstrapPhase !== "unverified") {
                clearInterval(this.quiescenceTimer!);
                this.quiescenceTimer = undefined;
                return;
            }
            const quiet =
                this.clock() - this.lastArrivalMs > QUIESCENCE_WINDOW_MS;
            this.quiescentChecks = quiet ? this.quiescentChecks + 1 : 0;
            if (this.quiescentChecks >= 2) {
                clearInterval(this.quiescenceTimer!);
                this.quiescenceTimer = undefined;
                this.bootstrapPhase = "converged";
                this.guardArmed = true;
                void this.writeBootstrapState({ bootstrap: null }).catch(
                    () => {}
                );
                this.events.dispatchEvent(
                    new CustomEvent("bootstrap:converged", {
                        detail: { verified: false },
                    })
                );
                this.resolveBootstrapWaiters({ verified: false });
                this.watchHub?.resyncAll("overlay-timeout", "bootstrap:end");
                this.changesetHub?.overlayRetired();
            }
        }, QUIESCENCE_CHECK_INTERVAL_MS);
        (this.quiescenceTimer as any)?.unref?.();
    }

    /**
     * Whole-store conflict/changeset scans bypass the overlay's read
     * points; while the overlay is active they would report a different
     * world than the tree view, so they are gated (see
     * BootstrapPendingError).
     */
    private assertNotBootstrapPartial(
        operation: string,
        allowPartial: boolean | undefined
    ) {
        if (this.bootstrapPhase === "overlay-active" && !allowPartial) {
            throw new BootstrapPendingError(operation);
        }
    }

    private resolveBootstrapWaiters(result: { verified: boolean }) {
        const waiters = this.bootstrapWaiters.splice(0);
        for (const waiter of waiters) {
            waiter(result);
        }
    }

    bootstrapStatus(): BootstrapStatus {
        return {
            phase: this.bootstrapPhase,
            manifest: this.bootstrapManifestMeta
                ? {
                      ...this.bootstrapManifestMeta,
                      ageMs:
                          this.clock() -
                          Number(this.bootstrapManifestMeta.createdAtWallMs),
                  }
                : undefined,
            pendingDocs: this.overlayPending.size,
            guardArmed: this.guardArmed,
            lastFailure: this.bootstrapFailure,
            msSinceLastArrival:
                this.lastArrivalMs === 0
                    ? Number.POSITIVE_INFINITY
                    : this.clock() - this.lastArrivalMs,
        };
    }

    awaitBootstrapConverged(): Promise<{ verified: boolean }> {
        if (this.bootstrapPhase === "off") {
            return Promise.resolve({ verified: true });
        }
        if (this.bootstrapPhase === "converged") {
            return Promise.resolve({ verified: this.bootstrapVerified });
        }
        if (this.bootstrapPhase === "unverified") {
            // The overlay is already retired; only the arming heuristic
            // remains. Resolving immediately keeps callers (the CLI most
            // visibly) from blocking on a multi-minute quiescence wait.
            return Promise.resolve({ verified: false });
        }
        return new Promise((resolve) => {
            this.bootstrapWaiters.push(resolve);
        });
    }

    /**
     * Materialize this replica's GC-retained head state — every naming
     * head (deletes included) and every version head per node, as full
     * documents, no history, no chunks — into content-addressed segments
     * plus a signed manifest other parties bootstrap from. One
     * O(retained-heads) scan, same order as a GC planning pass.
     */
    async snapshotWrite(
        options: { advisoryIgnorePatterns?: string[] } = {}
    ): Promise<SnapshotWriteResult> {
        if (!this.isFullReplica()) {
            throw new SharedFsError(
                "EINVAL",
                "snapshotWrite requires a full replica (replicate: { factor: 1 })"
            );
        }
        if (
            this.trustGraph &&
            !(await this.isTrustedWriter(this.node.identity.publicKey))
        ) {
            throw new SharedFsError(
                "EINVAL",
                "snapshotWrite requires a trusted writer key"
            );
        }
        if (
            this.bootstrapPhase !== "off" &&
            this.bootstrapPhase !== "converged"
        ) {
            // Mirrors the GC gate: "unverified" positively asserts a
            // partial view, and a fresh-timestamped partial snapshot
            // would OUTRANK complete ones for every future joiner.
            throw new SharedFsError(
                "EINVAL",
                "cannot materialize a snapshot from a partial (bootstrapping or unverified) view"
            );
        }
        if (this.snapshotRunning) {
            throw new SharedFsError(
                "EINVAL",
                "snapshotWrite is already running on this instance"
            );
        }
        this.snapshotRunning = true;
        try {
            return await this.snapshotWriteInner(options);
        } finally {
            this.snapshotRunning = false;
        }
    }

    private async snapshotWriteInner(
        options: { advisoryIgnorePatterns?: string[] } = {}
    ): Promise<SnapshotWriteResult> {
        const namingRows = (
            await this.queryRows([
                new StringMatch({ key: "kind", value: "naming" }),
            ])
        ).map(namingRowOf);
        const versionRows = (
            await this.queryRows([
                new StringMatch({ key: "kind", value: "file-version" }),
            ])
        ).map(versionRowOf);
        const headIds = new Set<string>();
        const nodes = new Set<string>();
        const namingByNode = new Map<string, NamingLike[]>();
        for (const row of namingRows) {
            nodes.add(row.nodeId);
            let bucket = namingByNode.get(row.nodeId);
            if (!bucket) {
                bucket = [];
                namingByNode.set(row.nodeId, bucket);
            }
            bucket.push(row);
        }
        for (const [nodeId, rows] of namingByNode) {
            const state = computeNamingState(nodeId, rows);
            for (const head of state?.heads ?? []) {
                headIds.add(head.id);
            }
        }
        const versionsByNode = new Map<string, VersionLike[]>();
        for (const row of versionRows) {
            nodes.add(row.nodeId);
            let bucket = versionsByNode.get(row.nodeId);
            if (!bucket) {
                bucket = [];
                versionsByNode.set(row.nodeId, bucket);
            }
            bucket.push(row);
        }
        for (const rows of versionsByNode.values()) {
            for (const head of this.contentHeads(rows)) {
                headIds.add(head.id);
            }
        }
        // Resolve exactly the head documents, in batches. The shard count
        // scales with snapshot size: each segment costs the joiner one
        // block round trip against a possibly warmup-saturated donor, so
        // tiny snapshots ship in few large-ish segments while big ones
        // stay under the per-block target. (Shard assignment therefore
        // changes when the count does; cross-snapshot CID dedup is an
        // optimization, not a contract.)
        const ids = [...headIds];
        const shardCount = Math.max(
            8,
            Math.min(
                SNAPSHOT_MAX_SEGMENT_COUNT,
                Math.ceil(
                    (ids.length * SNAPSHOT_EST_DOC_BYTES) /
                        SNAPSHOT_TARGET_SEGMENT_BYTES
                )
            )
        );
        const shards = new Map<number, SharedFsEntry[]>();
        let totalBytes = 0n;
        for (let i = 0; i < ids.length; i += HEAD_QUERY_BATCH) {
            const batch = ids.slice(i, i + HEAD_QUERY_BATCH);
            const docs = await this.queryDocuments<SharedFsEntry>([
                batch.length === 1
                    ? new StringMatch({ key: "id", value: batch[0] })
                    : new Or(
                          batch.map(
                              (id) => new StringMatch({ key: "id", value: id })
                          )
                      ),
            ]);
            for (const doc of docs) {
                if (
                    !(doc instanceof NamingEvent) &&
                    !(doc instanceof FileVersion)
                ) {
                    continue;
                }
                const shard =
                    sha256Sync(fromString(doc.nodeId))[0] % shardCount;
                let bucket = shards.get(shard);
                if (!bucket) {
                    bucket = [];
                    shards.set(shard, bucket);
                }
                bucket.push(doc);
            }
        }
        const segments: SegmentRef[] = [];
        let docCount = 0n;
        for (const shard of [...shards.keys()].sort((a, b) => a - b)) {
            const docs = shards
                .get(shard)!
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            const bytes = serialize(new SnapshotSegment({ entries: docs }));
            const cid = (await (this.node.services.blocks as any).put(
                bytes
            )) as string;
            segments.push(
                new SegmentRef({
                    cid,
                    sha256: sha256Base64Sync(bytes),
                    docCount: docs.length,
                    byteLength: bytes.byteLength,
                })
            );
            docCount += BigInt(docs.length);
            totalBytes += BigInt(bytes.byteLength);
        }
        // Per-author sequence: read our previous manifest, if any.
        const manifestId = `bootstrap:${this.authorKey()}`;
        let snapshotSeq = 1n;
        const previous = await this.getDocument<SharedFsEntry>(manifestId);
        if (previous instanceof BootstrapManifest) {
            try {
                snapshotSeq =
                    deserialize(previous.payloadBytes, SnapshotManifestPayload)
                        .snapshotSeq + 1n;
            } catch {
                snapshotSeq = 1n;
            }
        }
        const payload = new SnapshotManifestPayload({
            storeId: this.id,
            snapshotSeq,
            createdAtWallMs: BigInt(Math.floor(this.clock())),
            counts: new SnapshotCounts({
                nodes: BigInt(nodes.size),
                docs: docCount,
                bytes: totalBytes,
            }),
            segments,
            advisoryIgnorePatterns:
                options.advisoryIgnorePatterns ??
                this.advisoryIgnorePublish ??
                (await this.readAdvisoryFromRulesFile()),
        });
        const payloadBytes = serialize(payload);
        if (payloadBytes.byteLength > MANIFEST_PAYLOAD_CAP_BYTES) {
            // Loud failure by design: silent skips would leave stale
            // snapshots serving joiners indefinitely.
            throw new SharedFsError(
                "EIO",
                `snapshot manifest exceeds ${MANIFEST_PAYLOAD_CAP_BYTES} bytes`
            );
        }
        const signature = await this.node.identity.sign(payloadBytes);
        const manifest = new BootstrapManifest({
            id: manifestId,
            payloadBytes,
            signatureBytes: serialize(signature),
        });
        // CUT the superseded manifest chain before publishing the new one
        // so manifest history never accumulates in the replicated log
        // (Guard D never matches manifests, so the delete is final).
        if (previous) {
            await this.entries.del(manifestId).catch(() => {});
        }
        await this.putPreferLinked(manifest);
        this.docsSinceSnapshot = 0;
        return {
            snapshotSeq,
            createdAtWallMs: payload.createdAtWallMs,
            nodes: BigInt(nodes.size),
            docs: docCount,
            bytes: totalBytes,
            segments: segments.length,
            manifestId,
        };
    }

    /**
     * Automatic snapshot publication on long-running trusted full
     * replicas; skipped while too little changed. Failures are loud.
     */
    /**
     * Publisher fallback: a snapshot replica opened WITHOUT an ignore
     * policy still advertises the fleet's durable rules — the replicated
     * rules file is read and validated at publish time (signed manifest
     * data either way; invalid content embeds nothing).
     */
    private async readAdvisoryFromRulesFile(): Promise<string[] | undefined> {
        try {
            const content = await this.readFile("/.artifactignore");
            if (!content) {
                return undefined;
            }
            const lines = new TextDecoder()
                .decode(content)
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0 && !line.startsWith("#"));
            if (lines.length === 0) {
                return undefined;
            }
            compileIgnoreRules(lines);
            return lines;
        } catch {
            return undefined;
        }
    }

    private startSnapshotPublisher() {
        if (this.snapshotConfig.disabled || !this.isFullReplica()) {
            return;
        }
        const tick = async () => {
            // Publish only from a whole view: a plain replica ("off") or
            // a VERIFIED converged bootstrap — never from "unverified" or
            // quiescence-armed states, whose fresh timestamps would
            // outrank complete snapshots for every future joiner.
            if (
                !(
                    this.bootstrapPhase === "off" ||
                    (this.bootstrapPhase === "converged" &&
                        this.bootstrapVerified)
                )
            ) {
                return;
            }
            let due =
                this.docsSinceSnapshot >= this.snapshotConfig.minChangesBetween;
            if (!due) {
                // Quiet stores must not lose their bootstrap: joiners
                // reject manifests older than the staleness cap, so
                // refresh an aging (or missing) manifest even with no
                // changes — unchanged shards dedup to identical blocks.
                const previous = await this.getDocument<SharedFsEntry>(
                    `bootstrap:${this.authorKey()}`
                );
                if (previous instanceof BootstrapManifest) {
                    try {
                        const payload = deserialize(
                            previous.payloadBytes,
                            SnapshotManifestPayload
                        );
                        due =
                            this.clock() - Number(payload.createdAtWallMs) >
                            BOOTSTRAP_DEFAULTS.maxSnapshotAgeMs / 2;
                    } catch {
                        due = true;
                    }
                } else {
                    due = true;
                }
            }
            if (!due) {
                return;
            }
            // Never publish an empty view (an unreachable network or a
            // brand-new store): require at least one naming row.
            const probe = this.entries.index.iterate(
                {
                    query: [new StringMatch({ key: "kind", value: "naming" })],
                },
                { local: true, remote: false, resolve: false }
            );
            let populated: boolean;
            try {
                populated = (await probe.next(1)).length > 0;
            } finally {
                await (probe as any).close?.();
            }
            if (!populated) {
                return;
            }
            await this.snapshotWrite().catch((error: any) => {
                console.error(
                    "shared-fs: scheduled snapshot publication failed:",
                    error?.message ?? error
                );
            });
        };
        this.snapshotTimer = setInterval(() => {
            void tick().catch(() => {});
        }, this.snapshotConfig.publishIntervalMs);
        (this.snapshotTimer as any)?.unref?.();
        // First check soon after open so a populated replica with no (or
        // an aging) manifest does not wait a full interval.
        const early = setTimeout(() => {
            void tick().catch(() => {});
        }, 60_000);
        (early as any)?.unref?.();
        this.bootstrapTimers.push(early);
    }

    // ------------------------------------------------------------------
    // Garbage collection
    // ------------------------------------------------------------------

    private pinVersions(ids: string[]) {
        const expires = this.clock() + GC_PIN_TTL_MS;
        for (const id of ids) {
            this.versionPins.set(id, expires);
        }
    }

    private activePins(): Set<string> {
        const now = this.clock();
        const active = new Set<string>();
        for (const [id, expiry] of this.versionPins) {
            if (expiry >= now) {
                active.add(id);
            } else {
                this.versionPins.delete(id);
            }
        }
        return active;
    }

    /**
     * Guard D: veto by resurrection. Whenever a document this replica still
     * needs is removed (a collector elsewhere raced local state), re-put it
     * from the removed value carried by the change event. Only adds data,
     * idempotent, cannot loop (re-puts arrive as additions).
     */
    /**
     * Metadata removals queued for coalesced guard evaluation. Deletions
     * replicate as many independent CUT entries whose change events race the
     * index; evaluating per event produces gap states where a superseded
     * ancestor briefly looks like a head. Coalescing a quiet window turns an
     * entire purge burst into ONE coherent evaluation per node — and caps
     * the guard's cost per burst instead of per removed document.
     */
    private watchHub?: WatchHub;
    private changesetHub?: ChangesetBarrierHub;
    private guardFlushBusy = false;
    private pendingGuardVersions = new Map<string, Map<string, FileVersion>>();
    private pendingGuardNaming = new Map<string, Map<string, NamingEvent>>();
    private guardFlushTimer: ReturnType<typeof setTimeout> | undefined;

    private scheduleGuardFlush() {
        if (this.guardFlushTimer) {
            return;
        }
        this.guardFlushTimer = setTimeout(() => {
            this.guardFlushTimer = undefined;
            void this.flushGuardQueues().catch(() => {});
        }, 300);
        (this.guardFlushTimer as any)?.unref?.();
    }

    private async guardAgainstLiveRemovals(removed: unknown[]) {
        if (!this.guardArmed) {
            return;
        }
        for (const value of removed) {
            try {
                if (value instanceof FileChunk) {
                    if (this.gcSuppressed.has(value.id)) {
                        continue;
                    }
                    if (!this.verifyChunk(value, value.id)) {
                        continue;
                    }
                    const iterator = this.entries.index.iterate(
                        {
                            query: [
                                new StringMatch({
                                    key: "kind",
                                    value: "file-version",
                                }),
                                new StringMatch({
                                    key: "chunkRefs",
                                    value: value.id,
                                }),
                            ],
                        },
                        { local: true, remote: false, resolve: false }
                    );
                    let referenced: boolean;
                    try {
                        referenced = (await iterator.next(1)).length > 0;
                    } finally {
                        await (iterator as any).close?.();
                    }
                    if (referenced) {
                        await this.putPreferLinked(value);
                    }
                } else if (value instanceof FileVersion) {
                    if (this.gcSuppressed.has(value.id)) {
                        continue;
                    }
                    const bucket =
                        this.pendingGuardVersions.get(value.nodeId) ??
                        new Map<string, FileVersion>();
                    bucket.set(value.id, value);
                    this.pendingGuardVersions.set(value.nodeId, bucket);
                    this.scheduleGuardFlush();
                } else if (value instanceof NamingEvent) {
                    if (this.gcSuppressed.has(value.id)) {
                        continue;
                    }
                    const bucket =
                        this.pendingGuardNaming.get(value.nodeId) ??
                        new Map<string, NamingEvent>();
                    bucket.set(value.id, value);
                    this.pendingGuardNaming.set(value.nodeId, bucket);
                    this.scheduleGuardFlush();
                }
            } catch {
                // The guard must never throw into the event loop.
            }
        }
    }

    private async flushGuardQueues() {
        // Work enqueued while armed must not run after a disarm (a
        // bootstrap decided mid-window): resurrection judged against a
        // partial view — possibly through the overlay — is exactly what
        // the disarm exists to prevent. Queued buckets are dropped.
        if (!this.guardArmed) {
            this.pendingGuardVersions.clear();
            this.pendingGuardNaming.clear();
            return;
        }
        this.guardFlushBusy = true;
        let settledNodes: string[] = [];
        try {
            settledNodes = await this.flushGuardQueuesInner();
        } finally {
            this.guardFlushBusy = false;
        }
        // Quarantined watch losses re-check as soon as the guard's async
        // work for their nodes is done, instead of racing a constant.
        this.watchHub?.guardSettled(settledNodes);
    }

    private async flushGuardQueuesInner(): Promise<string[]> {
        const removedVersions = new Map<string, FileVersion[]>();
        for (const [nodeId, bucket] of this.pendingGuardVersions) {
            removedVersions.set(nodeId, [...bucket.values()]);
        }
        this.pendingGuardVersions.clear();
        const removedNaming = new Map<string, NamingEvent[]>();
        for (const [nodeId, bucket] of this.pendingGuardNaming) {
            removedNaming.set(nodeId, [...bucket.values()]);
        }
        this.pendingGuardNaming.clear();
        for (const [nodeId, values] of removedVersions) {
            try {
                // Decisions run on the resolved-document plane end to end:
                // mixing cache-backed naming with fresh version queries can
                // act on inconsistent snapshots.
                const namingDocs = await this.queryDocuments<NamingEvent>([
                    new StringMatch({ key: "kind", value: "naming" }),
                    new StringMatch({ key: "nodeId", value: nodeId }),
                ]);
                const naming = computeNamingState(
                    nodeId,
                    namingDocs.filter(
                        (doc): doc is NamingEvent => doc instanceof NamingEvent
                    )
                );
                if (!naming) {
                    continue;
                }
                const removedIds = new Set(values.map((value) => value.id));
                const remaining = (
                    await this.versionDocumentsForNode(nodeId)
                ).filter((doc) => !removedIds.has(doc.id));
                const heads = this.contentHeads([...remaining, ...values]);
                const observed = new Set(
                    naming.winner.deleted
                        ? (naming.winner as NamingEvent).observedContentHeads
                        : []
                );
                // Purge discriminator: a genuine delete-vs-edit recoverable
                // (an edit the delete never saw) always coexists with a
                // still-present observed version, because purge only runs
                // once EVERY head is observed — and then removes them all.
                // When no observed version survives locally, unobserved
                // "heads" are purge remnants arriving out of order, not
                // recoverable edits.
                const observedPresent = remaining.some((doc) =>
                    observed.has(doc.id)
                );
                for (const value of values) {
                    const isHead = heads.some((head) => head.id === value.id);
                    if (!isHead) {
                        continue;
                    }
                    const protectedHead = naming.winner.deleted
                        ? !observed.has(value.id) && observedPresent
                        : true;
                    if (protectedHead) {
                        await this.putPreferLinked(value);
                    }
                }
            } catch {
                // Never throw into the event loop.
            }
        }
        for (const [nodeId, values] of removedNaming) {
            try {
                const removedIds = new Set(values.map((value) => value.id));
                const namingDocs = await this.queryDocuments<NamingEvent>([
                    new StringMatch({ key: "kind", value: "naming" }),
                    new StringMatch({ key: "nodeId", value: nodeId }),
                ]);
                const remaining = namingDocs
                    .filter(
                        (doc): doc is NamingEvent => doc instanceof NamingEvent
                    )
                    .filter((event) => !removedIds.has(event.id));
                const state = computeNamingState(nodeId, [
                    ...remaining,
                    ...values,
                ]);
                if (!state) {
                    continue;
                }
                for (const value of values) {
                    if (state.heads.some((head) => head.id === value.id)) {
                        await this.putPreferLinked(value);
                    }
                }
            } catch {
                // Never throw into the event loop.
            }
        }
        return [...removedVersions.keys(), ...removedNaming.keys()];
    }

    private async gcLedgerPath(): Promise<string | undefined> {
        const directory = (this.node as any)?.directory as string | undefined;
        if (!directory) {
            return undefined;
        }
        const { mkdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const dir = join(directory, "shared-fs-gc");
        await mkdir(dir, { recursive: true });
        return join(dir, `${this.address?.toString() ?? "unaddressed"}.json`);
    }

    private async loadGcLedger(): Promise<GcLedger> {
        const empty: GcLedger = {
            chunkCandidates: {},
            purgeCandidates: {},
            lastRunMs: 0,
        };
        const path = await this.gcLedgerPath();
        if (!path) {
            this.memoryLedger ??= empty;
            return this.memoryLedger;
        }
        try {
            const { readFile } = await import("node:fs/promises");
            const parsed = JSON.parse(await readFile(path, "utf8"));
            return {
                chunkCandidates: parsed.chunkCandidates ?? {},
                purgeCandidates: parsed.purgeCandidates ?? {},
                lastRunMs: parsed.lastRunMs ?? 0,
            };
        } catch {
            return empty;
        }
    }

    private async saveGcLedger(ledger: GcLedger) {
        const path = await this.gcLedgerPath();
        if (!path) {
            this.memoryLedger = ledger;
            return;
        }
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, JSON.stringify(ledger));
    }

    /**
     * Context.modified in milliseconds regardless of the underlying clock
     * scale (wall-clock nanoseconds vs milliseconds), detected by magnitude.
     */
    private contextModifiedMs(context: any): number {
        const raw = Number(context?.modified ?? 0);
        return raw > 1e15 ? raw / 1e6 : raw;
    }

    /**
     * H0-verified chunk delete: resolve the bytes first (the only recovery
     * source once the CUT prunes the chain), delete, and when the CUT landed
     * on a head other than the one eligibility was computed against (a
     * concurrent re-put won the race) restore the chunk and count the
     * recovery instead of the deletion. Chunk ids are intentionally NOT
     * added to gcSuppressed: with refcount genuinely zero the resurrection
     * guard cannot fire, and suppressing it would blind this replica's only
     * local defense during the sweep window.
     */
    private async deleteChunkVerified(
        chunkId: string,
        expectedHead: string | undefined,
        sizeHint: number,
        report: GcReport
    ) {
        const value = await this.getDocument<FileChunk>(chunkId);
        try {
            const result: any = await this.entries.del(chunkId);
            const cutTarget = result?.entry?.meta?.next?.[0];
            if (expectedHead && cutTarget && cutTarget !== expectedHead) {
                if (value instanceof FileChunk) {
                    await this.entries.put(value);
                }
                report.cutRecoveries++;
                return;
            }
            report.deletedChunks++;
            report.reclaimedChunkBytes += BigInt(sizeHint);
        } catch (error) {
            if (!(error instanceof NotFoundError)) {
                throw error;
            }
        }
    }

    private gcRunning = false;

    async collectGarbage(options: GcOptions = {}): Promise<GcReport> {
        // A fresh open may still be deciding whether to bootstrap (a few
        // seconds of manifest discovery); wait that decision out instead
        // of failing spuriously.
        await this.bootstrapDecision.catch(() => {});
        if (
            this.bootstrapPhase !== "off" &&
            this.bootstrapPhase !== "converged"
        ) {
            // Belt and braces over the arrival-age and empty-ledger
            // shields: a partial (bootstrapping or unverified) replica
            // must not plan retirements at all.
            throw new SharedFsError(
                "EINVAL",
                "collectGarbage is unavailable until the cold-start bootstrap converges"
            );
        }
        if (this.gcRunning) {
            throw new SharedFsError(
                "EINVAL",
                "collectGarbage is already running on this instance"
            );
        }
        this.gcRunning = true;
        try {
            return await this.collectGarbageInner(options);
        } finally {
            this.gcRunning = false;
            // Suppression must never outlive the run — a leaked id would
            // permanently blind Guard D for exactly the documents an aborted
            // run was deleting.
            this.gcSuppressed.clear();
        }
    }

    private async collectGarbageInner(
        options: GcOptions = {}
    ): Promise<GcReport> {
        if (!this.isFullReplica()) {
            throw new SharedFsError(
                "EINVAL",
                "collectGarbage requires a full replica (replicate: { factor: 1 })"
            );
        }
        if (
            this.trustGraph &&
            !(await this.isTrustedWriter(this.node.identity.publicKey))
        ) {
            throw new SharedFsError(
                "EINVAL",
                "collectGarbage requires a trusted writer key"
            );
        }
        const config = {
            keepVersions: options.keepVersions ?? GC_DEFAULTS.keepVersions,
            retentionMs: options.retentionMs ?? GC_DEFAULTS.retentionMs,
            graceMs: options.graceMs ?? GC_DEFAULTS.graceMs,
            chunkGraceMs: options.chunkGraceMs ?? GC_DEFAULTS.chunkGraceMs,
            namingGraceMs: options.namingGraceMs ?? GC_DEFAULTS.namingGraceMs,
            settleMs: options.settleMs ?? GC_DEFAULTS.settleMs,
            minOrphanSpanMs:
                options.minOrphanSpanMs ?? GC_DEFAULTS.minOrphanSpanMs,
            chunkSweep: options.chunkSweep ?? ("ledger" as const),
            scope: options.scope,
            dryRun: options.dryRun ?? false,
            nowMs: options.nowMs ?? this.clock(),
        };
        const report: GcReport = {
            dryRun: config.dryRun,
            healedChunks: 0,
            damagedNodeIds: [],
            retiredVersions: 0,
            compactedNamingEvents: 0,
            purgedNodes: 0,
            deletedChunks: 0,
            reclaimedChunkBytes: 0n,
            chunkCandidatesRecorded: 0,
            purgeCandidatesRecorded: 0,
            conflictedNodes: 0,
            cutRecoveries: 0,
            manifestsRetired: 0,
            warnings: [],
        };
        // W1's dedup-skip safety depends on the invariant skipHorizon <=
        // retention - max(grace, 48h): a witness version younger than the
        // horizon must be unretirable everywhere while a new write
        // propagates. The horizon is fixed at authoring time, so retention
        // is clamped up rather than letting an aggressive option break W1.
        // Fixed 48h propagation slack regardless of horizon: short horizons
        // must not also shorten the window a slow replica has to object.
        const retentionFloor =
            this.skipHorizonMs + Math.max(config.graceMs, 2 * DAY_MS);
        if (config.retentionMs < retentionFloor) {
            report.warnings.push(
                `retentionMs raised to ${retentionFloor} to preserve the dedup-skip safety invariant`
            );
            config.retentionMs = retentionFloor;
        }
        const loaded = await this.loadGcLedger();
        const ledger: GcLedger = config.dryRun
            ? JSON.parse(JSON.stringify(loaded))
            : loaded;
        const runStartedMs = config.nowMs;

        const sleep = (ms: number) =>
            new Promise((resolve) => setTimeout(resolve, ms));

        // ---------------- PLAN (pure function of the local set) -----------
        const buildPlan = async () => {
            const pins = this.activePins();
            const namingDocs = await this.queryDocuments<NamingEvent>([
                new StringMatch({ key: "kind", value: "naming" }),
            ]);
            const namingByNode = new Map<string, NamingEvent[]>();
            for (const event of namingDocs) {
                const list = namingByNode.get(event.nodeId) ?? [];
                list.push(event);
                namingByNode.set(event.nodeId, list);
            }
            const namingStates = new Map<string, NodeNamingState>();
            for (const [nodeId, events] of namingByNode) {
                const state = computeNamingState(nodeId, events);
                if (state) {
                    namingStates.set(nodeId, state);
                }
            }
            const versionDocs = await this.queryDocuments<SharedFsEntry>([
                new StringMatch({ key: "kind", value: "file-version" }),
            ]);
            const versionsByNode = new Map<string, FileVersion[]>();
            for (const doc of versionDocs) {
                if (doc instanceof FileVersion) {
                    const list = versionsByNode.get(doc.nodeId) ?? [];
                    list.push(doc);
                    versionsByNode.set(doc.nodeId, list);
                }
            }
            // Arrival times (Context.modified) via one index-only pass.
            const modifiedMs = new Map<string, number>();
            const rows = await this.entries.index
                .iterate(
                    {
                        query: [
                            new Or([
                                new StringMatch({
                                    key: "kind",
                                    value: "file-version",
                                }),
                                new StringMatch({
                                    key: "kind",
                                    value: "naming",
                                }),
                            ]),
                        ],
                    },
                    { local: true, remote: false, resolve: false }
                )
                .all();
            for (const row of rows as any[]) {
                modifiedMs.set(row.id, this.contextModifiedMs(row.__context));
            }
            const ageOk = (
                doc: { id: string; createdAt: bigint },
                ms: number
            ) =>
                Number(doc.createdAt) <= runStartedMs - ms &&
                (modifiedMs.get(doc.id) ?? runStartedMs) <= runStartedMs - ms;

            const conflictedNodeIds = new Set<string>();
            for (const conflict of await this.namingConflicts()) {
                conflictedNodeIds.add(conflict.nodeId);
                for (const shadowed of conflict.shadowedNodeIds ?? []) {
                    conflictedNodeIds.add(shadowed);
                }
            }
            report.conflictedNodes = conflictedNodeIds.size;

            let scopeNodeIds: Set<string> | undefined;
            if (config.scope) {
                const prefix = normalizeFsPath(config.scope);
                scopeNodeIds = new Set();
                const cache = new Map<string, NodeNamingState>(namingStates);
                for (const nodeId of namingStates.keys()) {
                    const path = await this.pathForNode(nodeId, cache);
                    if (
                        prefix === "/" ||
                        path === prefix ||
                        path.startsWith(prefix + "/")
                    ) {
                        scopeNodeIds.add(nodeId);
                    }
                }
            }
            const inScope = (nodeId: string) =>
                !scopeNodeIds || scopeNodeIds.has(nodeId);

            type DagPlan = {
                retire: Map<string, FileVersion | NamingEvent>;
            };
            const planDag = <T extends { id: string; createdAt: bigint }>(
                docs: T[],
                parentsOf: (doc: T) => string[],
                heads: T[],
                keep: Set<string>
            ): Map<string, T> => {
                const byId = new Map(docs.map((doc) => [doc.id, doc]));
                const children = new Map<string, string[]>();
                for (const doc of docs) {
                    for (const parent of parentsOf(doc)) {
                        if (byId.has(parent)) {
                            const list = children.get(parent) ?? [];
                            list.push(doc.id);
                            children.set(parent, list);
                        }
                    }
                }
                const ancestorMemo = new Map<string, Set<string>>();
                const ancestorsOf = (id: string): Set<string> => {
                    const memo = ancestorMemo.get(id);
                    if (memo) {
                        return memo;
                    }
                    const out = new Set<string>();
                    ancestorMemo.set(id, out); // cycle guard
                    const doc = byId.get(id);
                    if (doc) {
                        for (const parent of parentsOf(doc)) {
                            if (byId.has(parent)) {
                                out.add(parent);
                                for (const deep of ancestorsOf(parent)) {
                                    out.add(deep);
                                }
                            }
                        }
                    }
                    return out;
                };
                // Strict COMMON ancestors of every head: conflicted nodes
                // compact shared history only; branch-exclusive documents
                // stay until the conflict resolves.
                let common: Set<string> | undefined;
                for (const head of heads) {
                    const ancestors = ancestorsOf(head.id);
                    common = common
                        ? new Set([...common].filter((id) => ancestors.has(id)))
                        : new Set(ancestors);
                }
                const retire = new Map<string, T>();
                for (const id of common ?? []) {
                    if (!keep.has(id)) {
                        const doc = byId.get(id);
                        if (doc) {
                            retire.set(id, doc);
                        }
                    }
                }
                // Grace-closure fixpoint: never leave a surviving doc whose
                // every present child is being retired — deleting them would
                // promote the survivor to a spurious head.
                let changed = true;
                while (changed) {
                    changed = false;
                    for (const doc of docs) {
                        if (retire.has(doc.id)) {
                            continue;
                        }
                        const kids = children.get(doc.id) ?? [];
                        if (
                            kids.length > 0 &&
                            kids.every((kid) => retire.has(kid))
                        ) {
                            for (const kid of kids) {
                                retire.delete(kid);
                                changed = true;
                            }
                        }
                    }
                }
                return retire;
            };

            // Version retirement per node.
            const versionRetire = new Map<string, FileVersion>();
            for (const [nodeId, docs] of versionsByNode) {
                if (!inScope(nodeId)) {
                    continue;
                }
                const naming = namingStates.get(nodeId);
                const heads = this.contentHeads(docs);
                const keep = new Set<string>();
                for (const head of heads) {
                    keep.add(head.id);
                }
                if (naming?.winner.deleted) {
                    const observed = new Set(
                        (naming.winner as NamingEvent).observedContentHeads
                    );
                    for (const doc of docs) {
                        // Recoverables and everything the delete observed.
                        if (!observed.has(doc.id)) {
                            keep.add(doc.id);
                        }
                    }
                    for (const id of observed) {
                        keep.add(id);
                    }
                }
                const newest = [...docs].sort(
                    (a, b) =>
                        Number(b.createdAt) - Number(a.createdAt) ||
                        compareIds(b.id, a.id)
                );
                for (const doc of newest.slice(0, config.keepVersions)) {
                    keep.add(doc.id);
                }
                for (const doc of docs) {
                    if (!ageOk(doc, config.retentionMs)) {
                        keep.add(doc.id);
                    }
                    if (!ageOk(doc, config.graceMs)) {
                        keep.add(doc.id);
                    }
                    if (pins.has(doc.id)) {
                        keep.add(doc.id);
                    }
                }
                // Witness rule: a doc is only retirable when some strict
                // present descendant is itself grace-old (supersession must
                // be causal AND settled).
                const byId = new Map(docs.map((doc) => [doc.id, doc]));
                const descendants = new Map<string, Set<string>>();
                for (const doc of docs) {
                    for (const parent of doc.parentVersionIds) {
                        if (byId.has(parent)) {
                            const set = descendants.get(parent) ?? new Set();
                            set.add(doc.id);
                            descendants.set(parent, set);
                        }
                    }
                }
                const hasSettledDescendant = (id: string): boolean => {
                    const seen = new Set<string>();
                    const queue = [...(descendants.get(id) ?? [])];
                    while (queue.length > 0) {
                        const next = queue.pop()!;
                        if (seen.has(next)) {
                            continue;
                        }
                        seen.add(next);
                        const doc = byId.get(next);
                        if (doc && ageOk(doc, config.graceMs)) {
                            return true;
                        }
                        for (const deep of descendants.get(next) ?? []) {
                            queue.push(deep);
                        }
                    }
                    return false;
                };
                for (const doc of docs) {
                    if (!keep.has(doc.id) && !hasSettledDescendant(doc.id)) {
                        keep.add(doc.id);
                    }
                }
                const retire = planDag(
                    docs,
                    (doc) => doc.parentVersionIds,
                    heads,
                    keep
                );
                for (const [id, doc] of retire) {
                    versionRetire.set(id, doc);
                }
            }

            // Naming compaction per eligible node.
            const namingRetire = new Map<string, NamingEvent>();
            for (const [nodeId, state] of namingStates) {
                if (!inScope(nodeId) || conflictedNodeIds.has(nodeId)) {
                    continue;
                }
                if (
                    !state.heads.every((head) =>
                        ageOk(head, config.namingGraceMs)
                    )
                ) {
                    continue;
                }
                const keep = new Set<string>();
                for (const head of state.heads) {
                    keep.add(head.id);
                }
                for (const event of state.events) {
                    if (!ageOk(event, config.namingGraceMs)) {
                        keep.add(event.id);
                    }
                }
                const retire = planDag(
                    state.events as NamingEvent[],
                    (event) => event.parentNamingIds,
                    state.heads as NamingEvent[],
                    keep
                );
                for (const [id, event] of retire) {
                    namingRetire.set(id, event);
                }
            }

            // Purge candidates (the only place content heads die).
            const purgeReady = new Map<string, string>(); // nodeId -> winner event id
            for (const [nodeId, state] of namingStates) {
                if (
                    !inScope(nodeId) ||
                    nodeKindOf(nodeId) !== "file" ||
                    conflictedNodeIds.has(nodeId)
                ) {
                    continue;
                }
                if (!state.winner.deleted || state.heads.length !== 1) {
                    continue;
                }
                const wall = Math.max(config.retentionMs, config.graceMs);
                if (!state.heads.every((head) => ageOk(head, wall))) {
                    continue;
                }
                const docs = versionsByNode.get(nodeId) ?? [];
                const heads = this.contentHeads(docs);
                const observed = new Set(
                    (state.winner as NamingEvent).observedContentHeads
                );
                if (!heads.every((head) => observed.has(head.id))) {
                    continue;
                }
                purgeReady.set(nodeId, state.winner.id);
            }

            return {
                versionRetire,
                namingRetire,
                purgeReady,
                versionsByNode,
                namingStates,
            };
        };

        let plan = await buildPlan();

        // ---------------- HEAL --------------------------------------------
        const damaged = new Set<string>();
        if (!config.dryRun) {
            // Dedup shared chunks across all surviving versions: one probe
            // (and at most one heal attempt) per distinct chunk id.
            const owners = new Map<string, Set<string>>();
            for (const [nodeId, docs] of plan.versionsByNode) {
                for (const doc of docs) {
                    if (plan.versionRetire.has(doc.id)) {
                        continue;
                    }
                    for (const chunkId of new Set(doc.chunkIds)) {
                        const set = owners.get(chunkId) ?? new Set<string>();
                        set.add(nodeId);
                        owners.set(chunkId, set);
                    }
                }
            }
            await mapWithConcurrency(
                [...owners.entries()],
                CHUNK_IO_CONCURRENCY,
                async ([chunkId, nodeIds]) => {
                    if (await this.hasDocument(chunkId)) {
                        return;
                    }
                    try {
                        const healed = await this.fetchChunk(chunkId, chunkId);
                        await this.entries.put(healed, { unique: true });
                        report.healedChunks++;
                    } catch {
                        for (const nodeId of nodeIds) {
                            damaged.add(nodeId);
                        }
                    }
                }
            );
            for (const nodeId of damaged) {
                report.warnings.push(
                    `node ${nodeId} has unrecoverable missing chunks; excluded from all deletion this run`
                );
            }
        }
        report.damagedNodeIds = [...damaged];

        // ---------------- SETTLE + REVALIDATE -----------------------------
        if (!config.dryRun && config.settleMs > 0) {
            await sleep(config.settleMs);
        }
        const settled = await buildPlan();
        const retireVersions = new Map(
            [...plan.versionRetire].filter(
                ([id, doc]) =>
                    settled.versionRetire.has(id) && !damaged.has(doc.nodeId)
            )
        );
        const retireNaming = new Map(
            [...plan.namingRetire].filter(
                ([id, event]) =>
                    settled.namingRetire.has(id) && !damaged.has(event.nodeId)
            )
        );
        const purgeReady = new Map(
            [...plan.purgeReady].filter(
                ([nodeId, winnerId]) =>
                    settled.purgeReady.get(nodeId) === winnerId &&
                    !damaged.has(nodeId)
            )
        );

        // ---------------- EXECUTE (metadata, parents before children) -----
        const executeDeletes = async (
            docs: (FileVersion | NamingEvent)[]
        ): Promise<number> => {
            let deleted = 0;
            const ordered = [...docs].sort(
                (a, b) =>
                    compareBigint(a.causalDepth, b.causalDepth) ||
                    compareIds(a.id, b.id)
            );
            for (const doc of ordered) {
                const row = (await this.entries.index.get(doc.id, {
                    local: true,
                    remote: false,
                    resolve: false,
                })) as any;
                if (!row) {
                    continue; // concurrent collector won
                }
                const expectedHead = row.__context?.head;
                this.gcSuppressed.add(doc.id);
                try {
                    const result: any = await this.entries.del(doc.id);
                    const cutTarget = result?.entry?.meta?.next?.[0];
                    if (
                        expectedHead &&
                        cutTarget &&
                        cutTarget !== expectedHead
                    ) {
                        // The CUT landed on a concurrent re-put, not on the
                        // head we planned against: restore the immutable
                        // value we hold (linking whatever survives — a
                        // concurrent chain demonstrably exists) and count
                        // the recovery.
                        await this.entries.put(doc);
                        report.cutRecoveries++;
                        continue;
                    }
                    deleted++;
                } catch (error) {
                    if (!(error instanceof NotFoundError)) {
                        throw error;
                    }
                }
            }
            return deleted;
        };

        if (!config.dryRun) {
            report.retiredVersions = await executeDeletes([
                ...retireVersions.values(),
            ]);
            report.compactedNamingEvents = await executeDeletes([
                ...retireNaming.values(),
            ]);
        } else {
            report.retiredVersions = retireVersions.size;
            report.compactedNamingEvents = retireNaming.size;
        }

        // ---------------- PURGE + CHUNK SWEEP (two-run barrier) -----------
        const spanReady = (firstSeenMs: number) =>
            config.chunkSweep === "immediate" ||
            (firstSeenMs <= runStartedMs - config.minOrphanSpanMs &&
                firstSeenMs <= ledger.lastRunMs);

        // Purge execution (recorded on a previous run, fully re-verified).
        const purgeExecuted: string[] = [];
        for (const [nodeId, record] of Object.entries(ledger.purgeCandidates)) {
            if (!spanReady(record.firstSeenMs)) {
                continue;
            }
            if (purgeReady.get(nodeId) !== record.winnerEventId) {
                delete ledger.purgeCandidates[nodeId];
                continue;
            }
            if (!config.dryRun) {
                const docs = settled.versionsByNode.get(nodeId) ?? [];
                await executeDeletes(docs);
                purgeExecuted.push(nodeId);
            }
            delete ledger.purgeCandidates[nodeId];
        }
        report.purgedNodes = purgeExecuted.length;
        for (const [nodeId, winnerId] of purgeReady) {
            if (
                !purgeExecuted.includes(nodeId) &&
                !ledger.purgeCandidates[nodeId]
            ) {
                ledger.purgeCandidates[nodeId] = {
                    firstSeenMs: runStartedMs,
                    winnerEventId: winnerId,
                };
                report.purgeCandidatesRecorded++;
            }
        }

        if (!config.dryRun && config.settleMs > 0) {
            // Let version CUTs propagate before chunk CUTs so remotes see
            // dereference-then-delete, not the reverse.
            await sleep(config.settleMs);
        }

        // Chunk candidates: refcount 0 against the post-retirement index and
        // old enough by arrival time.
        const chunkRows = (await this.entries.index
            .iterate(
                {
                    query: [
                        new StringMatch({ key: "kind", value: "file-chunk" }),
                    ],
                },
                { local: true, remote: false, resolve: false }
            )
            .all()) as any[];
        const orphaned = new Map<string, any>();
        const graceOldRows = chunkRows.filter(
            (row) =>
                this.contextModifiedMs(row.__context) <=
                runStartedMs - config.chunkGraceMs
        );
        await mapWithConcurrency(
            graceOldRows,
            CHUNK_IO_CONCURRENCY,
            async (row) => {
                const iterator = this.entries.index.iterate(
                    {
                        query: [
                            new StringMatch({
                                key: "kind",
                                value: "file-version",
                            }),
                            new StringMatch({
                                key: "chunkRefs",
                                value: row.id,
                            }),
                        ],
                    },
                    { local: true, remote: false, resolve: false }
                );
                let referenced: boolean;
                try {
                    referenced = (await iterator.next(1)).length > 0;
                } finally {
                    await (iterator as any).close?.();
                }
                if (!referenced) {
                    orphaned.set(row.id, row);
                }
            }
        );
        for (const [chunkId, record] of Object.entries(
            ledger.chunkCandidates
        )) {
            const row = orphaned.get(chunkId);
            if (!row) {
                delete ledger.chunkCandidates[chunkId];
                continue;
            }
            if (!spanReady(record.firstSeenMs)) {
                continue;
            }
            if (!config.dryRun) {
                await this.deleteChunkVerified(
                    chunkId,
                    row.__context?.head,
                    Number(row.__context?.size ?? 0),
                    report
                );
            }
            delete ledger.chunkCandidates[chunkId];
            orphaned.delete(chunkId);
        }
        if (config.chunkSweep === "immediate") {
            for (const [chunkId, row] of orphaned) {
                if (config.dryRun) {
                    report.chunkCandidatesRecorded++;
                    continue;
                }
                await this.deleteChunkVerified(
                    chunkId,
                    row.__context?.head,
                    Number(row.__context?.size ?? 0),
                    report
                );
            }
        } else {
            for (const chunkId of orphaned.keys()) {
                if (!ledger.chunkCandidates[chunkId]) {
                    ledger.chunkCandidates[chunkId] = {
                        firstSeenMs: runStartedMs,
                    };
                    report.chunkCandidatesRecorded++;
                }
            }
        }

        // Changeset-manifest sweep: retire membership records whose LOCAL
        // arrival age exceeds the retention window. Arrival age cannot be
        // forged remotely (a future-dated createdAtWallMs stamp neither
        // dodges this sweep nor survives the 1h ingest skew bound), and it
        // protects late-replicating old manifests, which arrive young.
        // Guard D never matches manifests, so the deletes are final; live
        // trackers observe the removal and resolve their waiters honestly.
        {
            const manifestAgeMs = Math.max(config.retentionMs, config.graceMs);
            const manifestRows = (await this.entries.index
                .iterate(
                    {
                        query: [
                            new StringMatch({
                                key: "kind",
                                value: "changeset-manifest",
                            }),
                        ],
                    },
                    { local: true, remote: false, resolve: false }
                )
                .all()) as any[];
            for (const row of manifestRows) {
                const arrivalMs = this.contextModifiedMs(row.__context);
                if (arrivalMs > runStartedMs - manifestAgeMs) {
                    continue;
                }
                if (!config.dryRun) {
                    await this.entries.del(row.id);
                }
                report.manifestsRetired++;
            }
        }

        ledger.lastRunMs = runStartedMs;
        if (!config.dryRun) {
            await this.saveGcLedger(ledger);
        }
        if (report.chunkCandidatesRecorded > 0) {
            report.warnings.push(
                `${report.chunkCandidatesRecorded} chunk candidate(s) recorded; run collectGarbage again after ${Math.round(config.minOrphanSpanMs / 60000)} minutes to reclaim their bytes`
            );
        }
        return report;
    }
}

export class SharedFsHandle {
    private handleWatchers = new Set<FsWatcher>();

    constructor(readonly program: SharedFileSystem) {}

    /**
     * Subscribe to filesystem-shaped change events for a path or subtree.
     * The watcher belongs to this handle: close() tears it down; the shared
     * program (and other handles' watchers) stay untouched.
     */
    watch(path = "/", options?: FsWatchOptions): FsWatcher {
        const watcher = this.program.watch(path, options);
        this.handleWatchers.add(watcher);
        watcher.on("close", () => this.handleWatchers.delete(watcher));
        return watcher;
    }

    /** Close this handle's watchers. Idempotent; the program stays open. */
    close(): void {
        for (const watcher of [...this.handleWatchers]) {
            watcher.close();
        }
        this.handleWatchers.clear();
    }

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

    conflicts(path?: string, options?: { allowPartial?: boolean }) {
        return this.program.conflicts(path, options);
    }

    resolveConflict(path: string, versionId: string) {
        return this.program.resolveConflict(path, versionId);
    }

    namingConflicts(path?: string, options?: { allowPartial?: boolean }) {
        return this.program.namingConflicts(path, options);
    }

    resolveNamingConflict(nodeId: string, action: ResolveNamingAction) {
        return this.program.resolveNamingConflict(nodeId, action);
    }

    collectGarbage(options?: GcOptions) {
        return this.program.collectGarbage(options);
    }

    writeBatch(entries: WriteBatchEntry[], options?: WriteBatchOptions) {
        return this.program.writeBatch(entries, options);
    }

    versionsByChangeset(
        changesetId: string,
        options?: { allowPartial?: boolean }
    ) {
        return this.program.versionsByChangeset(changesetId, options);
    }

    awaitChangeset(changesetId: string, options?: AwaitChangesetOptions) {
        return this.program.awaitChangeset(changesetId, options);
    }

    changesetStatus(changesetId: string, options?: { allowPartial?: boolean }) {
        return this.program.changesetStatus(changesetId, options);
    }

    watchChangesets(options?: { changesetId?: string; signal?: AbortSignal }) {
        return this.program.watchChangesets(options);
    }

    /** Materialize and publish a cold-start snapshot from this replica. */
    snapshotWrite() {
        return this.program.snapshotWrite();
    }

    bootstrapStatus() {
        return this.program.bootstrapStatus();
    }

    /** Resolves when the bootstrap overlay retires (either path). */
    awaitBootstrapConverged() {
        return this.program.awaitBootstrapConverged();
    }

    authorizeWriter(publicKey: PublicSignKey) {
        return this.program.authorizeWriter(publicKey);
    }

    /** Revoke this identity's trust edge to a writer (see program docs). */
    revokeWriter(publicKey: PublicSignKey) {
        return this.program.revokeWriter(publicKey);
    }

    isTrustedWriter(publicKey: PublicSignKey) {
        return this.program.isTrustedWriter(publicKey);
    }

    trustedWriters() {
        return this.program.trustedWriters();
    }
}

export const openSharedFs = async (options: OpenSharedFsOptions) => {
    if (options.ignore?.onIgnoredWrite === "divert") {
        // Refused BEFORE anything opens: the machine-local overlay is a
        // staged follow-up.
        throw new SharedFsError(
            "EINVAL",
            'ignore.onIgnoredWrite "divert" (the machine-local overlay) is not available yet; use "reject"'
        );
    }
    if (options.ignore?.patterns) {
        // Validate BEFORE anything opens: the program may be shared via
        // existing:"reuse", so a post-open failure must never tear it
        // down under another live handle.
        try {
            compileIgnoreRules(options.ignore.patterns, {
                casefold: options.ignore.casefold,
            });
        } catch (error: any) {
            throw new SharedFsError(
                "EINVAL",
                `invalid ignore policy: ${error?.message ?? error}`
            );
        }
    }
    const args: SharedFsOpenArgs = {
        machineLabel: options.machineLabel,
        replicate: options.replicate,
        remoteChunkFetch: options.remoteChunkFetch,
        clock: options.clock,
        dedupSkipHorizonMs: options.dedupSkipHorizonMs,
        // Creating a brand-new filesystem keeps today's open path exactly
        // — there is nothing to bootstrap from and the creator must
        // announce immediately.
        bootstrap: options.address
            ? options.bootstrap
            : (options.bootstrap ?? false),
        snapshot: options.snapshot,
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
                  sealedIgnoredNames: options.sealedIgnoredNames,
              }),
              {
                  existing: "reuse",
                  args,
              }
          );
    if (
        options.address &&
        options.sealedIgnoredNames &&
        JSON.stringify([...new Set(options.sealedIgnoredNames)].sort()) !==
            JSON.stringify(program.sealedIgnoredNames)
    ) {
        // The sealed list is address-immutable; a caller-supplied list on
        // an address open cannot apply and deserves a signal.
        console.warn(
            `shared-fs: sealedIgnoredNames option ignored — this filesystem is sealed with [${program.sealedIgnoredNames.join(", ")}]`
        );
    }
    if (options.ignore) {
        // Dynamic import: the wrapper extends SharedFsHandle, which this
        // module must finish defining first.
        const { IgnoreAwareFs } = await import("./ignore/ignore-fs.js");
        let engine: IgnorePolicyEngine | undefined;
        try {
            engine = new IgnorePolicyEngine(program, options.ignore);
            await engine.start();
            return new IgnoreAwareFs(program, engine, options.ignore);
        } catch (error: any) {
            // The program may be shared (existing:"reuse"): detach the
            // failed engine, never close under another live handle.
            engine?.stop();
            if (error instanceof SharedFsError) {
                throw error;
            }
            throw new SharedFsError(
                "EINVAL",
                `invalid ignore policy: ${error?.message ?? error}`
            );
        }
    }
    return new SharedFsHandle(program);
};
