import { strict as assert } from "assert";
import {
    createHierarchicalReindexManager,
    ReindexCanvasLike,
} from "../utils.js";

class StubCanvas implements ReindexCanvasLike {
    constructor(public idString: string, private ancestors: StubCanvas[]) {}
    async loadPath(_args: {
        includeSelf: boolean;
    }): Promise<ReindexCanvasLike[]> {
        return this.ancestors; // root .. parent
    }
}

describe("HierarchicalReindexManager targeted flush", () => {
    it("flush(canvasId) does not trigger runs for other canvases", async () => {
        const root = new StubCanvas("root", []);
        const a = new StubCanvas("a", [root]);
        const b = new StubCanvas("b", [root]);

        const calls: string[] = [];
        const mgr = createHierarchicalReindexManager<StubCanvas>({
            delay: 25,
            reindex: async (canvas, opts) => {
                calls.push(canvas.idString + (opts?.onlyReplies ? ":r" : ":f"));
                // Simulate work so that subsequent add() calls happen while running and coalesce
                await new Promise((r) => setTimeout(r, 40));
            },
            propagateParentsDefault: false,
        });

        await mgr.add({
            canvas: a,
            options: { onlyReplies: true },
            propagateParents: false,
        });
        await mgr.add({
            canvas: b,
            options: { onlyReplies: true },
            propagateParents: false,
        });

        // Because debouncer is leading, both adds trigger immediate runs
        assert.equal(
            calls.filter((c) => c.startsWith("a:")).length,
            1,
            "expected one initial run for a"
        );
        assert.equal(
            calls.filter((c) => c.startsWith("b:")).length,
            1,
            "expected one initial run for b"
        );

        // Enqueue further adds
        await mgr.add({
            canvas: a,
            options: { onlyReplies: true },
            propagateParents: false,
        });
        await mgr.add({
            canvas: b,
            options: { onlyReplies: true },
            propagateParents: false,
        });
        const beforeFlush = {
            a: calls.filter((c) => c.startsWith("a:")).length,
            b: calls.filter((c) => c.startsWith("b:")).length,
        };
        await mgr.flush("a");
        // Flushing a should not change b's call count
        assert.equal(
            calls.filter((c) => c.startsWith("b:")).length,
            beforeFlush.b,
            "flush(a) should not affect b runs"
        );
        // a may or may not have changed depending on upgrade timing; requirement is isolation only.
        await mgr.flush("b");
        // After flushing b, b count can only increase by at most 1
        const bAfter = calls.filter((c) => c.startsWith("b:")).length;
        assert.ok(
            bAfter === beforeFlush.b || bAfter === beforeFlush.b + 1,
            "b runs should increase by at most one after its own flush"
        );
    });
});
