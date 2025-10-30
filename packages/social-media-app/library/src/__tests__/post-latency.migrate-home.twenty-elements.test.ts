import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";

/**
 * Migration latency with 20 elements to observe scaling curve.
 * Threshold set to <3000ms (current regression headroom). Adjust downward after optimization.
 */

describe("post latency: migrate home twenty elements", () => {
    let session: TestSession;
    beforeEach(async () => {
        session = await TestSession.connected(1);
    });
    afterEach(async () => {
        await session.stop();
    });

    it("twenty element migrate (sync + updateHome) is fast (<3000ms)", async () => {
        const peer = session.peers[0];
        const dest = await peer.open(
            new Scope({ publicKey: peer.identity.publicKey }),
            { args: { replicate: true } }
        );
        const source = await peer.open(
            new Scope({ publicKey: peer.identity.publicKey }),
            { args: { replicate: false } }
        );

        const parent = new Canvas({
            publicKey: peer.identity.publicKey,
            selfScope: dest,
        });
        await parent.load(peer, { args: { replicate: true } });
        await dest.getOrCreateReply(undefined, parent);

        const draft = new Canvas({
            publicKey: peer.identity.publicKey,
            selfScope: source,
        });
        await draft.load(peer, { args: { replicate: false } });

        for (let i = 0; i < 20; i++) {
            await draft.addTextElement(`TwentyElem ${i} quick brown fox`, {
                skipReindex: false,
            });
        }
        await source._hierarchicalReindex!.flush();

        const t0 = Date.now();
        await parent.upsertReply(draft, {
            type: "sync",
            targetScope: dest,
            updateHome: "set",
            visibility: "both",
            debug: true,
        });
        const dt = Date.now() - t0;
        expect(
            dt,
            `twenty element migrate latency ${dt}ms exceeded 3000ms`
        ).to.be.lessThan(3000);
    });
});
