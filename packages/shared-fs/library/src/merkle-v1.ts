import { field, variant } from "@dao-xyz/borsh";
import { sha256Sync, toBase64URL } from "@peerbit/crypto";
import {
    boundedBytesFieldV1,
    boundedUtf8FieldV1,
    fixedBytesArrayFieldV1,
    fixedBytesFieldV1,
} from "./merkle-wire-v1.js";

/**
 * Experimental codecs for the next Shared FS content generation.
 *
 * These values are deliberately not accepted by the current v9 document
 * store. They define and test the byte-level contract before a new store
 * address is introduced.
 */

export const MERKLE_V1_FANOUT = 256;
export const MERKLE_V1_BITMAP_BYTES = MERKLE_V1_FANOUT / 8;
export const MERKLE_V1_MAX_LEVEL = 6;
export type MerkleV1LeafSize = 65_536 | 262_144 | 524_288;
export const MERKLE_V1_ALLOWED_LEAF_SIZES: readonly [65_536, 262_144, 524_288] =
    Object.freeze([65_536, 262_144, 524_288] as const);
export const MERKLE_V1_MAX_DATA_BYTES =
    MERKLE_V1_ALLOWED_LEAF_SIZES[MERKLE_V1_ALLOWED_LEAF_SIZES.length - 1];
export const MERKLE_V1_MAX_BLOCK_ID_UTF8_BYTES = 64;
export const MERKLE_V1_MAX_VARIANT_UTF8_BYTES = 64;
export const MERKLE_V1_MAX_WIRE_BYTES = 2 * 1024 * 1024;
export const MERKLE_DATA_BLOCK_V1_VARIANT =
    "shared_fs_merkle_data_block_v1" as const;
export const MERKLE_TREE_BLOCK_V1_VARIANT =
    "shared_fs_merkle_tree_block_v1" as const;

/** Common Borsh dispatch root for every supported Merkle content variant. */
export abstract class MerkleContentEntryV1 {
    abstract id: string;
}

const DATA_DOMAIN = new TextEncoder().encode("peerbit-shared-fs/data/v1");
const TREE_DOMAIN = new TextEncoder().encode("peerbit-shared-fs/tree/v1");
const FILE_DOMAIN = new TextEncoder().encode("peerbit-shared-fs/file/v1");
const MAX_U64 = (1n << 64n) - 1n;

export type MerkleRootDescriptorV1 = {
    leafSize: MerkleV1LeafSize;
    size: bigint | number;
    rootLevel: number;
    rootHash?: Uint8Array;
};

const fail = (message: string): never => {
    throw new Error(`Invalid Merkle v1 value: ${message}`);
};

const assertBytes = (value: Uint8Array, name: string) => {
    if (!(value instanceof Uint8Array)) {
        fail(`${name} must be a Uint8Array`);
    }
    return value;
};

const copyHash = (value: Uint8Array, name: string) => {
    const source = assertBytes(value, name);
    if (source.byteLength !== 32) {
        fail(`${name} must contain exactly 32 bytes`);
    }
    return new Uint8Array(source);
};

const asU64 = (value: bigint | number, name: string) => {
    if (typeof value !== "bigint" && typeof value !== "number") {
        fail(`${name} must be a number or bigint`);
    }
    if (
        typeof value === "number" &&
        (!Number.isSafeInteger(value) || value < 0)
    ) {
        fail(`${name} must be a non-negative safe integer or bigint`);
    }
    const converted = BigInt(value);
    if (converted < 0n || converted > MAX_U64) {
        fail(`${name} must fit in u64`);
    }
    return converted;
};

const encodeU32 = (value: number, name: string) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
        fail(`${name} must fit in u32`);
    }
    const encoded = new Uint8Array(4);
    new DataView(encoded.buffer).setUint32(0, value, true);
    return encoded;
};

const encodeU64 = (value: bigint | number, name: string) => {
    const encoded = new Uint8Array(8);
    new DataView(encoded.buffer).setBigUint64(0, asU64(value, name), true);
    return encoded;
};

const encodeU8 = (value: number, name: string) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
        fail(`${name} must fit in u8`);
    }
    return Uint8Array.of(value);
};

const concatBytes = (parts: readonly Uint8Array[]) => {
    const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
};

const equalBytes = (left: Uint8Array, right: Uint8Array) => {
    if (left.byteLength !== right.byteLength) return false;
    let different = 0;
    for (let i = 0; i < left.byteLength; i++) {
        different |= left[i] ^ right[i];
    }
    return different === 0;
};

// @peerbit/crypto keeps RFC 4648 padding. Merkle v1 ids deliberately use the
// canonical unpadded base64url form so one hash has only one textual id.
const toUnpaddedBase64URL = (value: Uint8Array) =>
    toBase64URL(value).replace(/=+$/u, "");

const merkleBlockIdFromHashV1 = (
    kind: "data" | "tree",
    hashValue: Uint8Array
) => {
    const hash = copyHash(hashValue, `${kind} hash`);
    return `${kind === "data" ? "data2" : "tree2"}:${toUnpaddedBase64URL(hash)}`;
};

/** Canonical document id for an already-authenticated data-block hash. */
export const merkleDataIdFromHashV1 = (hash: Uint8Array) =>
    merkleBlockIdFromHashV1("data", hash);

/** Canonical document id for an already-authenticated tree-block hash. */
export const merkleTreeIdFromHashV1 = (hash: Uint8Array) =>
    merkleBlockIdFromHashV1("tree", hash);

const assertLeafSize = (leafSize: number): MerkleV1LeafSize => {
    if (leafSize !== 65_536 && leafSize !== 262_144 && leafSize !== 524_288) {
        fail(
            `leafSize must be one of ${MERKLE_V1_ALLOWED_LEAF_SIZES.join(", ")}`
        );
    }
    return leafSize as MerkleV1LeafSize;
};

const assertLevel = (level: number) => {
    if (!Number.isInteger(level) || level < 1 || level > MERKLE_V1_MAX_LEVEL) {
        fail(`tree level must be from 1 through ${MERKLE_V1_MAX_LEVEL}`);
    }
    return level;
};

const isAllZero = (bytes: Uint8Array) => {
    let nonzero = 0;
    for (const value of bytes) nonzero |= value;
    return nonzero === 0;
};

const popcountByte = (value: number) => {
    let count = 0;
    for (let remaining = value; remaining !== 0; remaining &= remaining - 1) {
        count++;
    }
    return count;
};

export const merkleV1BitmapHasSlot = (bitmap: Uint8Array, slot: number) => {
    const source = assertBytes(bitmap, "bitmap");
    if (source.byteLength !== MERKLE_V1_BITMAP_BYTES) {
        fail(`bitmap must contain exactly ${MERKLE_V1_BITMAP_BYTES} bytes`);
    }
    if (!Number.isInteger(slot) || slot < 0 || slot >= MERKLE_V1_FANOUT) {
        fail(`slot must be from 0 through ${MERKLE_V1_FANOUT - 1}`);
    }
    return (source[slot >>> 3] & (1 << (slot & 7))) !== 0;
};

export const merkleV1BitmapSlots = (bitmap: Uint8Array) => {
    const source = assertBytes(bitmap, "bitmap");
    if (source.byteLength !== MERKLE_V1_BITMAP_BYTES) {
        fail(`bitmap must contain exactly ${MERKLE_V1_BITMAP_BYTES} bytes`);
    }
    const slots: number[] = [];
    for (let slot = 0; slot < MERKLE_V1_FANOUT; slot++) {
        if ((source[slot >>> 3] & (1 << (slot & 7))) !== 0) slots.push(slot);
    }
    return slots;
};

export const merkleV1BitmapFromSlots = (slots: readonly number[]) => {
    const bitmap = new Uint8Array(MERKLE_V1_BITMAP_BYTES);
    let previous = -1;
    for (const slot of slots) {
        if (!Number.isInteger(slot) || slot < 0 || slot >= MERKLE_V1_FANOUT) {
            fail(`slot must be from 0 through ${MERKLE_V1_FANOUT - 1}`);
        }
        if (slot <= previous) {
            fail("slots must be unique and strictly ascending");
        }
        bitmap[slot >>> 3] |= 1 << (slot & 7);
        previous = slot;
    }
    return bitmap;
};

const normalizeTree = (
    level: number,
    bitmapValue: Uint8Array,
    childValues: readonly Uint8Array[]
) => {
    assertLevel(level);
    const bitmapSource = assertBytes(bitmapValue, "bitmap");
    if (bitmapSource.byteLength !== MERKLE_V1_BITMAP_BYTES) {
        fail(`bitmap must contain exactly ${MERKLE_V1_BITMAP_BYTES} bytes`);
    }
    const bitmap = new Uint8Array(bitmapSource);
    const count = [...bitmap].reduce(
        (sum, value) => sum + popcountByte(value),
        0
    );
    if (count === 0) fail("tree blocks must not be empty");
    if (!Array.isArray(childValues)) fail("children must be an array");
    if (childValues.length !== count) {
        fail("children must match the bitmap population count");
    }
    const children = childValues.map((child, index) =>
        copyHash(child, `children[${index}]`)
    );
    return { bitmap, children };
};

const normalizeData = (bytesValue: Uint8Array) => {
    const source = assertBytes(bytesValue, "bytes");
    if (
        source.byteLength === 0 ||
        source.byteLength > MERKLE_V1_MAX_DATA_BYTES
    ) {
        fail(`data length must be from 1 through ${MERKLE_V1_MAX_DATA_BYTES}`);
    }
    // Snapshot before validation: callers may supply a SharedArrayBuffer view.
    const bytes = new Uint8Array(source);
    if (isAllZero(bytes)) {
        fail("all-zero data blocks must be represented by an absent child");
    }
    return bytes;
};

const encodeNormalizedDataHashInputV1 = (bytes: Uint8Array) =>
    concatBytes([DATA_DOMAIN, encodeU32(bytes.byteLength, "length"), bytes]);

const normalizedDataHashV1 = (bytes: Uint8Array) =>
    sha256Sync(encodeNormalizedDataHashInputV1(bytes));

const snapshotDataWithHashV1 = (bytesValue: Uint8Array) => {
    const bytes = normalizeData(bytesValue);
    const hash = normalizedDataHashV1(bytes);
    return { bytes, hash, id: merkleDataIdFromHashV1(hash) };
};

/** Canonical Borsh field bytes hashed for a data block (without a variant). */
export const encodeMerkleDataHashInputV1 = (bytesValue: Uint8Array) =>
    encodeNormalizedDataHashInputV1(normalizeData(bytesValue));

export const merkleDataHashV1 = (bytes: Uint8Array) =>
    sha256Sync(encodeMerkleDataHashInputV1(bytes));

export const merkleDataIdV1 = (bytes: Uint8Array) =>
    merkleDataIdFromHashV1(merkleDataHashV1(bytes));

@variant(MERKLE_DATA_BLOCK_V1_VARIANT)
export class MerkleDataBlockV1 extends MerkleContentEntryV1 {
    @field(
        boundedUtf8FieldV1({
            name: "data block id",
            maxUtf8Bytes: MERKLE_V1_MAX_BLOCK_ID_UTF8_BYTES,
            prefix: "data2:",
        })
    )
    id: string;

    @field(boundedBytesFieldV1(1, MERKLE_V1_MAX_DATA_BYTES, "data block bytes"))
    bytes: Uint8Array;

    constructor(properties?: { bytes: Uint8Array }) {
        super();
        if (properties) {
            const snapshot = snapshotDataWithHashV1(properties.bytes);
            this.bytes = snapshot.bytes;
            this.id = snapshot.id;
        }
    }

    /**
     * Construct an owned, canonical snapshot and return the hash computed for
     * those exact bytes. The hash does not authenticate later block mutations.
     */
    static createWithHash(bytesValue: Uint8Array): Readonly<{
        block: MerkleDataBlockV1;
        hash: Uint8Array;
    }> {
        const snapshot = snapshotDataWithHashV1(bytesValue);
        const block = new MerkleDataBlockV1();
        block.bytes = snapshot.bytes;
        block.id = snapshot.id;
        return { block, hash: snapshot.hash };
    }
}

export const assertMerkleDataBlockV1 = (value: unknown): MerkleDataBlockV1 => {
    if (!(value instanceof MerkleDataBlockV1)) {
        return fail("data block has an unknown type");
    }
    const expected = merkleDataIdV1(value.bytes);
    if (value.id !== expected) fail("data block id does not match its bytes");
    return value;
};

/** Canonical Borsh field bytes hashed for a tree block (without a variant). */
export const encodeMerkleTreeHashInputV1 = (
    level: number,
    bitmapValue: Uint8Array,
    childValues: readonly Uint8Array[]
) => {
    const { bitmap, children } = normalizeTree(level, bitmapValue, childValues);
    return concatBytes([
        TREE_DOMAIN,
        encodeU8(level, "level"),
        bitmap,
        encodeU32(children.length, "children length"),
        ...children,
    ]);
};

export const merkleTreeHashV1 = (
    level: number,
    bitmap: Uint8Array,
    children: readonly Uint8Array[]
) => sha256Sync(encodeMerkleTreeHashInputV1(level, bitmap, children));

export const merkleTreeIdV1 = (
    level: number,
    bitmap: Uint8Array,
    children: readonly Uint8Array[]
) => merkleTreeIdFromHashV1(merkleTreeHashV1(level, bitmap, children));

@variant(MERKLE_TREE_BLOCK_V1_VARIANT)
export class MerkleTreeBlockV1 extends MerkleContentEntryV1 {
    @field(
        boundedUtf8FieldV1({
            name: "tree block id",
            maxUtf8Bytes: MERKLE_V1_MAX_BLOCK_ID_UTF8_BYTES,
            prefix: "tree2:",
        })
    )
    id: string;

    @field({ type: "u8" })
    level: number;

    @field(fixedBytesFieldV1(MERKLE_V1_BITMAP_BYTES, "tree bitmap"))
    bitmap: Uint8Array;

    @field(fixedBytesArrayFieldV1(32, MERKLE_V1_FANOUT, "tree children"))
    children: Uint8Array[];

    constructor(properties?: {
        level: number;
        bitmap: Uint8Array;
        children: readonly Uint8Array[];
    }) {
        super();
        if (properties) {
            const normalized = normalizeTree(
                properties.level,
                properties.bitmap,
                properties.children
            );
            this.level = properties.level;
            this.bitmap = normalized.bitmap;
            this.children = normalized.children;
            this.id = merkleTreeIdV1(this.level, this.bitmap, this.children);
        }
    }
}

export const assertMerkleTreeBlockV1 = (value: unknown): MerkleTreeBlockV1 => {
    if (!(value instanceof MerkleTreeBlockV1)) {
        return fail("tree block has an unknown type");
    }
    const expected = merkleTreeIdV1(value.level, value.bitmap, value.children);
    if (value.id !== expected) fail("tree block id does not match its fields");
    return value;
};

export const merkleRootLevelV1 = (
    sizeValue: bigint | number,
    leafSizeValue: number
) => {
    const size = asU64(sizeValue, "size");
    const leafSize = BigInt(assertLeafSize(leafSizeValue));
    if (size <= leafSize) return 0;
    const leaves = (size + leafSize - 1n) / leafSize;
    let level = 0;
    let capacity = 1n;
    while (capacity < leaves) {
        capacity *= BigInt(MERKLE_V1_FANOUT);
        level++;
    }
    if (level > MERKLE_V1_MAX_LEVEL) {
        fail("size exceeds the Merkle v1 address space");
    }
    return level;
};

export const assertMerkleRootDescriptorV1 = (descriptor: unknown) => {
    if (!descriptor || typeof descriptor !== "object") {
        return fail("root descriptor must be an object");
    }
    const value = descriptor as Partial<MerkleRootDescriptorV1>;
    const leafSize = assertLeafSize(value.leafSize as number);
    const size = asU64(value.size as bigint | number, "size");
    const expectedLevel = merkleRootLevelV1(size, leafSize);
    if (value.rootLevel !== expectedLevel) {
        fail(`rootLevel must be the canonical level ${expectedLevel}`);
    }
    if (value.rootHash === null) fail("rootHash must be undefined or 32 bytes");
    const rootHash =
        value.rootHash === undefined
            ? undefined
            : copyHash(value.rootHash, "rootHash");
    if (size === 0n && rootHash) {
        fail("an empty file must not have a root hash");
    }
    return { leafSize, size, rootLevel: expectedLevel, rootHash };
};

/** Canonical Borsh field bytes hashed for a file content root. */
export const encodeMerkleContentRootHashInputV1 = (
    descriptor: MerkleRootDescriptorV1
) => {
    const normalized = assertMerkleRootDescriptorV1(descriptor);
    return concatBytes([
        FILE_DOMAIN,
        encodeU32(normalized.leafSize, "leafSize"),
        encodeU64(normalized.size, "size"),
        encodeU8(normalized.rootLevel, "rootLevel"),
        Uint8Array.of(normalized.rootHash ? 1 : 0),
        ...(normalized.rootHash ? [normalized.rootHash] : []),
    ]);
};

export const merkleContentRootV1 = (descriptor: MerkleRootDescriptorV1) =>
    sha256Sync(encodeMerkleContentRootHashInputV1(descriptor));

export const merkleContentRootEqualsV1 = (
    descriptor: MerkleRootDescriptorV1,
    expected: Uint8Array
) =>
    equalBytes(
        merkleContentRootV1(descriptor),
        copyHash(expected, "contentRoot")
    );

/** Enforces the only valid parent-child type transition during traversal. */
export const assertMerkleChildLevelV1 = (
    parentLevel: number,
    child: MerkleDataBlockV1 | MerkleTreeBlockV1
) => {
    assertLevel(parentLevel);
    if (parentLevel === 1) {
        if (!(child instanceof MerkleDataBlockV1)) {
            fail("a level-1 tree may reference only data blocks");
        }
        assertMerkleDataBlockV1(child);
        return;
    }
    if (
        !(child instanceof MerkleTreeBlockV1) ||
        child.level !== parentLevel - 1
    ) {
        fail(
            `a level-${parentLevel} tree requires level-${parentLevel - 1} children`
        );
    }
    assertMerkleTreeBlockV1(child);
};

/** Verifies a descriptor against the exact self-certifying root value. */
export const assertMerkleRootBlockV1 = (
    descriptor: MerkleRootDescriptorV1,
    root?: MerkleDataBlockV1 | MerkleTreeBlockV1
) => {
    const normalized = assertMerkleRootDescriptorV1(descriptor);
    if (!normalized.rootHash) {
        if (root) fail("an authenticated zero root must not resolve a block");
        return;
    }
    if (!root) return fail("a present root hash requires a root block");

    let actual: Uint8Array;
    if (normalized.rootLevel === 0) {
        if (!(root instanceof MerkleDataBlockV1)) {
            return fail("a level-0 root must resolve to a data block");
        }
        assertMerkleDataBlockV1(root);
        if (BigInt(root.bytes.byteLength) !== normalized.size) {
            return fail("a level-0 data block length must equal the file size");
        }
        actual = merkleDataHashV1(root.bytes);
    } else {
        if (
            !(root instanceof MerkleTreeBlockV1) ||
            root.level !== normalized.rootLevel
        ) {
            return fail(
                `a level-${normalized.rootLevel} root must resolve to a matching tree block`
            );
        }
        assertMerkleTreeBlockV1(root);
        const leafSize = BigInt(normalized.leafSize);
        const leaves = (normalized.size + leafSize - 1n) / leafSize;
        let childCapacity = 1n;
        for (let level = 1; level < normalized.rootLevel; level++) {
            childCapacity *= BigInt(MERKLE_V1_FANOUT);
        }
        const rootSlotLimit = (leaves + childCapacity - 1n) / childCapacity;
        if (
            merkleV1BitmapSlots(root.bitmap).some(
                (slot) => BigInt(slot) >= rootSlotLimit
            )
        ) {
            return fail("root tree contains a child beyond the file EOF");
        }
        actual = merkleTreeHashV1(root.level, root.bitmap, root.children);
    }
    if (!equalBytes(actual, normalized.rootHash)) {
        fail("root block hash does not match the descriptor");
    }
};
