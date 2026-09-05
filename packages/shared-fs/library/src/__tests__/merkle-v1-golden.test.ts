import { field, fixedArray, option, serialize, vec } from "@dao-xyz/borsh";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    MERKLE_V1_ALLOWED_LEAF_SIZES,
    MERKLE_V1_BITMAP_BYTES,
    MERKLE_V1_MAX_DATA_BYTES,
    MerkleDataBlockV1,
    MerkleTreeBlockV1,
    assertMerkleChildLevelV1,
    assertMerkleDataBlockV1,
    assertMerkleRootDescriptorV1,
    assertMerkleRootBlockV1,
    assertMerkleTreeBlockV1,
    encodeMerkleContentRootHashInputV1,
    encodeMerkleDataHashInputV1,
    encodeMerkleTreeHashInputV1,
    merkleContentRootEqualsV1,
    merkleContentRootV1,
    merkleDataHashV1,
    merkleDataIdV1,
    merkleRootLevelV1,
    merkleTreeHashV1,
    merkleTreeIdV1,
    merkleV1BitmapFromSlots,
    merkleV1BitmapHasSlot,
    merkleV1BitmapSlots,
} from "../merkle-v1.js";
import { decodeMerkleContentEntryV1 } from "../merkle-file-version-v1.js";

const encode = (value: string) => new TextEncoder().encode(value);
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

const readU32 = (wire: Uint8Array, offset: number) =>
    new DataView(wire.buffer, wire.byteOffset, wire.byteLength).getUint32(
        offset,
        true
    );

const afterBorshString = (wire: Uint8Array, offset: number) =>
    offset + 4 + readU32(wire, offset);

const withU32 = (wire: Uint8Array, offset: number, value: number) => {
    const changed = new Uint8Array(wire);
    new DataView(
        changed.buffer,
        changed.byteOffset,
        changed.byteLength
    ).setUint32(offset, value, true);
    return changed;
};

class DataHashFields {
    @field({ type: Uint8Array })
    bytes: Uint8Array;

    constructor(bytes: Uint8Array) {
        this.bytes = bytes;
    }
}

class TreeHashFields {
    @field({ type: "u8" })
    level: number;

    @field({ type: fixedArray("u8", 32) })
    bitmap: Uint8Array;

    @field({ type: vec(fixedArray("u8", 32)) })
    children: Uint8Array[];

    constructor(level: number, bitmap: Uint8Array, children: Uint8Array[]) {
        this.level = level;
        this.bitmap = bitmap;
        this.children = children;
    }
}

class RootHashFields {
    @field({ type: "u32" })
    leafSize: number;

    @field({ type: "u64" })
    size: bigint;

    @field({ type: "u8" })
    rootLevel: number;

    @field({ type: option(fixedArray("u8", 32)) })
    rootHash?: Uint8Array;

    constructor(
        leafSize: number,
        size: bigint,
        rootLevel: number,
        rootHash?: Uint8Array
    ) {
        this.leafSize = leafSize;
        this.size = size;
        this.rootLevel = rootLevel;
        this.rootHash = rootHash;
    }
}
const vectors = JSON.parse(
    readFileSync(
        new URL("../../../merkle-v1-golden-vectors.json", import.meta.url),
        "utf8"
    )
) as {
    format: string;
    integerEncoding: string;
    bitmapBitOrder: string;
    idEncoding: string;
    data: {
        bytesHex: string;
        hashInputHex: string;
        hashHex: string;
        id: string;
    };
    tree: {
        level: number;
        slots: number[];
        children: Array<{
            fillByte: number;
            length: number;
            hashHex: string;
        }>;
        hashInputHex: string;
        hashHex: string;
        id: string;
    };
    presentRoot: {
        leafSize: number;
        size: string;
        rootLevel: number;
        rootHashHex: string;
        hashInputHex: string;
        hashHex: string;
    };
    sparseRoot: {
        leafSize: number;
        size: string;
        rootLevel: number;
        hashInputHex: string;
        hashHex: string;
    };
};

describe("Merkle v1 canonical codecs", () => {
    it("publishes language-neutral, unpadded golden vectors", () => {
        expect(vectors.format).toBe("peerbit-shared-fs-merkle-v1-golden-v1");
        expect(vectors.integerEncoding).toBe("borsh-little-endian");
        expect(vectors.bitmapBitOrder).toBe(
            "slot i is least-significant bit (i & 7) of byte (i >>> 3)"
        );
        expect(vectors.idEncoding).toBe("unpadded-base64url");
        expect(vectors.data).toEqual({
            bytesHex: "68656c6c6f",
            hashInputHex:
                "706565726269742d7368617265642d66732f646174612f76310500000068656c6c6f",
            hashHex:
                "87690d6812d1ed1392730bddf27f0d2423277365dccedc46a45d2a2c9ccdbf53",
            id: "data2:h2kNaBLR7ROScwvd8n8NJCMnc2XcztxGpF0qLJzNv1M",
        });
        expect(vectors.tree.slots).toEqual([0, 1]);
        expect(vectors.presentRoot.rootLevel).toBe(vectors.tree.level);
        expect(
            merkleRootLevelV1(
                BigInt(vectors.presentRoot.size),
                vectors.presentRoot.leafSize
            )
        ).toBe(vectors.tree.level);
        expect(
            vectors.tree.children
                .slice(0, -1)
                .every((child) => child.length === vectors.presentRoot.leafSize)
        ).toBe(true);
        const finalChild = vectors.tree.children.at(-1)!;
        const finalSlot = vectors.tree.slots.at(-1)!;
        expect(finalChild.length).toBeGreaterThan(0);
        expect(finalChild.length).toBeLessThanOrEqual(
            vectors.presentRoot.leafSize
        );
        expect(BigInt(vectors.presentRoot.size)).toBe(
            BigInt(finalSlot) * BigInt(vectors.presentRoot.leafSize) +
                BigInt(finalChild.length)
        );
    });

    it("matches the fixed data-block golden vector", () => {
        const bytes = Uint8Array.from(
            Buffer.from(vectors.data.bytesHex, "hex")
        );
        expect(hex(encodeMerkleDataHashInputV1(bytes))).toBe(
            vectors.data.hashInputHex
        );
        expect(hex(merkleDataHashV1(bytes))).toBe(vectors.data.hashHex);
        expect(merkleDataIdV1(bytes)).toBe(vectors.data.id);
    });

    it("encodes every hashed field exactly as Borsh", () => {
        const bytes = encode("hello");
        const dataInput = encodeMerkleDataHashInputV1(bytes);
        expect(
            hex(dataInput.slice(encode("peerbit-shared-fs/data/v1").length))
        ).toBe(hex(serialize(new DataHashFields(bytes))));

        const bitmap = merkleV1BitmapFromSlots([0, 7, 255]);
        const children = [
            merkleDataHashV1(encode("alpha")),
            merkleDataHashV1(encode("beta")),
            merkleDataHashV1(encode("omega")),
        ];
        const treeInput = encodeMerkleTreeHashInputV1(1, bitmap, children);
        expect(
            hex(treeInput.slice(encode("peerbit-shared-fs/tree/v1").length))
        ).toBe(hex(serialize(new TreeHashFields(1, bitmap, children))));

        const rootHash = merkleTreeHashV1(1, bitmap, children);
        const presentInput = encodeMerkleContentRootHashInputV1({
            leafSize: 256 * 1024,
            size: 524_289n,
            rootLevel: 1,
            rootHash,
        });
        expect(
            hex(presentInput.slice(encode("peerbit-shared-fs/file/v1").length))
        ).toBe(
            hex(
                serialize(new RootHashFields(256 * 1024, 524_289n, 1, rootHash))
            )
        );
        const sparseInput = encodeMerkleContentRootHashInputV1({
            leafSize: 64 * 1024,
            size: 1_048_577n,
            rootLevel: 1,
        });
        expect(
            hex(sparseInput.slice(encode("peerbit-shared-fs/file/v1").length))
        ).toBe(hex(serialize(new RootHashFields(64 * 1024, 1_048_577n, 1))));
    });

    it("uses an explicit, canonical bitmap order", () => {
        const bitmap = merkleV1BitmapFromSlots([0, 7, 8, 255]);
        expect(bitmap).toHaveLength(MERKLE_V1_BITMAP_BYTES);
        expect(bitmap[0]).toBe(0x81);
        expect(bitmap[1]).toBe(0x01);
        expect(bitmap[31]).toBe(0x80);
        expect(merkleV1BitmapSlots(bitmap)).toEqual([0, 7, 8, 255]);
        expect(merkleV1BitmapHasSlot(bitmap, 7)).toBe(true);
        expect(merkleV1BitmapHasSlot(bitmap, 9)).toBe(false);
        expect(() => merkleV1BitmapFromSlots([7, 7])).toThrow(
            /strictly ascending/
        );
        expect(() => merkleV1BitmapFromSlots([8, 7])).toThrow(
            /strictly ascending/
        );
    });

    it("matches the fixed sparse-tree golden vector", () => {
        const bitmap = merkleV1BitmapFromSlots(vectors.tree.slots);
        const children = vectors.tree.children.map((child) =>
            merkleDataHashV1(new Uint8Array(child.length).fill(child.fillByte))
        );
        expect(children.map(hex)).toEqual(
            vectors.tree.children.map((child) => child.hashHex)
        );
        expect(
            hex(
                encodeMerkleTreeHashInputV1(
                    vectors.tree.level,
                    bitmap,
                    children
                )
            )
        ).toBe(vectors.tree.hashInputHex);
        expect(
            hex(merkleTreeHashV1(vectors.tree.level, bitmap, children))
        ).toBe(vectors.tree.hashHex);
        expect(merkleTreeIdV1(vectors.tree.level, bitmap, children)).toBe(
            vectors.tree.id
        );
    });

    it("matches present-root and authenticated-hole golden vectors", () => {
        const bitmap = merkleV1BitmapFromSlots(vectors.tree.slots);
        const rootHash = merkleTreeHashV1(
            vectors.tree.level,
            bitmap,
            vectors.tree.children.map((child) =>
                merkleDataHashV1(
                    new Uint8Array(child.length).fill(child.fillByte)
                )
            )
        );
        expect(hex(rootHash)).toBe(vectors.presentRoot.rootHashHex);
        const present = {
            leafSize: vectors.presentRoot.leafSize as 65_536,
            size: BigInt(vectors.presentRoot.size),
            rootLevel: vectors.presentRoot.rootLevel,
            rootHash,
        };
        expect(hex(encodeMerkleContentRootHashInputV1(present))).toBe(
            vectors.presentRoot.hashInputHex
        );
        expect(hex(merkleContentRootV1(present))).toBe(
            vectors.presentRoot.hashHex
        );

        const sparse = {
            leafSize: (64 * 1024) as const,
            size: 1_048_577n,
            rootLevel: 1,
        };
        expect(hex(encodeMerkleContentRootHashInputV1(sparse))).toBe(
            vectors.sparseRoot.hashInputHex
        );
        expect(hex(merkleContentRootV1(sparse))).toBe(
            vectors.sparseRoot.hashHex
        );
    });

    it("round-trips self-certifying data and tree values", () => {
        const source = encode("immutable payload");
        const data = new MerkleDataBlockV1({ bytes: source });
        source[0] ^= 0xff;
        expect(new TextDecoder().decode(data.bytes)).toBe("immutable payload");

        const decodedData = decodeMerkleContentEntryV1(serialize(data));
        expect(decodedData).toBeInstanceOf(MerkleDataBlockV1);
        expect(assertMerkleDataBlockV1(decodedData).id).toBe(data.id);
        expect(hex(serialize(decodedData))).toBe(hex(serialize(data)));

        const child = merkleDataHashV1(data.bytes);
        const bitmap = merkleV1BitmapFromSlots([31]);
        const tree = new MerkleTreeBlockV1({
            level: 1,
            bitmap,
            children: [child],
        });
        bitmap.fill(0);
        child.fill(0);
        expect(merkleV1BitmapSlots(tree.bitmap)).toEqual([31]);

        const decodedTree = decodeMerkleContentEntryV1(serialize(tree));
        expect(decodedTree).toBeInstanceOf(MerkleTreeBlockV1);
        expect(assertMerkleTreeBlockV1(decodedTree).id).toBe(tree.id);
        expect(hex(serialize(decodedTree))).toBe(hex(serialize(tree)));
    });

    it("bounds data and tree vectors before decoding", () => {
        const data = new MerkleDataBlockV1({ bytes: encode("bounded leaf") });
        const dataWire = serialize(data);
        const dataIdOffset = afterBorshString(dataWire, 0);
        const dataBytesOffset = afterBorshString(dataWire, dataIdOffset);
        expect(() =>
            decodeMerkleContentEntryV1(
                withU32(dataWire, dataBytesOffset, MERKLE_V1_MAX_DATA_BYTES + 1)
            )
        ).toThrow(/data block bytes length must be from/);

        const malformedId = new Uint8Array(dataWire);
        const malformedOffset = dataIdOffset + 4 + encode("data2:").byteLength;
        malformedId[malformedOffset] = 0xc0;
        malformedId[malformedOffset + 1] = 0xaf;
        expect(() => decodeMerkleContentEntryV1(malformedId)).toThrow(
            /data block id is not canonical UTF-8/
        );

        const child = merkleDataHashV1(data.bytes);
        const tree = new MerkleTreeBlockV1({
            level: 1,
            bitmap: merkleV1BitmapFromSlots([0]),
            children: [child],
        });
        const treeWire = serialize(tree);
        const treeIdOffset = afterBorshString(treeWire, 0);
        const childCountOffset =
            afterBorshString(treeWire, treeIdOffset) + 1 + 32;
        expect(() =>
            decodeMerkleContentEntryV1(
                withU32(treeWire, childCountOffset, 0xffff_ffff)
            )
        ).toThrow(/tree children exceeds 256 entries/);
    });

    it("rejects non-canonical or corrupted blocks", () => {
        expect(
            () => new MerkleDataBlockV1({ bytes: new Uint8Array() })
        ).toThrow(/data length/);
        expect(
            () => new MerkleDataBlockV1({ bytes: new Uint8Array([0, 0]) })
        ).toThrow(/all-zero/);
        const oversized = new Uint8Array(MERKLE_V1_MAX_DATA_BYTES + 1);
        expect(() => encodeMerkleDataHashInputV1(oversized)).toThrow(
            /data length/
        );
        expect(() => new MerkleDataBlockV1({ bytes: oversized })).toThrow(
            /data length/
        );

        const data = new MerkleDataBlockV1({ bytes: encode("valid") });
        data.id = `${data.id}-tampered`;
        expect(() => assertMerkleDataBlockV1(data)).toThrow(/does not match/);

        const bitmap = merkleV1BitmapFromSlots([0, 1]);
        expect(
            () =>
                new MerkleTreeBlockV1({
                    level: 1,
                    bitmap,
                    children: [merkleDataHashV1(encode("only one"))],
                })
        ).toThrow(/population count/);
        expect(
            () =>
                new MerkleTreeBlockV1({
                    level: 0,
                    bitmap: merkleV1BitmapFromSlots([0]),
                    children: [merkleDataHashV1(encode("child"))],
                })
        ).toThrow(/tree level/);
        expect(
            () =>
                new MerkleTreeBlockV1({
                    level: 1,
                    bitmap: new Uint8Array(1024 * 1024),
                    children: [],
                })
        ).toThrow(/bitmap must contain exactly/);
        expect(
            () =>
                new MerkleTreeBlockV1({
                    level: 1,
                    bitmap: merkleV1BitmapFromSlots([0]),
                    children: [new Uint8Array(1024 * 1024)],
                })
        ).toThrow(/exactly 32 bytes/);

        const tree = new MerkleTreeBlockV1({
            level: 1,
            bitmap: merkleV1BitmapFromSlots([0]),
            children: [merkleDataHashV1(encode("child"))],
        });
        tree.children[0][0] ^= 0xff;
        expect(() => assertMerkleTreeBlockV1(tree)).toThrow(/does not match/);
    });

    it("enforces canonical root levels across the u64 address space", () => {
        const leaf = 64 * 1024;
        expect(merkleRootLevelV1(0n, leaf)).toBe(0);
        expect(merkleRootLevelV1(BigInt(leaf), leaf)).toBe(0);
        expect(merkleRootLevelV1(BigInt(leaf) + 1n, leaf)).toBe(1);
        expect(merkleRootLevelV1(BigInt(leaf) * 256n, leaf)).toBe(1);
        expect(merkleRootLevelV1(BigInt(leaf) * 256n + 1n, leaf)).toBe(2);
        expect(merkleRootLevelV1((1n << 64n) - 1n, leaf)).toBe(6);
        expect(Object.isFrozen(MERKLE_V1_ALLOWED_LEAF_SIZES)).toBe(true);
        expect(() =>
            (MERKLE_V1_ALLOWED_LEAF_SIZES as unknown as number[]).push(
                128 * 1024
            )
        ).toThrow(TypeError);
        expect(() => merkleRootLevelV1(1n, 128 * 1024)).toThrow(
            /leafSize must be one of/
        );

        expect(() =>
            assertMerkleRootDescriptorV1({
                leafSize: leaf,
                size: BigInt(leaf) + 1n,
                rootLevel: 0,
            })
        ).toThrow(/canonical level 1/);
        expect(() =>
            assertMerkleRootDescriptorV1({
                leafSize: leaf,
                size: 0n,
                rootLevel: 0,
                rootHash: new Uint8Array(32),
            })
        ).toThrow(/empty file/);
        expect(() => assertMerkleRootDescriptorV1(null)).toThrow(/object/);
        expect(() =>
            assertMerkleRootDescriptorV1({
                leafSize: leaf,
                size: "0",
                rootLevel: 0,
            })
        ).toThrow(/number or bigint/);
        expect(() =>
            assertMerkleRootDescriptorV1({
                leafSize: leaf,
                size: 0n,
                rootLevel: 0,
                rootHash: null,
            })
        ).toThrow(/undefined or 32 bytes/);
    });

    it("binds content identity and traversal levels", () => {
        const data = new MerkleDataBlockV1({ bytes: encode("leaf") });
        const levelOne = new MerkleTreeBlockV1({
            level: 1,
            bitmap: merkleV1BitmapFromSlots([0]),
            children: [merkleDataHashV1(data.bytes)],
        });
        const levelTwo = new MerkleTreeBlockV1({
            level: 2,
            bitmap: merkleV1BitmapFromSlots([0]),
            children: [merkleTreeHashV1(1, levelOne.bitmap, levelOne.children)],
        });
        expect(() => assertMerkleChildLevelV1(1, data)).not.toThrow();
        expect(() => assertMerkleChildLevelV1(2, levelOne)).not.toThrow();
        expect(() => assertMerkleChildLevelV1(2, data)).toThrow(/requires/);
        expect(() => assertMerkleChildLevelV1(1, levelOne)).toThrow(
            /only data/
        );
        expect(() => assertMerkleChildLevelV1(3, levelOne)).toThrow(/level-2/);

        const descriptor = {
            leafSize: (64 * 1024) as const,
            size: 64n * 1024n * 257n,
            rootLevel: 2,
            rootHash: merkleTreeHashV1(
                levelTwo.level,
                levelTwo.bitmap,
                levelTwo.children
            ),
        };
        const identity = merkleContentRootV1(descriptor);
        expect(merkleContentRootEqualsV1(descriptor, identity)).toBe(true);
        identity[0] ^= 0xff;
        expect(merkleContentRootEqualsV1(descriptor, identity)).toBe(false);

        expect(() =>
            assertMerkleRootBlockV1(descriptor, levelTwo)
        ).not.toThrow();
        expect(() => assertMerkleRootBlockV1(descriptor, levelOne)).toThrow(
            /matching tree block/
        );
        expect(() =>
            assertMerkleRootBlockV1(
                {
                    leafSize: 64 * 1024,
                    size: 4n,
                    rootLevel: 0,
                    rootHash: merkleDataHashV1(data.bytes),
                },
                data
            )
        ).not.toThrow();
        expect(() =>
            assertMerkleRootBlockV1({
                leafSize: 64 * 1024,
                size: 4n,
                rootLevel: 0,
            })
        ).not.toThrow();
        expect(() =>
            assertMerkleRootBlockV1(
                {
                    leafSize: 64 * 1024,
                    size: 4n,
                    rootLevel: 0,
                },
                data
            )
        ).toThrow(/must not resolve/);
        expect(() =>
            assertMerkleRootBlockV1(
                {
                    leafSize: 64 * 1024,
                    size: 5n,
                    rootLevel: 0,
                    rootHash: merkleDataHashV1(data.bytes),
                },
                data
            )
        ).toThrow(/length must equal/);

        const beyondEof = new MerkleTreeBlockV1({
            level: 1,
            bitmap: merkleV1BitmapFromSlots([2]),
            children: [merkleDataHashV1(data.bytes)],
        });
        expect(() =>
            assertMerkleRootBlockV1(
                {
                    leafSize: 64 * 1024,
                    size: 64n * 1024n + 1n,
                    rootLevel: 1,
                    rootHash: merkleTreeHashV1(
                        beyondEof.level,
                        beyondEof.bitmap,
                        beyondEof.children
                    ),
                },
                beyondEof
            )
        ).toThrow(/beyond the file EOF/);
    });
});
