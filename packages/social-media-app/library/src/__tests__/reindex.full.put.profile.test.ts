import { expect } from "chai";
import { TestSession } from "@peerbit/test-utils";
import { performance } from "perf_hooks";
import { Canvas, Scope } from "../content.js";

/**
 * Profiling test: attempts to reproduce the slow `full:put` phase observed in E2E.
 * It creates a canvas with many owned elements (text) and then forces a reindex flush,
 * capturing timings of the two sub-operations inside full:put:
 *  - putWithContext ("ctx" batch)
 *  - index.put ("index" batch)
 *
 * NOTE: This test is informational and deliberately permissive: it does NOT fail on "fast" runs.
 *       It will assert basic sanity (both phases executed) and log timings so regressions can be inspected.
 */
describe("reindex full:put profiling", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(1);
    });

    afterEach(async () => {
        await session.stop();
    });

    it("measures full:put timing with many elements", async () => {
        const peer = session.peers[0];
        const scope = await peer.open(
            new Scope({ publicKey: peer.identity.publicKey }),
            { args: { replicate: false, debug: false } }
        );

        // Create root canvas (no parent)
        const [, root] = await scope.getOrCreateReply(
            undefined,
            new Canvas({
                publicKey: peer.identity.publicKey,
                selfScope: scope,
            })
        );

        // Activate built-in instrumentation test hook
        process.env.FULL_PUT_TEST_HOOK = "1";

        // Prepare many elements; adjust N to push serialization/write cost without blowing up test time.
        const N = Number(process.env.FULL_PUT_PROFILE_N || 1200);
        const texts = Array.from({ length: N }, (_, i) => `e${i}`);

        // Use bulk insertion util to avoid intermediate reindexes (a single full run at the end)
        await root.addTextElements(texts);

        // Directly invoke full reindex to profile put path deterministically
        await (scope as any).reIndex(root);
        const hook = (globalThis as any).__LAST_FULL_PUT;
        expect(hook).to.be.ok;
        expect(hook.id).to.equal(root.idString);
        expect(hook.ctxMs).to.be.a("number").and.greaterThan(0);
        expect(hook.indexMs).to.be.a("number").and.greaterThan(0);
        expect(hook.totalMs)
            .to.be.a("number")
            .and.greaterThan(hook.ctxMs + hook.indexMs - 1);
        console.log(
            `FULL_PUT_PROFILE elements=${N} ctxMs=${hook.ctxMs.toFixed(
                2
            )} indexMs=${hook.indexMs.toFixed(
                2
            )} totalMs=${hook.totalMs.toFixed(2)}`
        );
    });
});
