import { expect } from "chai";
import { TestSession } from "@peerbit/test-utils";
import { createRoot } from "../root.js";
import { Canvas } from "../content.js";

// This test ensures that adaptiveCooldownMinMs trims the first schedule delay inside a cooldown window.
// We simulate by scheduling a full reindex, waiting for completion, then quickly scheduling another one
// and measuring the schedule->run delay captured in __REINDEX_SCHED_STATS.

describe("adaptive cooldown", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(1);
        (globalThis as any).REINDEX_IDLE_TRACE = true; // collect scheduleDelay events
        (globalThis as any).__REINDEX_SCHED_STATS = undefined;
    });

    afterEach(async () => {
        await session.stop();
    });

    it("trims first cooldown schedule delay", async () => {
        const peer = session.peers[0];
        const { scope, canvas } = await createRoot(peer, {
            persisted: false,
            sections: ["general"],
        });

        // Force one reindex run (full)
        await (scope as any).reIndex(canvas);

        // Immediately schedule another run to land inside cooldown; full mode to ensure scheduling
        await scope._hierarchicalReindex!.add({
            canvas,
            options: { onlyReplies: false },
        });
        // Wait a tiny bit to let the trimmed timer fire
        await new Promise((r) => setTimeout(r, 15));
        await scope._hierarchicalReindex!.flush();

        const stats = (globalThis as any).__REINDEX_SCHED_STATS;
        expect(stats).to.be.ok;
        // Average should be small (<=15ms) due to adaptive trim (default adaptiveCooldownMinMs=1)
        const avg = stats.sum / stats.count;
        expect(avg).to.be.lessThan(30); // sanity guard: trimmed significantly below 120ms cooldown
    });
});
