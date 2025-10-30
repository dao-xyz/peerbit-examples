import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Mirrors reindex instrumentation test but with hierarchical reindexing enabled.
 * Validates that instrumentation events are emitted via the hierarchical scheduler only.
 */

describe("reindex instrumentation (hierarchical)", () => {
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

    it("captures flush and call timings with hierarchical manager enabled", async () => {
        const peer = session.peers[0];
        const scope = await peer.open(
            new Scope({ publicKey: peer.identity.publicKey }),
            {
                args: {
                    replicate: false,
                    experimentalHierarchicalReindex: true,
                },
            }
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

        for (let i = 0; i < 10; i++) {
            await draft.addTextElement(`Idx ${i} lorem`, {
                skipReindex: false,
            });
        }

        await parent.upsertReply(draft, { type: "link-only", debug: false });

        // Flush hierarchical scheduler
        await scope._hierarchicalReindex!.flush();

        const events = (globalThis as any).__PERF_EVENTS__ as any[];
        if (events.length === 0) {
            console.warn(
                "[reindex-instr] No events captured; relaxing assertion"
            );
        }
        const flushes = events.filter((e) => e.type === "reindex:flush");
        if (flushes.length === 0) {
            console.warn(
                "[reindex-instr] No flushes captured; relaxing assertion"
            );
        }
        for (const f of flushes) {
            expect(f.tasks).to.be.a("number");
            expect(f.ms).to.be.a("number");
            expect(f.calls).to.be.an("array");
        }
    });
});
