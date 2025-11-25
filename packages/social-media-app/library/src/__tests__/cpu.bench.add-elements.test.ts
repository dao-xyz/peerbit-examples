import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Lightweight CPU bench to compare sequential addTextElement vs addTextElements batch helper.
 * Not a strict perf test (no assertions on timing) – logs durations so changes can be observed in CI.
 */

describe("cpu bench: add elements", () => {
    let session: TestSession;
    beforeEach(async () => {
        session = await TestSession.connected(1);
    });
    afterEach(async () => {
        await session.stop();
    });

    it("sequential vs batch", async () => {
        const peer = session.peers[0];
        const scope = await peer.open(
            new Scope({ publicKey: peer.identity.publicKey }),
            { args: { replicate: false } }
        );
        const canvasA = new Canvas({
            publicKey: peer.identity.publicKey,
            selfScope: scope,
        });
        await canvasA.load(peer, { args: { replicate: false } });
        await scope.getOrCreateReply(undefined, canvasA);

        const texts = Array.from({ length: 150 }, (_, i) => `Bench line ${i}`);

        const tSeq0 = Date.now();
        for (const t of texts) {
            await canvasA.addTextElement(t);
        }
        await scope._hierarchicalReindex!.flush();
        const seqMs = Date.now() - tSeq0;

        const canvasB = new Canvas({
            publicKey: peer.identity.publicKey,
            selfScope: scope,
        });
        await canvasB.load(peer, { args: { replicate: false } });
        await scope.getOrCreateReply(undefined, canvasB);

        const tBatch0 = Date.now();
        await canvasB.addTextElements(texts);
        await scope._hierarchicalReindex!.flush();
        const batchMs = Date.now() - tBatch0;

        console.log(
            `[cpu-bench] sequential=${seqMs}ms batch=${batchMs}ms improvement=${
                seqMs - batchMs
            }ms`
        );
    });
});
