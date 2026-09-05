import { deserialize, field, option, serialize, variant } from "@dao-xyz/borsh";
import {
    MERKLE_DATA_BLOCK_V1_VARIANT,
    MERKLE_TREE_BLOCK_V1_VARIANT,
    MERKLE_V1_MAX_BLOCK_ID_UTF8_BYTES,
    MERKLE_V1_MAX_LEVEL,
    MERKLE_V1_MAX_VARIANT_UTF8_BYTES,
    MERKLE_V1_MAX_WIRE_BYTES,
    MerkleContentEntryV1,
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
import {
    assertExactWireRoundTripV1,
    boundedUtf8ArrayFieldV1,
    boundedUtf8FieldV1,
    copyWireAndReadVariantV1,
    fixedBytesFieldV1,
    merkleWireFailV1,
} from "./merkle-wire-v1.js";

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
    maxIndexKindUtf8Bytes: 16,
    maxBlockRefs: 256,
    maxBlockRefUtf8Bytes: MERKLE_V1_MAX_BLOCK_ID_UTF8_BYTES,
    maxBlockRefsUtf8Bytes: 256 * MERKLE_V1_MAX_BLOCK_ID_UTF8_BYTES,
});

export const MERKLE_FILE_VERSION_V1_VARIANT =
    "shared_fs_merkle_file_version_v1" as const;
export const MERKLE_INDEXABLE_ENTRY_V1_VARIANT =
    "shared_fs_merkle_indexable_entry_v1" as const;

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

export type MerkleContentValueV1 =
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
    const parentCount = value.parentVersionIds.length;
    if (parentCount > MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIds) {
        return fail(
            `parentVersionIds exceeds ${MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIds} entries`
        );
    }
    const parentVersionIds: string[] = [];
    const seenParents = new Set<string>();
    let parentBytes = 0;
    for (let index = 0; index < parentCount; index++) {
        const source = value.parentVersionIds[index];
        const parent = boundedString(
            source,
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

@variant(MERKLE_FILE_VERSION_V1_VARIANT)
export class MerkleFileVersionV1 extends MerkleContentEntryV1 {
    @field(
        boundedUtf8FieldV1({
            name: "id",
            maxUtf8Bytes: MERKLE_FILE_VERSION_V1_LIMITS.maxVersionIdUtf8Bytes,
            prefix: "version:",
        })
    )
    id: string;

    @field(
        boundedUtf8FieldV1({
            name: "nodeId",
            maxUtf8Bytes: MERKLE_FILE_VERSION_V1_LIMITS.maxNodeIdUtf8Bytes,
            prefix: "file:",
        })
    )
    nodeId: string;

    @field(
        boundedUtf8ArrayFieldV1({
            name: "parentVersionIds",
            maxCount: MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIds,
            maxUtf8Bytes:
                MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIdUtf8Bytes,
            maxAggregateUtf8Bytes:
                MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIdsUtf8Bytes,
            prefix: "version:",
            unique: true,
        })
    )
    parentVersionIds: string[];

    @field({ type: "u64" })
    causalDepth: bigint;

    @field({ type: "u64" })
    size: bigint;

    @field({ type: "u32" })
    leafSize: MerkleV1LeafSize;

    @field({ type: "u8" })
    rootLevel: number;

    @field({ type: option(fixedBytesFieldV1(32, "rootHash")) })
    rootHash?: Uint8Array;

    @field(fixedBytesFieldV1(32, "contentRoot"))
    contentRoot: Uint8Array;

    @field({ type: "u64" })
    createdAt: bigint;

    @field(
        boundedUtf8FieldV1({
            name: "authorKey",
            maxUtf8Bytes: MERKLE_FILE_VERSION_V1_LIMITS.maxAuthorKeyUtf8Bytes,
        })
    )
    authorKey: string;

    @field(
        boundedUtf8FieldV1({
            name: "machineLabel",
            maxUtf8Bytes:
                MERKLE_FILE_VERSION_V1_LIMITS.maxMachineLabelUtf8Bytes,
        })
    )
    machineLabel: string;

    @field({ type: "bool" })
    conflictResolution: boolean;

    @field({
        type: option(
            boundedUtf8FieldV1({
                name: "changesetId",
                maxUtf8Bytes:
                    MERKLE_FILE_VERSION_V1_LIMITS.maxChangesetIdUtf8Bytes,
            })
        ),
    })
    changesetId?: string;

    @field({ type: option(fixedBytesFieldV1(32, "legacyWholeSha256")) })
    legacyWholeSha256?: Uint8Array;

    constructor(properties?: MerkleFileVersionV1Properties) {
        super();
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
): MerkleContentValueV1 => {
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

const MERKLE_CONTENT_VARIANTS_V1 = new Set<string>([
    MERKLE_DATA_BLOCK_V1_VARIANT,
    MERKLE_TREE_BLOCK_V1_VARIANT,
    MERKLE_FILE_VERSION_V1_VARIANT,
]);

/**
 * Safely dispatch and validate one complete Merkle content wire value.
 *
 * Do not deserialize a concrete `@variant` class directly: Borsh consumes a
 * concrete string discriminator without comparing it. This entry point first
 * bounds and strictly decodes the tag, dispatches through the common abstract
 * union, validates the self-certifying payload, and requires an exact
 * byte-for-byte canonical reserialization.
 */
export const decodeMerkleContentEntryV1 = (
    encoded: Uint8Array
): MerkleContentValueV1 => {
    const { wire, variant } = copyWireAndReadVariantV1(
        encoded,
        MERKLE_V1_MAX_WIRE_BYTES,
        MERKLE_V1_MAX_VARIANT_UTF8_BYTES
    );
    if (!MERKLE_CONTENT_VARIANTS_V1.has(variant)) {
        return merkleWireFailV1(`unsupported content variant ${variant}`);
    }
    const decoded = deserialize(
        wire,
        MerkleContentEntryV1
    ) as MerkleContentValueV1;
    const validated = assertMerkleContentEntryV1(decoded);
    assertExactWireRoundTripV1(wire, serialize(validated));
    return validated;
};

/**
 * Generation-specific local index projection. `blockRefs` is accepted from no
 * public input: it is derived after structural validation from the signed
 * version root or self-certifying tree children.
 */
@variant(MERKLE_INDEXABLE_ENTRY_V1_VARIANT)
export class IndexableMerkleEntryV1 {
    @field(
        boundedUtf8FieldV1({
            name: "index id",
            maxUtf8Bytes: MERKLE_FILE_VERSION_V1_LIMITS.maxVersionIdUtf8Bytes,
        })
    )
    id: string;

    @field(
        boundedUtf8FieldV1({
            name: "index kind",
            maxUtf8Bytes: MERKLE_FILE_VERSION_V1_LIMITS.maxIndexKindUtf8Bytes,
        })
    )
    kind: MerkleIndexEntryKindV1 | "";

    @field({
        type: option(
            boundedUtf8FieldV1({
                name: "index nodeId",
                maxUtf8Bytes: MERKLE_FILE_VERSION_V1_LIMITS.maxNodeIdUtf8Bytes,
                prefix: "file:",
            })
        ),
    })
    nodeId?: string;

    @field(
        boundedUtf8ArrayFieldV1({
            name: "index blockRefs",
            maxCount: MERKLE_FILE_VERSION_V1_LIMITS.maxBlockRefs,
            maxUtf8Bytes: MERKLE_FILE_VERSION_V1_LIMITS.maxBlockRefUtf8Bytes,
            maxAggregateUtf8Bytes:
                MERKLE_FILE_VERSION_V1_LIMITS.maxBlockRefsUtf8Bytes,
            unique: true,
        })
    )
    blockRefs: string[];

    @field(
        boundedUtf8ArrayFieldV1({
            name: "index causalRefs",
            maxCount: MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIds,
            maxUtf8Bytes:
                MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIdUtf8Bytes,
            maxAggregateUtf8Bytes:
                MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIdsUtf8Bytes,
            prefix: "version:",
            unique: true,
        })
    )
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

    @field({ type: option(fixedBytesFieldV1(32, "index contentRoot")) })
    contentRoot?: Uint8Array;

    @field({ type: "u64" })
    createdAt: bigint;

    @field({
        type: option(
            boundedUtf8FieldV1({
                name: "index authorKey",
                maxUtf8Bytes:
                    MERKLE_FILE_VERSION_V1_LIMITS.maxAuthorKeyUtf8Bytes,
            })
        ),
    })
    authorKey?: string;

    @field({
        type: option(
            boundedUtf8FieldV1({
                name: "index machineLabel",
                maxUtf8Bytes:
                    MERKLE_FILE_VERSION_V1_LIMITS.maxMachineLabelUtf8Bytes,
            })
        ),
    })
    machineLabel?: string;

    @field({ type: "bool" })
    conflictResolution: boolean;

    @field({
        type: option(
            boundedUtf8FieldV1({
                name: "index changesetId",
                maxUtf8Bytes:
                    MERKLE_FILE_VERSION_V1_LIMITS.maxChangesetIdUtf8Bytes,
            })
        ),
    })
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

const BASE64URL_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const hashFromCanonicalBlockId = (
    id: unknown,
    kind: "data" | "tree",
    name: string
) => {
    const prefix = kind === "data" ? "data2:" : "tree2:";
    const value = boundedString(
        id,
        name,
        MERKLE_FILE_VERSION_V1_LIMITS.maxBlockRefUtf8Bytes,
        { prefix }
    ).value;
    const suffix = value.slice(prefix.length);
    if (suffix.length !== 43) {
        return fail(`${name} must contain one canonical 32-byte hash`);
    }
    const bytes: number[] = [];
    let accumulator = 0;
    let bits = 0;
    for (const character of suffix) {
        const digit = BASE64URL_ALPHABET.indexOf(character);
        if (digit < 0) {
            return fail(`${name} must use canonical unpadded base64url`);
        }
        accumulator = (accumulator << 6) | digit;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((accumulator >>> bits) & 0xff);
            accumulator &= (1 << bits) - 1;
        }
    }
    if (bytes.length !== 32 || bits !== 2 || accumulator !== 0) {
        return fail(`${name} must use canonical unpadded base64url`);
    }
    return Uint8Array.from(bytes);
};

const snapshotIndexStringArray = (
    value: unknown,
    name: string,
    options: {
        maxCount: number;
        maxItemUtf8Bytes: number;
        maxAggregateUtf8Bytes: number;
        prefix?: string;
    }
) => {
    if (!Array.isArray(value)) return fail(`${name} must be an array`);
    const count = value.length;
    if (count > options.maxCount) {
        return fail(`${name} exceeds ${options.maxCount} entries`);
    }
    const result: string[] = [];
    const seen = new Set<string>();
    let aggregate = 0;
    for (let index = 0; index < count; index++) {
        const source = value[index];
        const item = boundedString(
            source,
            `${name}[${index}]`,
            options.maxItemUtf8Bytes,
            { prefix: options.prefix }
        );
        aggregate += item.bytes;
        if (aggregate > options.maxAggregateUtf8Bytes) {
            return fail(
                `${name} exceeds ${options.maxAggregateUtf8Bytes} aggregate UTF-8 bytes`
            );
        }
        if (seen.has(item.value)) return fail(`${name} must be unique`);
        seen.add(item.value);
        result.push(item.value);
    }
    return result;
};

const assertZeroIndexMetadata = (value: {
    nodeId?: unknown;
    causalRefs: readonly string[];
    causalDepth?: unknown;
    size?: unknown;
    leafSize?: unknown;
    rootLevel?: unknown;
    contentRoot?: unknown;
    createdAt?: unknown;
    authorKey?: unknown;
    machineLabel?: unknown;
    conflictResolution?: unknown;
    changesetId?: unknown;
}) => {
    if (
        value.nodeId !== undefined ||
        value.causalRefs.length !== 0 ||
        asU64(value.causalDepth, "index causalDepth") !== 0n ||
        asU64(value.size, "index size") !== 0n ||
        value.leafSize !== 0 ||
        value.rootLevel !== 0 ||
        value.contentRoot !== undefined ||
        asU64(value.createdAt, "index createdAt") !== 0n ||
        value.authorKey !== undefined ||
        value.machineLabel !== undefined ||
        value.conflictResolution !== false ||
        value.changesetId !== undefined
    ) {
        return fail("non-version index rows must contain only zero metadata");
    }
};

/**
 * Validate a decoded local index row. This checks its canonical wire shape;
 * only constructing a fresh row from authenticated content proves that its
 * reverse edges were derived rather than author supplied.
 */
export const assertIndexableMerkleEntryV1 = (
    value: unknown
): IndexableMerkleEntryV1 => {
    if (!(value instanceof IndexableMerkleEntryV1)) {
        return fail("index row has an unknown type");
    }
    const snapshot = {
        id: value.id,
        kind: value.kind,
        nodeId: value.nodeId,
        blockRefs: snapshotIndexStringArray(
            value.blockRefs,
            "index blockRefs",
            {
                maxCount: MERKLE_FILE_VERSION_V1_LIMITS.maxBlockRefs,
                maxItemUtf8Bytes:
                    MERKLE_FILE_VERSION_V1_LIMITS.maxBlockRefUtf8Bytes,
                maxAggregateUtf8Bytes:
                    MERKLE_FILE_VERSION_V1_LIMITS.maxBlockRefsUtf8Bytes,
            }
        ),
        causalRefs: snapshotIndexStringArray(
            value.causalRefs,
            "index causalRefs",
            {
                maxCount: MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIds,
                maxItemUtf8Bytes:
                    MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIdUtf8Bytes,
                maxAggregateUtf8Bytes:
                    MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIdsUtf8Bytes,
                prefix: "version:",
            }
        ),
        causalDepth: value.causalDepth,
        size: value.size,
        leafSize: value.leafSize,
        rootLevel: value.rootLevel,
        treeLevel: value.treeLevel,
        contentRoot: value.contentRoot,
        createdAt: value.createdAt,
        authorKey: value.authorKey,
        machineLabel: value.machineLabel,
        conflictResolution: value.conflictResolution,
        changesetId: value.changesetId,
    };

    if (snapshot.kind === "file-version") {
        if (snapshot.treeLevel !== 0) {
            return fail("a file-version index row must have treeLevel 0");
        }
        if (snapshot.blockRefs.length > 1) {
            return fail("a file-version index row has at most one blockRef");
        }
        const rootHash = snapshot.blockRefs.length
            ? hashFromCanonicalBlockId(
                  snapshot.blockRefs[0],
                  snapshot.rootLevel === 0 ? "data" : "tree",
                  "index blockRefs[0]"
              )
            : undefined;
        const normalized = normalizeCommonFields({
            id: snapshot.id,
            nodeId: snapshot.nodeId,
            parentVersionIds: snapshot.causalRefs,
            causalDepth: snapshot.causalDepth,
            size: snapshot.size,
            leafSize: snapshot.leafSize,
            rootLevel: snapshot.rootLevel,
            rootHash,
            createdAt: snapshot.createdAt,
            authorKey: snapshot.authorKey,
            machineLabel: snapshot.machineLabel,
            conflictResolution: snapshot.conflictResolution,
            changesetId: snapshot.changesetId,
            legacyWholeSha256: undefined,
        });
        const contentRoot = copyHash(snapshot.contentRoot, "index contentRoot");
        if (!equalBytes(contentRoot, merkleContentRootV1(normalized.root))) {
            return fail("index contentRoot does not match its root descriptor");
        }
        return value;
    }

    if (snapshot.kind === "merkle-tree") {
        hashFromCanonicalBlockId(snapshot.id, "tree", "index id");
        if (
            !Number.isInteger(snapshot.treeLevel) ||
            snapshot.treeLevel < 1 ||
            snapshot.treeLevel > MERKLE_V1_MAX_LEVEL
        ) {
            return fail(
                `index treeLevel must be from 1 through ${MERKLE_V1_MAX_LEVEL}`
            );
        }
        for (let index = 0; index < snapshot.blockRefs.length; index++) {
            hashFromCanonicalBlockId(
                snapshot.blockRefs[index],
                snapshot.treeLevel === 1 ? "data" : "tree",
                `index blockRefs[${index}]`
            );
        }
        assertZeroIndexMetadata(snapshot);
        return value;
    }

    if (snapshot.kind === "merkle-data") {
        hashFromCanonicalBlockId(snapshot.id, "data", "index id");
        if (snapshot.blockRefs.length !== 0 || snapshot.treeLevel !== 0) {
            return fail("a data index row must not contain block references");
        }
        assertZeroIndexMetadata(snapshot);
        return value;
    }

    return fail("index kind is unsupported");
};

/**
 * Safely decode a locally persisted index row with an exact discriminator,
 * bounded fields, semantic shape checks, and canonical round-trip bytes.
 * Reconstruct the row from content before using `blockRefs` as trust evidence.
 */
export const decodeIndexableMerkleEntryV1 = (
    encoded: Uint8Array
): IndexableMerkleEntryV1 => {
    const { wire, variant } = copyWireAndReadVariantV1(
        encoded,
        MERKLE_V1_MAX_WIRE_BYTES,
        MERKLE_V1_MAX_VARIANT_UTF8_BYTES
    );
    if (variant !== MERKLE_INDEXABLE_ENTRY_V1_VARIANT) {
        return merkleWireFailV1(`unsupported index variant ${variant}`);
    }
    const decoded = deserialize(wire, IndexableMerkleEntryV1);
    assertIndexableMerkleEntryV1(decoded);
    assertExactWireRoundTripV1(wire, serialize(decoded));
    return decoded;
};
