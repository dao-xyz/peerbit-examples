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
    FileChunk,
    FileVersion,
    IndexableSharedFsEntry,
    NamingEvent,
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
    /**
     * True when this node's naming has unresolved concurrent assertions
     * (multiple naming heads) or the path slot has shadowed claimants.
     */
    namingConflict?: boolean;
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
    /** Row queries issued; tests assert warm paths issue none. */
    rowQueries = 0;

    constructor(properties: { id?: Uint8Array; rootKey?: PublicSignKey } = {}) {
        super();
        this.id = properties.id ?? randomBytes(32);
        this.trustGraph = properties.rootKey
            ? new TrustedNetwork({
                  id: this.id,
                  rootTrust: properties.rootKey,
              })
            : undefined;
        // v5: index-served metadata plane (causal refs, sizes, hashes and
        // attribution projected into the index) — the salt bump guarantees
        // older peers can never attach to the same log and fail confusingly
        // mid-replication.
        this.entries = new Documents({
            id: sha256Sync(concat([this.id, fromString("/shared-fs/v5")])),
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
        this.pendingGuardVersions = new Map();
        this.pendingGuardNaming = new Map();
        if (this.guardFlushTimer) {
            clearTimeout(this.guardFlushTimer);
            this.guardFlushTimer = undefined;
        }
        await this.entries.open({
            type: SharedFsEntry,
            replicate: this.replicate as any,
            replicas: { min: 3 },
            // Never prune locally authored entries, even when this peer is
            // not a replicator for them (e.g. replicate: false).
            keep: "self",
            canPerform: (operation) => this.canPerformEntry(operation),
            index: {
                type: IndexableSharedFsEntry,
            },
        });
        // Cache maintenance runs on every peer; the resurrection guard only
        // on full replicas. Registering a change consumer also makes
        // Documents materialize removed VALUES on delete. Deduped so a
        // close→reopen of the same instance never stacks listeners.
        if (this.changeListener) {
            this.entries.events.removeEventListener(
                "change",
                this.changeListener
            );
        }
        this.changeListener = (event: any) => {
            const added = event?.detail?.added ?? [];
            const removed = event?.detail?.removed ?? [];
            this.applyCacheChanges(added, removed);
            if (this.isFullReplica()) {
                void this.guardAgainstLiveRemovals(removed).catch(() => {});
            }
        };
        this.entries.events.addEventListener("change", this.changeListener);
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
            if (value instanceof FileChunk) {
                // Content-addressed chunks are self-certifying: the bytes
                // must hash to the id, regardless of who signed the entry.
                const hash = sha256Base64Sync(value.bytes);
                if (hash !== value.hash || value.id !== `chunk:${hash}`) {
                    return false;
                }
            } else if (value instanceof NamingEvent) {
                if (
                    !value.id.startsWith("naming:") ||
                    !(
                        value.nodeId.startsWith("dir:") ||
                        value.nodeId.startsWith("file:")
                    ) ||
                    !(
                        value.parentId === ROOT_NODE_ID ||
                        value.parentId.startsWith("dir:")
                    ) ||
                    !VALID_NAME(value.name) ||
                    !decodesToStringArray(value.parentNamingIdsJson) ||
                    !decodesToStringArray(value.observedContentHeadsJson) ||
                    value.causalDepth < 1n
                ) {
                    return false;
                }
            } else if (value instanceof FileVersion) {
                if (
                    !value.nodeId.startsWith("file:") ||
                    value.causalDepth < 1n
                ) {
                    return false;
                }
            }
        }
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
        // Any trusted signer may append. The stored authorKey is advisory
        // attribution, not an authentication binding: documents are immutable
        // and id-addressed, and resurrection/recovery flows legitimately
        // re-append other authors' documents under the local key.
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
            this.namingRowCache.set(
                nodeId,
                new Map((byNode.get(nodeId) ?? []).map((row) => [row.id, row]))
            );
        }
        const states = new Map<string, NodeNamingState>();
        for (const [nodeId, events] of byNode) {
            const state = computeNamingState(nodeId, events);
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
            return [...cached.values()];
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
        return rows;
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
            const slot = await this.slotResolution(parentId, name);
            if (!slot) {
                return undefined;
            }
            const kind = nodeKindOf(slot.nodeId);
            if (kind === "directory") {
                if (isLast) {
                    return {
                        kind,
                        nodeId: slot.nodeId,
                        winner: slot.state.winner,
                        state: slot.state,
                        contested: slot.shadowed.length > 0,
                        path: currentPath,
                    };
                }
                parentId = slot.nodeId;
                continue;
            }
            if (isLast) {
                return {
                    kind,
                    nodeId: slot.nodeId,
                    winner: slot.state.winner,
                    state: slot.state,
                    contested: slot.shadowed.length > 0,
                    path: currentPath,
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
        return documents.filter(isFileHead);
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
            this.versionRowCache.set(
                nodeId,
                new Map((byNode.get(nodeId) ?? []).map((row) => [row.id, row]))
            );
        }
        const result = new Map<string, VersionLike[]>();
        for (const [nodeId, rows] of byNode) {
            result.set(nodeId, this.contentHeads(rows));
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
        // rejected), so a remote copy can heal either case.
        if (!verified && this.remoteChunkFetch) {
            try {
                const remote = await this.entries.index.get(id, {
                    local: false,
                    remote: { timeout: this.remoteChunkFetch.timeoutMs } as any,
                });
                verified = this.verifyChunk(remote ?? undefined, id);
            } catch {
                verified = undefined;
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
        const winners: {
            name: string;
            nodeId: string;
            state: NodeNamingState;
            contested: boolean;
        }[] = [];
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
                    state: slot.state,
                    contested: slot.shadowed.length > 0,
                });
            }
        }
        const fileNodeIds = winners
            .filter((winner) => nodeKindOf(winner.nodeId) === "file")
            .map((winner) => winner.nodeId);
        const heads = await this.headsForNodes(fileNodeIds);
        const infos: SharedFsEntryInfo[] = [];
        for (const winner of winners) {
            const info = this.entryInfoFor(
                winner.state.winner,
                joinFsPath(normalized, winner.name),
                {
                    heads:
                        nodeKindOf(winner.nodeId) === "file"
                            ? heads.get(winner.nodeId)
                            : undefined,
                    namingConflict: winner.state.conflicted || winner.contested,
                }
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

    async conflicts(path?: string): Promise<SharedFsConflict[]> {
        if (path) {
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

    async namingConflicts(path?: string): Promise<SharedFsNamingConflict[]> {
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

    namingConflicts(path?: string) {
        return this.program.namingConflicts(path);
    }

    resolveNamingConflict(nodeId: string, action: ResolveNamingAction) {
        return this.program.resolveNamingConflict(nodeId, action);
    }

    collectGarbage(options?: GcOptions) {
        return this.program.collectGarbage(options);
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
        clock: options.clock,
        dedupSkipHorizonMs: options.dedupSkipHorizonMs,
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
