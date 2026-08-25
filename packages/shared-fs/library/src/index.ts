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
import { Documents, Or, StringMatch, type Query } from "@peerbit/document";
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
          winner: NamingEvent;
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

type NodeNamingState = {
    nodeId: string;
    events: NamingEvent[];
    heads: NamingEvent[];
    winner: NamingEvent;
    depths: Map<string, number>;
    /** Multiple heads with genuinely different payloads. */
    conflicted: boolean;
};

const samePayload = (a: NamingEvent, b: NamingEvent) =>
    a.parentId === b.parentId && a.name === b.name && a.deleted === b.deleted;

const computeNamingState = (
    nodeId: string,
    events: NamingEvent[]
): NodeNamingState | undefined => {
    if (events.length === 0) {
        return undefined;
    }
    const { heads, depths } = computeDag(
        events,
        (event) => event.parentNamingIds
    );
    const sorted = [...heads].sort((a, b) => {
        const depthDiff = (depths.get(b.id) ?? 0) - (depths.get(a.id) ?? 0);
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

    constructor(properties: { id?: Uint8Array; rootKey?: PublicSignKey } = {}) {
        super();
        this.id = properties.id ?? randomBytes(32);
        this.trustGraph = properties.rootKey
            ? new TrustedNetwork({
                  id: this.id,
                  rootTrust: properties.rootKey,
              })
            : undefined;
        // v3: causal-naming schema — the salt bump guarantees 0.2.x and
        // 0.3.x peers can never attach to the same log and fail confusingly
        // mid-replication.
        this.entries = new Documents({
            id: sha256Sync(concat([this.id, fromString("/shared-fs/v3")])),
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
            // Never prune locally authored entries, even when this peer is
            // not a replicator for them (e.g. replicate: false).
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
        if (entry instanceof NamingEvent || entry instanceof FileVersion) {
            return entry.authorKey;
        }
        return undefined;
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
                    !decodesToStringArray(value.observedContentHeadsJson)
                ) {
                    return false;
                }
            } else if (value instanceof FileVersion) {
                if (!value.nodeId.startsWith("file:")) {
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

    /** Full naming histories for many nodes, batched. */
    private async namingStatesForNodes(
        nodeIds: string[]
    ): Promise<Map<string, NodeNamingState>> {
        const unique = [...new Set(nodeIds)];
        const byNode = new Map<string, NamingEvent[]>();
        for (const nodeId of unique) {
            byNode.set(nodeId, []);
        }
        for (let i = 0; i < unique.length; i += HEAD_QUERY_BATCH) {
            const batch = unique.slice(i, i + HEAD_QUERY_BATCH);
            const documents = await this.queryDocuments<NamingEvent>([
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
            for (const document of documents) {
                if (document instanceof NamingEvent) {
                    byNode.get(document.nodeId)?.push(document);
                }
            }
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
        const slotDocs = await this.queryDocuments<NamingEvent>([
            new StringMatch({ key: "kind", value: "naming" }),
            new StringMatch({ key: "parentId", value: parentId }),
            new StringMatch({ key: "name", value: name }),
        ]);
        const candidates = [...new Set(slotDocs.map((event) => event.nodeId))];
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
            const depthDiff =
                (b.depths.get(b.winner.id) ?? 0) -
                (a.depths.get(a.winner.id) ?? 0);
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
        parentNamingIds: string[];
        observedContentHeads?: string[];
    }) {
        const metadata = this.signedMetadata();
        const event = new NamingEvent({
            id: createId("naming"),
            nodeId: properties.nodeId,
            parentId: properties.parentId,
            name: properties.name,
            deleted: properties.deleted ?? false,
            parentNamingIds: properties.parentNamingIds,
            observedContentHeads: properties.observedContentHeads ?? [],
            createdAt: metadata.timestamp,
            authorKey: metadata.authorKey,
            machineLabel: metadata.machineLabel,
        });
        await this.entries.put(event, { unique: true });
        return event;
    }

    // ------------------------------------------------------------------
    // Content layer
    // ------------------------------------------------------------------

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

    private contentHeads(documents: FileVersion[]): FileVersion[] {
        const { heads, depths } = computeDag(
            documents,
            (doc) => doc.parentVersionIds
        );
        return [...heads].sort((a, b) => {
            const depthDiff = (depths.get(b.id) ?? 0) - (depths.get(a.id) ?? 0);
            return depthDiff !== 0 ? depthDiff : compareIds(a.id, b.id);
        });
    }

    private async headsForNode(nodeId: string): Promise<FileVersion[]> {
        return this.contentHeads(await this.versionDocumentsForNode(nodeId));
    }

    /** Content heads for many nodes with batched queries. */
    private async headsForNodes(
        nodeIds: string[]
    ): Promise<Map<string, FileVersion[]>> {
        const byNode = new Map<string, FileVersion[]>();
        for (const nodeId of nodeIds) {
            byNode.set(nodeId, []);
        }
        for (let i = 0; i < nodeIds.length; i += HEAD_QUERY_BATCH) {
            const batch = nodeIds.slice(i, i + HEAD_QUERY_BATCH);
            const documents = await this.queryDocuments<SharedFsEntry>([
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
            for (const document of documents) {
                if (isFileHead(document)) {
                    byNode.get(document.nodeId)?.push(document);
                }
            }
        }
        const result = new Map<string, FileVersion[]>();
        for (const [nodeId, documents] of byNode) {
            result.set(nodeId, this.contentHeads(documents));
        }
        return result;
    }

    private versionInfo(
        head: FileVersion,
        path: string,
        heads: FileVersion[]
    ): SharedFsVersionInfo {
        return {
            id: head.id,
            nodeId: head.nodeId,
            path,
            size: head.size,
            contentHash: head.contentHash,
            parentVersionIds: head.parentVersionIds,
            createdAt: head.createdAt,
            authorKey: head.authorKey,
            machineLabel: head.machineLabel,
            deleted: false,
            head: heads.some((candidate) => candidate.id === head.id),
        };
    }

    private entryInfoFor(
        winner: NamingEvent,
        path: string,
        options: {
            heads?: FileVersion[];
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
                authorKey: winner.authorKey,
                machineLabel: winner.machineLabel,
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
            authorKey: winner.authorKey,
            machineLabel: winner.machineLabel,
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
            parentNamingIds: [],
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
        const parentVersionIds =
            options.baseVersionIds ?? currentHeads.map((head) => head.id);
        const versionId = createId("version");
        // Content-addressed chunks: identical bytes — across versions of
        // this file or across entirely different files — share one chunk
        // document. Chunks are append-only and immortal by design; a future
        // garbage collector must revisit this check-then-skip dedup and the
        // delete/put ordering before it may remove anything.
        const orderedChunks = chunkBytes(bytes, options.chunkSize).map(
            (chunk) => new FileChunk({ bytes: chunk })
        );
        const uniqueChunks = [
            ...new Map(
                orderedChunks.map((chunk) => [chunk.id, chunk])
            ).values(),
        ];
        // Skipping the put is only safe on a full replica: on a partial
        // replicator the existing copy may be remote-authored, and skipping
        // would leave this writer's content unprotected by keep:"self".
        // Re-putting identical bytes is LWW-safe.
        const fullReplica =
            this.replicate !== false && this.replicate?.factor === 1;
        await mapWithConcurrency(
            uniqueChunks,
            CHUNK_IO_CONCURRENCY,
            async (chunk) => {
                if (fullReplica) {
                    if (await this.hasDocument(chunk.id)) {
                        return;
                    }
                    // Absence just verified; skip the internal existing-key
                    // lookup. Duplicate-id races are idempotent by
                    // construction under content addressing.
                    await this.entries.put(chunk, { unique: true });
                    return;
                }
                // Partial replicator: put unconditionally (identical bytes
                // are LWW-safe) and let the internal existing-key lookup
                // link same-id heads.
                await this.entries.put(chunk);
            }
        );
        const metadata = this.signedMetadata();
        const nodeId = existingNodeId ?? createId("file");
        const version = new FileVersion({
            id: versionId,
            nodeId,
            parentVersionIds,
            contentHash,
            size: BigInt(bytes.byteLength),
            chunkIds: orderedChunks.map((chunk) => chunk.id),
            createdAt: metadata.timestamp,
            authorKey: metadata.authorKey,
            machineLabel: metadata.machineLabel,
        });
        await this.entries.put(version, { unique: true });
        if (!existingNodeId) {
            // Brand-new path: content first, then the naming event that
            // makes it visible. Writes to existing files never touch naming
            // — a concurrent rename can no longer be reverted by a save.
            const parentId = await this.resolveParent(normalized);
            await this.appendNamingEvent({
                nodeId,
                parentId,
                name: basename(normalized),
                parentNamingIds: [],
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
            version.nodeId !== resolved.nodeId
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
            resolved.kind === "root" ? ROOT_NODE_ID : resolved.nodeId;
        // Every event that ever asserted a placement under this directory is
        // a candidate; slot resolution filters to current live winners.
        const slotDocs = await this.queryDocuments<NamingEvent>([
            new StringMatch({ key: "kind", value: "naming" }),
            new StringMatch({ key: "parentId", value: parentId }),
        ]);
        const nodesByName = new Map<string, Set<string>>();
        for (const event of slotDocs) {
            const set = nodesByName.get(event.name) ?? new Set<string>();
            set.add(event.nodeId);
            nodesByName.set(event.name, set);
        }
        const allNodeIds = [...new Set(slotDocs.map((event) => event.nodeId))];
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
            contentHash: selected.contentHash,
            size: selected.size,
            chunkIds: selected.chunkIds,
            createdAt: metadata.timestamp,
            authorKey: metadata.authorKey,
            machineLabel: metadata.machineLabel,
            conflictResolution: true,
        });
        await this.entries.put(resolution, { unique: true });
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
                parentNamingIds: resolved.state.heads.map((head) => head.id),
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
            parentNamingIds: resolved.state.heads.map((head) => head.id),
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
            parentNamingIds: resolved.state.heads.map((head) => head.id),
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
                const observed = new Set(state.winner.observedContentHeads);
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
            parentNamingIds: state.heads.map((head) => head.id),
            observedContentHeads: payload.observedContentHeads,
        });
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
