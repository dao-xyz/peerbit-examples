import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";

/**
 * Attempts to reproduce slow publish with only a single text element while migrating home.
 * If this passes comfortably (<1500ms) while frontend shows multi-second delay, the remaining
 * gap is likely warmup/flush work preceding publish rather than element copy volume.
 */

describe("post latency: migrate home single element", () => {
    let session: TestSession;
    beforeEach(async () => {
        session = await TestSession.connected(1);
    });
    afterEach(async () => {
        await session.stop();
    });

    it("single element migrate (sync + updateHome) is fast (<1500ms)", async () => {
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
        await draft.addTextElement("Only one", { skipReindex: false });
        await source._hierarchicalReindex!.flush(); // isolate publish cost

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
            `single element migrate latency ${dt}ms exceeded 1500ms`
        ).to.be.lessThan(1500);
    });
});
