import { toBase64URL } from "@peerbit/crypto";
import {
    MERKLE_V1_BITMAP_BYTES,
    MERKLE_V1_FANOUT,
    MERKLE_V1_MAX_DATA_BYTES,
    MerkleDataBlockV1,
    MerkleTreeBlockV1,
    assertMerkleRootDescriptorV1,
    merkleDataHashV1,
    merkleTreeHashV1,
    merkleV1BitmapSlots,
    type MerkleRootDescriptorV1,
    type MerkleV1LeafSize,
} from "./merkle-v1.js";

export type MerkleBlockReferenceV1 = Readonly<{
    hash: Uint8Array;
    kind: "data" | "tree";
    /** Data blocks use level 0. Tree blocks use their exact level. */
    level: number;
}>;

export type MerkleBlockLoadOptionsV1 = Readonly<{ signal: AbortSignal }>;

/**
 * A generation-isolated source for decoded Merkle v1 blocks.
 *
 * The source remains owned by the caller. A session copies and verifies every
 * mutable field returned from `load` before it can enter a cache.
 */
export interface MerkleBlockSourceV1 {
    load(
        reference: MerkleBlockReferenceV1,
        options: MerkleBlockLoadOptionsV1
    ): Promise<unknown | undefined>;
}

export type MerkleReadSessionCacheOptionsV1 = {
    /** Maximum decoded tree entries retained by the verified LRU. */
    treeEntries?: number;
    /** Maximum canonical tree-field bytes retained by the verified LRU. */
    treeBytes?: number;
    /** Maximum decoded data entries retained by the verified LRU. */
    dataEntries?: number;
    /** Maximum data bytes retained by the verified LRU. */
    dataBytes?: number;
};

export type MerkleReadSessionOptionsV1 = {
    root: MerkleRootDescriptorV1;
    source: MerkleBlockSourceV1;
    cache?: MerkleReadSessionCacheOptionsV1;
    /** Bounds one returned allocation. Larger ranges can be read in pieces. */
    maxReadBytes?: number;
};

export type MerkleReadOptionsV1 = {
    signal?: AbortSignal;
};

export type MerkleReadSessionErrorCodeV1 =
    | "EIO"
    | "EINVAL"
    | "ECLOSED"
    | "ABORT_ERR";

export class MerkleReadSessionErrorV1 extends Error {
    readonly cause?: unknown;

    constructor(
        readonly code: MerkleReadSessionErrorCodeV1,
        message: string,
        cause?: unknown
    ) {
        super(message);
        this.name =
            code === "ABORT_ERR" ? "AbortError" : "MerkleReadSessionErrorV1";
        this.cause = cause;
    }
}

export type MerkleReadWorkCountersV1 = Readonly<{
    /** Calls admitted by the session, including empty and failed reads. */
    readCalls: number;
    /** Bytes returned by successful reads. */
    outputBytes: number;
    /** Actual source.load calls after cache and in-flight coalescing. */
    sourceFetches: number;
    /** Loads that joined an already-running fetch. */
    coalescedFetches: number;
    treeCacheHits: number;
    treeCacheMisses: number;
    dataCacheHits: number;
    dataCacheMisses: number;
    /** Source values copied and successfully verified. */
    treeBlocksVerified: number;
    /** Source values copied and successfully verified. */
    dataBlocksVerified: number;
    /** Payload bytes hashed while verifying fetched data blocks. */
    dataBytesVerified: number;
    /** Tree blocks consumed by range traversal, including cache hits. */
    treeBlocksVisited: number;
    /** Data blocks consumed by range traversal, including cache hits. */
    dataBlocksVisited: number;
    /** Distinct absent authenticated subtrees intersecting a read. */
    authenticatedZeroRanges: number;
    /** Requested bytes returned as zeros from authenticated absence. */
    authenticatedZeroBytes: number;
}>;

export type MerkleReadSessionStatsV1 = MerkleReadWorkCountersV1 &
    Readonly<{
        closed: boolean;
        inFlightFetches: number;
        cachedTreeBlocks: number;
        cachedTreeBytes: number;
        cachedDataBlocks: number;
        cachedDataBytes: number;
    }>;

export const MERKLE_READ_SESSION_V1_DEFAULT_CACHE = Object.freeze({
    treeEntries: 128,
    treeBytes: 2 * 1024 * 1024,
    dataEntries: 16,
    dataBytes: 8 * 1024 * 1024,
});

export const MERKLE_READ_SESSION_V1_DEFAULT_MAX_READ_BYTES = 64 * 1024 * 1024;
/** Hard allocation ceiling even when a caller raises maxReadBytes. */
export const MERKLE_READ_SESSION_V1_ABSOLUTE_MAX_READ_BYTES = 256 * 1024 * 1024;

type MutableWorkCounters = {
    -readonly [Key in keyof MerkleReadWorkCountersV1]: number;
};

type VerifiedTreeBlock = Readonly<{
    level: number;
    bitmap: Uint8Array;
    children: readonly Uint8Array[];
}>;

type VerifiedDataBlock = Readonly<{ bytes: Uint8Array }>;

type VerifiedBlock = VerifiedTreeBlock | VerifiedDataBlock;

type InFlightBlock = {
    controller: AbortController;
    promise: Promise<VerifiedBlock>;
    waiters: number;
    settled: boolean;
    abandoned: boolean;
};

const equalBytes = (left: Uint8Array, right: Uint8Array) => {
    if (left.byteLength !== right.byteLength) return false;
    let different = 0;
    for (let index = 0; index < left.byteLength; index++) {
        different |= left[index] ^ right[index];
    }
    return different === 0;
};

const copyExactBytes = (value: Uint8Array, length: number) => {
    const copy = new Uint8Array(length);
    copy.set(value.subarray(0, length));
    return copy;
};

const blockId = (kind: "data" | "tree", hash: Uint8Array) =>
    `${kind === "data" ? "data2" : "tree2"}:${toBase64URL(hash).replace(/=+$/u, "")}`;

const MAX_U64 = (1n << 64n) - 1n;

const hashKey = (hash: Uint8Array) => {
    let value = "";
    for (const byte of hash) value += byte.toString(16).padStart(2, "0");
    return value;
};

const maxBigInt = (left: bigint, right: bigint) =>
    left > right ? left : right;

const minBigInt = (left: bigint, right: bigint) =>
    left < right ? left : right;

const invalid = (message: string, cause?: unknown): never => {
    throw new MerkleReadSessionErrorV1("EINVAL", message, cause);
};

const ioFailure = (message: string, cause?: unknown): never => {
    throw new MerkleReadSessionErrorV1("EIO", message, cause);
};

const closedFailure = (): MerkleReadSessionErrorV1 =>
    new MerkleReadSessionErrorV1("ECLOSED", "Merkle read session is closed");

const abortFailure = (signal: AbortSignal): MerkleReadSessionErrorV1 =>
    new MerkleReadSessionErrorV1(
        "ABORT_ERR",
        "Merkle range read was aborted",
        signal.reason
    );

const asBound = (value: number | undefined, fallback: number, name: string) => {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 0) {
        return invalid(`${name} must be a non-negative safe integer`);
    }
    return resolved;
};

const asOffset = (value: number | bigint) => {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) {
            return invalid(
                "offset must be a non-negative safe integer or bigint"
            );
        }
        return BigInt(value);
    }
    if (typeof value !== "bigint" || value < 0n) {
        return invalid("offset must be a non-negative safe integer or bigint");
    }
    if (value > MAX_U64) {
        return invalid("offset must fit in u64");
    }
    return value;
};

class WeightedLru<Value> {
    private readonly values = new Map<
        string,
        { value: Value; weight: number }
    >();
    private totalWeight = 0;

    constructor(
        private readonly maxEntries: number,
        private readonly maxWeight: number
    ) {}

    get size() {
        return this.values.size;
    }

    get weight() {
        return this.totalWeight;
    }

    get(key: string): Value | undefined {
        const entry = this.values.get(key);
        if (!entry) return undefined;
        this.values.delete(key);
        this.values.set(key, entry);
        return entry.value;
    }

    set(key: string, value: Value, weight: number) {
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
        this.values.set(key, { value, weight });
        this.totalWeight += weight;
        while (
            this.values.size > this.maxEntries ||
            this.totalWeight > this.maxWeight
        ) {
            const oldest = this.values.entries().next().value as
                | [string, { value: Value; weight: number }]
                | undefined;
            if (!oldest) break;
            this.values.delete(oldest[0]);
            this.totalWeight -= oldest[1].weight;
        }
    }

    clear() {
        this.values.clear();
        this.totalWeight = 0;
    }
}

/**
 * Opt-in, read-only exact-range access to one immutable Merkle v1 root.
 *
 * This class deliberately has no relationship to the current v9 Documents
 * collection, program address, mount adapter, leases, or write path.
 */
export class MerkleReadSessionV1 {
    readonly leafSize: MerkleV1LeafSize;
    readonly size: bigint;
    readonly rootLevel: number;

    private readonly rootHash?: Uint8Array;
    private readonly source: MerkleBlockSourceV1;
    private readonly maxReadBytes: number;
    private readonly totalLeaves: bigint;
    private readonly levelCapacities: readonly bigint[];
    private readonly treeCache: WeightedLru<VerifiedTreeBlock>;
    private readonly dataCache: WeightedLru<VerifiedDataBlock>;
    private readonly inFlight = new Map<string, InFlightBlock>();
    private readonly counters: MutableWorkCounters = {
        readCalls: 0,
        outputBytes: 0,
        sourceFetches: 0,
        coalescedFetches: 0,
        treeCacheHits: 0,
        treeCacheMisses: 0,
        dataCacheHits: 0,
        dataCacheMisses: 0,
        treeBlocksVerified: 0,
        dataBlocksVerified: 0,
        dataBytesVerified: 0,
        treeBlocksVisited: 0,
        dataBlocksVisited: 0,
        authenticatedZeroRanges: 0,
        authenticatedZeroBytes: 0,
    };
    private closed = false;

    constructor(options: MerkleReadSessionOptionsV1) {
        if (!options || typeof options !== "object") {
            return invalid("options must be an object");
        }
        if (!options.source || typeof options.source.load !== "function") {
            return invalid("source.load must be a function");
        }
        let root: ReturnType<typeof assertMerkleRootDescriptorV1>;
        try {
            root = assertMerkleRootDescriptorV1(options.root);
        } catch (error) {
            return invalid("root descriptor is invalid", error);
        }
        this.leafSize = root.leafSize;
        this.size = root.size;
        this.rootLevel = root.rootLevel;
        this.rootHash = root.rootHash
            ? new Uint8Array(root.rootHash)
            : undefined;
        this.source = options.source;
        this.maxReadBytes = asBound(
            options.maxReadBytes,
            MERKLE_READ_SESSION_V1_DEFAULT_MAX_READ_BYTES,
            "maxReadBytes"
        );
        if (
            this.maxReadBytes > MERKLE_READ_SESSION_V1_ABSOLUTE_MAX_READ_BYTES
        ) {
            return invalid(
                `maxReadBytes must not exceed ${MERKLE_READ_SESSION_V1_ABSOLUTE_MAX_READ_BYTES}`
            );
        }
        const treeEntries = asBound(
            options.cache?.treeEntries,
            MERKLE_READ_SESSION_V1_DEFAULT_CACHE.treeEntries,
            "cache.treeEntries"
        );
        const treeBytes = asBound(
            options.cache?.treeBytes,
            MERKLE_READ_SESSION_V1_DEFAULT_CACHE.treeBytes,
            "cache.treeBytes"
        );
        const dataEntries = asBound(
            options.cache?.dataEntries,
            MERKLE_READ_SESSION_V1_DEFAULT_CACHE.dataEntries,
            "cache.dataEntries"
        );
        const dataBytes = asBound(
            options.cache?.dataBytes,
            MERKLE_READ_SESSION_V1_DEFAULT_CACHE.dataBytes,
            "cache.dataBytes"
        );
        this.treeCache = new WeightedLru(treeEntries, treeBytes);
        this.dataCache = new WeightedLru(dataEntries, dataBytes);
        const leafSize = BigInt(this.leafSize);
        this.totalLeaves =
            this.size === 0n ? 0n : (this.size + leafSize - 1n) / leafSize;
        const capacities = [1n];
        for (let level = 1; level <= this.rootLevel; level++) {
            capacities.push(capacities[level - 1] * BigInt(MERKLE_V1_FANOUT));
        }
        this.levelCapacities = capacities;
    }

    stats(): MerkleReadSessionStatsV1 {
        return Object.freeze({
            ...this.counters,
            closed: this.closed,
            inFlightFetches: this.inFlight.size,
            cachedTreeBlocks: this.treeCache.size,
            cachedTreeBytes: this.treeCache.weight,
            cachedDataBlocks: this.dataCache.size,
            cachedDataBytes: this.dataCache.weight,
        });
    }

    /** Abort pending source loads, reject active reads, and discard caches. */
    close() {
        if (this.closed) return;
        this.closed = true;
        const reason = closedFailure();
        for (const [key, entry] of this.inFlight) {
            entry.abandoned = true;
            entry.controller.abort(reason);
            this.inFlight.delete(key);
        }
        this.treeCache.clear();
        this.dataCache.clear();
    }

    async read(
        offsetValue: number | bigint,
        length: number,
        options: MerkleReadOptionsV1 = {}
    ): Promise<Uint8Array> {
        this.throwIfUnavailable(options.signal);
        const offset = asOffset(offsetValue);
        if (!Number.isSafeInteger(length) || length < 0) {
            return invalid("length must be a non-negative safe integer");
        }
        if (length > this.maxReadBytes) {
            return invalid(
                `length exceeds the configured maxReadBytes ${this.maxReadBytes}`
            );
        }
        this.counters.readCalls++;
        if (length === 0 || offset >= this.size) return new Uint8Array();

        const end = minBigInt(this.size, offset + BigInt(length));
        const outputLength = Number(end - offset);
        const output = new Uint8Array(outputLength);
        if (!this.rootHash) {
            this.recordAuthenticatedZeros(outputLength);
        } else if (this.rootLevel === 0) {
            const data = await this.loadData(
                this.rootHash,
                this.expectedLeafLength(0n),
                options.signal
            );
            output.set(data.bytes.subarray(Number(offset), Number(end)), 0);
        } else {
            await this.readTreeRange({
                hash: this.rootHash,
                level: this.rootLevel,
                baseLeaf: 0n,
                rangeStart: offset,
                rangeEnd: end,
                output,
                outputStart: offset,
                signal: options.signal,
            });
        }
        this.throwIfUnavailable(options.signal);
        this.counters.outputBytes += outputLength;
        return output;
    }

    private throwIfUnavailable(signal?: AbortSignal) {
        if (this.closed) throw closedFailure();
        if (signal?.aborted) throw abortFailure(signal);
    }

    private recordAuthenticatedZeros(bytes: number) {
        if (bytes === 0) return;
        this.counters.authenticatedZeroRanges++;
        this.counters.authenticatedZeroBytes += bytes;
    }

    private expectedLeafLength(leafIndex: bigint) {
        if (leafIndex < 0n || leafIndex >= this.totalLeaves) {
            return ioFailure("Merkle data reference is beyond the file EOF");
        }
        const leafStart = leafIndex * BigInt(this.leafSize);
        return Number(minBigInt(BigInt(this.leafSize), this.size - leafStart));
    }

    private validateTreePosition(
        tree: VerifiedTreeBlock,
        level: number,
        baseLeaf: bigint
    ) {
        if (baseLeaf < 0n || baseLeaf >= this.totalLeaves) {
            return ioFailure("Merkle tree reference is beyond the file EOF");
        }
        const capacity = this.levelCapacities[level];
        const childCapacity = this.levelCapacities[level - 1];
        const leavesHere = minBigInt(capacity, this.totalLeaves - baseLeaf);
        const slotLimit = (leavesHere + childCapacity - 1n) / childCapacity;
        const slots = merkleV1BitmapSlots(tree.bitmap);
        if (slots.some((slot) => BigInt(slot) >= slotLimit)) {
            return ioFailure(
                "Merkle tree contains a child beyond the file EOF"
            );
        }
        return slots;
    }

    private async readTreeRange(args: {
        hash: Uint8Array;
        level: number;
        baseLeaf: bigint;
        rangeStart: bigint;
        rangeEnd: bigint;
        output: Uint8Array;
        outputStart: bigint;
        signal?: AbortSignal;
    }): Promise<void> {
        this.throwIfUnavailable(args.signal);
        const tree = await this.loadTree(args.hash, args.level, args.signal);
        this.counters.treeBlocksVisited++;
        const slots = this.validateTreePosition(
            tree,
            args.level,
            args.baseLeaf
        );
        const childCapacity = this.levelCapacities[args.level - 1];
        const leafSize = BigInt(this.leafSize);
        const firstLeaf = args.rangeStart / leafSize;
        const lastLeaf = (args.rangeEnd - 1n) / leafSize;
        const firstSlot = Number((firstLeaf - args.baseLeaf) / childCapacity);
        const lastSlot = Number((lastLeaf - args.baseLeaf) / childCapacity);
        let compactIndex = 0;
        while (compactIndex < slots.length && slots[compactIndex] < firstSlot) {
            compactIndex++;
        }

        for (let slot = firstSlot; slot <= lastSlot; slot++) {
            this.throwIfUnavailable(args.signal);
            const childBaseLeaf = args.baseLeaf + BigInt(slot) * childCapacity;
            const childStart = childBaseLeaf * leafSize;
            const childEnd = minBigInt(
                this.size,
                (childBaseLeaf + childCapacity) * leafSize
            );
            const intersectionStart = maxBigInt(args.rangeStart, childStart);
            const intersectionEnd = minBigInt(args.rangeEnd, childEnd);
            if (intersectionStart >= intersectionEnd) continue;

            if (compactIndex >= slots.length || slots[compactIndex] !== slot) {
                this.recordAuthenticatedZeros(
                    Number(intersectionEnd - intersectionStart)
                );
                continue;
            }

            const childHash = tree.children[compactIndex];
            compactIndex++;
            if (args.level === 1) {
                const data = await this.loadData(
                    childHash,
                    this.expectedLeafLength(childBaseLeaf),
                    args.signal
                );
                const sourceStart = Number(intersectionStart - childStart);
                const sourceEnd = Number(intersectionEnd - childStart);
                const destinationStart = Number(
                    intersectionStart - args.outputStart
                );
                args.output.set(
                    data.bytes.subarray(sourceStart, sourceEnd),
                    destinationStart
                );
            } else {
                await this.readTreeRange({
                    ...args,
                    hash: childHash,
                    level: args.level - 1,
                    baseLeaf: childBaseLeaf,
                    rangeStart: intersectionStart,
                    rangeEnd: intersectionEnd,
                });
            }
        }
    }

    private async loadTree(
        hash: Uint8Array,
        level: number,
        signal?: AbortSignal
    ): Promise<VerifiedTreeBlock> {
        const block = await this.loadBlock("tree", level, hash, signal);
        if (!("level" in block)) {
            return ioFailure("Merkle tree reference resolved to a data block");
        }
        return block;
    }

    private async loadData(
        hash: Uint8Array,
        expectedLength: number,
        signal?: AbortSignal
    ): Promise<VerifiedDataBlock> {
        const block = await this.loadBlock("data", 0, hash, signal);
        if (!("bytes" in block)) {
            return ioFailure("Merkle data reference resolved to a tree block");
        }
        this.counters.dataBlocksVisited++;
        if (block.bytes.byteLength !== expectedLength) {
            return ioFailure(
                `Merkle data block length ${block.bytes.byteLength} does not match expected leaf length ${expectedLength}`
            );
        }
        return block;
    }

    private async loadBlock(
        kind: "data" | "tree",
        level: number,
        hash: Uint8Array,
        signal?: AbortSignal
    ): Promise<VerifiedBlock> {
        this.throwIfUnavailable(signal);
        if (!(hash instanceof Uint8Array) || hash.byteLength !== 32) {
            return ioFailure(
                "Merkle child reference must contain exactly 32 bytes"
            );
        }
        const key = `${kind}:${level}:${hashKey(hash)}`;
        const cache = kind === "tree" ? this.treeCache : this.dataCache;
        const cached = cache.get(key);
        if (cached) {
            if (kind === "tree") this.counters.treeCacheHits++;
            else this.counters.dataCacheHits++;
            return cached;
        }
        if (kind === "tree") this.counters.treeCacheMisses++;
        else this.counters.dataCacheMisses++;

        let entry = this.inFlight.get(key);
        if (entry) {
            this.counters.coalescedFetches++;
        } else {
            entry = this.createFetch(key, kind, level, new Uint8Array(hash));
        }
        entry.waiters++;
        try {
            return await this.awaitFetch(
                entry.promise,
                entry.controller.signal,
                signal
            );
        } finally {
            entry.waiters--;
            if (!entry.settled && entry.waiters === 0 && !entry.abandoned) {
                entry.abandoned = true;
                if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
                entry.controller.abort(
                    new MerkleReadSessionErrorV1(
                        "ABORT_ERR",
                        "Merkle block fetch has no remaining readers"
                    )
                );
            }
        }
    }

    private createFetch(
        key: string,
        kind: "data" | "tree",
        level: number,
        hash: Uint8Array
    ): InFlightBlock {
        let resolveFetch!: (block: VerifiedBlock) => void;
        let rejectFetch!: (error: unknown) => void;
        const promise = new Promise<VerifiedBlock>((resolve, reject) => {
            resolveFetch = resolve;
            rejectFetch = reject;
        });
        const entry: InFlightBlock = {
            controller: new AbortController(),
            promise,
            waiters: 0,
            settled: false,
            abandoned: false,
        };
        // Publish a fully initialized entry before invoking caller-controlled
        // source code. A synchronous close or reentrant read must be able to
        // observe and cancel/coalesce this fetch.
        this.inFlight.set(key, entry);
        const rejectOnAbort = () =>
            rejectFetch(
                this.closed
                    ? closedFailure()
                    : abortFailure(entry.controller.signal)
            );
        entry.controller.signal.addEventListener("abort", rejectOnAbort, {
            once: true,
        });
        const settle = () => {
            entry.settled = true;
            entry.controller.signal.removeEventListener("abort", rejectOnAbort);
            if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
        };
        void entry.promise.then(settle, settle);
        // A caller can abandon its race before a source that ignores abort
        // settles. Keep that late rejection observed without changing the
        // promise awaited by active callers.
        void entry.promise.catch(() => undefined);
        void this.fetchAndVerify(entry, kind, level, hash).then(
            resolveFetch,
            rejectFetch
        );
        return entry;
    }

    private async fetchAndVerify(
        entry: InFlightBlock,
        kind: "data" | "tree",
        level: number,
        hash: Uint8Array
    ): Promise<VerifiedBlock> {
        this.counters.sourceFetches++;
        let value: unknown;
        try {
            value = await this.source.load(
                { hash: new Uint8Array(hash), kind, level },
                { signal: entry.controller.signal }
            );
        } catch (error) {
            if (this.closed) throw closedFailure();
            if (entry.controller.signal.aborted) {
                throw abortFailure(entry.controller.signal);
            }
            return ioFailure("Merkle block source failed", error);
        }
        if (this.closed) throw closedFailure();
        if (entry.abandoned || entry.controller.signal.aborted) {
            throw abortFailure(entry.controller.signal);
        }
        if (value === undefined) {
            return ioFailure("Referenced Merkle block is missing");
        }

        const verified =
            kind === "tree"
                ? this.verifyTreeValue(value, level, hash)
                : this.verifyDataValue(value, hash);
        if (entry.abandoned || this.closed) {
            throw this.closed
                ? closedFailure()
                : abortFailure(entry.controller.signal);
        }
        const key = `${kind}:${level}:${hashKey(hash)}`;
        if (kind === "tree") {
            const tree = verified as VerifiedTreeBlock;
            this.treeCache.set(
                key,
                tree,
                1 + tree.bitmap.byteLength + 4 + tree.children.length * 32
            );
        } else {
            const data = verified as VerifiedDataBlock;
            this.dataCache.set(key, data, data.bytes.byteLength);
        }
        return verified;
    }

    private verifyTreeValue(
        value: unknown,
        expectedLevel: number,
        expectedHash: Uint8Array
    ): VerifiedTreeBlock {
        try {
            if (!(value instanceof MerkleTreeBlockV1)) {
                return ioFailure(
                    "Merkle tree reference resolved to an unknown or wrong block type"
                );
            }
            const id = value.id;
            const level = value.level;
            const rawBitmap = value.bitmap;
            const rawChildren = value.children;
            if (level !== expectedLevel) {
                return ioFailure(
                    `Merkle tree level ${String(level)} does not match expected level ${expectedLevel}`
                );
            }
            if (!(rawBitmap instanceof Uint8Array)) {
                return ioFailure("Merkle tree bitmap is not bytes");
            }
            if (rawBitmap.byteLength !== MERKLE_V1_BITMAP_BYTES) {
                return ioFailure(
                    `Merkle tree bitmap must contain exactly ${MERKLE_V1_BITMAP_BYTES} bytes`
                );
            }
            const bitmap = copyExactBytes(rawBitmap, MERKLE_V1_BITMAP_BYTES);
            if (!Array.isArray(rawChildren)) {
                return ioFailure("Merkle tree children are not an array");
            }
            const childCount = rawChildren.length;
            if (childCount === 0 || childCount > MERKLE_V1_FANOUT) {
                return ioFailure(
                    `Merkle tree child count must be from 1 through ${MERKLE_V1_FANOUT}`
                );
            }
            const presentSlots = merkleV1BitmapSlots(bitmap);
            if (childCount !== presentSlots.length) {
                return ioFailure(
                    "Merkle tree children do not match the bitmap population count"
                );
            }
            const children: Uint8Array[] = [];
            for (let index = 0; index < childCount; index++) {
                const child = rawChildren[index];
                if (!(child instanceof Uint8Array) || child.byteLength !== 32) {
                    return ioFailure(
                        "Merkle tree child hashes must contain exactly 32 bytes"
                    );
                }
                children.push(copyExactBytes(child, 32));
            }
            const actualHash = merkleTreeHashV1(level, bitmap, children);
            if (id !== blockId("tree", actualHash)) {
                return ioFailure(
                    "Merkle tree block id does not match its fields"
                );
            }
            if (!equalBytes(actualHash, expectedHash)) {
                return ioFailure(
                    "Merkle tree block hash does not match its authenticated reference"
                );
            }
            this.counters.treeBlocksVerified++;
            return { level, bitmap, children };
        } catch (error) {
            if (error instanceof MerkleReadSessionErrorV1) throw error;
            return ioFailure("Merkle tree block is corrupt", error);
        }
    }

    private verifyDataValue(
        value: unknown,
        expectedHash: Uint8Array
    ): VerifiedDataBlock {
        try {
            if (!(value instanceof MerkleDataBlockV1)) {
                return ioFailure(
                    "Merkle data reference resolved to an unknown or wrong block type"
                );
            }
            const id = value.id;
            const rawBytes = value.bytes;
            if (!(rawBytes instanceof Uint8Array)) {
                return ioFailure("Merkle data payload is not bytes");
            }
            const byteLength = rawBytes.byteLength;
            if (
                byteLength === 0 ||
                byteLength > MERKLE_V1_MAX_DATA_BYTES ||
                byteLength > this.leafSize
            ) {
                return ioFailure(
                    `Merkle data payload length must be from 1 through this session's ${this.leafSize}-byte leaf size`
                );
            }
            const bytes = copyExactBytes(rawBytes, byteLength);
            const actualHash = merkleDataHashV1(bytes);
            if (id !== blockId("data", actualHash)) {
                return ioFailure(
                    "Merkle data block id does not match its bytes"
                );
            }
            if (!equalBytes(actualHash, expectedHash)) {
                return ioFailure(
                    "Merkle data block hash does not match its authenticated reference"
                );
            }
            this.counters.dataBlocksVerified++;
            this.counters.dataBytesVerified += bytes.byteLength;
            return { bytes };
        } catch (error) {
            if (error instanceof MerkleReadSessionErrorV1) throw error;
            return ioFailure("Merkle data block is corrupt", error);
        }
    }

    private awaitFetch(
        promise: Promise<VerifiedBlock>,
        sourceSignal: AbortSignal,
        signal?: AbortSignal
    ): Promise<VerifiedBlock> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                signal?.removeEventListener("abort", onAbort);
                sourceSignal.removeEventListener("abort", onSourceAbort);
            };
            const settleResolve = (value: VerifiedBlock) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            };
            const settleReject = (error: unknown) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            };
            const onAbort = () => settleReject(abortFailure(signal!));
            const onSourceAbort = () =>
                settleReject(
                    this.closed ? closedFailure() : abortFailure(sourceSignal)
                );
            signal?.addEventListener("abort", onAbort, { once: true });
            sourceSignal.addEventListener("abort", onSourceAbort, {
                once: true,
            });
            if (signal?.aborted) {
                onAbort();
                return;
            }
            if (sourceSignal.aborted) {
                onSourceAbort();
                return;
            }
            promise.then(settleResolve, settleReject);
        });
    }
}
