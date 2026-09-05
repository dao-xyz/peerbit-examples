import { performance } from "node:perf_hooks";
import { Peerbit } from "peerbit";
import { describe, expect, it } from "vitest";
import { openSharedFs } from "../index.js";

const enabled = process.env.PEERBIT_SHARED_FS_SLOT_CACHE_BENCH === "1";
const manualDescribe = enabled ? describe : describe.skip;

const percentile = (samples: number[], fraction: number) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * fraction) - 1];
};

manualDescribe("shared fs exact slot-candidate benchmark", () => {
    it("keeps warm point lookup work independent of directory width", async () => {
        const run = async (width: number) => {
            const peer = await Peerbit.create();
            try {
                const fs = await openSharedFs({
                    peerbit: peer,
                    machineLabel: `slot-bench-${width}`,
                });
                await fs.mkdir("/wide");
                await fs.writeBatch(
                    Array.from({ length: width }, (_, index) => ({
                        path: `/wide/entry-${String(index).padStart(5, "0")}.txt`,
                        content: "x",
                    }))
                );
                const target = `/wide/entry-${String(
                    Math.floor(width / 2)
                ).padStart(5, "0")}.txt`;
                const program: any = fs.program;
                // Isolate this path's cache footprint from create-stream
                // admission and eviction during the fixture setup.
                program.slotCandidateCache.clear();
                program.slotCandidateRowsExamined = 0;
                const samples: number[] = [];
                for (let index = 0; index < 100; index++) {
                    const started = performance.now();
                    expect(await fs.stat(target)).toBeDefined();
                    samples.push(performance.now() - started);
                }
                const retained = program.slotCandidateCache.snapshot();
                return {
                    width,
                    p50Ms: percentile(samples, 0.5),
                    p95Ms: percentile(samples, 0.95),
                    examined: program.slotCandidateRowsExamined,
                    rowsByNameEntries: retained.slots,
                    reverseIndexEntries: retained.reverse,
                };
            } finally {
                await peer.stop().catch(() => {});
            }
        };

        const report = {
            small: await run(100),
            wide: await run(10_000),
        };
        console.log(
            "slot-candidate cache benchmark:",
            JSON.stringify(report, (_key, value) =>
                typeof value === "number" ? Number(value.toFixed(4)) : value
            )
        );

        // Two candidates per two-segment stat: /wide and the exact leaf.
        // This structural assertion is the portable gate; timings are only
        // descriptive because CI runners are heterogeneous.
        expect(report.small.examined).toBe(200);
        expect(report.wide.examined).toBe(200);
        // A cold point path retains only /wide and the requested child;
        // neither directory width nor unrelated histories are admitted.
        expect(report.small.rowsByNameEntries).toBe(2);
        expect(report.small.reverseIndexEntries).toBe(2);
        expect(report.wide.rowsByNameEntries).toBe(2);
        expect(report.wide.reverseIndexEntries).toBe(2);
    }, 120_000);
});
