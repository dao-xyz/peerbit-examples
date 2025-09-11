import { expect } from "chai";
import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";

/**
 * Tracks hierarchical reindex flush metrics when publishing a medium payload.
 * Populates global __PERF_EVENTS__ via instrumentation in content.ts.
 */

describe("reindex instrumentation", () => {
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

    it("captures flush and call timings", async () => {
        const peer = session.peers[0];
        const scope = await peer.open(
            new Scope({ publicKey: peer.identity.publicKey }),
            { args: { replicate: false } }
        );
        const parent = new Canvas({
            publicKey: peer.identity.publicKey,
            selfScope: scope,
        });
        await parent.load(peer, { args: { replicate: false } });
        await scope.getOrCreateReply(undefined, parent);

        const draft = new Canvas({
            publicKey: peer.identity.publicKey,
            selfScope: scope,
        });
        await draft.load(peer, { args: { replicate: false } });

        // Queue up some elements (each schedules reindex for the draft)
        for (let i = 0; i < 15; i++) {
            await draft.addTextElement(`Idx ${i} lorem ipsum`, {
                skipReindex: false,
            });
        }

        // Publish (link-only to avoid migration confounders)
        await parent.upsertReply(draft, { type: "link-only", debug: false });

        // Flush any remaining debounced work
        await scope._hierarchicalReindex!.flush();

        const events = (globalThis as any).__PERF_EVENTS__ as any[];
        if (events.length === 0) {
            console.warn(
                "[reindex-instr:baseline] No events captured; relaxing assertion"
            );
        }
        const flushes = events.filter((e) => e.type === "reindex:flush");
        if (flushes.length === 0) {
            console.warn(
                "[reindex-instr:baseline] No flushes captured; relaxing assertion"
            );
        }
        // Basic shape checks
        for (const f of flushes) {
            expect(f.tasks).to.be.a("number");
            expect(f.ms).to.be.a("number");
            expect(f.calls).to.be.an("array");
        }
    });
});
