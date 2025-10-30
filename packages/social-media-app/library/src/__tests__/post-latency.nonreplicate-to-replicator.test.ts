import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";

describe("post latency: non-replicating client → replicating scope", () => {
    let session: TestSession;
    beforeEach(async () => {
        // 2 peers: client, replicator
        session = await TestSession.connected(2);
    });
    afterEach(async () => {
        await session.stop();
    });

    it("simple publish should be fast (< 2s)", async () => {
        const client = session.peers[0]; // non-replicating
        const replicator = session.peers[1];

        // Destination scope opened on the replicator with replication enabled
        const dest = await replicator.open(
            new Scope({ publicKey: replicator.identity.publicKey }),
            { args: { replicate: true } }
        );

        // Client opens a local handle to the same scope address without replication
        const destFromClient = await client.open<Scope>(dest.address, {
            existing: "reuse",
            args: { replicate: false },
        });

        // Create a child on the client side
        const draft = new Canvas({
            publicKey: client.identity.publicKey,
            selfScope: destFromClient, // home is the dest scope address
        });

        const start = Date.now();
        const [, canvas] = await destFromClient.getOrCreateReply(
            undefined,
            draft
        );
        const end = Date.now();

        // Smoke check: the replies row exists locally without remote fetches
        const exists = await destFromClient.replies.index.get(canvas.id, {
            resolve: false,
            local: true,
        });
        expect(!!exists).to.eq(true);

        const ms = end - start;
        // Bound: should be well under production 13s regression; aim for < 2s in test env
        expect(ms).to.be.lessThan(2000);
    });
});
