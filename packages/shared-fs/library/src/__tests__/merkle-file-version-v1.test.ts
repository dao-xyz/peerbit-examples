import { serialize } from "@dao-xyz/borsh";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    IndexableMerkleEntryV1,
    MERKLE_FILE_VERSION_V1_LIMITS,
    MerkleFileVersionV1,
    assertMerkleContentEntryV1,
    assertMerkleFileVersionV1,
    decodeIndexableMerkleEntryV1,
    decodeMerkleContentEntryV1,
    merkleRootBlockRefsV1,
    merkleRootDescriptorFromVersionV1,
    merkleTreeBlockRefsV1,
    type MerkleFileVersionV1Properties,
} from "../merkle-file-version-v1.js";
import {
    MERKLE_V1_MAX_DATA_BYTES,
    MERKLE_V1_MAX_WIRE_BYTES,
    MerkleDataBlockV1,
    MerkleTreeBlockV1,
    merkleContentRootV1,
    merkleDataHashV1,
    merkleDataIdFromHashV1,
    merkleTreeHashV1,
    merkleTreeIdFromHashV1,
    merkleV1BitmapFromSlots,
} from "../merkle-v1.js";

const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const encode = (value: string) => new TextEncoder().encode(value);

const vectors = JSON.parse(
    readFileSync(
        new URL("../../../merkle-v1-golden-vectors.json", import.meta.url),
        "utf8"
    )
) as {
    presentRoot: {
        leafSize: number;
        size: string;
        rootLevel: number;
        rootHashHex: string;
        hashHex: string;
    };
    fileVersion: {
        variant: string;
        id: string;
        nodeId: string;
        parentVersionIds: string[];
        causalDepth: string;
        createdAt: string;
        authorKey: string;
        machineLabel: string;
        conflictResolution: boolean;
        changesetId: string;
        legacyWholeSha256Hex: string;
        rootBlockRefs: string[];
        borshHex: string;
    };
    fileVersionIndex: {
        variant: string;
        kind: string;
        treeLevel: number;
        borshHex: string;
    };
};

const goldenProperties = (): MerkleFileVersionV1Properties => ({
    id: vectors.fileVersion.id,
    nodeId: vectors.fileVersion.nodeId,
    parentVersionIds: [...vectors.fileVersion.parentVersionIds],
    causalDepth: BigInt(vectors.fileVersion.causalDepth),
    size: BigInt(vectors.presentRoot.size),
    leafSize: vectors.presentRoot.leafSize as 65_536,
    rootLevel: vectors.presentRoot.rootLevel,
    rootHash: fromHex(vectors.presentRoot.rootHashHex),
    createdAt: BigInt(vectors.fileVersion.createdAt),
    authorKey: vectors.fileVersion.authorKey,
    machineLabel: vectors.fileVersion.machineLabel,
    conflictResolution: vectors.fileVersion.conflictResolution,
    changesetId: vectors.fileVersion.changesetId,
    legacyWholeSha256: fromHex(vectors.fileVersion.legacyWholeSha256Hex),
});

const validVersion = () => new MerkleFileVersionV1(goldenProperties());

const expectRejectedMutation = (
    mutate: (value: MerkleFileVersionV1) => void,
    expected: RegExp
) => {
    const value = validVersion();
    mutate(value);
    expect(() => assertMerkleFileVersionV1(value)).toThrow(expected);
};

const accessorBackedTree = (source: MerkleTreeBlockV1) => {
    const reads = { id: 0, level: 0, bitmap: 0, children: 0 };
    const value = Object.create(
        MerkleTreeBlockV1.prototype
    ) as MerkleTreeBlockV1;
    Object.defineProperties(value, {
        id: {
            get: () => {
                reads.id++;
                return reads.id === 1 ? source.id : "tree2:changed-after-check";
            },
        },
        level: {
            get: () => {
                reads.level++;
                return reads.level === 1 ? source.level : 2;
            },
        },
        bitmap: {
            get: () => {
                reads.bitmap++;
                return reads.bitmap === 1 ? source.bitmap : new Uint8Array(32);
            },
        },
        children: {
            get: () => {
                reads.children++;
                return reads.children === 1
                    ? source.children
                    : [new Uint8Array(32).fill(0xff)];
            },
        },
    });
    return { value, reads };
};

const accessorBackedData = (source: MerkleDataBlockV1) => {
    const reads = { id: 0, bytes: 0 };
    const value = Object.create(
        MerkleDataBlockV1.prototype
    ) as MerkleDataBlockV1;
    Object.defineProperties(value, {
        id: {
            get: () => {
                reads.id++;
                return reads.id === 1 ? source.id : "data2:changed-after-check";
            },
        },
        bytes: {
            get: () => {
                reads.bytes++;
                return reads.bytes === 1
                    ? source.bytes
                    : encode("changed-after-check");
            },
        },
    });
    return { value, reads };
};

const readU32 = (wire: Uint8Array, offset: number) =>
    new DataView(wire.buffer, wire.byteOffset, wire.byteLength).getUint32(
        offset,
        true
    );

const withU32 = (wire: Uint8Array, offset: number, value: number) => {
    const changed = new Uint8Array(wire);
    new DataView(
        changed.buffer,
        changed.byteOffset,
        changed.byteLength
    ).setUint32(offset, value, true);
    return changed;
};

const encodeU32 = (value: number) => {
    const encoded = new Uint8Array(4);
    new DataView(encoded.buffer).setUint32(0, value, true);
    return encoded;
};

const concatBytes = (parts: readonly Uint8Array[]) => {
    const result = new Uint8Array(
        parts.reduce((total, part) => total + part.byteLength, 0)
    );
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
};

const encodeBorshString = (value: string) => {
    const bytes = encode(value);
    return concatBytes([encodeU32(bytes.byteLength), bytes]);
};

const afterBorshString = (wire: Uint8Array, offset: number) =>
    offset + 4 + readU32(wire, offset);

const replaceBorshString = (
    wire: Uint8Array,
    offset: number,
    replacement: string
) => {
    const changed = new Uint8Array(wire);
    const encoded = encode(replacement);
    const length = readU32(changed, offset);
    if (encoded.byteLength !== length) {
        throw new Error("replacement must preserve the Borsh string length");
    }
    changed.set(encoded, offset + 4);
    return changed;
};

const versionWireOffsets = (wire: Uint8Array) => {
    const id = afterBorshString(wire, 0);
    const nodeId = afterBorshString(wire, id);
    const parentVersionIds = afterBorshString(wire, nodeId);
    return { id, nodeId, parentVersionIds };
};

const indexWireOffsets = (wire: Uint8Array) => {
    const id = afterBorshString(wire, 0);
    const kind = afterBorshString(wire, id);
    const nodePresence = afterBorshString(wire, kind);
    if (wire[nodePresence] !== 1) throw new Error("golden nodeId is absent");
    const blockRefs = afterBorshString(wire, nodePresence + 1);
    return { id, kind, blockRefs };
};

describe("Merkle file-version v1 wire contract", () => {
    it("matches the language-neutral Borsh golden vector", () => {
        const value = validVersion();
        expect(hex(value.contentRoot)).toBe(vectors.presentRoot.hashHex);
        expect(hex(serialize(value))).toBe(vectors.fileVersion.borshHex);
        expect(merkleRootBlockRefsV1(value)).toEqual(
            vectors.fileVersion.rootBlockRefs
        );

        const decoded = decodeMerkleContentEntryV1(
            fromHex(vectors.fileVersion.borshHex)
        );
        expect(decoded).toBeInstanceOf(MerkleFileVersionV1);
        const decodedVersion = assertMerkleFileVersionV1(decoded);
        expect(decodedVersion).toBe(decoded);
        expect(decodedVersion.id).toBe(vectors.fileVersion.id);
        expect(decodedVersion.parentVersionIds).toEqual(
            vectors.fileVersion.parentVersionIds
        );
        expect(decodedVersion.causalDepth).toBe(
            BigInt(vectors.fileVersion.causalDepth)
        );
        expect(decodedVersion.createdAt).toBe(
            BigInt(vectors.fileVersion.createdAt)
        );
        expect(hex(decodedVersion.legacyWholeSha256!)).toBe(
            vectors.fileVersion.legacyWholeSha256Hex
        );
        expect(hex(serialize(decodedVersion))).toBe(
            vectors.fileVersion.borshHex
        );
    });

    it("copies caller-owned arrays and hashes and derives content identity", () => {
        const properties = goldenProperties();
        const parents = properties.parentVersionIds as string[];
        const rootHash = properties.rootHash!;
        const legacyHash = properties.legacyWholeSha256!;
        let suppliedBlockRefReads = 0;
        const supplied = {
            ...properties,
            contentRoot: new Uint8Array(32),
        } as unknown as MerkleFileVersionV1Properties & {
            blockRefs: string[];
            contentRoot: Uint8Array;
        };
        Object.defineProperty(supplied, "blockRefs", {
            enumerable: true,
            get: () => {
                suppliedBlockRefReads++;
                return ["data2:attacker-controlled"];
            },
        });
        const value = new MerkleFileVersionV1(supplied);

        parents[0] = "version:mutated";
        rootHash.fill(0);
        legacyHash.fill(0);

        expect(value.parentVersionIds).toEqual(
            vectors.fileVersion.parentVersionIds
        );
        expect(hex(value.rootHash!)).toBe(vectors.presentRoot.rootHashHex);
        expect(hex(value.contentRoot)).toBe(vectors.presentRoot.hashHex);
        expect(hex(value.legacyWholeSha256!)).toBe(
            vectors.fileVersion.legacyWholeSha256Hex
        );
        expect(
            (value as MerkleFileVersionV1 & { blockRefs?: string[] }).blockRefs
        ).toBeUndefined();
        expect(suppliedBlockRefReads).toBe(0);

        const descriptor = merkleRootDescriptorFromVersionV1(value);
        descriptor.rootHash!.fill(0);
        expect(hex(value.rootHash!)).toBe(vectors.presentRoot.rootHashHex);
    });

    it("snapshots bounded string arrays without repeated accessor reads", () => {
        const value = validVersion();
        const source = [...value.parentVersionIds];
        const reads = { length: 0, entries: new Array(source.length).fill(0) };
        value.parentVersionIds = new Proxy(source, {
            get(target, property, receiver) {
                if (property === "length") {
                    reads.length++;
                    return reads.length === 1 ? target.length : 0xffff_ffff;
                }
                if (typeof property === "string" && /^\d+$/u.test(property)) {
                    const index = Number(property);
                    reads.entries[index]++;
                    return reads.entries[index] === 1
                        ? target[index]
                        : "version:changed-after-check";
                }
                return Reflect.get(target, property, receiver);
            },
        });

        expect(hex(serialize(value))).toBe(vectors.fileVersion.borshHex);
        expect(reads).toEqual({ length: 1, entries: [1, 1] });
    });

    it("validates bounded identifiers, parents, clocks, and attribution", () => {
        expect(
            () =>
                new MerkleFileVersionV1(
                    null as unknown as MerkleFileVersionV1Properties
                )
        ).toThrow(/properties must be an object/);
        expectRejectedMutation((value) => (value.id = "version:"), /after/);
        expectRejectedMutation((value) => (value.id = "wrong:id"), /start/);
        expectRejectedMutation((value) => (value.nodeId = "file:"), /after/);
        expectRejectedMutation(
            (value) => (value.id = `version:${"x".repeat(249)}`),
            /exceeds 256/
        );
        expectRejectedMutation(
            (value) => (value.id = "version:\ud800"),
            /well-formed Unicode/
        );
        expectRejectedMutation(
            (value) =>
                (value.parentVersionIds = [
                    ...value.parentVersionIds,
                    value.parentVersionIds[0],
                ]),
            /unique/
        );
        expectRejectedMutation(
            (value) => (value.parentVersionIds = [value.id]),
            /must not name itself/
        );
        expectRejectedMutation(
            (value) =>
                (value.parentVersionIds = Array.from(
                    {
                        length:
                            MERKLE_FILE_VERSION_V1_LIMITS.maxParentVersionIds +
                            1,
                    },
                    (_, index) => `version:${index}`
                )),
            /8000 entries/
        );
        expectRejectedMutation(
            (value) =>
                (value.parentVersionIds = Array.from(
                    { length: 4097 },
                    (_, index) =>
                        `version:${index.toString().padStart(8, "0")}${"p".repeat(240)}`
                )),
            /aggregate UTF-8 bytes/
        );
        expectRejectedMutation(
            (value) =>
                ((
                    value as unknown as { parentVersionIds: unknown }
                ).parentVersionIds = null),
            /must be an array/
        );
        expect(
            () =>
                new MerkleFileVersionV1({
                    ...goldenProperties(),
                    parentVersionIds: null,
                } as unknown as MerkleFileVersionV1Properties)
        ).toThrow(/must be an array/);
        expectRejectedMutation((value) => (value.causalDepth = 0n), /at least/);
        expectRejectedMutation(
            (value) => (value.causalDepth = 1n << 64n),
            /fit in u64/
        );
        expect(
            () =>
                new MerkleFileVersionV1({
                    ...goldenProperties(),
                    parentVersionIds: [],
                    causalDepth: 2n,
                })
        ).toThrow(/parentless.*causalDepth 1/);
        expect(
            () =>
                new MerkleFileVersionV1({
                    ...goldenProperties(),
                    causalDepth: 1n,
                })
        ).toThrow(/with parents.*at least 2/);
        expectRejectedMutation(
            (value) => (value.createdAt = -1n),
            /non-negative|fit in u64/
        );
        expectRejectedMutation((value) => (value.authorKey = ""), /must not/);
        expectRejectedMutation(
            (value) => (value.authorKey = "é".repeat(2049)),
            /4096 UTF-8 bytes/
        );
        expectRejectedMutation(
            (value) => (value.machineLabel = "m".repeat(4097)),
            /4096 UTF-8 bytes/
        );
        expectRejectedMutation(
            (value) =>
                ((
                    value as unknown as { conflictResolution: unknown }
                ).conflictResolution = 1),
            /must be a boolean/
        );
        expect(
            () =>
                new MerkleFileVersionV1({
                    ...goldenProperties(),
                    conflictResolution: null,
                } as unknown as MerkleFileVersionV1Properties)
        ).toThrow(/must be a boolean/);
    });

    it("validates canonical roots and optional metadata", () => {
        expectRejectedMutation((value) => (value.rootLevel = 0), /canonical/);
        expectRejectedMutation(
            (value) => (value.rootHash = new Uint8Array(31)),
            /exactly 32 bytes/
        );
        expectRejectedMutation(
            (value) => value.contentRoot.fill(0),
            /does not match/
        );
        expectRejectedMutation(
            (value) => (value.contentRoot = new Uint8Array(31)),
            /exactly 32 bytes/
        );
        expectRejectedMutation(
            (value) => (value.changesetId = ""),
            /must not be empty/
        );
        expectRejectedMutation(
            (value) => (value.changesetId = "🙂".repeat(129)),
            /256 UTF-16 code units/
        );
        expectRejectedMutation(
            (value) =>
                ((value as unknown as { changesetId: unknown }).changesetId =
                    null),
            /undefined or a string/
        );
        expectRejectedMutation(
            (value) => (value.legacyWholeSha256 = new Uint8Array(31)),
            /exactly 32 bytes/
        );
        expectRejectedMutation(
            (value) =>
                ((
                    value as unknown as { legacyWholeSha256: unknown }
                ).legacyWholeSha256 = null),
            /undefined or 32 bytes/
        );
        expect(() => assertMerkleFileVersionV1({})).toThrow(/unknown type/);
    });

    it("derives generation-specific reverse edges after strict validation", () => {
        const version = validVersion();
        (version as MerkleFileVersionV1 & { blockRefs?: string[] }).blockRefs =
            ["data2:attacker-controlled"];
        const versionRow = new IndexableMerkleEntryV1(version);
        expect(hex(serialize(versionRow))).toBe(
            vectors.fileVersionIndex.borshHex
        );
        expect(versionRow).toMatchObject({
            id: version.id,
            kind: "file-version",
            nodeId: version.nodeId,
            blockRefs: vectors.fileVersion.rootBlockRefs,
            causalRefs: vectors.fileVersion.parentVersionIds,
            causalDepth: BigInt(vectors.fileVersion.causalDepth),
            size: BigInt(vectors.presentRoot.size),
            leafSize: vectors.presentRoot.leafSize,
            rootLevel: vectors.presentRoot.rootLevel,
            changesetId: vectors.fileVersion.changesetId,
        });
        expect(hex(versionRow.contentRoot!)).toBe(hex(version.contentRoot));

        const data = new MerkleDataBlockV1({ bytes: encode("leaf") });
        const dataHash = merkleDataHashV1(data.bytes);
        const levelOne = new MerkleTreeBlockV1({
            level: 1,
            bitmap: merkleV1BitmapFromSlots([0, 2]),
            children: [dataHash, dataHash],
        });
        expect(merkleTreeBlockRefsV1(levelOne)).toEqual([
            merkleDataIdFromHashV1(dataHash),
        ]);
        expect(new IndexableMerkleEntryV1(levelOne)).toMatchObject({
            id: levelOne.id,
            kind: "merkle-tree",
            blockRefs: [merkleDataIdFromHashV1(dataHash)],
            treeLevel: 1,
        });

        const treeHash = merkleTreeHashV1(
            levelOne.level,
            levelOne.bitmap,
            levelOne.children
        );
        const levelTwo = new MerkleTreeBlockV1({
            level: 2,
            bitmap: merkleV1BitmapFromSlots([0]),
            children: [treeHash],
        });
        expect(merkleTreeBlockRefsV1(levelTwo)).toEqual([
            merkleTreeIdFromHashV1(treeHash),
        ]);
        expect(new IndexableMerkleEntryV1(data)).toMatchObject({
            id: data.id,
            kind: "merkle-data",
            blockRefs: [],
        });

        const direct = new MerkleFileVersionV1({
            ...goldenProperties(),
            id: "version:direct",
            parentVersionIds: [],
            causalDepth: 1n,
            size: BigInt(data.bytes.byteLength),
            rootLevel: 0,
            rootHash: dataHash,
        });
        expect(merkleRootBlockRefsV1(direct)).toEqual([
            merkleDataIdFromHashV1(dataHash),
        ]);
        const sparse = new MerkleFileVersionV1({
            ...goldenProperties(),
            id: "version:sparse",
            parentVersionIds: [],
            causalDepth: 1n,
            size: 1_048_577n,
            rootLevel: 1,
            rootHash: undefined,
        });
        expect(merkleRootBlockRefsV1(sparse)).toEqual([]);
        expect(new IndexableMerkleEntryV1(sparse).blockRefs).toEqual([]);

        expect(assertMerkleContentEntryV1(version)).toBe(version);
        expect(assertMerkleContentEntryV1(levelOne)).toBe(levelOne);
        expect(assertMerkleContentEntryV1(data)).toBe(data);
        expect(() =>
            assertMerkleContentEntryV1({ kind: "merkle-data" })
        ).toThrow(/unknown type/);
        expect(
            () =>
                new IndexableMerkleEntryV1({
                    ...version,
                    blockRefs: ["data2:attacker-controlled"],
                } as unknown as MerkleFileVersionV1)
        ).toThrow(/unknown type/);
        expect(
            () =>
                new IndexableMerkleEntryV1(
                    null as unknown as MerkleFileVersionV1
                )
        ).toThrow(/unknown type/);

        const decodedRow = decodeIndexableMerkleEntryV1(serialize(versionRow));
        expect(decodedRow.blockRefs).toEqual(vectors.fileVersion.rootBlockRefs);
        expect(hex(decodedRow.contentRoot!)).toBe(vectors.presentRoot.hashHex);
        expect(hex(serialize(decodedRow))).toBe(
            vectors.fileVersionIndex.borshHex
        );
    });

    it("rejects unknown and non-canonical wire discriminators", () => {
        const versionWire = fromHex(vectors.fileVersion.borshHex);
        expect(encode("shared_fs_merkle_file_version_v2").byteLength).toBe(
            readU32(versionWire, 0)
        );
        expect(() =>
            decodeMerkleContentEntryV1(
                replaceBorshString(
                    versionWire,
                    0,
                    "shared_fs_merkle_file_version_v2"
                )
            )
        ).toThrow(/unsupported content variant/);

        const indexWire = fromHex(vectors.fileVersionIndex.borshHex);
        expect(encode("shared_fs_merkle_indexable_entry_v2").byteLength).toBe(
            readU32(indexWire, 0)
        );
        expect(() =>
            decodeIndexableMerkleEntryV1(
                replaceBorshString(
                    indexWire,
                    0,
                    "shared_fs_merkle_indexable_entry_v2"
                )
            )
        ).toThrow(/unsupported index variant/);

        expect(() =>
            decodeMerkleContentEntryV1(withU32(versionWire, 0, 0xffff_ffff))
        ).toThrow(/variant exceeds|variant length exceeds/);

        const malformedVariant = new Uint8Array(versionWire);
        malformedVariant[4] = 0x80;
        expect(() => decodeMerkleContentEntryV1(malformedVariant)).toThrow(
            /variant is not canonical UTF-8/
        );
        expect(() =>
            decodeMerkleContentEntryV1(
                new Uint8Array(MERKLE_V1_MAX_WIRE_BYTES + 1)
            )
        ).toThrow(/encoded value exceeds/);
    });

    it("bounds file-version and index allocation before decoding", () => {
        const versionWire = fromHex(vectors.fileVersion.borshHex);
        const versionOffsets = versionWireOffsets(versionWire);
        expect(() =>
            decodeMerkleContentEntryV1(
                withU32(
                    versionWire,
                    versionOffsets.id,
                    MERKLE_FILE_VERSION_V1_LIMITS.maxVersionIdUtf8Bytes + 1
                )
            )
        ).toThrow(/id exceeds 256 UTF-8 bytes/);
        expect(() =>
            decodeMerkleContentEntryV1(
                withU32(
                    versionWire,
                    versionOffsets.parentVersionIds,
                    0xffff_ffff
                )
            )
        ).toThrow(/parentVersionIds exceeds 8000 entries/);

        let afterParents = versionOffsets.parentVersionIds + 4;
        const originalParentCount = readU32(
            versionWire,
            versionOffsets.parentVersionIds
        );
        for (let index = 0; index < originalParentCount; index++) {
            afterParents = afterBorshString(versionWire, afterParents);
        }
        const aggregateOverflowParents = Array.from(
            { length: 4097 },
            (_, index) =>
                encodeBorshString(
                    `version:${index.toString().padStart(8, "0")}${"p".repeat(240)}`
                )
        );
        const aggregateOverflowWire = concatBytes([
            versionWire.subarray(0, versionOffsets.parentVersionIds),
            encodeU32(aggregateOverflowParents.length),
            ...aggregateOverflowParents,
            versionWire.subarray(afterParents),
        ]);
        expect(aggregateOverflowWire.byteLength).toBeLessThan(
            MERKLE_V1_MAX_WIRE_BYTES
        );
        expect(() => decodeMerkleContentEntryV1(aggregateOverflowWire)).toThrow(
            /parentVersionIds.*aggregate UTF-8 byte/
        );

        const malformedId = new Uint8Array(versionWire);
        const malformedOffset =
            versionOffsets.id + 4 + encode("version:").byteLength;
        malformedId[malformedOffset] = 0xc0;
        malformedId[malformedOffset + 1] = 0xaf;
        expect(() => decodeMerkleContentEntryV1(malformedId)).toThrow(
            /id is not canonical UTF-8/
        );

        const indexWire = fromHex(vectors.fileVersionIndex.borshHex);
        const indexOffsets = indexWireOffsets(indexWire);
        expect(() =>
            decodeIndexableMerkleEntryV1(
                withU32(indexWire, indexOffsets.blockRefs, 0xffff_ffff)
            )
        ).toThrow(/index blockRefs exceeds 256 entries/);
        expect(() =>
            decodeIndexableMerkleEntryV1(
                withU32(
                    indexWire,
                    indexOffsets.kind,
                    MERKLE_FILE_VERSION_V1_LIMITS.maxIndexKindUtf8Bytes + 1
                )
            )
        ).toThrow(/index kind exceeds 16 UTF-8 bytes/);
    });

    it("validates decoded index semantics after bounded field decoding", () => {
        const versionRow = new IndexableMerkleEntryV1(validVersion());
        versionRow.changesetId = "🙂".repeat(129);
        expect(() =>
            decodeIndexableMerkleEntryV1(serialize(versionRow))
        ).toThrow(/changesetId exceeds 256 UTF-16 code units/);

        const mismatchedRoot = new IndexableMerkleEntryV1(validVersion());
        mismatchedRoot.blockRefs = [
            merkleTreeIdFromHashV1(new Uint8Array(32).fill(0x5a)),
        ];
        expect(() =>
            decodeIndexableMerkleEntryV1(serialize(mismatchedRoot))
        ).toThrow(/contentRoot does not match/);

        const data = new MerkleDataBlockV1({ bytes: encode("index shape") });
        const dataRow = new IndexableMerkleEntryV1(data);
        dataRow.nodeId = "file:not-allowed";
        expect(() => decodeIndexableMerkleEntryV1(serialize(dataRow))).toThrow(
            /non-version index rows must contain only zero metadata/
        );
    });

    it("snapshots accessor-backed blocks before deriving ids or refs", () => {
        const data = new MerkleDataBlockV1({ bytes: encode("stable leaf") });
        const tree = new MerkleTreeBlockV1({
            level: 1,
            bitmap: merkleV1BitmapFromSlots([7]),
            children: [merkleDataHashV1(data.bytes)],
        });
        const expectedRefs = [merkleDataIdFromHashV1(tree.children[0])];

        const forRefs = accessorBackedTree(tree);
        expect(merkleTreeBlockRefsV1(forRefs.value)).toEqual(expectedRefs);
        expect(forRefs.reads).toEqual({
            id: 1,
            level: 1,
            bitmap: 1,
            children: 1,
        });

        const forTreeIndex = accessorBackedTree(tree);
        expect(new IndexableMerkleEntryV1(forTreeIndex.value)).toMatchObject({
            id: tree.id,
            kind: "merkle-tree",
            blockRefs: expectedRefs,
            treeLevel: 1,
        });
        expect(forTreeIndex.reads).toEqual({
            id: 1,
            level: 1,
            bitmap: 1,
            children: 1,
        });

        const forDataIndex = accessorBackedData(data);
        expect(new IndexableMerkleEntryV1(forDataIndex.value)).toMatchObject({
            id: data.id,
            kind: "merkle-data",
            blockRefs: [],
        });
        expect(forDataIndex.reads).toEqual({ id: 1, bytes: 1 });
    });

    it("uses canonical ids for authenticated hashes", () => {
        expect(
            merkleDataIdFromHashV1(fromHex(vectors.presentRoot.rootHashHex))
        ).toBe("data2:-CvXqY1LwUJ3FSkeE9IDPVYH2u4G3dYOwMM9RQ2mN60");
        expect(
            merkleTreeIdFromHashV1(fromHex(vectors.presentRoot.rootHashHex))
        ).toBe(vectors.fileVersion.rootBlockRefs[0]);
        expect(() => merkleDataIdFromHashV1(new Uint8Array(31))).toThrow(
            /exactly 32 bytes/
        );
        expect(() => merkleTreeIdFromHashV1(new Uint8Array(33))).toThrow(
            /exactly 32 bytes/
        );
    });

    it("keeps signed version and index size independent of logical file size", () => {
        const small = new MerkleFileVersionV1({
            ...goldenProperties(),
            id: "version:small",
            parentVersionIds: [],
            causalDepth: 1n,
            size: 16n * 1024n * 1024n,
            rootLevel: 1,
        });
        const large = new MerkleFileVersionV1({
            ...goldenProperties(),
            id: "version:large",
            parentVersionIds: [],
            causalDepth: 1n,
            size: 1024n * 1024n * 1024n,
            rootLevel: 2,
        });
        expect(serialize(small).byteLength).toBe(serialize(large).byteLength);
        expect(serialize(new IndexableMerkleEntryV1(small)).byteLength).toBe(
            serialize(new IndexableMerkleEntryV1(large)).byteLength
        );
        expect(hex(small.contentRoot)).toBe(
            hex(
                merkleContentRootV1({
                    leafSize: small.leafSize,
                    size: small.size,
                    rootLevel: small.rootLevel,
                    rootHash: small.rootHash,
                })
            )
        );
    });
});
