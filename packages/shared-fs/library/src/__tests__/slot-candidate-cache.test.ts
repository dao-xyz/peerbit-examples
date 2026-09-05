import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    NamingEvent,
    ROOT_NODE_ID,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const waitFor = async (
    predicate: () => Promise<boolean>,
    label: string,
    timeoutMs = 10_000
) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) {
            throw new Error(`timeout: ${label}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

describe("shared fs exact slot-candidate cache", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "slot-cache",
        });
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

    it("examines only the requested histories in a wide warm directory", async () => {
        await fs.mkdir("/wide");
        await fs.writeBatch(
            Array.from({ length: 2_000 }, (_, index) => ({
                path: `/wide/entry-${String(index).padStart(5, "0")}.txt`,
                content: `value ${index}`,
            }))
        );

        const program: any = fs.program;
        program.slotCandidateRowsExamined = 0;
        for (let index = 0; index < 25; index++) {
            expect(
                (await fs.stat("/wide/entry-01000.txt"))?.nodeId
            ).toBeDefined();
        }

        // Each two-segment path examines one root-slot row and one leaf-slot
        // row. The other 1,999 leaf histories are never visited.
        expect(program.slotCandidateRowsExamined).toBe(50);
    });

    it("moves a same-id Documents replacement out of its old name", async () => {
        await fs.writeFile("/before.txt", "content");
        const originalInfo = (await fs.stat("/before.txt"))!;
        const program: any = fs.program;
        const state = await program.namingStateForNode(originalInfo.nodeId);
        const original = state.winner;

        // Warm both the parent sweep and the node history before bypassing
        // the append-only public API. Documents reports this replacement as
        // an added row, so the exact-name index must relocate the existing id.
        expect(
            (await program.slotRows(ROOT_NODE_ID, "before.txt")).map(
                (row: any) => row.id
            )
        ).toContain(original.id);
        await program.entries.put(
            new NamingEvent({
                id: original.id,
                nodeId: original.nodeId,
                parentId: original.parentId,
                name: "after.txt",
                deleted: original.deleted,
                causalDepth: original.causalDepth,
                parentNamingIds: original.parentNamingIds,
                createdAt: original.createdAt + 1n,
                authorKey: original.authorKey,
                machineLabel: original.machineLabel,
                changesetId: original.changesetId,
            })
        );

        await waitFor(
            async () =>
                (await program.slotRows(ROOT_NODE_ID, "after.txt")).some(
                    (row: any) => row.id === original.id
                ),
            "same-id naming replacement reaches the slot cache"
        );
        expect(
            (await program.slotRows(ROOT_NODE_ID, "before.txt")).some(
                (row: any) => row.id === original.id
            )
        ).toBe(false);
        expect(await fs.stat("/before.txt")).toBeUndefined();
        expect((await fs.stat("/after.txt"))?.nodeId).toBe(originalInfo.nodeId);
        expect(decode(await fs.readFile("/after.txt"))).toBe("content");
    });

    it("moves a same-id Documents replacement out of its old parent", async () => {
        await fs.mkdir("/left");
        await fs.mkdir("/right");
        await fs.writeFile("/left/moved.txt", "content");
        const left = (await fs.stat("/left"))!;
        const right = (await fs.stat("/right"))!;
        const originalInfo = (await fs.stat("/left/moved.txt"))!;
        const program: any = fs.program;
        const state = await program.namingStateForNode(originalInfo.nodeId);
        const original = state.winner;

        expect(
            (await program.slotRows(left.nodeId, "moved.txt")).map(
                (row: any) => row.id
            )
        ).toContain(original.id);
        expect(await program.slotRows(right.nodeId, "arrived.txt")).toEqual([]);
        await program.entries.put(
            new NamingEvent({
                id: original.id,
                nodeId: original.nodeId,
                parentId: right.nodeId,
                name: "arrived.txt",
                deleted: original.deleted,
                causalDepth: original.causalDepth,
                parentNamingIds: original.parentNamingIds,
                createdAt: original.createdAt + 1n,
                authorKey: original.authorKey,
                machineLabel: original.machineLabel,
                changesetId: original.changesetId,
            })
        );

        await waitFor(
            async () =>
                (await program.slotRows(right.nodeId, "arrived.txt")).some(
                    (row: any) => row.id === original.id
                ),
            "same-id naming replacement reaches its new parent cache"
        );
        expect(
            (await program.slotRows(left.nodeId, "moved.txt")).some(
                (row: any) => row.id === original.id
            )
        ).toBe(false);
        expect(await fs.stat("/left/moved.txt")).toBeUndefined();
        expect((await fs.stat("/right/arrived.txt"))?.nodeId).toBe(
            originalInfo.nodeId
        );
        expect(decode(await fs.readFile("/right/arrived.txt"))).toBe("content");
    });

    it("flattens a very large same-name history without argument fan-out", async () => {
        const program: any = fs.program;
        const repeatedRow = {
            id: "naming:large-history",
            nodeId: "file:large-history",
            parentId: ROOT_NODE_ID,
            name: "large-history",
            deleted: false,
            causalDepth: 1n,
            createdAt: 1n,
            parentNamingIds: [],
        };
        const history = Array.from({ length: 150_000 }, (_, index) => ({
            ...repeatedRow,
            id: `naming:large-history-${index}`,
        }));
        program.overlaySweep.set(
            ROOT_NODE_ID,
            new Map([[repeatedRow.name, history]])
        );
        program.bootstrapPhase = "overlay-active";

        expect(await program.sweepRows(ROOT_NODE_ID)).toHaveLength(
            history.length
        );
    });

    it("retains every claimant history through delete, restore, and move", async () => {
        await fs.writeFile("/note.txt", "first life");
        const first = (await fs.stat("/note.txt"))!;
        await fs.rm("/note.txt");
        await fs.writeFile("/note.txt", "second life");
        const second = (await fs.stat("/note.txt"))!;

        await fs.program.resolveNamingConflict(first.nodeId, {
            type: "restore",
        });
        const duplicate = (await fs.namingConflicts()).find(
            (conflict) =>
                conflict.type === "duplicate-name" &&
                conflict.path === "/note.txt"
        );
        expect(duplicate).toBeDefined();
        expect(
            new Set([duplicate!.nodeId, ...duplicate!.shadowedNodeIds!])
        ).toEqual(new Set([first.nodeId, second.nodeId]));

        const shadowed = duplicate!.shadowedNodeIds![0];
        await fs.program.resolveNamingConflict(shadowed, {
            type: "move",
            to: "/note-restored.txt",
        });

        expect(await fs.namingConflicts()).toEqual([]);
        expect(
            new Set([
                decode(await fs.readFile("/note.txt")),
                decode(await fs.readFile("/note-restored.txt")),
            ])
        ).toEqual(new Set(["first life", "second life"]));
    });

    it("unions exact overlay slots and clears them on either retirement", async () => {
        const program: any = fs.program;
        program.bootstrapPhase = "fetching";
        program.bootstrapVerified = false;
        // Warm a negative REAL-index slot first. Overlay installation does
        // not bump real-index epochs, so the later positive result proves
        // overlay rows are unioned dynamically rather than cached.
        expect(
            await program.slotResolution(ROOT_NODE_ID, "overlay-only")
        ).toBeUndefined();
        program.installOverlayDoc(
            new NamingEvent({
                id: "naming:overlay-only",
                nodeId: "dir:overlay-only",
                parentId: ROOT_NODE_ID,
                name: "overlay-only",
                causalDepth: 1n,
                parentNamingIds: [],
                createdAt: 1n,
                authorKey: "overlay-author",
                machineLabel: "overlay-machine",
            })
        );

        // Installation during fetching is not visible until the complete
        // overlay switches on atomically.
        expect(
            await program.slotResolution(ROOT_NODE_ID, "overlay-only")
        ).toBeUndefined();
        program.bootstrapPhase = "overlay-active";
        expect(
            (await program.slotResolution(ROOT_NODE_ID, "overlay-only"))?.nodeId
        ).toBe("dir:overlay-only");

        program.retireOverlay(true, program.openGeneration);
        expect(program.overlaySweep.size).toBe(0);
        expect(program.slotCandidateCache.snapshot().parents).toBe(0);
        expect(
            await program.slotResolution(ROOT_NODE_ID, "overlay-only")
        ).toBeUndefined();

        program.bootstrapPhase = "overlay-active";
        program.installOverlayDoc(
            new NamingEvent({
                id: "naming:overlay-timeout",
                nodeId: "dir:overlay-timeout",
                parentId: ROOT_NODE_ID,
                name: "overlay-timeout",
                causalDepth: 1n,
                parentNamingIds: [],
                createdAt: 2n,
                authorKey: "overlay-author",
                machineLabel: "overlay-machine",
            })
        );
        expect(
            (await program.slotResolution(ROOT_NODE_ID, "overlay-timeout"))
                ?.nodeId
        ).toBe("dir:overlay-timeout");
        program.retireOverlay(false, program.openGeneration);
        program.clearBootstrapTimers();
        expect(program.overlaySweep.size).toBe(0);
        expect(program.slotCandidateCache.snapshot().parents).toBe(0);
        expect(await fs.stat("/overlay-timeout")).toBeUndefined();
    });

    it("reinitializes the index across close and same-program reopen", async () => {
        await fs.writeFile("/persisted.txt", "persisted");
        expect(await fs.stat("/persisted.txt")).toBeDefined();
        const program: any = fs.program;
        const previousCache = program.slotCandidateCache;
        expect(previousCache.snapshot().parents).toBeGreaterThan(0);
        expect(previousCache.snapshot().reverse).toBeGreaterThan(0);

        await program.close();
        const reopened = await (peer as any).open(program, {
            existing: "reuse",
            args: {
                machineLabel: "slot-cache-reopen",
                addressOpen: true,
                bootstrap: false,
                snapshot: { disabled: true },
                gc: false,
            },
        });

        expect(reopened).toBe(program);
        expect(program.slotCandidateCache).not.toBe(previousCache);
        expect(program.slotCandidateCache.snapshot().parents).toBe(0);
        expect(program.slotCandidateCache.snapshot().reverse).toBe(0);
        expect(decode(await fs.readFile("/persisted.txt"))).toBe("persisted");
    });
});
