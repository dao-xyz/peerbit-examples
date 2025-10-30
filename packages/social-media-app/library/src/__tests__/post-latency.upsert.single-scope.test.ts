import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";

/**
 * Locks in latency for a typical single-scope publish path used by the frontend:
 * 1. Draft created in destination scope (no replication)
 * 2. A simple text element is added
 * 3. Parent.upsertReply(draft, { type: 'sync', visibility: 'both' })
 * Measures end-to-end time; fails if excessively high, surfacing regressions like the ~4s gap observed in UI.
 */

describe("post latency: single-scope upsertReply", () => {
    let session: TestSession;
    beforeEach(async () => {
        session = await TestSession.connected(1); // single peer
    });
    afterEach(async () => {
        await session.stop();
    });

    it("publish with one text element is fast (<1500ms)", async () => {
        const peer = session.peers[0];
        const scope = await peer.open(
            new Scope({ publicKey: peer.identity.publicKey }),
            {
                args: { replicate: false },
            }
        );

        // Create and load parent canvas in same scope
        const parent = new Canvas({
            publicKey: peer.identity.publicKey,
            selfScope: scope,
        });
        await parent.load(peer, { args: { replicate: false } });
        await scope.getOrCreateReply(undefined, parent); // anchor parent in scope

        // Create draft canvas and load it
        const draft = new Canvas({
            publicKey: peer.identity.publicKey,
            selfScope: scope,
        });
        await draft.load(peer, { args: { replicate: false } });

        // Insert one text element (mirrors frontend draft compose)
        await draft.addTextElement("Hello world", { skipReindex: false });

        const t0 = Date.now();
        const res = await parent.upsertReply(draft, {
            type: "sync",
            targetScope: scope,
            updateHome: "set",
            visibility: "both",
            kind: undefined as any,
            debug: false,
        });
        const child = res[1];
        const t1 = Date.now();
        const ms = t1 - t0;
        // Expect under 1.5s in test environment; adjust if flakiness observed
        expect(
            ms,
            `upsertReply latency ${ms}ms exceeded 1500ms`
        ).to.be.lessThan(1500);
        // Sanity: child is accessible locally immediately
        const exists = await scope.replies.index.get(child.id, {
            local: true,
            resolve: false,
        });
        expect(!!exists).to.eq(true);
    });
});
