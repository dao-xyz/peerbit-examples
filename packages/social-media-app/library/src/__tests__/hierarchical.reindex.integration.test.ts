import { strict as assert } from "assert";
import { Peerbit } from "peerbit";
import { Scope, Canvas } from "../content.js";

// Lightweight integration exercising Scope with experimentalHierarchicalReindex flag.
describe("HierarchicalReindexManager.integration", () => {
    it("initializes hierarchical manager and performs full + replies propagation", async () => {
        const client = await Peerbit.create();
        try {
            const scope = await client.open(
                new Scope({ publicKey: client.identity.publicKey }),
                { args: { experimentalHierarchicalReindex: true } }
            );
            const c1 = new Canvas({
                publicKey: scope.publicKey,
                selfScope: scope,
            });
            await scope.replies.put(c1);
            await scope._hierarchicalReindex!.flush();
            await scope._hierarchicalReindex!.add({
                canvas: c1,
                options: { onlyReplies: false },
                propagateParents: true,
            });
            await scope._hierarchicalReindex!.flush();
            assert.ok(
                scope._hierarchicalReindex!.size() >= 1,
                "expected at least one entry"
            );
        } finally {
            await client.stop();
        }
    });
});
