import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Peerbit } from "peerbit";
import { describe, expect, it } from "vitest";
import { openSharedFs } from "../index.js";

const enabled = process.env.PEERBIT_SHARED_FS_SLOT_CACHE_BENCH === "1";
const manualDescribe = enabled ? describe : describe.skip;
const workerPath = fileURLToPath(
    new URL("./slot-candidate-cache.bench.worker.ts", import.meta.url)
);

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

describe("shared fs public namespace benchmark controls", () => {
    it.each([
        ["wide", enabled ? 10_000 : 8],
        ["versions", enabled ? 1_000 : 8],
        ["churn", enabled ? 100 : 4],
        ["claims", 3],
    ] as const)(
        "validates %s in an isolated process",
        (shape, size) => {
            const result = spawnSync(
                process.execPath,
                ["--import", "tsx", workerPath, shape, String(size)],
                { encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024 }
            );
            if (result.status !== 0) console.log(result.stdout);
            if (result.stderr) console.error(result.stderr);
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            const lines = result.stdout
                .split("\n")
                .filter((line) => line.startsWith("namespace-workload: "));
            expect(lines).toHaveLength(1);
            const report = JSON.parse(
                lines[0].slice("namespace-workload: ".length)
            );
            expect(report).toMatchObject({
                schema: "shared-fs-public-namespace-v1",
                shape,
                size,
                samples: 20,
            });
            expect(report.phases.warmStat.samples).toBe(20);
            for (const phase of Object.values(report.phases) as any[]) {
                expect(phase.totalMs).toBeGreaterThanOrEqual(0);
                expect(phase.indexOnlyRowQueries).toBeGreaterThanOrEqual(0);
                expect(phase.pointCandidateRowsExamined).toBeGreaterThanOrEqual(
                    0
                );
            }
            if (shape === "wide") {
                expect(report.phases.warmStat.pointCandidateRowsExamined).toBe(
                    40
                );
                expect(report.phases.warmStat.indexOnlyRowQueries).toBe(0);
                expect(report.counts.afterPoints.rows).toBe(2);
            } else if (shape === "versions") {
                expect(report.counts.namingAfter).toBe(
                    report.counts.namingBefore
                );
                expect(report.counts.contentVersions).toBe(size + 1);
                expect(report.phases.warmStat.pointCandidateRowsExamined).toBe(
                    40
                );
            } else if (shape === "churn") {
                expect(report.counts.namingAfter).toBe(
                    report.counts.namingBefore + 4 * size
                );
            } else {
                expect(report.counts.claimants).toBe(3);
                expect(report.phases.warmStat.pointCandidateRowsExamined).toBe(
                    60
                );
            }
            // Successful CI evidence needs the same provenance and caveats as
            // a direct worker invocation, not only the timing subset.
            console.log("namespace-workload: " + JSON.stringify(report));
        },
        95_000
    );
});
