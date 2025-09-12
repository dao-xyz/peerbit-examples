import { expect } from "chai";
import { TestSession } from "@peerbit/test-utils";
import { describe, it, beforeEach, afterEach } from "vitest";
import { Scope } from "../content.js";
// Install runtime monkey profiler (no-op unless SCOPE_OPEN_PROFILE=1)
// Import after other modules so we can patch loaded constructors more reliably.
import "../test-utils/monkey-profiler";

/**
 * Profiles repeated Scope open cost.
 * Uses instrumentation already added in content.ts when SCOPE_OPEN_PROFILE=1.
 * Env vars:
 *  SCOPE_OPEN_PROFILE=1  -> enable per-phase logging
 *  SCOPE_OPEN_N (default 25)
 *  SCOPE_PARALLEL_OPEN=1 -> test parallel open variant (phases still reported individually)
 */

describe("scope open profiling", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(1);
        process.env.SCOPE_OPEN_PROFILE = "1"; // force instrumentation
    });

    afterEach(async () => {
        await session.stop();
    });

    it("opens many scopes sequentially", async () => {
        const peer = session.peers[0];
        const N = Number(process.env.SCOPE_OPEN_N || 25);

        // Clear previous collected profile events if any
        (globalThis as any).__SCOPE_OPEN_PROFILE = [];

        const totals: number[] = [];
        for (let i = 0; i < N; i++) {
            await peer.open(new Scope({ publicKey: peer.identity.publicKey }), {
                args: { replicate: false, debug: false },
            });
            const latest = (globalThis as any).__SCOPE_OPEN_PROFILE?.slice(
                -1
            )[0];
            if (latest) {
                totals.push(latest.total);
                console.log(
                    `SCOPE_OPEN_LOOP iter=${i} total=${
                        latest.total
                    } phases=${latest.phases
                        .map((p: any) => p.phase + ":" + p.dt)
                        .join(",")}`
                );
            }
        }

        // Instrumentation may be disabled or not collected; only assert shape if present
        if (totals.length > 0) {
            expect(totals.length).to.eq(N);
        }

        if (totals.length > 0) {
            // Basic summary stats
            const sorted = [...totals].sort((a, b) => a - b);
            const pick = (p: number) =>
                sorted[
                    Math.min(
                        sorted.length - 1,
                        Math.floor(p * (sorted.length - 1))
                    )
                ];
            const sum = totals.reduce((a, b) => a + b, 0);
            const summary = {
                count: N,
                avg: +(sum / N).toFixed(2),
                p50: +pick(0.5).toFixed(2),
                p90: +pick(0.9).toFixed(2),
                max: +sorted[sorted.length - 1].toFixed(2),
                min: +sorted[0].toFixed(2),
            };
            console.log(
                `SCOPE_OPEN_SUMMARY count=${summary.count} avg=${summary.avg} p50=${summary.p50} p90=${summary.p90} max=${summary.max} min=${summary.min}`
            );
        }
    });
});
