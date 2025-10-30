import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Parameter sweep to observe scaling of full:put ctx/index phases.
// Uses the __LAST_FULL_PUT hook added when FULL_PUT_TEST_HOOK=1.
// Skipped by default unless FULL_PUT_SWEEP=1.

const SIZES = [50, 200, 600, 1200];

describe("reindex full:put scaling sweep", () => {
    let session: TestSession;
    beforeEach(async () => {
        session = await TestSession.connected(1);
        process.env.FULL_PUT_TEST_HOOK = "1";
    });
    afterEach(async () => {
        await session.stop();
    });

    it(`profiles N=`, async () => {
        console.log("FULL_PUT_SWEEP profile");
        for (const N of SIZES) {
            const peer = session.peers[0];
            const scope = await peer.open(
                new Scope({ publicKey: peer.identity.publicKey }),
                { args: { replicate: false, debug: false } }
            );
            const [, root] = await scope.getOrCreateReply(
                undefined,
                new Canvas({
                    publicKey: peer.identity.publicKey,
                    selfScope: scope,
                })
            );
            const texts = Array.from({ length: N }, (_, i) => `e${i}`);
            await root.addTextElements(texts);
            await (scope as any).reIndex(root);
            const hook = (globalThis as any).__LAST_FULL_PUT;
            expect(hook).to.be.ok;
            console.log(
                `FULL_PUT_SWEEP N=${N} elements=${hook.elements
                } ctxMs=${hook.ctxMs.toFixed(2)} indexMs=${hook.indexMs.toFixed(
                    2
                )} totalMs=${hook.totalMs.toFixed(2)} bytes=${hook.bytes}`
            );
        }
    });
});
