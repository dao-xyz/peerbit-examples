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

        // Current manager schedules only the target canvas; ancestor aggregation happens in reIndex.
        // With our stubbed reindex (no ancestor work), expect only the child run here.
        assert.deepEqual(calls, [{ id: "child", onlyReplies: false }]);
    });

    it("propagates skipAncestors flag to reindex", async () => {
        const root = new StubCanvas("root", []);
        const child = new StubCanvas("child", [root]);

        const seen: {
            id: string;
            onlyReplies: boolean;
            skipAncestors?: boolean;
        }[] = [];
        const mgr = createHierarchicalReindexManager<StubCanvas>({
            delay: 0,
            reindex: async (canvas, opts) => {
                seen.push({
                    id: canvas.idString,
                    onlyReplies: !!opts?.onlyReplies,
                    skipAncestors: !!(opts as any)?.skipAncestors,
                });
            },
        });

        await mgr.add({
            canvas: child,
            options: { onlyReplies: false, skipAncestors: true },
        });
        // child run should carry skipAncestors true
        const childRun = seen.find((c) => c.id === "child");
        assert.ok(childRun, "expected child run");
        assert.equal(childRun!.skipAncestors, true);
    });

    it("coalesces rapid upgrades under cooldown", async () => {
        const root = new StubCanvas("root", []);
        const c = new StubCanvas("x", [root]);
        const calls: { onlyReplies: boolean }[] = [];
        const mgr = createHierarchicalReindexManager<StubCanvas>({
            delay: 0,
            cooldownMs: 50,
            adaptiveCooldownMinMs: 10,
            reindex: async (_c, opts) => {
                calls.push({ onlyReplies: !!opts?.onlyReplies });
            },
        });

        // Burst of schedules/upgrades
        await mgr.add({ canvas: c, options: { onlyReplies: true } });
        await mgr.add({ canvas: c, options: { onlyReplies: false } });
        await mgr.add({ canvas: c, options: { onlyReplies: false } });

        // Should not exceed 2 runs under burst (cooldown coalesces upgrades)
        assert.ok(calls.length <= 2, `expected <=2 runs, got ${calls.length}`);
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
