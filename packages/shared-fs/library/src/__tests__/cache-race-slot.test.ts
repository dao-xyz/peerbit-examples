import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT_NODE_ID, openSharedFs, type SharedFsHandle } from "../index.js";
import { parkNextRowQuery } from "./cache-race-park.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const waitForSlotMutation = async (program: any, previous: number) => {
    const deadline = Date.now() + 10_000;
    while (program.slotMutationEpoch === previous) {
        if (Date.now() > deadline) {
            throw new Error("timeout: naming cache event");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

describe("shared fs cache fill/event race (directory slots)", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({ peerbit: peer, machineLabel: "slot-race" });
    });

    afterEach(async () => {
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

    it("never installs a stale name index over a racing create", async () => {
        await fs.writeFile("/stable.txt", "stable");
        const program: any = fs.program;
        program.slotSweepCache.clear();

        const mutationEpoch = program.slotMutationEpoch;
        const { release, parkedReached } = parkNextRowQuery(program);
        const fill = program.slotRows(ROOT_NODE_ID, "raced.txt");
        await parkedReached;
        await fs.writeFile("/raced.txt", "new");
        await waitForSlotMutation(program, mutationEpoch);
        release();
        await fill;

        program.slotCandidateRowsExamined = 0;
        expect(decode(await fs.readFile("/raced.txt"))).toBe("new");
        expect(program.slotCandidateRowsExamined).toBe(1);
    });

    it("never installs a stale name index over a racing GC removal", async () => {
        await fs.writeFile("/removed.txt", "removed");
        const program: any = fs.program;
        const nodeId = (await fs.stat("/removed.txt"))!.nodeId;
        const naming = (await program.namingStateForNode(nodeId)).winner;
        program.slotSweepCache.clear();
        program.slotPlacementById.clear();

        const mutationEpoch = program.slotMutationEpoch;
        const { release, parkedReached } = parkNextRowQuery(program);
        const fill = program.slotRows(ROOT_NODE_ID, "removed.txt");
        await parkedReached;
        // Model a collector-owned removal so Guard D does not intentionally
        // restore this live head while the stale pre-removal fill is parked.
        program.gcSuppressed.add(naming.id);
        try {
            await program.entries.del(naming.id);
        } finally {
            program.gcSuppressed.delete(naming.id);
        }
        await waitForSlotMutation(program, mutationEpoch);

        release();
        await fill;
        expect(program.slotSweepCache.has(ROOT_NODE_ID)).toBe(false);
        expect(await fs.stat("/removed.txt")).toBeUndefined();
        expect(await program.slotRows(ROOT_NODE_ID, "removed.txt")).toEqual([]);
    });

    it("never installs an old-generation fill after close and reopen", async () => {
        await fs.writeFile("/persisted.txt", "persisted");
        const program: any = fs.program;
        const reopen = () =>
            (peer as any).open(program, {
                existing: "reuse",
                args: {
                    machineLabel: "slot-race-reopen",
                    addressOpen: true,
                    bootstrap: false,
                    snapshot: { disabled: true },
                    gc: false,
                },
            });

        // The first reopen models a normal persisted generation: it has rows
        // in the index but fresh per-node epochs and an empty cache.
        await program.close();
        await reopen();
        const { release, parkedReached } = parkNextRowQuery(program);
        const staleFill = program.slotRows(ROOT_NODE_ID, "persisted.txt");
        await parkedReached;

        await program.close();
        await reopen();
        const currentCache = program.slotSweepCache;
        expect(currentCache.size).toBe(0);

        release();
        await staleFill;
        expect(program.slotSweepCache).toBe(currentCache);
        expect(currentCache.size).toBe(0);
        expect(decode(await fs.readFile("/persisted.txt"))).toBe("persisted");
    });

    it("rejects old-generation naming and version fills after reopen", async () => {
        await fs.writeFile("/persisted.txt", "persisted");
        const program: any = fs.program;
        const nodeId = (await fs.stat("/persisted.txt"))!.nodeId;
        const reopen = () =>
            (peer as any).open(program, {
                existing: "reuse",
                args: {
                    machineLabel: "metadata-race-reopen",
                    addressOpen: true,
                    bootstrap: false,
                    snapshot: { disabled: true },
                    gc: false,
                },
            });

        const parkAcrossReopen = async (
            startFill: () => Promise<unknown>,
            cacheName: "namingRowCache" | "versionRowCache"
        ) => {
            await program.close();
            await reopen();
            const epochBefore = program.cacheGlobalEpoch;
            const { release, parkedReached } = parkNextRowQuery(program);
            const staleFill = startFill();
            await parkedReached;

            await program.close();
            await reopen();
            const currentCache = program[cacheName];
            expect(program.cacheGlobalEpoch).toBeGreaterThan(epochBefore);
            expect(currentCache.size).toBe(0);

            release();
            await staleFill;
            expect(program[cacheName]).toBe(currentCache);
            expect(currentCache.has(nodeId)).toBe(false);
        };

        await parkAcrossReopen(
            () => program.namingStatesForNodes([nodeId]),
            "namingRowCache"
        );
        await parkAcrossReopen(
            () => program.headsForNodes([nodeId]),
            "versionRowCache"
        );
        expect(decode(await fs.readFile("/persisted.txt"))).toBe("persisted");
    });
});
