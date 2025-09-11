import { expect } from "chai";
import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";

/**
 * Validates that using beginBulk/endBulk reduces the number of reindex flushes
 * compared to naive sequential adds.
 */

describe("reindex bulk insert", () => {
    let session: TestSession;
    beforeEach(async () => {
        (globalThis as any).__COLLECT_REINDEX = true;
        (globalThis as any).__PERF_EVENTS__ = [];
        session = await TestSession.connected(1);
    });
    afterEach(async () => {
        delete (globalThis as any).__COLLECT_REINDEX;
        delete (globalThis as any).__PERF_EVENTS__;
        await session.stop();
    });

    it("coalesces reindex into ~1 flush for many adds", async () => {
        const peer = session.peers[0];
        const scope = await peer.open(
            new Scope({ publicKey: peer.identity.publicKey }),
            { args: { replicate: false } }
        );
        const canvas = new Canvas({
            publicKey: peer.identity.publicKey,
            selfScope: scope,
        });
        await canvas.load(peer, { args: { replicate: false } });
        await scope.getOrCreateReply(undefined, canvas);

        const N = 80;
        canvas.beginBulk();
        for (let i = 0; i < N; i++) {
            await canvas.addTextElement(`Bulk ${i} lorem ipsum dolor sit amet`);
        }
        await canvas.endBulk();

        await scope._hierarchicalReindex!.flush();
        const events = (globalThis as any).__PERF_EVENTS__ as any[];
        const flushes = events.filter((e) => e.type === "reindex:flush");
        console.log("[bulk-insert] flushes=%d for N=%d", flushes.length, N);
        expect(flushes.length).to.be.lessThan(10); // heuristic upper bound
    });
});
