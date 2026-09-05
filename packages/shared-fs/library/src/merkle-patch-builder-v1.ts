import {
    MERKLE_V1_BITMAP_BYTES,
    MERKLE_V1_FANOUT,
    MERKLE_V1_MAX_DATA_BYTES,
    MerkleDataBlockV1,
    MerkleTreeBlockV1,
    assertMerkleRootDescriptorV1,
    merkleDataHashV1,
    merkleDataIdFromHashV1,
    merkleRootLevelV1,
    merkleTreeHashV1,
    merkleTreeIdFromHashV1,
    merkleV1BitmapFromSlots,
    merkleV1BitmapSlots,
    type MerkleRootDescriptorV1,
    type MerkleV1LeafSize,
} from "./merkle-v1.js";
import type {
    MerkleBlockReferenceV1,
    MerkleBlockSourceV1,
} from "./merkle-read-session-v1.js";

export type MerklePatchBuilderBlockV1 = MerkleDataBlockV1 | MerkleTreeBlockV1;

export type MerkleBlockPutOptionsV1 = Readonly<{ signal: AbortSignal }>;

/**
 * Idempotent sink for canonical Merkle v1 blocks. Source and sink must share a
 * block domain, and the sink must retain every reused base reference. Failure
 * may leave unreachable blocks, but the builder never returns a partial root.
 */
export interface MerkleBlockSinkV1 {
    put(
        block: MerklePatchBuilderBlockV1,
        options: MerkleBlockPutOptionsV1
    ): Promise<void>;
}

export type MerkleBytePatchV1 = Readonly<{
    offset: number | bigint;
    bytes: Uint8Array;
}>;

export type MerklePatchBuilderLimitsV1 = Readonly<{
    /** Maximum number of non-empty patch records copied by one build. */
    maxPatches?: number;
    /** Maximum aggregate payload bytes copied from all patches. */
    maxPatchBytes?: number;
    /** Maximum distinct leaf indices requiring reconstruction. */
    maxChangedLeaves?: number;
    /** Maximum verified tree entries retained by the build-local LRU. */
    maxTreeCacheEntries?: number;
    /** Maximum canonical tree-field bytes retained by the build-local LRU. */
    maxTreeCacheBytes?: number;
}>;

export type MerklePatchBuilderOptionsV1 = Readonly<{
    root: MerkleRootDescriptorV1;
    source: MerkleBlockSourceV1;
    sink: MerkleBlockSinkV1;
    limits?: MerklePatchBuilderLimitsV1;
}>;

export type MerklePatchBuildOptionsV1 = Readonly<{
    /** Strictly ascending, non-overlapping byte patches. */
    patches?: readonly MerkleBytePatchV1[];
    /** Defaults to max(base size, every patch end). */
    size?: number | bigint;
    signal?: AbortSignal;
}>;

export type MerklePatchBuilderErrorCodeV1 =
    | "EIO"
    | "EINVAL"
    | "ECLOSED"
    | "EALREADY"
    | "ABORT_ERR";

export class MerklePatchBuilderErrorV1 extends Error {
    readonly cause?: unknown;

    constructor(
        readonly code: MerklePatchBuilderErrorCodeV1,
        message: string,
        cause?: unknown
    ) {
        super(message);
        this.name =
            code === "ABORT_ERR" ? "AbortError" : "MerklePatchBuilderErrorV1";
        this.cause = cause;
    }
}

export const MERKLE_PATCH_BUILDER_V1_DEFAULT_LIMITS = Object.freeze({
    maxPatches: 1_024,
    maxPatchBytes: 64 * 1024 * 1024,
    maxChangedLeaves: 4_096,
    maxTreeCacheEntries: 4_096,
    maxTreeCacheBytes: 32 * 1024 * 1024,
});

export const MERKLE_PATCH_BUILDER_V1_ABSOLUTE_LIMITS = Object.freeze({
    maxPatches: 65_536,
    maxPatchBytes: 256 * 1024 * 1024,
    maxChangedLeaves: 65_536,
    maxTreeCacheEntries: 65_536,
    maxTreeCacheBytes: 256 * 1024 * 1024,
});

export type MerklePatchBuilderWorkCountersV1 = Readonly<{
    /** Calls admitted past the idle/closed/pre-aborted checks. */
    buildCalls: number;
    patchCount: number;
    patchBytes: number;
    changedLeavesPlanned: number;
    leafHashesChanged: number;
    leafHashesReused: number;
    authenticatedZeroLeavesRead: number;
    /** Actual source.load calls; cache hits do not increment this. */
    sourceFetches: number;
    treeCacheHits: number;
    treeCacheMisses: number;
    treeCacheEvictions: number;
    treeBlocksVerified: number;
    /** Positional tree visits, including verified-cache hits. */
    treeBlocksVisited: number;
    dataBlocksVerified: number;
    /** Payload bytes hashed while verifying fetched base data. */
    sourceDataBytesVerified: number;
    /** Payload bytes hashed for new blocks and post-sink checks. */
    newDataBytesHashed: number;
    /** Nonzero candidate blocks, including candidates whose hash is reused. */
    dataBlocksCreated: number;
    treeBlocksCreated: number;
    dataBlocksWritten: number;
    treeBlocksWritten: number;
    sinkPuts: number;
    duplicateSinkPutsAvoided: number;
    treeHashesReused: number;
    treeNodesCollapsed: number;
    prunedChildReferences: number;
    rootReferencesDropped: number;
}>;

export type MerklePatchBuilderStatsV1 = MerklePatchBuilderWorkCountersV1 &
    Readonly<{
        phase: "idle" | "running" | "complete" | "failed";
        closed: boolean;
        cachedTreeBlocks: number;
        cachedTreeBytes: number;
    }>;

export type MerklePatchBuildResultV1 = Readonly<{
    root: Readonly<MerkleRootDescriptorV1>;
    stats: MerklePatchBuilderStatsV1;
}>;

type MutableCounters = {
    -readonly [Key in keyof MerklePatchBuilderWorkCountersV1]: number;
};

type NormalizedPatch = Readonly<{
    offset: bigint;
    end: bigint;
    bytes: Uint8Array;
}>;

type LeafPatchSegment = Readonly<{
    destinationStart: number;
    sourceStart: number;
    length: number;
    bytes: Uint8Array;
}>;

type LeafChange = Readonly<{
    index: bigint;
    hash?: Uint8Array;
}>;

type NodeReference = Readonly<{
    hash: Uint8Array;
    /** Zero is data. Positive values are exact tree levels. */
    level: number;
}>;

type VerifiedTree = Readonly<{
    level: number;
    bitmap: Uint8Array;
    slots: readonly number[];
    children: readonly Uint8Array[];
}>;

type ResolvedLimits = {
    [Key in keyof Required<MerklePatchBuilderLimitsV1>]: number;
};

const MAX_U64 = (1n << 64n) - 1n;
const FANOUT = BigInt(MERKLE_V1_FANOUT);

const invalid = (message: string, cause?: unknown): never => {
    throw new MerklePatchBuilderErrorV1("EINVAL", message, cause);
};

const ioFailure = (message: string, cause?: unknown): never => {
    throw new MerklePatchBuilderErrorV1("EIO", message, cause);
};

const closedFailure = () =>
    new MerklePatchBuilderErrorV1("ECLOSED", "Merkle patch builder is closed");

const alreadyFailure = () =>
    new MerklePatchBuilderErrorV1(
        "EALREADY",
        "Merkle patch builders admit exactly one build"
    );

const abortFailure = (signal: AbortSignal) =>
    new MerklePatchBuilderErrorV1(
        "ABORT_ERR",
        "Merkle patch build was aborted",
        signal.reason
    );

const asU64 = (value: number | bigint, name: string) => {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) {
            return invalid(
                `${name} must be a non-negative safe integer or bigint`
            );
        }
        return BigInt(value);
    }
    if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
        return invalid(`${name} must fit in u64`);
    }
    return value;
};

const minBigInt = (left: bigint, right: bigint) =>
    left < right ? left : right;

const maxBigInt = (left: bigint, right: bigint) =>
    left > right ? left : right;

const equalBytes = (left?: Uint8Array, right?: Uint8Array) => {
    if (left === undefined || right === undefined) return left === right;
    if (left.byteLength !== right.byteLength) return false;
    let different = 0;
    for (let index = 0; index < left.byteLength; index++) {
        different |= left[index] ^ right[index];
    }
    return different === 0;
};

const copyHash = (hash: Uint8Array, name = "hash") => {
    if (!(hash instanceof Uint8Array) || hash.byteLength !== 32) {
        return ioFailure(`${name} must contain exactly 32 bytes`);
    }
    return new Uint8Array(hash);
};

const hashKey = (hash: Uint8Array) => {
    let value = "";
    for (const byte of hash) value += byte.toString(16).padStart(2, "0");
    return value;
};

const isAllZero = (bytes: Uint8Array) => {
    let nonzero = 0;
    for (const value of bytes) nonzero |= value;
    return nonzero === 0;
};

const childCapacityAtLevel = (level: number) => {
    let capacity = 1n;
    for (let current = 1; current < level; current++) capacity *= FANOUT;
    return capacity;
};

const leafCountForSize = (size: bigint, leafSize: bigint) =>
    size === 0n ? 0n : (size + leafSize - 1n) / leafSize;

const resolveLimit = (
    value: number | undefined,
    fallback: number,
    absolute: number,
    name: string
) => {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 0) {
        return invalid(`${name} must be a non-negative safe integer`);
    }
    if (resolved > absolute) {
        return invalid(`${name} must not exceed ${absolute}`);
    }
    return resolved;
};

class WeightedTreeLru {
    private readonly values = new Map<
        string,
        { tree: VerifiedTree; weight: number }
    >();
    private totalWeight = 0;

    constructor(
        private readonly maxEntries: number,
        private readonly maxWeight: number,
        private readonly onEviction: () => void
    ) {}

    get size() {
        return this.values.size;
    }

    get weight() {
        return this.totalWeight;
    }

    get(key: string) {
        const entry = this.values.get(key);
        if (!entry) return undefined;
        this.values.delete(key);
        this.values.set(key, entry);
        return entry.tree;
    }

    set(key: string, tree: VerifiedTree, weight: number) {
        if (
            this.maxEntries === 0 ||
            this.maxWeight === 0 ||
            weight > this.maxWeight
        ) {
            return;
        }
        const previous = this.values.get(key);
        if (previous) {
            this.values.delete(key);
            this.totalWeight -= previous.weight;
        }
        this.values.set(key, { tree, weight });
        this.totalWeight += weight;
        while (
            this.values.size > this.maxEntries ||
            this.totalWeight > this.maxWeight
        ) {
            const oldest = this.values.entries().next().value as
                | [string, { tree: VerifiedTree; weight: number }]
                | undefined;
            if (!oldest) break;
            this.values.delete(oldest[0]);
            this.totalWeight -= oldest[1].weight;
            this.onEviction();
        }
    }

    clear() {
        this.values.clear();
        this.totalWeight = 0;
    }
}

/** One-shot path-copy builder isolated from the current v9 runtime. */
export class MerklePatchBuilderV1 {
    readonly leafSize: MerkleV1LeafSize;
    readonly baseSize: bigint;
    readonly baseRootLevel: number;

    private readonly baseRootHash?: Uint8Array;
    private readonly source: MerkleBlockSourceV1;
    private readonly sink: MerkleBlockSinkV1;
    private readonly limits: ResolvedLimits;
    private readonly treeCache: WeightedTreeLru;
    private readonly writtenBlocks = new Set<string>();
    private readonly counters: MutableCounters = {
        buildCalls: 0,
        patchCount: 0,
        patchBytes: 0,
        changedLeavesPlanned: 0,
        leafHashesChanged: 0,
        leafHashesReused: 0,
        authenticatedZeroLeavesRead: 0,
        sourceFetches: 0,
        treeCacheHits: 0,
        treeCacheMisses: 0,
        treeCacheEvictions: 0,
        treeBlocksVerified: 0,
        treeBlocksVisited: 0,
        dataBlocksVerified: 0,
        sourceDataBytesVerified: 0,
        newDataBytesHashed: 0,
        dataBlocksCreated: 0,
        treeBlocksCreated: 0,
        dataBlocksWritten: 0,
        treeBlocksWritten: 0,
        sinkPuts: 0,
        duplicateSinkPutsAvoided: 0,
        treeHashesReused: 0,
        treeNodesCollapsed: 0,
        prunedChildReferences: 0,
        rootReferencesDropped: 0,
    };
    private phase: "idle" | "running" | "complete" | "failed" = "idle";
    private closed = false;
    private operationController?: AbortController;
    private callerSignal?: AbortSignal;

    constructor(options: MerklePatchBuilderOptionsV1) {
        if (!options || typeof options !== "object") {
            return invalid("options must be an object");
        }
        const source = options.source;
        const sink = options.sink;
        const limits = options.limits;
        if (!source || typeof source.load !== "function") {
            return invalid("source.load must be a function");
        }
        if (!sink || typeof sink.put !== "function") {
            return invalid("sink.put must be a function");
        }
        if (limits !== undefined && (!limits || typeof limits !== "object")) {
            return invalid("limits must be an object");
        }
        let root: ReturnType<typeof assertMerkleRootDescriptorV1>;
        try {
            root = assertMerkleRootDescriptorV1(options.root);
        } catch (error) {
            return invalid("root descriptor is invalid", error);
        }
        this.leafSize = root.leafSize;
        this.baseSize = root.size;
        this.baseRootLevel = root.rootLevel;
        this.baseRootHash = root.rootHash
            ? new Uint8Array(root.rootHash)
            : undefined;
        this.source = source;
        this.sink = sink;
        this.limits = {
            maxPatches: resolveLimit(
                limits?.maxPatches,
                MERKLE_PATCH_BUILDER_V1_DEFAULT_LIMITS.maxPatches,
                MERKLE_PATCH_BUILDER_V1_ABSOLUTE_LIMITS.maxPatches,
                "limits.maxPatches"
            ),
            maxPatchBytes: resolveLimit(
                limits?.maxPatchBytes,
                MERKLE_PATCH_BUILDER_V1_DEFAULT_LIMITS.maxPatchBytes,
                MERKLE_PATCH_BUILDER_V1_ABSOLUTE_LIMITS.maxPatchBytes,
                "limits.maxPatchBytes"
            ),
            maxChangedLeaves: resolveLimit(
                limits?.maxChangedLeaves,
                MERKLE_PATCH_BUILDER_V1_DEFAULT_LIMITS.maxChangedLeaves,
                MERKLE_PATCH_BUILDER_V1_ABSOLUTE_LIMITS.maxChangedLeaves,
                "limits.maxChangedLeaves"
            ),
            maxTreeCacheEntries: resolveLimit(
                limits?.maxTreeCacheEntries,
                MERKLE_PATCH_BUILDER_V1_DEFAULT_LIMITS.maxTreeCacheEntries,
                MERKLE_PATCH_BUILDER_V1_ABSOLUTE_LIMITS.maxTreeCacheEntries,
                "limits.maxTreeCacheEntries"
            ),
            maxTreeCacheBytes: resolveLimit(
                limits?.maxTreeCacheBytes,
                MERKLE_PATCH_BUILDER_V1_DEFAULT_LIMITS.maxTreeCacheBytes,
                MERKLE_PATCH_BUILDER_V1_ABSOLUTE_LIMITS.maxTreeCacheBytes,
                "limits.maxTreeCacheBytes"
            ),
        };
        this.treeCache = new WeightedTreeLru(
            this.limits.maxTreeCacheEntries,
            this.limits.maxTreeCacheBytes,
            () => this.counters.treeCacheEvictions++
        );
    }

    stats(): MerklePatchBuilderStatsV1 {
        return Object.freeze({
            ...this.counters,
            phase: this.phase,
            closed: this.closed,
            cachedTreeBlocks: this.treeCache.size,
            cachedTreeBytes: this.treeCache.weight,
        });
    }

    /** Abort pending source/sink work and release the verified tree cache. */
    close() {
        if (this.closed) return;
        this.closed = true;
        this.treeCache.clear();
        this.operationController?.abort(closedFailure());
    }

    async build(
        options: MerklePatchBuildOptionsV1 = {}
    ): Promise<MerklePatchBuildResultV1> {
        if (this.closed) throw closedFailure();
        if (this.phase !== "idle") throw alreadyFailure();
        if (!options || typeof options !== "object") {
            return invalid("build options must be an object");
        }
        const signal = options.signal;
        if (signal?.aborted) throw abortFailure(signal);
        this.phase = "running";
        this.counters.buildCalls++;
        this.operationController = new AbortController();
        this.callerSignal = signal;
        const onCallerAbort = () =>
            this.operationController?.abort(abortFailure(signal!));
        signal?.addEventListener("abort", onCallerAbort, { once: true });

        try {
            const normalized = this.normalizeBuild(options);
            const root = await this.executeBuild(normalized);
            this.throwIfUnavailable();
            this.phase = "complete";
            this.treeCache.clear();
            this.writtenBlocks.clear();
            const resultRoot = Object.freeze({
                leafSize: root.leafSize,
                size: root.size,
                rootLevel: root.rootLevel,
                rootHash: root.rootHash
                    ? new Uint8Array(root.rootHash)
                    : undefined,
            });
            return Object.freeze({ root: resultRoot, stats: this.stats() });
        } catch (error) {
            this.phase = "failed";
            if (error instanceof MerklePatchBuilderErrorV1) throw error;
            if (this.closed) throw closedFailure();
            if (signal?.aborted) throw abortFailure(signal);
            return ioFailure("Merkle patch build failed", error);
        } finally {
            signal?.removeEventListener("abort", onCallerAbort);
            this.operationController = undefined;
            this.callerSignal = undefined;
            this.treeCache.clear();
            this.writtenBlocks.clear();
        }
    }

    private normalizeBuild(options: MerklePatchBuildOptionsV1) {
        if (!options || typeof options !== "object") {
            return invalid("build options must be an object");
        }
        const patchValues = options.patches ?? [];
        if (!Array.isArray(patchValues)) {
            return invalid("patches must be an array");
        }
        if (patchValues.length > this.limits.maxPatches) {
            return invalid(
                `patch count exceeds configured maxPatches ${this.limits.maxPatches}`
            );
        }

        const patches: NormalizedPatch[] = [];
        let previousEnd = 0n;
        let patchBytes = 0;
        let impliedSize = this.baseSize;
        for (let index = 0; index < patchValues.length; index++) {
            const value = patchValues[index];
            if (!value || typeof value !== "object") {
                return invalid(`patches[${index}] must be an object`);
            }
            const offsetValue = value.offset;
            const bytesValue = value.bytes;
            const offset = asU64(offsetValue, `patches[${index}].offset`);
            if (!(bytesValue instanceof Uint8Array)) {
                return invalid(`patches[${index}].bytes must be a Uint8Array`);
            }
            const length = bytesValue.byteLength;
            if (length === 0) {
                return invalid(`patches[${index}].bytes must not be empty`);
            }
            patchBytes += length;
            if (patchBytes > this.limits.maxPatchBytes) {
                return invalid(
                    `patch bytes exceed configured maxPatchBytes ${this.limits.maxPatchBytes}`
                );
            }
            const end = offset + BigInt(length);
            if (end > MAX_U64) {
                return invalid(
                    `patches[${index}] ends beyond the u64 file size`
                );
            }
            if (index > 0 && offset < previousEnd) {
                return invalid(
                    "patches must be strictly ascending and non-overlapping"
                );
            }
            previousEnd = end;
            impliedSize = maxBigInt(impliedSize, end);
            patches.push({
                offset,
                end,
                bytes: new Uint8Array(bytesValue),
            });
        }

        const sizeValue = options.size;
        const size =
            sizeValue === undefined ? impliedSize : asU64(sizeValue, "size");
        if (patches.some((patch) => patch.end > size)) {
            return invalid("a patch ends beyond the requested file size");
        }
        let rootLevel: number;
        try {
            rootLevel = merkleRootLevelV1(size, this.leafSize);
        } catch (error) {
            return invalid(
                "requested size is outside the Merkle v1 address space",
                error
            );
        }

        this.counters.patchCount = patches.length;
        this.counters.patchBytes = patchBytes;
        return { patches, size, rootLevel };
    }

    private async executeBuild(normalized: {
        patches: readonly NormalizedPatch[];
        size: bigint;
        rootLevel: number;
    }): Promise<ReturnType<typeof assertMerkleRootDescriptorV1>> {
        const leafSize = BigInt(this.leafSize);
        const baseLeaves = leafCountForSize(this.baseSize, leafSize);
        const targetLeaves = leafCountForSize(normalized.size, leafSize);
        if (normalized.size === 0n) {
            if (this.baseRootHash) this.counters.rootReferencesDropped++;
            return assertMerkleRootDescriptorV1({
                leafSize: this.leafSize,
                size: 0n,
                rootLevel: 0,
            });
        }

        const segmentsByLeaf = new Map<string, LeafPatchSegment[]>();
        const changedLeafIndexes = new Map<string, bigint>();
        const addLeaf = (index: bigint) => {
            if (index >= 0n && index < targetLeaves) {
                changedLeafIndexes.set(index.toString(), index);
            }
        };
        for (const patch of normalized.patches) {
            const firstLeaf = patch.offset / leafSize;
            const lastLeaf = (patch.end - 1n) / leafSize;
            for (let leaf = firstLeaf; leaf <= lastLeaf; leaf++) {
                addLeaf(leaf);
                const leafStart = leaf * leafSize;
                const start = maxBigInt(patch.offset, leafStart);
                const end = minBigInt(patch.end, leafStart + leafSize);
                const key = leaf.toString();
                const segments = segmentsByLeaf.get(key) ?? [];
                segments.push({
                    destinationStart: Number(start - leafStart),
                    sourceStart: Number(start - patch.offset),
                    length: Number(end - start),
                    bytes: patch.bytes,
                });
                segmentsByLeaf.set(key, segments);
            }
        }

        if (this.baseSize !== normalized.size) {
            if (baseLeaves > 0n) {
                const oldLast = baseLeaves - 1n;
                if (oldLast < targetLeaves && this.baseSize % leafSize !== 0n) {
                    addLeaf(oldLast);
                }
            }
            const targetLast = targetLeaves - 1n;
            if (targetLast < baseLeaves) {
                const oldLength = this.expectedBaseLeafLength(targetLast);
                const newLength = this.expectedTargetLeafLength(
                    targetLast,
                    normalized.size,
                    targetLeaves
                );
                if (oldLength !== newLength) addLeaf(targetLast);
            }
        }

        if (changedLeafIndexes.size > this.limits.maxChangedLeaves) {
            return invalid(
                `changed leaf count exceeds configured maxChangedLeaves ${this.limits.maxChangedLeaves}`
            );
        }
        const plannedLeaves = [...changedLeafIndexes.values()].sort((a, b) =>
            a < b ? -1 : a > b ? 1 : 0
        );
        this.counters.changedLeavesPlanned = plannedLeaves.length;
        const changes: LeafChange[] = [];

        for (const leafIndex of plannedLeaves) {
            this.throwIfUnavailable();
            const oldLength =
                leafIndex < baseLeaves
                    ? this.expectedBaseLeafLength(leafIndex)
                    : 0;
            const newLength = this.expectedTargetLeafLength(
                leafIndex,
                normalized.size,
                targetLeaves
            );
            const oldHash = await this.resolveBaseLeafHash(
                leafIndex,
                baseLeaves
            );
            const segments = segmentsByLeaf.get(leafIndex.toString()) ?? [];
            const fullyCovered = this.segmentsCoverLeaf(segments, newLength);
            const bytes = new Uint8Array(newLength);
            if (!fullyCovered && oldLength > 0) {
                if (oldHash) {
                    const oldBytes = await this.loadData(oldHash, oldLength);
                    bytes.set(
                        oldBytes.subarray(
                            0,
                            Math.min(oldBytes.byteLength, newLength)
                        ),
                        0
                    );
                } else {
                    this.counters.authenticatedZeroLeavesRead++;
                }
            }
            for (const segment of segments) {
                bytes.set(
                    segment.bytes.subarray(
                        segment.sourceStart,
                        segment.sourceStart + segment.length
                    ),
                    segment.destinationStart
                );
            }

            let newHash: Uint8Array | undefined;
            let newBlock: MerkleDataBlockV1 | undefined;
            if (!isAllZero(bytes)) {
                this.counters.newDataBytesHashed += bytes.byteLength;
                const created = MerkleDataBlockV1.createWithHash(bytes);
                newHash = created.hash;
                newBlock = created.block;
                this.counters.dataBlocksCreated++;
            }
            const sameHash = equalBytes(oldHash, newHash);
            if (sameHash) this.counters.leafHashesReused++;
            else {
                this.counters.leafHashesChanged++;
                changes.push({
                    index: leafIndex,
                    hash: newHash ? new Uint8Array(newHash) : undefined,
                });
            }

            // A full overwrite need not fetch the old data block. When its
            // content hash is unchanged, put the caller-provided bytes anyway
            // so a missing base payload is repaired instead of silently reused.
            if (newHash && newBlock && (!sameHash || fullyCovered)) {
                await this.putBlock(newBlock, "data", 0, newHash);
            }
        }

        let rootReference = await this.baseReferenceAtLevel(
            normalized.rootLevel,
            baseLeaves
        );
        if (normalized.rootLevel === 0) {
            const leafChange = changes.find((change) => change.index === 0n);
            if (leafChange) {
                rootReference = leafChange.hash
                    ? { hash: new Uint8Array(leafChange.hash), level: 0 }
                    : undefined;
            }
        } else if (
            changes.length > 0 ||
            normalized.size < this.baseSize ||
            (rootReference && rootReference.level < normalized.rootLevel)
        ) {
            rootReference = await this.rewriteTree({
                level: normalized.rootLevel,
                baseLeaf: 0n,
                baseReference: rootReference,
                changes,
                baseLeaves,
                targetLeaves,
            });
        }
        this.throwIfUnavailable();

        try {
            return assertMerkleRootDescriptorV1({
                leafSize: this.leafSize,
                size: normalized.size,
                rootLevel: normalized.rootLevel,
                rootHash: rootReference
                    ? new Uint8Array(rootReference.hash)
                    : undefined,
            });
        } catch (error) {
            return ioFailure(
                "builder produced an invalid root descriptor",
                error
            );
        }
    }

    private expectedBaseLeafLength(leafIndex: bigint) {
        const start = leafIndex * BigInt(this.leafSize);
        if (start >= this.baseSize) return 0;
        return Number(minBigInt(BigInt(this.leafSize), this.baseSize - start));
    }

    private expectedTargetLeafLength(
        leafIndex: bigint,
        targetSize: bigint,
        targetLeaves: bigint
    ) {
        if (leafIndex < 0n || leafIndex >= targetLeaves) {
            return ioFailure("planned leaf lies beyond the target EOF");
        }
        const start = leafIndex * BigInt(this.leafSize);
        return Number(minBigInt(BigInt(this.leafSize), targetSize - start));
    }

    private segmentsCoverLeaf(
        segments: readonly LeafPatchSegment[],
        leafLength: number
    ) {
        let covered = 0;
        for (const segment of segments) {
            if (segment.destinationStart > covered) return false;
            covered = Math.max(
                covered,
                segment.destinationStart + segment.length
            );
            if (covered >= leafLength) return true;
        }
        return covered >= leafLength;
    }

    private async resolveBaseLeafHash(
        leafIndex: bigint,
        baseLeaves: bigint
    ): Promise<Uint8Array | undefined> {
        if (leafIndex < 0n || leafIndex >= baseLeaves || !this.baseRootHash) {
            return undefined;
        }
        let reference: NodeReference = {
            hash: new Uint8Array(this.baseRootHash),
            level: this.baseRootLevel,
        };
        if (reference.level === 0) return new Uint8Array(reference.hash);

        let baseLeaf = 0n;
        for (let level = reference.level; level > 0; level--) {
            const tree = await this.loadTreeAt(
                reference.hash,
                level,
                baseLeaf,
                baseLeaves
            );
            const childCapacity = childCapacityAtLevel(level);
            const slot = Number((leafIndex - baseLeaf) / childCapacity);
            const hash = this.treeChild(tree, slot);
            if (!hash) return undefined;
            baseLeaf += BigInt(slot) * childCapacity;
            reference = { hash, level: level - 1 };
        }
        return new Uint8Array(reference.hash);
    }

    private async baseReferenceAtLevel(
        targetLevel: number,
        baseLeaves: bigint
    ): Promise<NodeReference | undefined> {
        if (!this.baseRootHash) return undefined;
        let reference: NodeReference = {
            hash: new Uint8Array(this.baseRootHash),
            level: this.baseRootLevel,
        };
        while (reference.level > targetLevel) {
            const tree = await this.loadTreeAt(
                reference.hash,
                reference.level,
                0n,
                baseLeaves
            );
            const child = this.treeChild(tree, 0);
            this.counters.prunedChildReferences +=
                tree.children.length - (child ? 1 : 0);
            this.counters.rootReferencesDropped++;
            if (!child) return undefined;
            reference = { hash: child, level: reference.level - 1 };
        }
        return reference;
    }

    private async rewriteTree(args: {
        level: number;
        baseLeaf: bigint;
        baseReference?: NodeReference;
        changes: readonly LeafChange[];
        baseLeaves: bigint;
        targetLeaves: bigint;
    }): Promise<NodeReference | undefined> {
        this.throwIfUnavailable();
        if (args.level === 0) {
            const change = args.changes[0];
            if (change) {
                return change.hash
                    ? { hash: new Uint8Array(change.hash), level: 0 }
                    : undefined;
            }
            if (!args.baseReference) return undefined;
            if (args.baseReference.level !== 0) {
                return ioFailure("internal Merkle path level mismatch");
            }
            return {
                hash: new Uint8Array(args.baseReference.hash),
                level: 0,
            };
        }

        let baseTree: VerifiedTree | undefined;
        const children = new Map<number, NodeReference>();
        if (args.baseReference) {
            if (args.baseReference.level === args.level) {
                baseTree = await this.loadTreeAt(
                    args.baseReference.hash,
                    args.level,
                    args.baseLeaf,
                    args.baseLeaves
                );
                for (let index = 0; index < baseTree.slots.length; index++) {
                    children.set(baseTree.slots[index], {
                        hash: new Uint8Array(baseTree.children[index]),
                        level: args.level - 1,
                    });
                }
            } else if (args.baseReference.level < args.level) {
                children.set(0, {
                    hash: new Uint8Array(args.baseReference.hash),
                    level: args.baseReference.level,
                });
            } else {
                return ioFailure("internal Merkle path level mismatch");
            }
        }

        const childCapacity = childCapacityAtLevel(args.level);
        for (const slot of [...children.keys()]) {
            const childStart = args.baseLeaf + BigInt(slot) * childCapacity;
            if (childStart >= args.targetLeaves) {
                children.delete(slot);
                this.counters.prunedChildReferences++;
            }
        }

        const recurseSlots = new Set<number>();
        for (const change of args.changes) {
            recurseSlots.add(
                Number((change.index - args.baseLeaf) / childCapacity)
            );
        }
        for (const [slot, reference] of children) {
            if (reference.level < args.level - 1) recurseSlots.add(slot);
        }
        if (
            args.targetLeaves < args.baseLeaves &&
            args.targetLeaves > args.baseLeaf &&
            args.targetLeaves <
                args.baseLeaf + childCapacity * BigInt(MERKLE_V1_FANOUT)
        ) {
            const lastTargetLeaf = args.targetLeaves - 1n;
            const boundarySlot = Number(
                (lastTargetLeaf - args.baseLeaf) / childCapacity
            );
            if (
                args.targetLeaves <
                args.baseLeaf + BigInt(boundarySlot + 1) * childCapacity
            ) {
                recurseSlots.add(boundarySlot);
            }
        }

        for (const slot of [...recurseSlots].sort((a, b) => a - b)) {
            const childStart = args.baseLeaf + BigInt(slot) * childCapacity;
            if (childStart >= args.targetLeaves) {
                if (children.delete(slot))
                    this.counters.prunedChildReferences++;
                continue;
            }
            const childEnd = childStart + childCapacity;
            const childChanges = args.changes.filter(
                (change) =>
                    change.index >= childStart && change.index < childEnd
            );
            const rewritten = await this.rewriteTree({
                ...args,
                level: args.level - 1,
                baseLeaf: childStart,
                baseReference: children.get(slot),
                changes: childChanges,
            });
            if (rewritten) children.set(slot, rewritten);
            else children.delete(slot);
        }

        if (children.size === 0) {
            if (args.baseReference) this.counters.treeNodesCollapsed++;
            return undefined;
        }
        const slots = [...children.keys()].sort((a, b) => a - b);
        const hashes = slots.map((slot) => {
            const child = children.get(slot)!;
            if (child.level !== args.level - 1) {
                return ioFailure("internal Merkle child was not materialized");
            }
            return new Uint8Array(child.hash);
        });
        const bitmap = merkleV1BitmapFromSlots(slots);
        const hash = merkleTreeHashV1(args.level, bitmap, hashes);
        if (
            args.baseReference?.level === args.level &&
            equalBytes(hash, args.baseReference.hash)
        ) {
            this.counters.treeHashesReused++;
            return {
                hash: new Uint8Array(args.baseReference.hash),
                level: args.level,
            };
        }

        await this.writeTree(args.level, bitmap, hashes, hash);
        return { hash, level: args.level };
    }

    private async loadTreeAt(
        hash: Uint8Array,
        level: number,
        baseLeaf: bigint,
        baseLeaves: bigint
    ) {
        const tree = await this.loadTree(hash, level);
        this.counters.treeBlocksVisited++;
        if (baseLeaf < 0n || baseLeaf >= baseLeaves) {
            return ioFailure("Merkle tree reference lies beyond the base EOF");
        }
        const capacity = childCapacityAtLevel(level) * FANOUT;
        const childCapacity = childCapacityAtLevel(level);
        const leavesHere = minBigInt(capacity, baseLeaves - baseLeaf);
        const slotLimit = (leavesHere + childCapacity - 1n) / childCapacity;
        if (tree.slots.some((slot) => BigInt(slot) >= slotLimit)) {
            return ioFailure(
                "Merkle tree contains a child beyond the base EOF"
            );
        }
        return tree;
    }

    private treeChild(tree: VerifiedTree, slot: number) {
        const compactIndex = tree.slots.indexOf(slot);
        return compactIndex < 0
            ? undefined
            : new Uint8Array(tree.children[compactIndex]);
    }

    private async loadTree(
        hashValue: Uint8Array,
        expectedLevel: number
    ): Promise<VerifiedTree> {
        const hash = copyHash(hashValue);
        const key = `tree:${expectedLevel}:${hashKey(hash)}`;
        const cached = this.treeCache.get(key);
        if (cached) {
            this.counters.treeCacheHits++;
            return cached;
        }
        this.counters.treeCacheMisses++;
        const value = await this.loadSource(
            { hash, kind: "tree", level: expectedLevel },
            "Merkle tree source"
        );
        if (value === undefined) {
            return ioFailure("Referenced Merkle tree block is missing");
        }
        let tree: VerifiedTree;
        try {
            if (!(value instanceof MerkleTreeBlockV1)) {
                return ioFailure(
                    "Merkle tree reference resolved to an unknown or wrong block type"
                );
            }
            const id = value.id;
            const level = value.level;
            const bitmapValue = value.bitmap;
            const childrenValue = value.children;
            if (level !== expectedLevel) {
                return ioFailure(
                    `Merkle tree level ${String(level)} does not match expected level ${expectedLevel}`
                );
            }
            if (
                !(bitmapValue instanceof Uint8Array) ||
                bitmapValue.byteLength !== MERKLE_V1_BITMAP_BYTES
            ) {
                return ioFailure(
                    `Merkle tree bitmap must contain exactly ${MERKLE_V1_BITMAP_BYTES} bytes`
                );
            }
            if (
                !Array.isArray(childrenValue) ||
                childrenValue.length === 0 ||
                childrenValue.length > MERKLE_V1_FANOUT
            ) {
                return ioFailure(
                    `Merkle tree child count must be from 1 through ${MERKLE_V1_FANOUT}`
                );
            }
            const bitmap = new Uint8Array(bitmapValue);
            const slots = merkleV1BitmapSlots(bitmap);
            if (slots.length !== childrenValue.length) {
                return ioFailure(
                    "Merkle tree children do not match its bitmap population"
                );
            }
            const children = childrenValue.map((child, index) =>
                copyHash(child, `Merkle tree child ${index}`)
            );
            const actualHash = merkleTreeHashV1(level, bitmap, children);
            if (id !== merkleTreeIdFromHashV1(actualHash)) {
                return ioFailure("Merkle tree id does not match its fields");
            }
            if (!equalBytes(actualHash, hash)) {
                return ioFailure(
                    "Merkle tree hash does not match its authenticated reference"
                );
            }
            tree = { level, bitmap, slots, children };
        } catch (error) {
            if (error instanceof MerklePatchBuilderErrorV1) throw error;
            return ioFailure("Merkle tree block is corrupt", error);
        }
        this.counters.treeBlocksVerified++;
        this.treeCache.set(
            key,
            tree,
            1 + tree.bitmap.byteLength + 4 + tree.children.length * 32
        );
        return tree;
    }

    private async loadData(hashValue: Uint8Array, expectedLength: number) {
        const hash = copyHash(hashValue);
        const value = await this.loadSource(
            { hash, kind: "data", level: 0 },
            "Merkle data source"
        );
        if (value === undefined) {
            return ioFailure("Referenced Merkle data block is missing");
        }
        try {
            if (!(value instanceof MerkleDataBlockV1)) {
                return ioFailure(
                    "Merkle data reference resolved to an unknown or wrong block type"
                );
            }
            const id = value.id;
            const bytesValue = value.bytes;
            if (!(bytesValue instanceof Uint8Array)) {
                return ioFailure("Merkle data payload is not bytes");
            }
            const length = bytesValue.byteLength;
            if (
                length === 0 ||
                length > MERKLE_V1_MAX_DATA_BYTES ||
                length > this.leafSize ||
                length !== expectedLength
            ) {
                return ioFailure(
                    `Merkle data payload length ${length} does not match expected leaf length ${expectedLength}`
                );
            }
            const bytes = new Uint8Array(bytesValue);
            const actualHash = merkleDataHashV1(bytes);
            if (id !== merkleDataIdFromHashV1(actualHash)) {
                return ioFailure("Merkle data id does not match its bytes");
            }
            if (!equalBytes(actualHash, hash)) {
                return ioFailure(
                    "Merkle data hash does not match its authenticated reference"
                );
            }
            this.counters.dataBlocksVerified++;
            this.counters.sourceDataBytesVerified += bytes.byteLength;
            return bytes;
        } catch (error) {
            if (error instanceof MerklePatchBuilderErrorV1) throw error;
            return ioFailure("Merkle data block is corrupt", error);
        }
    }

    private async loadSource(reference: MerkleBlockReferenceV1, label: string) {
        this.counters.sourceFetches++;
        return this.callExternal(label, (signal) =>
            this.source.load(
                {
                    hash: new Uint8Array(reference.hash),
                    kind: reference.kind,
                    level: reference.level,
                },
                { signal }
            )
        );
    }

    private async writeTree(
        level: number,
        bitmap: Uint8Array,
        children: readonly Uint8Array[],
        expectedHash: Uint8Array
    ) {
        const block = new MerkleTreeBlockV1({ level, bitmap, children });
        if (block.id !== merkleTreeIdFromHashV1(expectedHash)) {
            return ioFailure("internal Merkle tree hash mismatch");
        }
        this.counters.treeBlocksCreated++;
        await this.putBlock(block, "tree", level, expectedHash);
    }

    private async putBlock(
        sourceBlock: MerklePatchBuilderBlockV1,
        kind: "data" | "tree",
        level: number,
        expectedHash: Uint8Array
    ) {
        const key = `${kind}:${level}:${hashKey(expectedHash)}`;
        if (this.writtenBlocks.has(key)) {
            this.counters.duplicateSinkPutsAvoided++;
            return;
        }
        const block = sourceBlock;
        this.counters.sinkPuts++;
        await this.callExternal("Merkle block sink", (signal) =>
            this.sink.put(block, { signal })
        );
        try {
            let actualHash: Uint8Array;
            let id: string;
            if (block instanceof MerkleDataBlockV1) {
                id = block.id;
                const bytesValue = block.bytes;
                if (
                    !(bytesValue instanceof Uint8Array) ||
                    bytesValue.byteLength === 0 ||
                    bytesValue.byteLength > this.leafSize
                ) {
                    return ioFailure(
                        "Merkle block sink mutated the submitted data block"
                    );
                }
                this.counters.newDataBytesHashed += bytesValue.byteLength;
                // The codec snapshots before validating and hashing. No
                // mutable sink-owned payload is used after this check.
                actualHash = merkleDataHashV1(bytesValue);
            } else {
                id = block.id;
                const blockLevel = block.level;
                const bitmapValue = block.bitmap;
                const childrenValue = block.children;
                if (
                    blockLevel !== level ||
                    !(bitmapValue instanceof Uint8Array) ||
                    bitmapValue.byteLength !== MERKLE_V1_BITMAP_BYTES ||
                    !Array.isArray(childrenValue) ||
                    childrenValue.length === 0 ||
                    childrenValue.length > MERKLE_V1_FANOUT
                ) {
                    return ioFailure(
                        "Merkle block sink mutated the submitted tree block"
                    );
                }
                const bitmap = new Uint8Array(bitmapValue);
                const children = childrenValue.map((child, index) =>
                    copyHash(child, `submitted tree child ${index}`)
                );
                actualHash = merkleTreeHashV1(blockLevel, bitmap, children);
            }
            const actualId =
                kind === "data"
                    ? merkleDataIdFromHashV1(actualHash)
                    : merkleTreeIdFromHashV1(actualHash);
            if (!equalBytes(actualHash, expectedHash) || id !== actualId) {
                return ioFailure(
                    "Merkle block sink mutated the submitted block"
                );
            }
        } catch (error) {
            if (error instanceof MerklePatchBuilderErrorV1) throw error;
            return ioFailure(
                "Merkle block sink mutated the submitted block",
                error
            );
        }
        this.writtenBlocks.add(key);
        if (kind === "data") this.counters.dataBlocksWritten++;
        else this.counters.treeBlocksWritten++;
    }

    private throwIfUnavailable() {
        if (this.closed) throw closedFailure();
        if (this.callerSignal?.aborted) throw abortFailure(this.callerSignal);
        if (this.operationController?.signal.aborted) {
            const reason = this.operationController.signal.reason;
            if (reason instanceof MerklePatchBuilderErrorV1) throw reason;
            throw abortFailure(this.operationController.signal);
        }
    }

    private callExternal<Value>(
        label: string,
        call: (signal: AbortSignal) => Promise<Value>
    ): Promise<Value> {
        this.throwIfUnavailable();
        const controller = this.operationController;
        if (!controller)
            return ioFailure("internal build controller is missing");
        let pending: Promise<Value>;
        try {
            pending = Promise.resolve(call(controller.signal));
        } catch (error) {
            if (this.closed) throw closedFailure();
            if (controller.signal.aborted) this.throwIfUnavailable();
            return Promise.reject(
                new MerklePatchBuilderErrorV1("EIO", `${label} failed`, error)
            );
        }
        return new Promise<Value>((resolve, reject) => {
            let settled = false;
            const cleanup = () =>
                controller.signal.removeEventListener("abort", onAbort);
            const settleResolve = (value: Value) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            };
            const settleReject = (error: unknown) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (this.closed) reject(closedFailure());
                else if (controller.signal.aborted) {
                    const reason = controller.signal.reason;
                    reject(
                        reason instanceof MerklePatchBuilderErrorV1
                            ? reason
                            : abortFailure(controller.signal)
                    );
                } else {
                    reject(
                        new MerklePatchBuilderErrorV1(
                            "EIO",
                            `${label} failed`,
                            error
                        )
                    );
                }
            };
            const onAbort = () => {
                const reason = controller.signal.reason;
                settleReject(
                    reason instanceof MerklePatchBuilderErrorV1
                        ? reason
                        : abortFailure(controller.signal)
                );
            };
            controller.signal.addEventListener("abort", onAbort, {
                once: true,
            });
            if (controller.signal.aborted) onAbort();
            pending.then(settleResolve, settleReject);
        });
    }
}
