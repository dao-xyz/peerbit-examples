import { performance } from "node:perf_hooks";
import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
};

const measureMedian = async (
    samples: number,
    fn: () => Promise<unknown>
): Promise<number> => {
    const timings: number[] = [];
    for (let i = 0; i < samples; i++) {
        const start = performance.now();
        await fn();
        timings.push(performance.now() - start);
    }
    return median(timings);
};

/**
 * Guards against O(store)-per-operation regressions. Before 0.1.0 every
 * operation rebuilt a full projection of the entire store, so per-op latency
 * grew linearly with total document count (measured ~10x from 100 to 1000
 * files). The indexed implementation is O(result); these ratios allow
 * generous CI noise (4x) while failing long before linear cost returns.
 *
 * Deterministic complement: shared-fs.test.ts asserts metadata operations
 * resolve fewer than 10 documents regardless of unrelated store contents.
 */
describe("shared fs scaling guard", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({
            peerbit: peer,
            machineLabel: "scaling-guard",
        });
    });

    afterEach(async () => {
        try {
            await peer.stop();
        } catch (error) {
            if (
                !(
                    error instanceof TypeError &&
                    error.message.includes("clearAll")
                )
            ) {
                throw error;
            }
        }
    });

    it(
        "keeps per-operation latency flat while the store grows 20x",
        { retry: 1, timeout: 240_000 },
        async () => {
            // A small probe directory whose operations should not care about the
            // unrelated bulk data at all.
            await fs.mkdir("/probe");
            for (let i = 0; i < 5; i++) {
                await fs.writeFile(`/probe/file-${i}.txt`, `probe ${i}`);
            }

            await fs.mkdir("/bulk");
            const writeSamplesSmall: number[] = [];
            for (let i = 0; i < 50; i++) {
                const start = performance.now();
                await fs.writeFile(
                    `/bulk/small-${String(i).padStart(5, "0")}.txt`,
                    `bulk content ${i}`
                );
                writeSamplesSmall.push(performance.now() - start);
            }

            const statSmall = await measureMedian(30, () =>
                fs.stat("/probe/file-2.txt")
            );
            const readSmall = await measureMedian(30, async () => {
                const bytes = await fs.readFile("/probe/file-2.txt");
                if (decode(bytes) !== "probe 2") {
                    throw new Error("unexpected probe content");
                }
            });
            const listProbeSmall = await measureMedian(20, () =>
                fs.list("/probe")
            );

            // Grow the store 20x.
            for (let i = 50; i < 1000; i++) {
                await fs.writeFile(
                    `/bulk/small-${String(i).padStart(5, "0")}.txt`,
                    `bulk content ${i}`
                );
            }

            // Let deferred work (index flushes, GC) settle before sampling so
            // the growth loop's tail does not bleed into the measurements.
            await new Promise((resolve) => setTimeout(resolve, 250));
            globalThis.gc?.();

            const writeSamplesLarge: number[] = [];
            for (let i = 1000; i < 1050; i++) {
                const start = performance.now();
                await fs.writeFile(
                    `/bulk/small-${String(i).padStart(5, "0")}.txt`,
                    `bulk content ${i}`
                );
                writeSamplesLarge.push(performance.now() - start);
            }

            const statLarge = await measureMedian(30, () =>
                fs.stat("/probe/file-2.txt")
            );
            const readLarge = await measureMedian(30, async () => {
                const bytes = await fs.readFile("/probe/file-2.txt");
                if (decode(bytes) !== "probe 2") {
                    throw new Error("unexpected probe content");
                }
            });
            const listProbeLarge = await measureMedian(20, () =>
                fs.list("/probe")
            );

            const report = {
                stat: { small: statSmall, large: statLarge },
                read: { small: readSmall, large: readLarge },
                listProbe: { small: listProbeSmall, large: listProbeLarge },
                write: {
                    small: median(writeSamplesSmall),
                    large: median(writeSamplesLarge),
                },
            };
            // Visible in CI output for tracking trends.
            console.log(
                "scaling guard medians (ms):",
                JSON.stringify(report, (key, value) =>
                    typeof value === "number" ? Number(value.toFixed(3)) : value
                )
            );

            // Additive + multiplicative bound: 4x the small-store median plus a
            // 5ms absolute allowance, so sub-millisecond baselines on noisy
            // shared CI runners cannot trip the guard, while a return of
            // O(store) behavior (10x+ growth measured on the old code) still
            // fails decisively.
            const bound = (before: number) => before * 4 + 5;

            expect(statLarge).toBeLessThan(bound(statSmall));
            expect(readLarge).toBeLessThan(bound(readSmall));
            expect(listProbeLarge).toBeLessThan(bound(listProbeSmall));
            expect(median(writeSamplesLarge)).toBeLessThan(
                bound(median(writeSamplesSmall))
            );

            // Sanity: the listing itself must still be correct at scale.
            expect((await fs.list("/bulk")).length).toBe(1050);
        }
    );
});
