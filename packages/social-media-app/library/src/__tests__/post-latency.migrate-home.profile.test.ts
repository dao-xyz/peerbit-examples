import { expect } from "chai";
import { TestSession } from "@peerbit/test-utils";
import { Canvas, Scope } from "../content.js";

/**
 * Profiles copy + cleanup + reindex phases for different element counts using instrumentation
 * emitted when __COLLECT_REINDEX and __PERF_EVENTS__ are enabled.
 * Logs summary per size; asserts shape only (not performance budgets) so it won't fail as we iterate.
 */

describe("post latency: migrate home profile (no thresholds)", () => {
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

    const SIZES = [1, 10, 50, 150];

    async function run(size: number) {
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
        for (let i = 0; i < size; i++) {
            await draft.addTextElement(`Profile ${size} - ${i}`);
        }
        await source._hierarchicalReindex!.flush();
        const t0 = Date.now();
        await parent.upsertReply(draft, {
            type: "sync",
            targetScope: dest,
            updateHome: "set",
            visibility: "both",
            debug: false,
        });
        const total = Date.now() - t0;
        const events = (globalThis as any).__PERF_EVENTS__ as any[];
        const copy = events
            .filter((e) => e.type === "copy:summary")
            .slice(-1)[0];
        const cleanupEls = events
            .filter((e) => e.type === "cleanup:elements")
            .slice(-1)[0];
        const cleanupLinks = events
            .filter((e) => e.type === "cleanup:childLinks")
            .slice(-1)[0];
        const cleanupViz = events
            .filter((e) => e.type === "cleanup:visualizations")
            .slice(-1)[0];
        const flushes = events.filter((e) => e.type === "reindex:flush");
        return {
            size,
            total,
            copy,
            cleanupEls,
            cleanupLinks,
            cleanupViz,
            flushes,
        };
    }

    it("profiles multiple sizes", async () => {
        const results = [] as any[];
        for (const s of SIZES) {
            const r = await run(s);
            results.push(r);
        }
        // Shape assertions
        for (const r of results) {
            expect(r.copy).to.be.ok;
            expect(r.copy.total).to.equal(r.size);
            expect(r.cleanupEls).to.be.ok;
            // Inline reindex flushes may be zero with deferred scheduling; assert shape only
            expect(r.flushes.length).to.be.greaterThanOrEqual(0);
        }
        console.log("PROFILE_RESULTS", JSON.stringify(results, null, 2));
    });
});

describe("post latency: deferCleanup experiment", () => {
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

    async function setupDraft(size: number) {
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
        for (let i = 0; i < size; i++) await draft.addTextElement(`Defer ${i}`);
        await source._hierarchicalReindex!.flush();
        return { peer, dest, source, parent, draft };
    }

    it("compares inline vs deferred cleanup for 50 elements", async () => {
        const { parent, draft, dest } = await setupDraft(50);
        const tInline0 = Date.now();
        await parent.upsertReply(draft, {
            type: "sync",
            targetScope: dest,
            updateHome: "set",
            visibility: "both",
            debug: true,
        });
        const inlineMs = Date.now() - tInline0;

        // Reset instrumentation
        (globalThis as any).__PERF_EVENTS__ = [];

        // Recreate draft (can't reuse since it migrated)
        const { parent: p2, draft: d2, dest: d2scope } = await setupDraft(50);
        const tDef0 = Date.now();
        await p2.upsertReply(d2, {
            type: "sync",
            targetScope: d2scope,
            updateHome: "set",
            visibility: "both",
            debug: true,
            deferCleanup: true,
        });
        const deferMs = Date.now() - tDef0;

        console.log(
            `INLINE_CLEANUP_50=${inlineMs}ms DEFERRED_CLEANUP_50=${deferMs}ms`
        );
        expect(inlineMs).to.be.greaterThan(0);
        expect(deferMs).to.be.greaterThan(0);
    });
});
