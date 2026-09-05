import { deserialize, serialize } from "@dao-xyz/borsh";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    IndexableMerkleEntryV1,
    MERKLE_FILE_VERSION_V1_LIMITS,
    MerkleFileVersionV1,
    assertMerkleContentEntryV1,
    assertMerkleFileVersionV1,
    merkleRootBlockRefsV1,
    merkleRootDescriptorFromVersionV1,
    merkleTreeBlockRefsV1,
    type MerkleFileVersionV1Properties,
} from "../merkle-file-version-v1.js";
import {
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

describe("Merkle file-version v1 wire contract", () => {
    it("matches the language-neutral Borsh golden vector", () => {
        const value = validVersion();
        expect(hex(value.contentRoot)).toBe(vectors.presentRoot.hashHex);
        expect(hex(serialize(value))).toBe(vectors.fileVersion.borshHex);
        expect(merkleRootBlockRefsV1(value)).toEqual(
            vectors.fileVersion.rootBlockRefs
        );

        const decoded = deserialize(
            fromHex(vectors.fileVersion.borshHex),
            MerkleFileVersionV1
        );
        expect(decoded).toBeInstanceOf(MerkleFileVersionV1);
        expect(assertMerkleFileVersionV1(decoded)).toBe(decoded);
        expect(decoded.id).toBe(vectors.fileVersion.id);
        expect(decoded.parentVersionIds).toEqual(
            vectors.fileVersion.parentVersionIds
        );
        expect(decoded.causalDepth).toBe(
            BigInt(vectors.fileVersion.causalDepth)
        );
        expect(decoded.createdAt).toBe(BigInt(vectors.fileVersion.createdAt));
        expect(hex(decoded.legacyWholeSha256!)).toBe(
            vectors.fileVersion.legacyWholeSha256Hex
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

        const decodedRow = deserialize(
            serialize(versionRow),
            IndexableMerkleEntryV1
        );
        expect(decodedRow.blockRefs).toEqual(vectors.fileVersion.rootBlockRefs);
        expect(hex(decodedRow.contentRoot!)).toBe(vectors.presentRoot.hashHex);
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
