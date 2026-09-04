import { describe, expect, it } from "vitest";
import {
    MERKLE_READ_SESSION_V1_ABSOLUTE_MAX_READ_BYTES,
    MerkleReadSessionErrorV1,
    MerkleReadSessionV1,
    type MerkleBlockSourceV1,
} from "../merkle-read-session-v1.js";
import {
    MERKLE_V1_BITMAP_BYTES,
    MERKLE_V1_FANOUT,
    MERKLE_V1_MAX_DATA_BYTES,
    MerkleDataBlockV1,
    MerkleTreeBlockV1,
    merkleDataHashV1,
    merkleRootLevelV1,
    merkleTreeHashV1,
    merkleV1BitmapFromSlots,
    type MerkleRootDescriptorV1,
    type MerkleV1LeafSize,
} from "../merkle-v1.js";

const LEAF_SIZE = 65_536 as const;

const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const blockKey = (kind: "data" | "tree", level: number, hash: Uint8Array) =>
    `${kind}:${level}:${hex(hash)}`;

class MemoryBlockSource implements MerkleBlockSourceV1 {
    readonly blocks = new Map<string, unknown>();
    readonly loads: Array<{
        kind: "data" | "tree";
        level: number;
        hash: string;
    }> = [];

    async load(reference: {
        hash: Uint8Array;
        kind: "data" | "tree";
        level: number;
    }): Promise<unknown | undefined> {
        this.loads.push({
            kind: reference.kind,
            level: reference.level,
            hash: hex(reference.hash),
        });
        return this.blocks.get(
            blockKey(reference.kind, reference.level, reference.hash)
        );
    }

    putData(block: MerkleDataBlockV1) {
        const hash = merkleDataHashV1(block.bytes);
        this.blocks.set(blockKey("data", 0, hash), block);
        return hash;
    }

    putTree(block: MerkleTreeBlockV1) {
        const hash = merkleTreeHashV1(
            block.level,
            block.bitmap,
            block.children
        );
        this.blocks.set(blockKey("tree", block.level, hash), block);
        return hash;
    }
}

type Fixture = {
    bytes: Uint8Array;
    root: MerkleRootDescriptorV1;
    source: MemoryBlockSource;
};

const allZero = (bytes: Uint8Array) => {
    for (const byte of bytes) if (byte !== 0) return false;
    return true;
};

const buildFixture = (
    bytesValue: Uint8Array,
    leafSize: MerkleV1LeafSize = LEAF_SIZE
): Fixture => {
    const bytes = new Uint8Array(bytesValue);
    const source = new MemoryBlockSource();
    const rootLevel = merkleRootLevelV1(bytes.byteLength, leafSize);
    const leafCount = Math.ceil(bytes.byteLength / leafSize);
    let hashes = new Map<number, Uint8Array>();
    for (let leaf = 0; leaf < leafCount; leaf++) {
        const value = bytes.slice(
            leaf * leafSize,
            Math.min(bytes.byteLength, (leaf + 1) * leafSize)
        );
        if (allZero(value)) continue;
        const block = new MerkleDataBlockV1({ bytes: value });
        hashes.set(leaf, source.putData(block));
    }

    if (rootLevel === 0) {
        return {
            bytes,
            source,
            root: {
                leafSize,
                size: BigInt(bytes.byteLength),
                rootLevel,
                rootHash: hashes.get(0),
            },
        };
    }

    for (let level = 1; level <= rootLevel; level++) {
        const groups = new Map<
            number,
            Array<{ slot: number; hash: Uint8Array }>
        >();
        for (const [childIndex, hash] of hashes) {
            const parentIndex = Math.floor(childIndex / MERKLE_V1_FANOUT);
            const slot = childIndex % MERKLE_V1_FANOUT;
            const group = groups.get(parentIndex) ?? [];
            group.push({ slot, hash });
            groups.set(parentIndex, group);
        }
        hashes = new Map();
        for (const [parentIndex, group] of groups) {
            group.sort((left, right) => left.slot - right.slot);
            const tree = new MerkleTreeBlockV1({
                level,
                bitmap: merkleV1BitmapFromSlots(group.map(({ slot }) => slot)),
                children: group.map(({ hash }) => hash),
            });
            hashes.set(parentIndex, source.putTree(tree));
        }
    }
    return {
        bytes,
        source,
        root: {
            leafSize,
            size: BigInt(bytes.byteLength),
            rootLevel,
            rootHash: hashes.get(0),
        },
    };
};

const expectBytes = (actual: Uint8Array, expected: Uint8Array) => {
    expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0);
};

const expectEio = async (promise: Promise<unknown>) => {
    await expect(promise).rejects.toMatchObject({
        name: "MerkleReadSessionErrorV1",
        code: "EIO",
    });
};

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const within = <Value>(promise: Promise<Value>, timeoutMs = 250) =>
    new Promise<Value>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error("operation did not settle promptly")),
            timeoutMs
        );
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });

describe("MerkleReadSessionV1", () => {
    it("reads exact cross-leaf ranges, authenticated holes, and strict EOF", async () => {
        const bytes = new Uint8Array(2 * LEAF_SIZE + 73);
        for (let index = 0; index < LEAF_SIZE; index++) {
            bytes[index] = (index * 17 + 3) & 0xff;
        }
        for (let index = 2 * LEAF_SIZE; index < bytes.length; index++) {
            bytes[index] = (index * 29 + 11) & 0xff;
        }
        const fixture = buildFixture(bytes);
        const session = new MerkleReadSessionV1({
            root: fixture.root,
            source: fixture.source,
        });

        const offset = LEAF_SIZE - 19;
        const requested = LEAF_SIZE + 200;
        expectBytes(
            await session.read(BigInt(offset), requested),
            bytes.slice(offset)
        );
        expect(await session.read(bytes.length, 100)).toHaveLength(0);
        expect(await session.read(0, 0)).toHaveLength(0);

        const firstStats = session.stats();
        expect(firstStats).toMatchObject({
            readCalls: 3,
            outputBytes: bytes.length - offset,
            sourceFetches: 3,
            treeBlocksVerified: 1,
            treeBlocksVisited: 1,
            dataBlocksVerified: 2,
            dataBlocksVisited: 2,
            authenticatedZeroRanges: 1,
            authenticatedZeroBytes: LEAF_SIZE,
        });

        expectBytes(await session.read(offset, requested), bytes.slice(offset));
        expect(session.stats()).toMatchObject({
            sourceFetches: 3,
            treeCacheHits: 1,
            dataCacheHits: 2,
        });
    });

    it("walks a level-2 boundary in returned leaves plus depth", async () => {
        const bytes = new Uint8Array(257 * LEAF_SIZE);
        bytes[LEAF_SIZE - 1] = 1;
        bytes[255 * LEAF_SIZE] = 2;
        bytes[256 * LEAF_SIZE] = 3;
        bytes[bytes.length - 1] = 4;
        const fixture = buildFixture(bytes);
        expect(fixture.root.rootLevel).toBe(2);
        const session = new MerkleReadSessionV1({
            root: fixture.root,
            source: fixture.source,
        });
        const offset = 255 * LEAF_SIZE + LEAF_SIZE - 8;

        expectBytes(
            await session.read(offset, 16),
            bytes.slice(offset, offset + 16)
        );
        expect(session.stats()).toMatchObject({
            sourceFetches: 5,
            treeBlocksVerified: 3,
            treeBlocksVisited: 3,
            dataBlocksVerified: 2,
            dataBlocksVisited: 2,
        });
    });

    it("matches a deterministic randomized byte-buffer oracle", async () => {
        let state = 0x9e37_79b9;
        const random = () => {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            return state >>> 0;
        };

        for (let run = 0; run < 24; run++) {
            const size = random() % (8 * LEAF_SIZE + 1);
            const bytes = new Uint8Array(size);
            for (let leaf = 0; leaf * LEAF_SIZE < size; leaf++) {
                if ((random() & 3) === 0) continue;
                const end = Math.min(size, (leaf + 1) * LEAF_SIZE);
                for (let index = leaf * LEAF_SIZE; index < end; index++) {
                    bytes[index] = random() & 0xff;
                }
                if (
                    end > leaf * LEAF_SIZE &&
                    allZero(bytes.subarray(leaf * LEAF_SIZE, end))
                ) {
                    bytes[leaf * LEAF_SIZE] = 1;
                }
            }
            const fixture = buildFixture(bytes);
            const session = new MerkleReadSessionV1({
                root: fixture.root,
                source: fixture.source,
                maxReadBytes: 2 * LEAF_SIZE,
            });
            for (let read = 0; read < 30; read++) {
                const offset = random() % (size + LEAF_SIZE + 1);
                const length = random() % (2 * LEAF_SIZE + 1);
                const expected = bytes.slice(offset, offset + length);
                expectBytes(
                    await session.read(BigInt(offset), length),
                    expected
                );
            }
            expect(session.stats().cachedTreeBlocks).toBeLessThanOrEqual(128);
            expect(session.stats().cachedDataBlocks).toBeLessThanOrEqual(16);
            session.close();
        }
    });

    it("reads an authenticated all-zero root without consulting the source", async () => {
        let loads = 0;
        const session = new MerkleReadSessionV1({
            root: {
                leafSize: LEAF_SIZE,
                size: 3n * BigInt(LEAF_SIZE) + 9n,
                rootLevel: 1,
            },
            source: {
                async load() {
                    loads++;
                    return undefined;
                },
            },
        });
        const result = await session.read(LEAF_SIZE - 5, 40);
        expect(result).toEqual(new Uint8Array(40));
        expect(loads).toBe(0);
        expect(session.stats()).toMatchObject({
            authenticatedZeroRanges: 1,
            authenticatedZeroBytes: 40,
            sourceFetches: 0,
        });
    });

    it("fails closed for missing, corrupt, and wrong-type data children", async () => {
        const bytes = new Uint8Array(LEAF_SIZE + 1);
        bytes[0] = 7;
        bytes[LEAF_SIZE] = 9;
        const fixture = buildFixture(bytes);
        const root = fixture.root.rootHash!;
        const rootBlock = fixture.source.blocks.get(
            blockKey("tree", 1, root)
        ) as MerkleTreeBlockV1;
        const dataHash = rootBlock.children[0];
        const dataKey = blockKey("data", 0, dataHash);

        fixture.source.blocks.delete(dataKey);
        await expectEio(
            new MerkleReadSessionV1({
                root: fixture.root,
                source: fixture.source,
            }).read(0, 1)
        );

        fixture.source.blocks.set(dataKey, rootBlock);
        await expectEio(
            new MerkleReadSessionV1({
                root: fixture.root,
                source: fixture.source,
            }).read(0, 1)
        );

        const corrupt = new MerkleDataBlockV1({
            bytes: new Uint8Array(LEAF_SIZE).fill(1),
        });
        corrupt.bytes[0] ^= 0xff;
        fixture.source.blocks.set(dataKey, corrupt);
        await expectEio(
            new MerkleReadSessionV1({
                root: fixture.root,
                source: fixture.source,
            }).read(0, 1)
        );
    });

    it("fails closed for wrong data length even when the block is self-certifying", async () => {
        const source = new MemoryBlockSource();
        const short = new MerkleDataBlockV1({ bytes: Uint8Array.of(1, 2, 3) });
        const shortHash = source.putData(short);
        const final = new MerkleDataBlockV1({ bytes: Uint8Array.of(4) });
        const finalHash = source.putData(final);
        const tree = new MerkleTreeBlockV1({
            level: 1,
            bitmap: merkleV1BitmapFromSlots([0, 1]),
            children: [shortHash, finalHash],
        });
        const rootHash = source.putTree(tree);
        const session = new MerkleReadSessionV1({
            root: {
                leafSize: LEAF_SIZE,
                size: BigInt(LEAF_SIZE + 1),
                rootLevel: 1,
                rootHash,
            },
            source,
        });

        await expectEio(session.read(0, 1));

        const directRoot = new MerkleReadSessionV1({
            root: {
                leafSize: LEAF_SIZE,
                size: 4,
                rootLevel: 0,
                rootHash: shortHash,
            },
            source,
        });
        await expectEio(directRoot.read(0, 1));
    });

    it("fails closed for wrong tree type, level, hash, shape, and root EOF", async () => {
        const data = new MerkleDataBlockV1({ bytes: Uint8Array.of(1) });
        const dataHash = merkleDataHashV1(data.bytes);

        const wrongType = new MerkleReadSessionV1({
            root: {
                leafSize: LEAF_SIZE,
                size: BigInt(LEAF_SIZE + 1),
                rootLevel: 1,
                rootHash: dataHash,
            },
            source: {
                async load() {
                    return data;
                },
            },
        });
        await expectEio(wrongType.read(0, 1));

        const levelTwo = new MerkleTreeBlockV1({
            level: 2,
            bitmap: merkleV1BitmapFromSlots([0]),
            children: [dataHash],
        });
        const levelTwoHash = merkleTreeHashV1(
            levelTwo.level,
            levelTwo.bitmap,
            levelTwo.children
        );
        const wrongLevel = new MerkleReadSessionV1({
            root: {
                leafSize: LEAF_SIZE,
                size: BigInt(LEAF_SIZE + 1),
                rootLevel: 1,
                rootHash: levelTwoHash,
            },
            source: {
                async load() {
                    return levelTwo;
                },
            },
        });
        await expectEio(wrongLevel.read(0, 1));

        const source = new MemoryBlockSource();
        const leafHash = source.putData(data);
        const validTree = new MerkleTreeBlockV1({
            level: 1,
            bitmap: merkleV1BitmapFromSlots([0]),
            children: [leafHash],
        });
        const validTreeHash = source.putTree(validTree);
        const wrongHash = new Uint8Array(validTreeHash);
        wrongHash[0] ^= 0xff;
        await expectEio(
            new MerkleReadSessionV1({
                root: {
                    leafSize: LEAF_SIZE,
                    size: BigInt(LEAF_SIZE + 1),
                    rootLevel: 1,
                    rootHash: wrongHash,
                },
                source: {
                    async load() {
                        return validTree;
                    },
                },
            }).read(0, 1)
        );
        const corruptTree = new MerkleTreeBlockV1({
            level: validTree.level,
            bitmap: validTree.bitmap,
            children: validTree.children,
        });
        corruptTree.children[0] = new Uint8Array(31);
        source.blocks.set(blockKey("tree", 1, validTreeHash), corruptTree);
        await expectEio(
            new MerkleReadSessionV1({
                root: {
                    leafSize: LEAF_SIZE,
                    size: BigInt(LEAF_SIZE + 1),
                    rootLevel: 1,
                    rootHash: validTreeHash,
                },
                source,
            }).read(0, 1)
        );

        const beyondEof = new MerkleTreeBlockV1({
            level: 1,
            bitmap: merkleV1BitmapFromSlots([2]),
            children: [leafHash],
        });
        const beyondHash = source.putTree(beyondEof);
        await expectEio(
            new MerkleReadSessionV1({
                root: {
                    leafSize: LEAF_SIZE,
                    size: BigInt(LEAF_SIZE + 1),
                    rootLevel: 1,
                    rootHash: beyondHash,
                },
                source,
            }).read(0, 1)
        );
    });

    it("rejects oversized mutable loader fields before copying or hashing", async () => {
        const originalData = new MerkleDataBlockV1({ bytes: Uint8Array.of(1) });
        const dataHash = merkleDataHashV1(originalData.bytes);
        originalData.bytes = new Uint8Array(MERKLE_V1_MAX_DATA_BYTES + 1);
        const dataSession = new MerkleReadSessionV1({
            root: {
                leafSize: LEAF_SIZE,
                size: 1,
                rootLevel: 0,
                rootHash: dataHash,
            },
            source: {
                async load() {
                    return originalData;
                },
            },
        });
        await expectEio(dataSession.read(0, 1));
        expect(dataSession.stats()).toMatchObject({
            dataBlocksVerified: 0,
            dataBytesVerified: 0,
            cachedDataBlocks: 0,
        });

        const childHash = new Uint8Array(32).fill(1);
        const originalTree = new MerkleTreeBlockV1({
            level: 1,
            bitmap: merkleV1BitmapFromSlots([0]),
            children: [childHash],
        });
        const treeHash = merkleTreeHashV1(
            originalTree.level,
            originalTree.bitmap,
            originalTree.children
        );
        const assertRejectedTree = async (
            mutate: (tree: MerkleTreeBlockV1) => void
        ) => {
            const tree = new MerkleTreeBlockV1({
                level: originalTree.level,
                bitmap: originalTree.bitmap,
                children: originalTree.children,
            });
            mutate(tree);
            const session = new MerkleReadSessionV1({
                root: {
                    leafSize: LEAF_SIZE,
                    size: BigInt(LEAF_SIZE + 1),
                    rootLevel: 1,
                    rootHash: treeHash,
                },
                source: {
                    async load() {
                        return tree;
                    },
                },
            });
            await expectEio(session.read(0, 1));
            expect(session.stats()).toMatchObject({
                treeBlocksVerified: 0,
                cachedTreeBlocks: 0,
            });
        };
        await assertRejectedTree((tree) => {
            tree.bitmap = new Uint8Array(MERKLE_V1_BITMAP_BYTES + 1);
        });
        await assertRejectedTree((tree) => {
            tree.children = new Array(MERKLE_V1_FANOUT + 1).fill(childHash);
        });
        await assertRejectedTree((tree) => {
            tree.children[0] = new Uint8Array(33);
        });
    });

    it("captures accessor-backed loader fields exactly once before validation", async () => {
        const dataBytes = Uint8Array.of(1, 2, 3);
        const data = new MerkleDataBlockV1({ bytes: dataBytes });
        const dataHash = merkleDataHashV1(dataBytes);
        const oversized = new Uint8Array(MERKLE_V1_MAX_DATA_BYTES + 1);
        let dataReads = 0;
        Object.defineProperty(data, "bytes", {
            configurable: true,
            get() {
                dataReads++;
                return dataReads === 1 ? dataBytes : oversized;
            },
        });
        const dataSession = new MerkleReadSessionV1({
            root: {
                leafSize: LEAF_SIZE,
                size: dataBytes.byteLength,
                rootLevel: 0,
                rootHash: dataHash,
            },
            source: {
                async load() {
                    return data;
                },
            },
        });
        expectBytes(await dataSession.read(0, dataBytes.length), dataBytes);
        expect(dataReads).toBe(1);

        const treeBytes = new Uint8Array(LEAF_SIZE + 1);
        treeBytes[0] = 4;
        treeBytes[LEAF_SIZE] = 5;
        const fixture = buildFixture(treeBytes);
        const treeHash = fixture.root.rootHash!;
        const tree = fixture.source.blocks.get(
            blockKey("tree", 1, treeHash)
        ) as MerkleTreeBlockV1;
        const children = tree.children;
        let childrenReads = 0;
        Object.defineProperty(tree, "children", {
            configurable: true,
            get() {
                childrenReads++;
                return childrenReads === 1
                    ? children
                    : new Array(MERKLE_V1_FANOUT + 1).fill(children[0]);
            },
        });
        const treeSession = new MerkleReadSessionV1({
            root: fixture.root,
            source: fixture.source,
        });
        expectBytes(await treeSession.read(0, 1), treeBytes.slice(0, 1));
        expect(childrenReads).toBe(1);
    });

    it("validates EOF inside a referenced boundary subtree", async () => {
        const source = new MemoryBlockSource();
        const data = new MerkleDataBlockV1({ bytes: Uint8Array.of(1) });
        const dataHash = source.putData(data);
        const invalidBoundary = new MerkleTreeBlockV1({
            level: 1,
            bitmap: merkleV1BitmapFromSlots([1]),
            children: [dataHash],
        });
        const boundaryHash = source.putTree(invalidBoundary);
        const rootTree = new MerkleTreeBlockV1({
            level: 2,
            bitmap: merkleV1BitmapFromSlots([1]),
            children: [boundaryHash],
        });
        const rootHash = source.putTree(rootTree);
        const size = BigInt(256 * LEAF_SIZE + 1);
        const session = new MerkleReadSessionV1({
            root: {
                leafSize: LEAF_SIZE,
                size,
                rootLevel: 2,
                rootHash,
            },
            source,
        });

        await expectEio(session.read(256 * LEAF_SIZE, 1));
    });

    it("copies mutable loader blocks and never exposes cached storage", async () => {
        const bytes = new Uint8Array(91);
        for (let index = 0; index < bytes.length; index++)
            bytes[index] = index + 1;
        const fixture = buildFixture(bytes);
        const dataHash = fixture.root.rootHash!;
        const data = fixture.source.blocks.get(
            blockKey("data", 0, dataHash)
        ) as MerkleDataBlockV1;
        const session = new MerkleReadSessionV1({
            root: fixture.root,
            source: {
                async load(reference) {
                    reference.hash.fill(0);
                    return data;
                },
            },
        });

        const first = await session.read(0, bytes.length);
        expectBytes(first, bytes);
        data.bytes.fill(0xff);
        data.id = "mutated-after-verification";
        first.fill(0);
        expectBytes(await session.read(0, bytes.length), bytes);
        expect(session.stats()).toMatchObject({
            sourceFetches: 1,
            dataCacheHits: 1,
        });
        expect(Object.isFrozen(session.stats())).toBe(true);

        const treeBytes = new Uint8Array(LEAF_SIZE + 1);
        treeBytes[0] = 17;
        treeBytes[LEAF_SIZE] = 23;
        const treeFixture = buildFixture(treeBytes);
        const treeHash = treeFixture.root.rootHash!;
        const tree = treeFixture.source.blocks.get(
            blockKey("tree", 1, treeHash)
        ) as MerkleTreeBlockV1;
        const treeSession = new MerkleReadSessionV1({
            root: treeFixture.root,
            source: treeFixture.source,
        });
        expectBytes(await treeSession.read(0, 1), treeBytes.slice(0, 1));
        tree.bitmap.fill(0);
        tree.children.length = 0;
        tree.id = "mutated-after-verification";
        expectBytes(
            await treeSession.read(LEAF_SIZE, 1),
            treeBytes.slice(LEAF_SIZE)
        );
        expect(treeSession.stats().treeCacheHits).toBe(1);
    });

    it("enforces entry and byte bounds with true LRU eviction", async () => {
        const bytes = new Uint8Array(3 * LEAF_SIZE);
        bytes.fill(1, 0, LEAF_SIZE);
        bytes.fill(2, LEAF_SIZE, 2 * LEAF_SIZE);
        bytes.fill(3, 2 * LEAF_SIZE);
        const fixture = buildFixture(bytes);
        const session = new MerkleReadSessionV1({
            root: fixture.root,
            source: fixture.source,
            cache: {
                treeEntries: 1,
                treeBytes: 9_000,
                dataEntries: 2,
                dataBytes: 2 * LEAF_SIZE,
            },
        });

        await session.read(0, 1);
        await session.read(LEAF_SIZE, 1);
        await session.read(0, 1); // refresh leaf zero
        await session.read(2 * LEAF_SIZE, 1); // evict leaf one
        expect(session.stats()).toMatchObject({
            cachedTreeBlocks: 1,
            cachedDataBlocks: 2,
            cachedDataBytes: 2 * LEAF_SIZE,
        });
        const before = session.stats().sourceFetches;
        await session.read(LEAF_SIZE, 1);
        expect(session.stats().sourceFetches).toBe(before + 1);

        const uncached = new MerkleReadSessionV1({
            root: fixture.root,
            source: fixture.source,
            cache: {
                treeEntries: 0,
                treeBytes: 0,
                dataEntries: 3,
                dataBytes: LEAF_SIZE - 1,
            },
        });
        await uncached.read(0, 1);
        expect(uncached.stats()).toMatchObject({
            cachedTreeBlocks: 0,
            cachedTreeBytes: 0,
            cachedDataBlocks: 0,
            cachedDataBytes: 0,
        });
    });

    it("coalesces concurrent loads while one caller aborts independently", async () => {
        const bytes = Uint8Array.of(10, 20, 30, 40);
        const fixture = buildFixture(bytes);
        const block = fixture.source.blocks.values().next().value;
        let resolveLoad!: (value: unknown) => void;
        let sourceSignal!: AbortSignal;
        let loads = 0;
        const source: MerkleBlockSourceV1 = {
            load(_reference, options) {
                loads++;
                sourceSignal = options.signal;
                return new Promise((resolve) => {
                    resolveLoad = resolve;
                });
            },
        };
        const session = new MerkleReadSessionV1({ root: fixture.root, source });
        const aborter = new AbortController();
        const abandoned = session.read(0, bytes.length, {
            signal: aborter.signal,
        });
        const surviving = session.read(0, bytes.length);
        await nextTurn();
        expect(loads).toBe(1);
        aborter.abort("caller stopped");
        await expect(abandoned).rejects.toMatchObject({
            name: "AbortError",
            code: "ABORT_ERR",
        });
        expect(sourceSignal.aborted).toBe(false);
        resolveLoad(block);
        expectBytes(await surviving, bytes);
        expect(session.stats()).toMatchObject({
            sourceFetches: 1,
            coalescedFetches: 1,
            inFlightFetches: 0,
        });
    });

    it("aborts an unobservant source promptly on close and never caches late data", async () => {
        const bytes = Uint8Array.of(1, 2, 3);
        const fixture = buildFixture(bytes);
        const block = fixture.source.blocks.values().next().value;
        let resolveLoad!: (value: unknown) => void;
        let sourceSignal!: AbortSignal;
        const source: MerkleBlockSourceV1 = {
            load(_reference, options) {
                sourceSignal = options.signal;
                return new Promise((resolve) => {
                    resolveLoad = resolve;
                });
            },
        };
        const session = new MerkleReadSessionV1({ root: fixture.root, source });
        const pending = session.read(0, bytes.length);
        await nextTurn();
        session.close();
        expect(sourceSignal.aborted).toBe(true);
        await expect(pending).rejects.toMatchObject({ code: "ECLOSED" });
        resolveLoad(block);
        await nextTurn();
        expect(session.stats()).toMatchObject({
            closed: true,
            inFlightFetches: 0,
            cachedDataBlocks: 0,
            cachedTreeBlocks: 0,
        });
        await expect(session.read(0, 1)).rejects.toMatchObject({
            code: "ECLOSED",
        });
        session.close();
    });

    it("registers a fetch before a loader can close the session reentrantly", async () => {
        const bytes = Uint8Array.of(1, 2, 3);
        const fixture = buildFixture(bytes);
        let sourceSignal!: AbortSignal;
        let session!: MerkleReadSessionV1;
        const source: MerkleBlockSourceV1 = {
            load(_reference, options) {
                sourceSignal = options.signal;
                session.close();
                return new Promise(() => undefined);
            },
        };
        session = new MerkleReadSessionV1({ root: fixture.root, source });

        await expect(
            within(session.read(0, bytes.length))
        ).rejects.toMatchObject({ code: "ECLOSED" });
        expect(sourceSignal.aborted).toBe(true);
        expect(session.stats()).toMatchObject({
            closed: true,
            inFlightFetches: 0,
            cachedDataBlocks: 0,
            cachedTreeBlocks: 0,
        });
    });

    it("aborts a source when its final waiter leaves and permits a clean retry", async () => {
        const bytes = Uint8Array.of(5, 6, 7);
        const fixture = buildFixture(bytes);
        const block = fixture.source.blocks.values().next().value;
        let firstResolve!: (value: unknown) => void;
        let firstSignal!: AbortSignal;
        let loads = 0;
        const source: MerkleBlockSourceV1 = {
            load(_reference, options) {
                loads++;
                if (loads === 1) {
                    firstSignal = options.signal;
                    return new Promise((resolve) => {
                        firstResolve = resolve;
                    });
                }
                return Promise.resolve(block);
            },
        };
        const session = new MerkleReadSessionV1({ root: fixture.root, source });
        const controller = new AbortController();
        const first = session.read(0, 1, { signal: controller.signal });
        await nextTurn();
        controller.abort();
        await expect(first).rejects.toMatchObject({ code: "ABORT_ERR" });
        expect(firstSignal.aborted).toBe(true);
        firstResolve(block);
        await nextTurn();
        expect(session.stats().cachedDataBlocks).toBe(0);
        expectBytes(await session.read(0, bytes.length), bytes);
        expect(loads).toBe(2);
    });

    it("does not cache failures and retries a formerly missing block", async () => {
        const bytes = Uint8Array.of(8, 9);
        const fixture = buildFixture(bytes);
        const block = fixture.source.blocks.values().next().value;
        let loads = 0;
        const session = new MerkleReadSessionV1({
            root: fixture.root,
            source: {
                async load() {
                    loads++;
                    return loads === 1 ? undefined : block;
                },
            },
        });
        await expectEio(session.read(0, 1));
        expectBytes(await session.read(0, 2), bytes);
        expect(loads).toBe(2);
    });

    it("rejects invalid roots, ranges, resource bounds, and oversized reads", async () => {
        const source = new MemoryBlockSource();
        expect(
            () =>
                new MerkleReadSessionV1({
                    root: {
                        leafSize: LEAF_SIZE,
                        size: BigInt(LEAF_SIZE + 1),
                        rootLevel: 0,
                    },
                    source,
                })
        ).toThrowError(MerkleReadSessionErrorV1);
        expect(
            () =>
                new MerkleReadSessionV1({
                    root: {
                        leafSize: LEAF_SIZE,
                        size: 0,
                        rootLevel: 0,
                    },
                    source,
                    cache: { dataBytes: -1 },
                })
        ).toThrow(/cache\.dataBytes/);
        expect(
            () =>
                new MerkleReadSessionV1({
                    root: {
                        leafSize: LEAF_SIZE,
                        size: 0,
                        rootLevel: 0,
                    },
                    source,
                    maxReadBytes:
                        MERKLE_READ_SESSION_V1_ABSOLUTE_MAX_READ_BYTES + 1,
                })
        ).toThrow(/maxReadBytes must not exceed/);

        const session = new MerkleReadSessionV1({
            root: {
                leafSize: LEAF_SIZE,
                size: 0,
                rootLevel: 0,
            },
            source,
            maxReadBytes: 16,
        });
        await expect(session.read(-1, 1)).rejects.toMatchObject({
            code: "EINVAL",
        });
        await expect(session.read(0, -1)).rejects.toMatchObject({
            code: "EINVAL",
        });
        await expect(session.read(0, 17)).rejects.toMatchObject({
            code: "EINVAL",
        });
        await expect(
            session.read(Number.MAX_SAFE_INTEGER + 1, 1)
        ).rejects.toMatchObject({
            code: "EINVAL",
        });
        await expect(session.read(1n << 64n, 1)).rejects.toMatchObject({
            code: "EINVAL",
        });
    });
});
