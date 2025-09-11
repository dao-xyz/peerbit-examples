import { expect } from "chai";
import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";

/**
 * Migration latency with a modest payload (10 text elements) to observe scaling between
 * single-element (~1s) and heavy (400 elements, current regression ~3-4s).
 * Target budget: keep under 2000ms; adjust if flakes appear.
 */

describe("post latency: migrate home ten elements", () => {
    let session: TestSession;
    beforeEach(async () => {
        session = await TestSession.connected(1);
    });
    afterEach(async () => {
        await session.stop();
    });

    it("ten element migrate (sync + updateHome) is fast (<2000ms)", async () => {
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

        for (let i = 0; i < 10; i++) {
            await draft.addTextElement(`TenElem ${i} quick brown fox`, {
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
            `ten element migrate latency ${dt}ms exceeded 2000ms`
        ).to.be.lessThan(2000);
    });
});
