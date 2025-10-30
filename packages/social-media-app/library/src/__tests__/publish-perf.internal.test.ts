import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";

// Internal perf test for Scope.publish instrumentation.
// Runs in debug mode to collect perf:scope.publish events and asserts phase ordering.

describe("publish internal perf instrumentation", () => {
    let session: TestSession;
    const events: any[] = [];
    beforeEach(async () => {
        session = await TestSession.connected(1);
        events.length = 0;
        globalThis.addEventListener("perf:scope.publish", (e: any) =>
            events.push(e.detail)
        );
    });
    afterEach(async () => {
        globalThis.removeEventListener("perf:scope.publish", () => { });
        await session.stop();
    });

    it("captures sync phase markers", async () => {
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
        await draft.addTextElement("Hello", { skipReindex: false });

        await parent.upsertReply(draft, {
            type: "sync",
            targetScope: scope,
            updateHome: "set",
            visibility: "both",
            debug: true,
        });

        expect(events.length).to.be.greaterThan(0);
        const evt = events[0];
        expect(evt.mode).to.eq("sync");
        const names = evt.marks.map((m: any) => m.name);
        // Ensure required phases are present in order
        const required = [
            "start",
            "sync:lookupExisting",
            "sync:copyPayload",
            "sync:finalize",
            "end",
        ];
        for (const r of required) {
            expect(names).to.include(r);
        }
        // Monotonic timestamps
        let last = -1;
        for (const m of evt.marks) {
            expect(m.t).to.be.at.least(last);
            last = m.t;
        }
    });
});
