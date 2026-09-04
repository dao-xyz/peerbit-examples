import { describe, expect, it } from "vitest";
import {
    MERKLE_PATCH_BUILDER_V1_ABSOLUTE_LIMITS,
    MerklePatchBuilderErrorV1,
    MerklePatchBuilderV1,
    type MerkleBlockSinkV1,
} from "../merkle-patch-builder-v1.js";
import {
    MerkleReadSessionV1,
    type MerkleBlockSourceV1,
} from "../merkle-read-session-v1.js";
import {
    MERKLE_V1_FANOUT,
    MerkleDataBlockV1,
    MerkleTreeBlockV1,
    merkleDataHashV1,
    merkleRootLevelV1,
    merkleTreeHashV1,
    merkleV1BitmapFromSlots,
    merkleV1BitmapSlots,
    type MerkleRootDescriptorV1,
    type MerkleV1LeafSize,
} from "../merkle-v1.js";

const LEAF_SIZE = 65_536 as const;
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const blockKey = (kind: "data" | "tree", level: number, hash: Uint8Array) =>
    `${kind}:${level}:${hex(hash)}`;

const cloneBlock = (block: MerkleDataBlockV1 | MerkleTreeBlockV1) =>
    block instanceof MerkleDataBlockV1
        ? new MerkleDataBlockV1({ bytes: block.bytes })
        : new MerkleTreeBlockV1({
              level: block.level,
              bitmap: block.bitmap,
              children: block.children,
          });

class MemoryBlocks implements MerkleBlockSourceV1, MerkleBlockSinkV1 {
    readonly blocks = new Map<string, MerkleDataBlockV1 | MerkleTreeBlockV1>();
    readonly loads: Array<{ kind: "data" | "tree"; level: number }> = [];
    readonly puts: Array<{ kind: "data" | "tree"; level: number }> = [];
    failPutAt = 0;

    async load(reference: {
        hash: Uint8Array;
        kind: "data" | "tree";
        level: number;
    }) {
        this.loads.push({ kind: reference.kind, level: reference.level });
        return this.blocks.get(
            blockKey(reference.kind, reference.level, reference.hash)
        );
    }

    async put(block: MerkleDataBlockV1 | MerkleTreeBlockV1) {
        const kind = block instanceof MerkleDataBlockV1 ? "data" : "tree";
        const level = kind === "data" ? 0 : block.level;
        this.puts.push({ kind, level });
        if (this.failPutAt > 0 && this.puts.length === this.failPutAt) {
            throw new Error("injected sink failure");
        }
        const hash =
            block instanceof MerkleDataBlockV1
                ? merkleDataHashV1(block.bytes)
                : merkleTreeHashV1(block.level, block.bitmap, block.children);
        this.blocks.set(blockKey(kind, level, hash), cloneBlock(block));
    }

    putFixture(block: MerkleDataBlockV1 | MerkleTreeBlockV1) {
        const kind = block instanceof MerkleDataBlockV1 ? "data" : "tree";
        const level = kind === "data" ? 0 : block.level;
        const hash =
            block instanceof MerkleDataBlockV1
                ? merkleDataHashV1(block.bytes)
                : merkleTreeHashV1(block.level, block.bitmap, block.children);
        this.blocks.set(blockKey(kind, level, hash), cloneBlock(block));
        return hash;
    }
}

const allZero = (bytes: Uint8Array) => {
    for (const byte of bytes) if (byte !== 0) return false;
    return true;
};

const buildFixture = (
    bytesValue: Uint8Array,
    store = new MemoryBlocks(),
    leafSize: MerkleV1LeafSize = LEAF_SIZE
) => {
    const bytes = new Uint8Array(bytesValue);
    const leafCount = Math.ceil(bytes.length / leafSize);
    let hashes = new Map<number, Uint8Array>();
    for (let leaf = 0; leaf < leafCount; leaf++) {
        const value = bytes.slice(
            leaf * leafSize,
            Math.min(bytes.length, (leaf + 1) * leafSize)
        );
        if (!allZero(value)) {
            hashes.set(
                leaf,
                store.putFixture(new MerkleDataBlockV1({ bytes: value }))
            );
        }
    }
    const rootLevel = merkleRootLevelV1(bytes.length, leafSize);
    for (let level = 1; level <= rootLevel; level++) {
        const groups = new Map<
            number,
            Array<{ slot: number; hash: Uint8Array }>
        >();
        for (const [childIndex, hash] of hashes) {
            const parentIndex = Math.floor(childIndex / MERKLE_V1_FANOUT);
            const group = groups.get(parentIndex) ?? [];
            group.push({
                slot: childIndex % MERKLE_V1_FANOUT,
                hash,
            });
            groups.set(parentIndex, group);
        }
        hashes = new Map();
        for (const [parentIndex, group] of groups) {
            group.sort((left, right) => left.slot - right.slot);
            hashes.set(
                parentIndex,
                store.putFixture(
                    new MerkleTreeBlockV1({
                        level,
                        bitmap: merkleV1BitmapFromSlots(
                            group.map(({ slot }) => slot)
                        ),
                        children: group.map(({ hash }) => hash),
                    })
                )
            );
        }
    }
    const root: MerkleRootDescriptorV1 = {
        leafSize,
        size: BigInt(bytes.length),
        rootLevel,
        rootHash: hashes.get(0),
    };
    return { bytes, root, store };
};

const expectBytes = (actual: Uint8Array, expected: Uint8Array) => {
    expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0);
};

const readAll = async (
    root: Readonly<MerkleRootDescriptorV1>,
    store: MemoryBlocks
) => {
    const size = Number(root.size);
    const session = new MerkleReadSessionV1({
        root,
        source: store,
        maxReadBytes: Math.max(size, 1),
    });
    try {
        return await session.read(0, size);
    } finally {
        session.close();
    }
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

describe("MerklePatchBuilderV1", () => {
    it("builds sparse growth from an authenticated zero root", async () => {
        const store = new MemoryBlocks();
        const targetSize = 3 * LEAF_SIZE + 17;
        const expected = new Uint8Array(targetSize);
        const first = Uint8Array.of(1, 2, 3, 4);
        const last = Uint8Array.of(8, 9, 10);
        expected.set(first, LEAF_SIZE - 2);
        expected.set(last, 3 * LEAF_SIZE + 7);

        const result = await new MerklePatchBuilderV1({
            root: { leafSize: LEAF_SIZE, size: 0n, rootLevel: 0 },
            source: store,
            sink: store,
        }).build({
            size: targetSize,
            patches: [
                { offset: LEAF_SIZE - 2, bytes: first },
                { offset: 3 * LEAF_SIZE + 7, bytes: last },
            ],
        });

        expect(result.root).toMatchObject({
            size: BigInt(targetSize),
            rootLevel: 1,
        });
        expectBytes(await readAll(result.root, store), expected);
        expect(result.stats).toMatchObject({
            phase: "complete",
            patchCount: 2,
            changedLeavesPlanned: 3,
            leafHashesChanged: 3,
            dataBlocksWritten: 3,
            treeBlocksWritten: 1,
            sourceFetches: 0,
        });
        expect(store.puts.at(-1)).toEqual({ kind: "tree", level: 1 });
    });

    it("represents pure sparse growth without fetching or writing blocks", async () => {
        const store = new MemoryBlocks();
        const size = 300n * BigInt(LEAF_SIZE) + 7n;
        const result = await new MerklePatchBuilderV1({
            root: { leafSize: LEAF_SIZE, size: 0n, rootLevel: 0 },
            source: store,
            sink: store,
        }).build({ size });

        expect(result.root).toMatchObject({
            size,
            rootLevel: 2,
            rootHash: undefined,
        });
        expect(result.stats).toMatchObject({
            changedLeavesPlanned: 0,
            sourceFetches: 0,
            sinkPuts: 0,
        });
        const session = new MerkleReadSessionV1({
            root: result.root,
            source: store,
            maxReadBytes: 128,
        });
        expect(await session.read(size - 128n, 128)).toEqual(
            new Uint8Array(128)
        );
    });

    it("deduplicates identical new content-addressed sink puts", async () => {
        const store = new MemoryBlocks();
        const leaf = new Uint8Array(LEAF_SIZE).fill(5);
        const input = new Uint8Array(2 * LEAF_SIZE);
        input.set(leaf, 0);
        input.set(leaf, LEAF_SIZE);
        const result = await new MerklePatchBuilderV1({
            root: { leafSize: LEAF_SIZE, size: 0n, rootLevel: 0 },
            source: store,
            sink: store,
        }).build({ patches: [{ offset: 0, bytes: input }] });

        expect(result.stats).toMatchObject({
            changedLeavesPlanned: 2,
            dataBlocksCreated: 2,
            dataBlocksWritten: 1,
            duplicateSinkPutsAvoided: 1,
            treeBlocksWritten: 1,
        });
        expectBytes(await readAll(result.root, store), input);
    });

    it("path-copies only changed branches and reuses an untouched subtree", async () => {
        const bytes = new Uint8Array(257 * LEAF_SIZE);
        bytes[0] = 1;
        bytes[11 * LEAF_SIZE] = 2;
        bytes[256 * LEAF_SIZE] = 3;
        const fixture = buildFixture(bytes);
        const oldRoot = fixture.store.blocks.get(
            blockKey("tree", 2, fixture.root.rootHash!)
        ) as MerkleTreeBlockV1;
        const oldRootSlots = merkleV1BitmapSlots(oldRoot.bitmap);
        const untouchedHash = oldRoot.children[oldRootSlots.indexOf(1)];

        const result = await new MerklePatchBuilderV1({
            root: fixture.root,
            source: fixture.store,
            sink: fixture.store,
        }).build({ patches: [{ offset: 7, bytes: Uint8Array.of(77) }] });
        bytes[7] = 77;

        const newRoot = fixture.store.blocks.get(
            blockKey("tree", 2, result.root.rootHash!)
        ) as MerkleTreeBlockV1;
        const newRootSlots = merkleV1BitmapSlots(newRoot.bitmap);
        expectBytes(newRoot.children[newRootSlots.indexOf(1)], untouchedHash);
        expectBytes(await readAll(result.root, fixture.store), bytes);
        expect(result.stats).toMatchObject({
            changedLeavesPlanned: 1,
            sourceFetches: 3,
            treeBlocksVerified: 2,
            dataBlocksVerified: 1,
            sourceDataBytesVerified: LEAF_SIZE,
            newDataBytesHashed: 3 * LEAF_SIZE,
            dataBlocksWritten: 1,
            treeBlocksWritten: 2,
        });
        expect(result.stats.treeCacheHits).toBeGreaterThanOrEqual(2);
    });

    it("scales tree work with distinct changed paths rather than file size", async () => {
        const bytes = new Uint8Array(513 * LEAF_SIZE);
        bytes[0] = 1;
        bytes[1 * LEAF_SIZE] = 2;
        bytes[256 * LEAF_SIZE] = 3;
        bytes[512 * LEAF_SIZE] = 4;
        const firstFixture = buildFixture(bytes);
        expect(firstFixture.root.rootLevel).toBe(2);

        const sameBranch = await new MerklePatchBuilderV1({
            root: firstFixture.root,
            source: firstFixture.store,
            sink: firstFixture.store,
        }).build({
            patches: [
                { offset: 1, bytes: Uint8Array.of(10) },
                { offset: LEAF_SIZE + 1, bytes: Uint8Array.of(20) },
            ],
        });
        expect(sameBranch.stats).toMatchObject({
            changedLeavesPlanned: 2,
            sourceFetches: 4,
            treeBlocksVerified: 2,
            dataBlocksVerified: 2,
            treeBlocksWritten: 2,
        });

        const secondFixture = buildFixture(bytes);
        const splitBranches = await new MerklePatchBuilderV1({
            root: secondFixture.root,
            source: secondFixture.store,
            sink: secondFixture.store,
        }).build({
            patches: [
                { offset: 1, bytes: Uint8Array.of(10) },
                { offset: 256 * LEAF_SIZE + 1, bytes: Uint8Array.of(30) },
            ],
        });
        expect(splitBranches.stats).toMatchObject({
            changedLeavesPlanned: 2,
            sourceFetches: 5,
            treeBlocksVerified: 3,
            dataBlocksVerified: 2,
            treeBlocksWritten: 3,
        });
    });

    it("bounds and releases the verified tree cache", async () => {
        const bytes = new Uint8Array(257 * LEAF_SIZE);
        bytes[0] = 1;
        bytes[256 * LEAF_SIZE] = 2;
        const fixture = buildFixture(bytes);
        const result = await new MerklePatchBuilderV1({
            root: fixture.root,
            source: fixture.store,
            sink: fixture.store,
            limits: {
                maxTreeCacheEntries: 1,
                maxTreeCacheBytes: 9_000,
            },
        }).build({
            patches: [
                { offset: 1, bytes: Uint8Array.of(3) },
                { offset: 256 * LEAF_SIZE, bytes: Uint8Array.of(4) },
            ],
        });
        bytes[1] = 3;
        bytes[256 * LEAF_SIZE] = 4;

        expect(result.stats.treeCacheEvictions).toBeGreaterThan(0);
        expect(result.stats.cachedTreeBlocks).toBe(0);
        expect(result.stats.cachedTreeBytes).toBe(0);
        expectBytes(await readAll(result.root, fixture.store), bytes);
    });

    it("grows, truncates, lowers root height, and collapses zero paths", async () => {
        const bytes = new Uint8Array(258 * LEAF_SIZE + 9);
        bytes[0] = 1;
        bytes[255 * LEAF_SIZE] = 2;
        bytes[256 * LEAF_SIZE] = 3;
        bytes[bytes.length - 1] = 4;
        const fixture = buildFixture(bytes);
        expect(fixture.root.rootLevel).toBe(2);

        const boundarySize = 256 * LEAF_SIZE;
        const truncated = await new MerklePatchBuilderV1({
            root: fixture.root,
            source: fixture.store,
            sink: fixture.store,
        }).build({ size: boundarySize });
        expect(truncated.root.rootLevel).toBe(1);
        expect(truncated.stats.treeBlocksWritten).toBe(0);
        expectBytes(
            await readAll(truncated.root, fixture.store),
            bytes.slice(0, boundarySize)
        );

        const partialSize = 255 * LEAF_SIZE + 5;
        const partial = await new MerklePatchBuilderV1({
            root: truncated.root,
            source: fixture.store,
            sink: fixture.store,
        }).build({ size: partialSize });
        expectBytes(
            await readAll(partial.root, fixture.store),
            bytes.slice(0, partialSize)
        );
        expect(partial.stats.dataBlocksWritten).toBe(1);
        expect(partial.stats.treeBlocksWritten).toBe(1);

        const zeroed = await new MerklePatchBuilderV1({
            root: partial.root,
            source: fixture.store,
            sink: fixture.store,
        }).build({
            patches: [{ offset: 0, bytes: new Uint8Array(partialSize) }],
        });
        expect(zeroed.root.rootHash).toBeUndefined();
        expect(zeroed.stats.treeNodesCollapsed).toBeGreaterThan(0);
        expectBytes(
            await readAll(zeroed.root, fixture.store),
            new Uint8Array(partialSize)
        );

        const grownSize = 257 * LEAF_SIZE + 3;
        const grown = await new MerklePatchBuilderV1({
            root: truncated.root,
            source: fixture.store,
            sink: fixture.store,
        }).build({ size: grownSize });
        const grownExpected = new Uint8Array(grownSize);
        grownExpected.set(bytes.slice(0, boundarySize));
        expect(grown.root.rootLevel).toBe(2);
        expect(grown.stats.treeBlocksWritten).toBe(1);
        expectBytes(await readAll(grown.root, fixture.store), grownExpected);
    });

    it("matches a deterministic randomized byte-buffer oracle", async () => {
        let state = 0x243f_6a88;
        const random = () => {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            return state >>> 0;
        };
        const store = new MemoryBlocks();
        let oracle = new Uint8Array();
        let root: MerkleRootDescriptorV1 = {
            leafSize: LEAF_SIZE,
            size: 0n,
            rootLevel: 0,
        };

        for (let run = 0; run < 36; run++) {
            const size = random() % (9 * LEAF_SIZE + 113);
            const resized = new Uint8Array(size);
            resized.set(oracle.subarray(0, Math.min(size, oracle.length)));
            const patches: Array<{ offset: number; bytes: Uint8Array }> = [];
            if (size > 0) {
                const candidates: Array<{
                    offset: number;
                    bytes: Uint8Array;
                }> = [];
                const candidateCount = 1 + (random() % 3);
                for (
                    let candidate = 0;
                    candidate < candidateCount;
                    candidate++
                ) {
                    const length = Math.min(size, 1 + (random() % 4_097));
                    const offset = random() % (size - length + 1);
                    const patch = new Uint8Array(length);
                    if ((random() & 3) !== 0) {
                        for (let index = 0; index < patch.length; index++) {
                            patch[index] = random() & 0xff;
                        }
                    }
                    candidates.push({ offset, bytes: patch });
                }
                candidates.sort((left, right) => left.offset - right.offset);
                let previousEnd = 0;
                for (const patch of candidates) {
                    if (patch.offset < previousEnd) continue;
                    resized.set(patch.bytes, patch.offset);
                    patches.push(patch);
                    previousEnd = patch.offset + patch.bytes.byteLength;
                }
            }
            const result = await new MerklePatchBuilderV1({
                root,
                source: store,
                sink: store,
            }).build({ size, patches });
            oracle = resized;
            root = result.root;
            expectBytes(await readAll(root, store), oracle);
            // Three <= 4097-byte patches touch at most two leaves each;
            // resize can add the old and new boundary leaves.
            expect(result.stats.changedLeavesPlanned).toBeLessThanOrEqual(8);
        }
    });

    it("matches randomized growth and truncation across a radix boundary", async () => {
        let state = 0xa409_3822;
        const random = () => {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            return state >>> 0;
        };
        const store = new MemoryBlocks();
        let oracle = new Uint8Array(257 * LEAF_SIZE + 19);
        oracle[0] = 1;
        oracle[255 * LEAF_SIZE] = 2;
        oracle[256 * LEAF_SIZE + 18] = 3;
        let root = buildFixture(oracle, store).root;

        for (let run = 0; run < 8; run++) {
            const leaves = 254 + (random() % 6);
            const size = leaves * LEAF_SIZE + (random() % 97);
            const resized = new Uint8Array(size);
            resized.set(oracle.subarray(0, Math.min(size, oracle.length)));
            const offset = random() % size;
            const length = Math.min(size - offset, 1 + (random() % 257));
            const patch = new Uint8Array(length);
            for (let index = 0; index < patch.length; index++) {
                patch[index] = random() & 0xff;
            }
            resized.set(patch, offset);
            const result = await new MerklePatchBuilderV1({
                root,
                source: store,
                sink: store,
            }).build({ size, patches: [{ offset, bytes: patch }] });
            oracle = resized;
            root = result.root;
            expect(root.rootLevel).toBe(size <= 256 * LEAF_SIZE ? 1 : 2);
            expectBytes(await readAll(root, store), oracle);
        }
    });

    it("repairs a fully overwritten payload without loading old data", async () => {
        const bytes = new Uint8Array(LEAF_SIZE + 1);
        bytes.fill(7, 0, LEAF_SIZE);
        bytes[LEAF_SIZE] = 9;
        const fixture = buildFixture(bytes);
        const rootTree = fixture.store.blocks.get(
            blockKey("tree", 1, fixture.root.rootHash!)
        ) as MerkleTreeBlockV1;
        const firstHash = rootTree.children[0];
        fixture.store.blocks.delete(blockKey("data", 0, firstHash));
        fixture.store.loads.length = 0;
        fixture.store.puts.length = 0;

        const result = await new MerklePatchBuilderV1({
            root: fixture.root,
            source: fixture.store,
            sink: fixture.store,
        }).build({
            patches: [{ offset: 0, bytes: bytes.slice(0, LEAF_SIZE) }],
        });

        expectBytes(result.root.rootHash!, fixture.root.rootHash!);
        expect(result.stats).toMatchObject({
            leafHashesReused: 1,
            dataBlocksVerified: 0,
            dataBlocksWritten: 1,
            treeBlocksWritten: 0,
        });
        expect(fixture.store.loads.every(({ kind }) => kind === "tree")).toBe(
            true
        );
        expectBytes(await readAll(result.root, fixture.store), bytes);
    });

    it("fails closed for consumed missing or corrupt base blocks", async () => {
        const bytes = new Uint8Array(LEAF_SIZE + 1);
        bytes[0] = 1;
        bytes[LEAF_SIZE] = 2;
        const missingTree = buildFixture(bytes);
        missingTree.store.blocks.delete(
            blockKey("tree", 1, missingTree.root.rootHash!)
        );
        await expect(
            new MerklePatchBuilderV1({
                root: missingTree.root,
                source: missingTree.store,
                sink: missingTree.store,
            }).build({ patches: [{ offset: 1, bytes: Uint8Array.of(3) }] })
        ).rejects.toMatchObject({ code: "EIO" });

        const corruptData = buildFixture(bytes);
        const tree = corruptData.store.blocks.get(
            blockKey("tree", 1, corruptData.root.rootHash!)
        ) as MerkleTreeBlockV1;
        const dataKey = blockKey("data", 0, tree.children[0]);
        const data = corruptData.store.blocks.get(dataKey) as MerkleDataBlockV1;
        data.bytes[0] ^= 0xff;
        await expect(
            new MerklePatchBuilderV1({
                root: corruptData.root,
                source: corruptData.store,
                sink: corruptData.store,
            }).build({ patches: [{ offset: 1, bytes: Uint8Array.of(3) }] })
        ).rejects.toMatchObject({ code: "EIO" });

        const beyondEof = buildFixture(bytes);
        const badData = new MerkleDataBlockV1({ bytes: Uint8Array.of(4) });
        const badHash = beyondEof.store.putFixture(badData);
        const badRoot = new MerkleTreeBlockV1({
            level: 1,
            bitmap: merkleV1BitmapFromSlots([2]),
            children: [badHash],
        });
        const badRootHash = beyondEof.store.putFixture(badRoot);
        await expect(
            new MerklePatchBuilderV1({
                root: { ...beyondEof.root, rootHash: badRootHash },
                source: beyondEof.store,
                sink: beyondEof.store,
            }).build({ patches: [{ offset: 1, bytes: Uint8Array.of(3) }] })
        ).rejects.toMatchObject({ code: "EIO" });
    });

    it("does not return a root after sink failure or sink mutation", async () => {
        const store = new MemoryBlocks();
        store.failPutAt = 1;
        const failed = new MerklePatchBuilderV1({
            root: { leafSize: LEAF_SIZE, size: 0n, rootLevel: 0 },
            source: store,
            sink: store,
        });
        await expect(
            failed.build({ patches: [{ offset: 0, bytes: Uint8Array.of(1) }] })
        ).rejects.toMatchObject({ code: "EIO" });
        expect(failed.stats()).toMatchObject({
            phase: "failed",
            sinkPuts: 1,
            dataBlocksWritten: 0,
        });

        const mutatingSink: MerkleBlockSinkV1 = {
            async put(block) {
                if (block instanceof MerkleDataBlockV1) block.bytes[0] ^= 1;
            },
        };
        await expect(
            new MerklePatchBuilderV1({
                root: { leafSize: LEAF_SIZE, size: 0n, rootLevel: 0 },
                source: store,
                sink: mutatingSink,
            }).build({ patches: [{ offset: 0, bytes: Uint8Array.of(1) }] })
        ).rejects.toMatchObject({ code: "EIO" });
    });

    it("copies patch bytes before awaiting storage and is one-shot", async () => {
        let release!: () => void;
        const stored = new MemoryBlocks();
        const sink: MerkleBlockSinkV1 = {
            async put(block) {
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                await stored.put(block);
            },
        };
        const input = Uint8Array.of(1, 2, 3);
        const builder = new MerklePatchBuilderV1({
            root: { leafSize: LEAF_SIZE, size: 0n, rootLevel: 0 },
            source: stored,
            sink,
        });
        const pending = builder.build({
            patches: [{ offset: 0, bytes: input }],
        });
        await nextTurn();
        input.fill(9);
        release();
        const result = await pending;
        expectBytes(await readAll(result.root, stored), Uint8Array.of(1, 2, 3));
        await expect(builder.build()).rejects.toMatchObject({
            code: "EALREADY",
        });
    });

    it("aborts an unobservant source promptly on close", async () => {
        const fixture = buildFixture(Uint8Array.of(1, 2, 3));
        const sourceBlock = fixture.store.blocks.values().next().value!;
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
        const builder = new MerklePatchBuilderV1({
            root: fixture.root,
            source,
            sink: fixture.store,
        });
        const pending = builder.build({
            patches: [{ offset: 1, bytes: Uint8Array.of(8) }],
        });
        await nextTurn();
        builder.close();
        expect(sourceSignal.aborted).toBe(true);
        await expect(within(pending)).rejects.toMatchObject({
            code: "ECLOSED",
        });
        resolveLoad(sourceBlock);
        await nextTurn();
        expect(builder.stats()).toMatchObject({
            phase: "failed",
            closed: true,
            cachedTreeBlocks: 0,
            dataBlocksWritten: 0,
        });
    });

    it("aborts an unobservant sink promptly for one caller", async () => {
        let sinkSignal!: AbortSignal;
        let resolvePut!: () => void;
        const sink: MerkleBlockSinkV1 = {
            put(_block, options) {
                sinkSignal = options.signal;
                return new Promise<void>((resolve) => {
                    resolvePut = resolve;
                });
            },
        };
        const controller = new AbortController();
        const builder = new MerklePatchBuilderV1({
            root: { leafSize: LEAF_SIZE, size: 0n, rootLevel: 0 },
            source: new MemoryBlocks(),
            sink,
        });
        const pending = builder.build({
            patches: [{ offset: 0, bytes: Uint8Array.of(1) }],
            signal: controller.signal,
        });
        await nextTurn();
        controller.abort("caller stopped");
        expect(sinkSignal.aborted).toBe(true);
        await expect(within(pending)).rejects.toMatchObject({
            name: "AbortError",
            code: "ABORT_ERR",
        });
        resolvePut();
        await nextTurn();
        expect(builder.stats()).toMatchObject({
            phase: "failed",
            dataBlocksWritten: 0,
        });
    });

    it("enforces patch, leaf, cache, range, and lifecycle bounds", async () => {
        const store = new MemoryBlocks();
        const empty: MerkleRootDescriptorV1 = {
            leafSize: LEAF_SIZE,
            size: 0n,
            rootLevel: 0,
        };
        expect(
            () =>
                new MerklePatchBuilderV1({
                    root: empty,
                    source: store,
                    sink: store,
                    limits: {
                        maxPatchBytes:
                            MERKLE_PATCH_BUILDER_V1_ABSOLUTE_LIMITS.maxPatchBytes +
                            1,
                    },
                })
        ).toThrow(/must not exceed/);
        await expect(
            new MerklePatchBuilderV1({
                root: empty,
                source: store,
                sink: store,
                limits: { maxPatches: 1 },
            }).build({
                patches: [
                    { offset: 0, bytes: Uint8Array.of(1) },
                    { offset: 1, bytes: Uint8Array.of(2) },
                ],
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            new MerklePatchBuilderV1({
                root: empty,
                source: store,
                sink: store,
            }).build({
                patches: [
                    { offset: 0, bytes: Uint8Array.of(1, 2) },
                    { offset: 1, bytes: Uint8Array.of(3) },
                ],
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            new MerklePatchBuilderV1({
                root: empty,
                source: store,
                sink: store,
            }).build({
                size: 1,
                patches: [{ offset: 1, bytes: Uint8Array.of(3) }],
            })
        ).rejects.toMatchObject({ code: "EINVAL" });
        await expect(
            new MerklePatchBuilderV1({
                root: empty,
                source: store,
                sink: store,
                limits: { maxChangedLeaves: 1 },
            }).build({
                patches: [
                    {
                        offset: LEAF_SIZE - 1,
                        bytes: Uint8Array.of(1, 2),
                    },
                ],
            })
        ).rejects.toMatchObject({ code: "EINVAL" });

        const closed = new MerklePatchBuilderV1({
            root: empty,
            source: store,
            sink: store,
        });
        closed.close();
        closed.close();
        await expect(closed.build()).rejects.toMatchObject({ code: "ECLOSED" });
        expect(Object.isFrozen(closed.stats())).toBe(true);
    });

    it("surfaces the dedicated error class", () => {
        const error = new MerklePatchBuilderErrorV1("EIO", "failure");
        expect(error).toMatchObject({
            name: "MerklePatchBuilderErrorV1",
            code: "EIO",
        });
    });
});
