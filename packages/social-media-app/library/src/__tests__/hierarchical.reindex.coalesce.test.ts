import { strict as assert } from "assert";
import {
    createHierarchicalReindexManager,
    ReindexCanvasLike,
} from "../utils.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

class StubCanvas implements ReindexCanvasLike {
    constructor(
        public idString: string,
        private ancestors: StubCanvas[]
    ) { }
    async loadPath(_args: {
        includeSelf: boolean;
    }): Promise<ReindexCanvasLike[]> {
        return this.ancestors; // root .. parent
    }
}

describe("HierarchicalReindexManager coalescing", () => {
    it("coalesces many adds during running phase into minimal runs", async () => {
        const root = new StubCanvas("root", []);
        const parent = new StubCanvas("parent", [root]);
        const child = new StubCanvas("child", [root, parent]);

        const calls: { id: string; onlyReplies: boolean }[] = [];
        const mgr = createHierarchicalReindexManager<StubCanvas>({
            delay: 5, // small debounce window
            reindex: async (canvas, opts) => {
                calls.push({
                    id: canvas.idString,
                    onlyReplies: !!opts?.onlyReplies,
                });
                // Simulate work so additional add() calls happen while running
                await new Promise((r) => setTimeout(r, 10));
            },
        });

        // Burst of mixed adds: replies/full toggles
        const burst: Promise<void>[] = [];
        for (let i = 0; i < 30; i++) {
            burst.push(
                mgr.add({
                    canvas: child,
                    options: { onlyReplies: i % 2 === 0 },
                })
            );
        }
        await Promise.all(burst);
        // Final ensure flush completes
        await mgr.flush();

        // Expect: one full run for child, at most one replies-only parent run
        const childCalls = calls.filter((c) => c.id === "child");
        const parentCalls = calls.filter((c) => c.id === "parent");
        // Expect: one full run for child, maybe one replies-only run pre-upgrade, and minimal parent runs
        assert(
            childCalls.length <= 2,
            `child ran too many times: ${childCalls.length}`
        );
        assert(
            parentCalls.length <= 2,
            `parent ran too many times: ${parentCalls.length}`
        );
        assert(
            childCalls.some((c) => c.onlyReplies === false),
            "expected a full child run"
        );
    });
});
