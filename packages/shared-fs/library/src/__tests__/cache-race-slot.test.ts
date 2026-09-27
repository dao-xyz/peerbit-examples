import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT_NODE_ID, openSharedFs, type SharedFsHandle } from "../index.js";
import { forcePointTier, parkNextRowQuery } from "./cache-race-park.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

/**
 * Resolves once the program has applied a change event matching `matches`.
 * Register it before the operation: the program's own listener was added at
 * open, so it runs (and updates the caches) before this one fires.
 */
const nextChange = (program: any, matches: (detail: any) => boolean) =>
    new Promise<void>((resolve) => {
        const listener = (event: any) => {
            if (!matches(event?.detail ?? {})) return;
            program.entries.events.removeEventListener("change", listener);
            resolve();
        };
        program.entries.events.addEventListener("change", listener);
    });

describe("shared fs cache fill/event race (directory slots)", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({ peerbit: peer, machineLabel: "slot-race" });
        // These races target the point tier and sweep fills directly.
        forcePointTier(fs.program);
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

    it("never installs a stale directory sweep over a racing create", async () => {
        await fs.writeFile("/stable.txt", "stable");
        const program: any = fs.program;
        program.slotSweepCache.clear();
        program.slotPointCache.clear();
        // Known wide, so the concurrent create resolves its own absent slot
        // with an exact query rather than caching a (fresh) listing itself.
        program.slotPointCache.markWide(ROOT_NODE_ID);

        const { release, parkedReached } = parkNextRowQuery(program);
        // Park a full sweep: the concurrent create resolves its own absent
        // slot with an exact query, so it cannot wait on this barrier.
        const fill = program.sweepRows(ROOT_NODE_ID);
        await parkedReached;
        // The local write applies its cache change before writeFile returns.
        await fs.writeFile("/raced.txt", "new");
        release();
        expect((await fill).map((row: any) => row.name)).toEqual([
            "stable.txt",
        ]);
        expect(program.slotSweepCache.has(ROOT_NODE_ID)).toBe(false);

        expect(decode(await fs.readFile("/raced.txt"))).toBe("new");
        expect((await fs.list("/")).map((entry) => entry.name).sort()).toEqual([
            "raced.txt",
            "stable.txt",
        ]);
    });

    it("never installs a stale point slot over a racing GC removal", async () => {
        await fs.writeFile("/removed.txt", "removed");
        const program: any = fs.program;
        const nodeId = (await fs.stat("/removed.txt"))!.nodeId;
        const naming = (await program.namingStateForNode(nodeId)).winner;
        // The race under test is the point slot's; keep root off the
        // listing tier (a narrow root is otherwise read and cached whole).
        program.slotSweepCache.clear();
        program.slotPointCache.clear();
        program.slotPointCache.markWide(ROOT_NODE_ID);
        expect(program.slotSweepCache.has(ROOT_NODE_ID)).toBe(false);

        const { release, parkedReached } = parkNextRowQuery(program);
        const fill = program.slotRows(ROOT_NODE_ID, "removed.txt");
        await parkedReached;
        // Model a collector-owned removal so Guard D does not intentionally
        // restore this live head while the stale pre-removal fill is parked.
        const removed = nextChange(program, (detail) =>
            (detail.removed ?? []).some((value: any) => value?.id === naming.id)
        );
        program.gcSuppressed.add(naming.id);
        try {
            await program.entries.del(naming.id);
            await removed;
        } finally {
            program.gcSuppressed.delete(naming.id);
        }

        release();
        expect((await fill).map((row: any) => row.id)).toEqual([naming.id]);
        expect(
            program.slotPointCache.getSlot(ROOT_NODE_ID, "removed.txt")
        ).toBeUndefined();
        expect(await fs.stat("/removed.txt")).toBeUndefined();
        expect(await program.slotRows(ROOT_NODE_ID, "removed.txt")).toEqual([]);
    });

    it("never installs an old-generation point fill after close and reopen", async () => {
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
        // in the index but fresh per-node epochs and empty caches.
        await program.close();
        await reopen();
        const { release, parkedReached } = parkNextRowQuery(program);
        const staleFill = program.slotRows(ROOT_NODE_ID, "persisted.txt");
        await parkedReached;

        await program.close();
        await reopen();
        const currentCache = program.slotPointCache;
        expect(currentCache.snapshot().entries).toBe(0);

        release();
        await staleFill;
        expect(program.slotPointCache).toBe(currentCache);
        expect(currentCache.snapshot().entries).toBe(0);
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
