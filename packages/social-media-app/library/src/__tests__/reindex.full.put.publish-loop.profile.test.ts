import { expect } from "chai";
import { TestSession } from "@peerbit/test-utils";
import { createRoot } from "../root.js";
import { Canvas, Scope } from "../content.js";
import { sha256Base64Sync } from "@peerbit/crypto";

/**
 * Loop profiling scenario approximating frontend behavior:
 * 1. Create persistent public root scope + root canvas via createRoot
 * 2. Create K child canvases under root (public) each with E elements
 * 3. For each iteration:
 *    a. Create a private temp scope
 *    b. Draft reply canvas in private scope, add D elements
 *    c. Publish via root.upsertReply(draft, { type: "sync", targetScope: public, updateHome: "set" })
 *    d. Force reindex flush and capture __LAST_FULL_PUT timing (ctx/index breakdown)
 *
 * Output: FULL_PUT_PUBLISH_LOOP iter=<i> draftElems=<D> ctxMs=.. indexMs=.. totalMs=.. childrenBefore=.. childrenAfter=..
 *
 * Control with env vars:
 *  LOOP_ITERS (default 5)
 *  CHILDREN (default 3)
 *  CHILD_ELEMS (default 20)
 *  DRAFT_ELEMS (default 50)
 */

describe("reindex publish loop profiling", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(1);
        process.env.FULL_PUT_TEST_HOOK = "1"; // enable timing hook
    });

    afterEach(async () => {
        await session.stop();
    });

    it("profiles private->public publish loops", async () => {
        const peer = session.peers[0];
        // Enable idle tracing if env flag set (propagates to hierarchical manager instrumentation)
        if (process.env.REINDEX_IDLE_TRACE === "1") {
            (globalThis as any).REINDEX_IDLE_TRACE = true;
        }
        // 1. Create root via helper (persisted so address stable)
        const { scope: publicScope, canvas: root } = await createRoot(peer, {
            persisted: true,
            sections: ["general", "random"],
        });

        // 2. Seed child canvases
        const CHILDREN = Number(process.env.CHILDREN || 3);
        const CHILD_ELEMS = Number(process.env.CHILD_ELEMS || 20);
        for (let i = 0; i < CHILDREN; i++) {
            const child = new Canvas({
                publicKey: peer.identity.publicKey,
                selfScope: publicScope,
            });
            await publicScope.getOrCreateReply(root, child);
            await child.addTextElements(
                Array.from({ length: CHILD_ELEMS }, (_, j) => `seed-${i}-${j}`)
            );
        }
        await publicScope._hierarchicalReindex!.flush();

        const LOOP_ITERS = Number(process.env.LOOP_ITERS || 150);
        const DRAFT_ELEMS = Number(process.env.DRAFT_ELEMS || 1);
        const tempScope = await peer.open(
            new Scope({ publicKey: peer.identity.publicKey }),
            { args: { replicate: false, debug: false } }
        );

        for (let iter = 0; iter < LOOP_ITERS; iter++) {
            // a. private temp scope
            const t1 = Date.now();
            // b. draft
            const t2 = Date.now();
            const draft = new Canvas({
                publicKey: peer.identity.publicKey,
                selfScope: tempScope,
            });
            const t3 = Date.now();
            await tempScope.getOrCreateReply(undefined, draft);
            const t4 = Date.now();
            await draft.addTextElements(
                Array.from(
                    { length: DRAFT_ELEMS },
                    (_, k) => `draft-${iter}-${k}`
                )
            );

            const t5 = Date.now();
            // children before
            const beforeKids = (await root.getChildren()).length;

            const t6 = Date.now();
            // c. publish (sync + migrate home)
            const [created, moved] = await root.upsertReply(draft, {
                type: "sync",
                targetScope: publicScope,
                updateHome: "set",
            });
            expect(created).to.be.true;
            expect(sha256Base64Sync(moved.id)).to.eq(
                sha256Base64Sync(draft.id)
            );
            expect(moved.selfScope.address).to.eq(publicScope.address);

            const t7 = Date.now();
            // d. flush reindex queue and invoke explicit reIndex on published node to ensure __LAST_FULL_PUT is updated for it
            await publicScope._hierarchicalReindex!.flush();
            const t8 = Date.now();
            await publicScope.reIndex(moved); // captures hook for this canvas
            const hook = (globalThis as any).__LAST_FULL_PUT;
            // fallback: if hook captured another canvas (rare) run again
            const t9 = Date.now();
            if (!hook || hook.id !== moved.idString) {
                await (publicScope as any).reIndex(moved);
            }
            const hook2 = (globalThis as any).__LAST_FULL_PUT;
            expect(hook2).to.be.ok;

            /* const afterKids = (await root.getChildren()).length;

            console.log(
                `FULL_PUT_PUBLISH_LOOP iter=${iter} draftElems=${DRAFT_ELEMS} ctxMs=${hook2.ctxMs?.toFixed(
                    2
                )} indexMs=${hook2.indexMs?.toFixed(
                    2
                )} totalMs=${hook2.totalMs?.toFixed(
                    2
                )} childrenBefore=${beforeKids} childrenAfter=${afterKids}`
            );

            console.log(
                `TIMINGS iter=${iter} t1-2=${t2 - t1} t2-3=${t3 - t2} t3-4=${
                    t4 - t3
                } t4-5=${t5 - t4} t5-6=${t6 - t5} t6-7=${t7 - t6} t7-8=${
                    t8 - t7
                } t8-9=${t9 - t8}`
            ); */
        }
        // Aggregate idle metrics if collected
        if (process.env.REINDEX_IDLE_TRACE === "1") {
            const events: any[] = (globalThis as any).__REINDEX_IDLE || [];
            const sched = events.filter(
                (e) => e.phase === "idle:scheduleDelay"
            );
            const cooldown = events.filter(
                (e) => e.phase === "idle:cooldownDefer"
            );
            const quantiles = (arr: number[]) => {
                if (!arr.length) return { avg: 0, p50: 0, p90: 0, max: 0 };
                const sorted = [...arr].sort((a, b) => a - b);
                const pick = (p: number) =>
                    sorted[
                        Math.min(
                            sorted.length - 1,
                            Math.floor(p * (sorted.length - 1))
                        )
                    ];
                const sum = sorted.reduce((a, b) => a + b, 0);
                return {
                    avg: sum / sorted.length,
                    p50: pick(0.5),
                    p90: pick(0.9),
                    max: sorted[sorted.length - 1],
                };
            };
            const schedStats = quantiles(sched.map((e) => e.scheduleDelay));
            const cooldownStats = quantiles(cooldown.map((e) => e.remaining));
            console.log(
                `REINDEX_IDLE_SUMMARY scheduleDelay.count=${
                    sched.length
                } scheduleDelay.avg=${schedStats.avg.toFixed(
                    2
                )} scheduleDelay.p50=${schedStats.p50.toFixed(
                    2
                )} scheduleDelay.p90=${schedStats.p90.toFixed(
                    2
                )} scheduleDelay.max=${schedStats.max.toFixed(
                    2
                )} cooldown.defer.count=${
                    cooldown.length
                } cooldown.defer.avg=${cooldownStats.avg.toFixed(
                    2
                )} cooldown.defer.p50=${cooldownStats.p50.toFixed(
                    2
                )} cooldown.defer.p90=${cooldownStats.p90.toFixed(
                    2
                )} cooldown.defer.max=${cooldownStats.max.toFixed(2)}`
            );
        }
    });
});
