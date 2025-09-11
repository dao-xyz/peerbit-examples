import { strict as assert } from "assert";
import {
    createHierarchicalReindexManager,
    ReindexCanvasLike,
} from "../utils.js";

// Simple stub canvas implementing ReindexCanvasLike
class StubCanvas implements ReindexCanvasLike {
    constructor(public idString: string, private ancestors: StubCanvas[]) {}
    async loadPath(_args: {
        includeSelf: boolean;
    }): Promise<ReindexCanvasLike[]> {
        // Return chain [root, ..., parent]; ancestors provided in order root..parent
        return this.ancestors;
    }
}

describe("HierarchicalReindexManager", () => {
    it("propagates to parent with replies-only and runs full on child", async () => {
        const root = new StubCanvas("root", []);
        const parent = new StubCanvas("parent", [root]);
        const child = new StubCanvas("child", [root, parent]);

        const calls: { id: string; onlyReplies: boolean }[] = [];
        const mgr = createHierarchicalReindexManager<StubCanvas>({
            delay: 0, // immediate leading run
            reindex: async (canvas, opts) => {
                calls.push({
                    id: canvas.idString,
                    onlyReplies: !!opts?.onlyReplies,
                });
            },
        });

        await mgr.add({ canvas: child }); // full by default, parents replies-only

        // Expect a run for child (full) and parent (replies). Order not strictly guaranteed; sort for assertions
        const sorted = calls.sort((a, b) => a.id.localeCompare(b.id));
        assert.deepEqual(sorted, [
            { id: "child", onlyReplies: false },
            { id: "parent", onlyReplies: true },
        ]);
    });

    it("separate runs for replies then full upgrade on same canvas", async () => {
        const root = new StubCanvas("root", []);
        const canvas = new StubCanvas("c1", [root]);
        const calls: { id: string; onlyReplies: boolean }[] = [];
        const mgr = createHierarchicalReindexManager<StubCanvas>({
            delay: 0,
            reindex: async (c, opts) => {
                calls.push({
                    id: c.idString,
                    onlyReplies: !!opts?.onlyReplies,
                });
            },
        });

        await mgr.add({ canvas, options: { onlyReplies: true } });
        await mgr.add({ canvas, options: { onlyReplies: false } });

        // Expect two calls: first replies-only, then full
        assert.equal(calls.length, 2, "expected two runs");
        assert.equal(calls[0].onlyReplies, true);
        assert.equal(calls[1].onlyReplies, false);
    });

    it("flush only affects targeted canvas", async () => {
        const root = new StubCanvas("root", []);
        const a = new StubCanvas("a", [root]);
        const b = new StubCanvas("b", [root]);
        const calls: { id: string; onlyReplies: boolean }[] = [];
        const mgr = createHierarchicalReindexManager<StubCanvas>({
            delay: () => 5, // small delay
            reindex: async (c, opts) => {
                calls.push({
                    id: c.idString,
                    onlyReplies: !!opts?.onlyReplies,
                });
            },
        });

        // Schedule both but do not await (fire-and-await separately)
        const p1 = mgr.add({ canvas: a, options: { onlyReplies: true } });
        const p2 = mgr.add({ canvas: b, options: { onlyReplies: true } });
        await Promise.all([p1, p2]);

        // Force flush of only canvas a (should be no-op since delay 5ms may already have run, but call anyway)
        await mgr.flush("a");

        // Ensure both canvases ran exactly once (independence of timers) regardless of order
        const countA = calls.filter((c) => c.id === "a").length;
        const countB = calls.filter((c) => c.id === "b").length;
        assert.equal(countA, 1);
        assert.equal(countB, 1);
    });
});
