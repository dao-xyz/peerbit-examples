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
                program.slotCandidateRowsExamined = 0;
                const samples: number[] = [];
                for (let index = 0; index < 100; index++) {
                    const started = performance.now();
                    expect(await fs.stat(target)).toBeDefined();
                    samples.push(performance.now() - started);
                }
                const rowsByNameEntries = [
                    ...program.slotSweepCache.values(),
                ].reduce(
                    (total: number, bucket: Map<string, unknown>) =>
                        total + bucket.size,
                    0
                );
                return {
                    width,
                    p50Ms: percentile(samples, 0.5),
                    p95Ms: percentile(samples, 0.95),
                    examined: program.slotCandidateRowsExamined,
                    rowsByNameEntries,
                    reverseIndexEntries: program.slotPlacementById.size,
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
        // The /wide row plus one row per uniquely named child: the exact-name
        // index and its cross-parent replacement reverse index each hold one
        // entry per typical cached row. The previous id-keyed bucket held one.
        expect(report.small.rowsByNameEntries).toBe(101);
        expect(report.small.reverseIndexEntries).toBe(101);
        expect(report.wide.rowsByNameEntries).toBe(10_001);
        expect(report.wide.reverseIndexEntries).toBe(10_001);
    }, 120_000);
});
