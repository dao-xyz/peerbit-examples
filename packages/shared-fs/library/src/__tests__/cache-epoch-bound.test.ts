import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import { parkNextRowQuery } from "./cache-race-park.js";

const TEST_CACHE_NODE_LIMIT = 20;

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

describe("shared fs cache epoch bounds", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;
    let program: any;
    let originalCacheNodeLimit: number;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({ peerbit: peer, machineLabel: "epoch-bound" });
        program = fs.program;
        originalCacheNodeLimit = program.constructor.CACHE_NODE_LIMIT;
        program.constructor.CACHE_NODE_LIMIT = TEST_CACHE_NODE_LIMIT;
    });

    afterEach(async () => {
        program.constructor.CACHE_NODE_LIMIT = originalCacheNodeLimit;
        try {
            await peer.stop();
        } catch (error) {
            if (
                !(
                    error instanceof TypeError &&
                    error.message.includes("clearAll")
                )
            ) {
                throw error;
            }
        }
    });

    it("rejects a stale fill when pruning reuses its missing local epoch", async () => {
        await fs.writeFile("/f.txt", "v1");
        const nodeId = (await program.resolvePath("/f.txt")).nodeId;
        program.versionRowCache.clear();
        program.cacheEpochs.clear();

        const generationBefore = program.cacheGlobalEpoch;
        const { release, parkedReached } = parkNextRowQuery(program);
        const fill = program.headsForNodes([nodeId]);
        await parkedReached;

        // The fill captured generation:N / local:0 with a v1 snapshot.
        // Publish v2, then make that newly created local counter the oldest
        // entry evicted by epoch-map pruning. Without the global generation
        // bump, the fill would see local zero again and install stale v1.
        await fs.writeFile("/f.txt", "v2");
        await new Promise((resolve) => setTimeout(resolve, 50));
        const changedEpoch = program.cacheEpochs.get(nodeId);
        expect(changedEpoch).toBeGreaterThan(0);
        // Remove unrelated listener bookkeeping and make the changed node
        // deterministically first in Map eviction order.
        program.cacheEpochs = new Map([[nodeId, changedEpoch]]);
        program.versionRowCache.delete(nodeId);
        for (let i = 0; i < TEST_CACHE_NODE_LIMIT; i++) {
            program.bumpEpoch(`churn-${i}`);
        }

        expect(program.cacheEpochs.has(nodeId)).toBe(false);
        expect(program.cacheGlobalEpoch).toBeGreaterThan(generationBefore);
        release();
        await fill;

        expect(program.versionRowCache.has(nodeId)).toBe(false);
        expect(decode(await fs.readFile("/f.txt"))).toBe("v2");
    });

    it("rejects an old public-list fill that completes after close and reopen", async () => {
        await fs.mkdir("/dir");
        await fs.writeFile("/dir/old.txt", "old");

        const reopen = async (machineLabel: string) => {
            const reopened = await (peer as any).open(program, {
                existing: "reuse",
                args: {
                    machineLabel,
                    allowPartialWrites: true,
                    addressOpen: true,
                    bootstrap: false,
                    gc: false,
                },
            });
            expect(reopened).toBe(program);
        };

        // Reopen once so persisted rows begin with missing per-node epochs,
        // exactly as they do when entries.open ingests them before the cache
        // listener is registered. Warm only path resolution; the directory's
        // child sweep remains cold for the parked public list below.
        await program.close();
        await reopen("epoch-bound-before-park");
        const directory = await fs.stat("/dir");
        expect(directory?.kind).toBe("directory");
        const parentId = directory!.nodeId;
        expect(program.slotSweepCache.has(parentId)).toBe(false);
        expect(program.cacheEpochs.get(`slot:${parentId}`)).toBeUndefined();

        const capturedGeneration = program.cacheGlobalEpoch;
        const { release, parkedReached } = parkNextRowQuery(program);
        const staleList = fs.list("/dir");
        await parkedReached;

        // The parked sweep has only old.txt. Publish another child, then
        // replace every cache during a real same-instance reopen before the
        // old query is allowed to finish.
        await fs.writeFile("/dir/new.txt", "new");
        await program.close();
        await reopen("epoch-bound-after-park");
        expect(program.cacheGlobalEpoch).toBeGreaterThan(capturedGeneration);
        expect(program.slotSweepCache.has(parentId)).toBe(false);

        release();
        expect((await staleList).map((entry) => entry.name)).toEqual([
            "old.txt",
        ]);
        // The old fill may return its snapshot to its original caller, but
        // it must not populate the freshly opened program's sweep cache.
        expect(program.slotSweepCache.has(parentId)).toBe(false);
        expect((await fs.list("/dir")).map((entry) => entry.name).sort()).toEqual(
            ["new.txt", "old.txt"]
        );
    });

    it("keeps epoch metadata bounded under high-cardinality churn", () => {
        program.constructor.CACHE_NODE_LIMIT = originalCacheNodeLimit;
        const generationBefore = program.cacheGlobalEpoch;
        let largestObservedSize = 0;
        for (let i = 0; i < originalCacheNodeLimit * 2; i++) {
            program.bumpEpoch(`unique-node-${i}`);
            largestObservedSize = Math.max(
                largestObservedSize,
                program.cacheEpochs.size
            );
        }

        expect(largestObservedSize).toBeLessThanOrEqual(originalCacheNodeLimit);
        expect(program.cacheEpochs.size).toBeLessThanOrEqual(
            originalCacheNodeLimit
        );
        expect(program.cacheGlobalEpoch).toBeGreaterThan(generationBefore);
    });
});
