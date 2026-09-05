import { field, fixedArray, option, variant, vec } from "@dao-xyz/borsh";
import {
    MerkleDataBlockV1,
    MerkleTreeBlockV1,
    assertMerkleDataBlockV1,
    assertMerkleRootDescriptorV1,
    assertMerkleTreeBlockV1,
    merkleContentRootV1,
    merkleDataIdFromHashV1,
    merkleTreeIdFromHashV1,
    type MerkleRootDescriptorV1,
    type MerkleV1LeafSize,
} from "./merkle-v1.js";

/** Wire/resource bounds for one immutable Merkle file-version document. */
export const MERKLE_FILE_VERSION_V1_LIMITS = Object.freeze({
    maxParentVersionIds: 8_000,
    maxVersionIdUtf8Bytes: 256,
    maxNodeIdUtf8Bytes: 256,
    maxParentVersionIdUtf8Bytes: 256,
    maxParentVersionIdsUtf8Bytes: 1024 * 1024,
    maxAuthorKeyUtf8Bytes: 4 * 1024,
    maxMachineLabelUtf8Bytes: 4 * 1024,
    maxChangesetIdCodeUnits: 256,
    maxChangesetIdUtf8Bytes: 1024,
});

export type MerkleFileVersionV1Properties = Readonly<{
    id: string;
    nodeId: string;
    parentVersionIds?: readonly string[];
    causalDepth: bigint | number;
    size: bigint | number;
    leafSize: MerkleV1LeafSize;
    rootLevel: number;
    rootHash?: Uint8Array;
    createdAt: bigint | number;
    authorKey: string;
    machineLabel: string;
    conflictResolution?: boolean;
    changesetId?: string;
    legacyWholeSha256?: Uint8Array;
}>;

export type MerkleContentEntryV1 =
    | MerkleFileVersionV1
    | MerkleTreeBlockV1
    | MerkleDataBlockV1;

export type MerkleIndexEntryKindV1 =
    | "file-version"
    | "merkle-tree"
    | "merkle-data";

const MAX_U64 = (1n << 64n) - 1n;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

const fail = (message: string): never => {
    throw new Error(`Invalid Merkle file version v1 value: ${message}`);
};

const asU64 = (value: unknown, name: string) => {
    if (typeof value !== "bigint" && typeof value !== "number") {
        return fail(`${name} must be a number or bigint`);
    }
    if (
        typeof value === "number" &&
        (!Number.isSafeInteger(value) || value < 0)
    ) {
        return fail(`${name} must be a non-negative safe integer or bigint`);
    }
    const converted = BigInt(value);
    if (converted < 0n || converted > MAX_U64) {
        return fail(`${name} must fit in u64`);
    }
    return converted;
};

function copyHash(value: unknown, name: string): Uint8Array;
function copyHash(
    value: unknown,
    name: string,
    options: { optional: true }
): Uint8Array | undefined;
function copyHash(
    value: unknown,
    name: string,
    options: { optional?: boolean } = {}
): Uint8Array | undefined {
    if (value === undefined && options.optional) return undefined;
    if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
        return fail(`${name} must contain exactly 32 bytes`);
    }
    return new Uint8Array(value);
}

const equalBytes = (left: Uint8Array, right: Uint8Array) => {
    let different = left.byteLength ^ right.byteLength;
    const length = Math.min(left.byteLength, right.byteLength);
    for (let index = 0; index < length; index++) {
        different |= left[index] ^ right[index];
    }
    return different === 0;
};

const boundedString = (
    value: unknown,
    name: string,
    maxUtf8Bytes: number,
    options: { prefix?: string } = {}
) => {
    if (typeof value !== "string") return fail(`${name} must be a string`);
    if (value.length === 0) {
        return fail(`${name} must not be empty`);
    }
    if (options.prefix && !value.startsWith(options.prefix)) {
        return fail(`${name} must start with ${options.prefix}`);
    }
    if (options.prefix && value.length === options.prefix.length) {
        return fail(`${name} must include a value after ${options.prefix}`);
    }
    const bytes = textEncoder.encode(value);
    // TextEncoder replaces unpaired UTF-16 surrogates. Reject rather than
    // permitting two JS strings to serialize to the same wire bytes.
    if (textDecoder.decode(bytes) !== value) {
        return fail(`${name} must contain well-formed Unicode`);
    }
    if (bytes.byteLength > maxUtf8Bytes) {
        return fail(`${name} exceeds ${maxUtf8Bytes} UTF-8 bytes`);
    }
    return { value, bytes: bytes.byteLength };
};

type NormalizedMerkleFileVersionV1 = Readonly<{
    id: string;
    nodeId: string;
    parentVersionIds: string[];
    causalDepth: bigint;
    size: bigint;
    leafSize: MerkleV1LeafSize;
    rootLevel: number;
    rootHash?: Uint8Array;
    contentRoot: Uint8Array;
    createdAt: bigint;
    authorKey: string;
    machineLabel: string;
    conflictResolution: boolean;
    changesetId?: string;
    legacyWholeSha256?: Uint8Array;
}>;

const normalizeCommonFields = (value: {
    id?: unknown;
    nodeId?: unknown;
    parentVersionIds?: unknown;
    causalDepth?: unknown;
    size?: unknown;
    leafSize?: unknown;
    rootLevel?: unknown;
    rootHash?: unknown;
    createdAt?: unknown;
    authorKey?: unknown;
    machineLabel?: unknown;
    conflictResolution?: unknown;
    changesetId?: unknown;
    legacyWholeSha256?: unknown;
}) => {
    const id = boundedString(
        value.id,
        "id",
        MERKLE_FILE_VERSION_V1_LIMITS.maxVersionIdUtf8Bytes,
        { prefix: "version:" }
    ).value;
    const nodeId = boundedString(
        value.nodeId,
        "nodeId",
        MERKLE_FILE_VERSION_V1_LIMITS.maxNodeIdUtf8Bytes,
        { prefix: "file:" }
    ).value;
    if (!Array.isArray(value.parentVersionIds)) {
        return fail("parentVersionIds must be an array");
    }
    if (
        value.parentVersionIds.length >
        MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIds
    ) {
        return fail(
            `parentVersionIds exceeds ${MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIds} entries`
        );
    }
    const parentVersionIds: string[] = [];
    const seenParents = new Set<string>();
    let parentBytes = 0;
    for (let index = 0; index < value.parentVersionIds.length; index++) {
        const parent = boundedString(
            value.parentVersionIds[index],
            `parentVersionIds[${index}]`,
            MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIdUtf8Bytes,
            { prefix: "version:" }
        );
        if (parent.value === id) {
            return fail("a version must not name itself as a parent");
        }
        if (seenParents.has(parent.value)) {
            return fail("parentVersionIds must be unique");
        }
        seenParents.add(parent.value);
        parentBytes += parent.bytes;
        if (
            parentBytes >
            MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIdsUtf8Bytes
        ) {
            return fail(
                `parentVersionIds exceeds ${MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIdsUtf8Bytes} aggregate UTF-8 bytes`
            );
        }
        parentVersionIds.push(parent.value);
    }

    const causalDepth = asU64(value.causalDepth, "causalDepth");
    if (causalDepth < 1n) return fail("causalDepth must be at least 1");
    if (parentVersionIds.length === 0 && causalDepth !== 1n) {
        return fail("a parentless version must have causalDepth 1");
    }
    if (parentVersionIds.length !== 0 && causalDepth < 2n) {
        return fail("a version with parents must have causalDepth at least 2");
    }
    let root: ReturnType<typeof assertMerkleRootDescriptorV1>;
    try {
        root = assertMerkleRootDescriptorV1({
            size: value.size as bigint | number,
            leafSize: value.leafSize as number,
            rootLevel: value.rootLevel as number,
            rootHash: value.rootHash as Uint8Array | undefined,
        });
    } catch (error) {
        return fail(
            `root descriptor is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    const createdAt = asU64(value.createdAt, "createdAt");
    const authorKey = boundedString(
        value.authorKey,
        "authorKey",
        MERKLE_FILE_VERSION_V1_LIMITS.maxAuthorKeyUtf8Bytes
    ).value;
    const machineLabel = boundedString(
        value.machineLabel,
        "machineLabel",
        MERKLE_FILE_VERSION_V1_LIMITS.maxMachineLabelUtf8Bytes
    ).value;
    if (typeof value.conflictResolution !== "boolean") {
        return fail("conflictResolution must be a boolean");
    }
    let changesetId: string | undefined;
    if (value.changesetId !== undefined) {
        if (value.changesetId === null) {
            return fail("changesetId must be undefined or a string");
        }
        const checked = boundedString(
            value.changesetId,
            "changesetId",
            MERKLE_FILE_VERSION_V1_LIMITS.maxChangesetIdUtf8Bytes
        );
        if (
            checked.value.length >
            MERKLE_FILE_VERSION_V1_LIMITS.maxChangesetIdCodeUnits
        ) {
            return fail(
                `changesetId exceeds ${MERKLE_FILE_VERSION_V1_LIMITS.maxChangesetIdCodeUnits} UTF-16 code units`
            );
        }
        changesetId = checked.value;
    }
    if (value.legacyWholeSha256 === null) {
        return fail("legacyWholeSha256 must be undefined or 32 bytes");
    }
    const legacyWholeSha256 = copyHash(
        value.legacyWholeSha256,
        "legacyWholeSha256",
        { optional: true }
    );
    return {
        id,
        nodeId,
        parentVersionIds,
        causalDepth,
        root,
        createdAt,
        authorKey,
        machineLabel,
        conflictResolution: value.conflictResolution,
        changesetId,
        legacyWholeSha256,
    };
};

const normalizeProperties = (
    value: MerkleFileVersionV1Properties
): NormalizedMerkleFileVersionV1 => {
    // Do not spread arbitrary input into the wire instance. Capture only the
    // declared fields, once each, and default only truly absent optionals.
    const parentVersionIds = value.parentVersionIds;
    const conflictResolution = value.conflictResolution;
    const normalized = normalizeCommonFields({
        id: value.id,
        nodeId: value.nodeId,
        parentVersionIds:
            parentVersionIds === undefined ? [] : parentVersionIds,
        causalDepth: value.causalDepth,
        size: value.size,
        leafSize: value.leafSize,
        rootLevel: value.rootLevel,
        rootHash: value.rootHash,
        createdAt: value.createdAt,
        authorKey: value.authorKey,
        machineLabel: value.machineLabel,
        conflictResolution:
            conflictResolution === undefined ? false : conflictResolution,
        changesetId: value.changesetId,
        legacyWholeSha256: value.legacyWholeSha256,
    });
    const { root, ...metadata } = normalized;
    return {
        ...metadata,
        size: root.size,
        leafSize: root.leafSize,
        rootLevel: root.rootLevel,
        rootHash: root.rootHash,
        contentRoot: merkleContentRootV1(root),
    };
};

const snapshotVersion = (
    value: MerkleFileVersionV1
): NormalizedMerkleFileVersionV1 => {
    if (!(value instanceof MerkleFileVersionV1)) {
        return fail("file version has an unknown type");
    }
    // Capture each public field before validation so an accessor-backed
    // adversarial instance cannot change a value between related checks.
    const normalized = normalizeCommonFields({
        id: value.id,
        nodeId: value.nodeId,
        parentVersionIds: value.parentVersionIds,
        causalDepth: value.causalDepth,
        size: value.size,
        leafSize: value.leafSize,
        rootLevel: value.rootLevel,
        rootHash: value.rootHash,
        createdAt: value.createdAt,
        authorKey: value.authorKey,
        machineLabel: value.machineLabel,
        conflictResolution: value.conflictResolution,
        changesetId: value.changesetId,
        legacyWholeSha256: value.legacyWholeSha256,
    });
    const contentRoot = copyHash(value.contentRoot, "contentRoot");
    const expectedContentRoot = merkleContentRootV1(normalized.root);
    if (!equalBytes(contentRoot, expectedContentRoot)) {
        return fail("contentRoot does not match the root descriptor");
    }
    const { root, ...metadata } = normalized;
    return {
        ...metadata,
        size: root.size,
        leafSize: root.leafSize,
        rootLevel: root.rootLevel,
        rootHash: root.rootHash,
        contentRoot,
    };
};

@variant("shared_fs_merkle_file_version_v1")
export class MerkleFileVersionV1 {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    nodeId: string;

    @field({ type: vec("string") })
    parentVersionIds: string[];

    @field({ type: "u64" })
    causalDepth: bigint;

    @field({ type: "u64" })
    size: bigint;

    @field({ type: "u32" })
    leafSize: MerkleV1LeafSize;

    @field({ type: "u8" })
    rootLevel: number;

    @field({ type: option(fixedArray("u8", 32)) })
    rootHash?: Uint8Array;

    @field({ type: fixedArray("u8", 32) })
    contentRoot: Uint8Array;

    @field({ type: "u64" })
    createdAt: bigint;

    @field({ type: "string" })
    authorKey: string;

    @field({ type: "string" })
    machineLabel: string;

    @field({ type: "bool" })
    conflictResolution: boolean;

    @field({ type: option("string") })
    changesetId?: string;

    @field({ type: option(fixedArray("u8", 32)) })
    legacyWholeSha256?: Uint8Array;

    constructor(properties?: MerkleFileVersionV1Properties) {
        if (properties === undefined) return;
        if (!properties || typeof properties !== "object") {
            return fail("properties must be an object");
        }
        Object.assign(this, normalizeProperties(properties));
    }
}

/** Validate every bounded field and the descriptor-to-contentRoot binding. */
export const assertMerkleFileVersionV1 = (
    value: unknown
): MerkleFileVersionV1 => {
    snapshotVersion(value as MerkleFileVersionV1);
    return value as MerkleFileVersionV1;
};

/** Return a copied, fully validated root descriptor from a signed version. */
export const merkleRootDescriptorFromVersionV1 = (
    value: MerkleFileVersionV1
): Readonly<MerkleRootDescriptorV1> => {
    const normalized = snapshotVersion(value);
    return Object.freeze({
        leafSize: normalized.leafSize,
        size: normalized.size,
        rootLevel: normalized.rootLevel,
        rootHash: normalized.rootHash
            ? new Uint8Array(normalized.rootHash)
            : undefined,
    });
};

/** The version's sole direct content edge; descendants belong to tree rows. */
export const merkleRootBlockRefsV1 = (
    value: MerkleFileVersionV1
): readonly string[] => {
    const normalized = snapshotVersion(value);
    if (!normalized.rootHash) return Object.freeze([]);
    return Object.freeze([
        normalized.rootLevel === 0
            ? merkleDataIdFromHashV1(normalized.rootHash)
            : merkleTreeIdFromHashV1(normalized.rootHash),
    ]);
};

const snapshotTreeBlockV1 = (value: MerkleTreeBlockV1) => {
    if (!(value instanceof MerkleTreeBlockV1)) {
        return fail("tree block has an unknown type");
    }
    // Read every public property exactly once. Reconstructing through the
    // canonical constructor copies bitmap/children and verifies the claimed
    // id against one stable snapshot, closing accessor-backed TOCTOU gaps.
    const claimedId = value.id;
    const level = value.level;
    const bitmap = value.bitmap;
    const children = value.children;
    const snapshot = new MerkleTreeBlockV1({ level, bitmap, children });
    if (claimedId !== snapshot.id) {
        return fail("tree block id does not match its fields");
    }
    return snapshot;
};

const snapshotDataBlockV1 = (value: MerkleDataBlockV1) => {
    if (!(value instanceof MerkleDataBlockV1)) {
        return fail("data block has an unknown type");
    }
    const claimedId = value.id;
    const bytes = value.bytes;
    const snapshot = new MerkleDataBlockV1({ bytes });
    if (claimedId !== snapshot.id) {
        return fail("data block id does not match its bytes");
    }
    return snapshot;
};

/** Derive distinct reverse-index edges from a structurally verified tree. */
export const merkleTreeBlockRefsV1 = (
    value: MerkleTreeBlockV1
): readonly string[] => {
    const snapshot = snapshotTreeBlockV1(value);
    const idForHash =
        snapshot.level === 1 ? merkleDataIdFromHashV1 : merkleTreeIdFromHashV1;
    return Object.freeze([
        ...new Set(snapshot.children.map((hash) => idForHash(hash))),
    ]);
};

/** Strict generation entry guard: unknown variants fail closed. */
export const assertMerkleContentEntryV1 = (
    value: unknown
): MerkleContentEntryV1 => {
    if (value instanceof MerkleFileVersionV1) {
        return assertMerkleFileVersionV1(value);
    }
    if (value instanceof MerkleTreeBlockV1) {
        return assertMerkleTreeBlockV1(value);
    }
    if (value instanceof MerkleDataBlockV1) {
        return assertMerkleDataBlockV1(value);
    }
    return fail("entry has an unknown type");
};

/**
 * Generation-specific local index projection. `blockRefs` is accepted from no
 * public input: it is derived after structural validation from the signed
 * version root or self-certifying tree children.
 */
@variant("shared_fs_merkle_indexable_entry_v1")
export class IndexableMerkleEntryV1 {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    kind: MerkleIndexEntryKindV1 | "";

    @field({ type: option("string") })
    nodeId?: string;

    @field({ type: vec("string") })
    blockRefs: string[];

    @field({ type: vec("string") })
    causalRefs: string[];

    @field({ type: "u64" })
    causalDepth: bigint;

    @field({ type: "u64" })
    size: bigint;

    @field({ type: "u32" })
    leafSize: number;

    @field({ type: "u8" })
    rootLevel: number;

    @field({ type: "u8" })
    treeLevel: number;

    @field({ type: option(fixedArray("u8", 32)) })
    contentRoot?: Uint8Array;

    @field({ type: "u64" })
    createdAt: bigint;

    @field({ type: option("string") })
    authorKey?: string;

    @field({ type: option("string") })
    machineLabel?: string;

    @field({ type: "bool" })
    conflictResolution: boolean;

    @field({ type: option("string") })
    changesetId?: string;

    constructor(value?: MerkleContentEntryV1) {
        this.id = "";
        this.kind = "";
        this.blockRefs = [];
        this.causalRefs = [];
        this.causalDepth = 0n;
        this.size = 0n;
        this.leafSize = 0;
        this.rootLevel = 0;
        this.treeLevel = 0;
        this.createdAt = 0n;
        this.conflictResolution = false;
        if (value === undefined) return;

        if (value instanceof MerkleFileVersionV1) {
            const normalized = snapshotVersion(value);
            this.id = normalized.id;
            this.kind = "file-version";
            this.nodeId = normalized.nodeId;
            this.blockRefs = normalized.rootHash
                ? [
                      normalized.rootLevel === 0
                          ? merkleDataIdFromHashV1(normalized.rootHash)
                          : merkleTreeIdFromHashV1(normalized.rootHash),
                  ]
                : [];
            this.causalRefs = [...normalized.parentVersionIds];
            this.causalDepth = normalized.causalDepth;
            this.size = normalized.size;
            this.leafSize = normalized.leafSize;
            this.rootLevel = normalized.rootLevel;
            this.contentRoot = new Uint8Array(normalized.contentRoot);
            this.createdAt = normalized.createdAt;
            this.authorKey = normalized.authorKey;
            this.machineLabel = normalized.machineLabel;
            this.conflictResolution = normalized.conflictResolution;
            this.changesetId = normalized.changesetId;
            return;
        }
        if (value instanceof MerkleTreeBlockV1) {
            const snapshot = snapshotTreeBlockV1(value);
            this.id = snapshot.id;
            this.kind = "merkle-tree";
            const idForHash =
                snapshot.level === 1
                    ? merkleDataIdFromHashV1
                    : merkleTreeIdFromHashV1;
            this.blockRefs = [
                ...new Set(snapshot.children.map((hash) => idForHash(hash))),
            ];
            this.treeLevel = snapshot.level;
            return;
        }
        if (value instanceof MerkleDataBlockV1) {
            const snapshot = snapshotDataBlockV1(value);
            this.id = snapshot.id;
            this.kind = "merkle-data";
            return;
        }
        fail("index source has an unknown type");
    }
}
