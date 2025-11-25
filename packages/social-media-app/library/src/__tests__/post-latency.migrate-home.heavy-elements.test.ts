import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Reproduces slow publish (home migration + heavy element copy) expected to exceed target budget.
 * Scenario:
 *  - Draft lives in a non‑replicating source scope with many elements (simulating a rich post)
 *  - Parent lives in a different replicating destination scope
 *  - We publish via parent.upsertReply(draft, { type: 'sync', updateHome: 'set' })
 * Expected (current): latency often > 3‑4s (FAIL). Desired future: < 1500ms.
 * We assert <1500ms so this test intentionally fails now to lock in regression.
 */

describe("post latency: migrate home with heavy elements (EXPECTED FAIL)", () => {
    let session: TestSession;
    beforeEach(async () => {
        session = await TestSession.connected(1);
    });
    afterEach(async () => {
        await session.stop();
    });

    it("migrating heavy draft is fast (<1500ms) — currently regresses", async () => {
        const peer = session.peers[0];

        // Destination (replicating) scope
        const dest = await peer.open(
            new Scope({ publicKey: peer.identity.publicKey }),
            { args: { replicate: true } }
        );

        // Source (non‑replicating) scope distinct address
        const source = await peer.open(
            new Scope({ publicKey: peer.identity.publicKey }),
            { args: { replicate: false } }
        );

        // Parent in destination scope
        const parent = new Canvas({
            publicKey: peer.identity.publicKey,
            selfScope: dest,
        });
        await parent.load(peer, { args: { replicate: true } });
        await dest.getOrCreateReply(undefined, parent);

        // Draft in source scope with many elements
        const draft = new Canvas({
            publicKey: peer.identity.publicKey,
            selfScope: source,
        });
        await draft.load(peer, { args: { replicate: false } });

        const insertSTart = Date.now();
        // Reduced from 400 to 150 to keep CI runtime lower while still exceeding the target budget.
        const ELEMENTS = 150; // adjust if runtime too short/long
        for (let i = 0; i < ELEMENTS; i++) {
            // Use unique text so index transform work is not trivial NOOP.
            await draft.addTextElement(`Line ${i} lorem ipsum dolor sit amet`, {
                skipReindex: i !== ELEMENTS - 1, // skip reindex except last to speed up test
            });
        }
        console.log(
            `Inserted ${ELEMENTS} elements in ${Date.now() - insertSTart}ms`
        );
        // console.log(`Draft now has ${draft.indexedElements.size} indexed elements`);

        // Force any pending debounced reindex before timing to isolate publish cost
        await source._hierarchicalReindex!.flush();

        // Lightweight event polyfill for Node environments lacking addEventListener
        if (typeof (globalThis as any).addEventListener !== "function") {
            const __listeners: Record<string, Function[]> = {};
            (globalThis as any).addEventListener = (type: string, cb: any) => {
                (__listeners[type] ||= []).push(cb);
            };
            (globalThis as any).removeEventListener = (
                type: string,
                cb: any
            ) => {
                const arr = __listeners[type];
                if (!arr) return;
                const i = arr.indexOf(cb);
                if (i >= 0) arr.splice(i, 1);
            };
            (globalThis as any).dispatchEvent = (evt: any) => {
                const arr = __listeners[evt.type];
                if (arr) arr.forEach((f) => f(evt));
                return true;
            };
        }

        const t0 = Date.now();
        let evt: any | undefined;
        (globalThis as any).__PUBLISH_EVENTS = [];
        (globalThis as any).addEventListener?.(
            "perf:scope.publish",
            (e: any) => {
                (globalThis as any).__PUBLISH_EVENTS.push(e.detail);
            }
        );
        await parent.upsertReply(draft, {
            type: "sync",
            targetScope: dest,
            updateHome: "set",
            visibility: "both",
            debug: true, // emit perf:scope.publish
        });
        const dt = Date.now() - t0;
        const evts = (globalThis as any).__PUBLISH_EVENTS as any[];
        evt = evts?.[0];
        if (evt?.marks) {
            const names = evt.marks.map((m: any) => m.name);
            // For large migrations we expect deferred cleanup (manual or auto)
            expect(
                names.includes("sync:deferredCleanup") ||
                    names.includes("sync:autoDeferred"),
                `expected deferred cleanup mark, saw: ${names.join(",")}`
            ).to.be.true;
        }

        // Intentional failing assertion to lock regression
        expect(
            dt,
            `migrated publish latency ${dt}ms exceeded 1500ms`
        ).to.be.lessThan(1500);
    });

    it("migrating medium draft (50 elements) used for tracking optimization progress", async () => {
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
        for (let i = 0; i < 50; i++) {
            await draft.addTextElement(`Mid ${i} dolor sit`, {
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
        // Set generous threshold now; will ratchet down after improvements.
        expect(
            dt,
            `medium migrate latency ${dt}ms exceeded 2500ms`
        ).to.be.lessThan(2500);
    });
});
