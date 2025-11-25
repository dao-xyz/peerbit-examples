import { createHierarchicalReindexManager } from "../utils";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("hierarchical reindex (manager semantics)", () => {
    it("schedules only the target canvas; upgrades to full are preserved", async () => {
        type C = {
            idString: string;
            loadPath: ({
                includeSelf,
            }: {
                includeSelf: boolean;
            }) => Promise<any[]>;
        };

        // create fake canvases: root -> parent -> child
        const root: C = { idString: "root", loadPath: async () => [] } as any;
        const parent: C = {
            idString: "parent",
            loadPath: async () => [root],
        } as any;
        const child: C = {
            idString: "child",
            loadPath: async ({ includeSelf }: { includeSelf: boolean }) => [
                root,
                parent,
            ],
        } as any;

        const calls: Array<{ id: string; onlyReplies: boolean }> = [];

        const mgr = createHierarchicalReindexManager<C>({
            delay: () => 1,
            reindex: async (canvas, opts) => {
                calls.push({
                    id: canvas.idString,
                    onlyReplies: !!opts?.onlyReplies,
                });
            },
            cooldownMs: 0,
        });

        // Schedule replies-only with propagation request (ignored by manager; reIndex handles ancestors)
        await mgr.add({
            canvas: child,
            options: { onlyReplies: true },
            propagateParents: true,
        });

        // Immediately upgrade to full before flush/run
        await mgr.add({ canvas: child, options: { onlyReplies: false } });

        // Force run all pending work
        await mgr.flush();

        // Expect child to have a full run at least once
        const childFull = calls.some(
            (c) => c.id === "child" && c.onlyReplies === false
        );
        // Manager no longer propagates to parents; parent scheduling is performed inside reIndex
        const parentAny = calls.some((c) => c.id === "parent");

        expect(childFull).toBe(true);
        expect(parentAny).toBe(false);
    });
});
