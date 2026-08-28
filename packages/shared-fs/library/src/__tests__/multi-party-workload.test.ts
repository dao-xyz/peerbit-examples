import { performance } from "node:perf_hooks";
import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";

/**
 * Multi-party workload benchmark: many writers churning a shared tree at
 * high frequency — bursts of small edits, hot files saved hundreds of
 * times, wide directories, and cold joins. Budgets are generous (CI noise)
 * but fail long before the workload becomes interactive-unusable; medians
 * print to CI output for trend tracking.
 */

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

const waitUntil = async (
    assertion: () => Promise<void> | void,
    options: { timeoutMs?: number; intervalMs?: number } = {}
) => {
    const timeoutMs = options.timeoutMs ?? (process.env.CI ? 90_000 : 30_000);
    const intervalMs = options.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    throw lastError;
};

const report = (label: string, data: Record<string, number>) => {
    console.log(
        `multi-party ${label}:`,
        JSON.stringify(data, (key, value) =>
            typeof value === "number" ? Number(value.toFixed(2)) : value
        )
    );
};

describe("shared fs multi-party workload", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({ peerbit: peer, machineLabel: "workload" });
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
        "keeps hot-file reads flat while a file accumulates hundreds of versions",
        { retry: 1, timeout: 240_000 },
        async () => {
            await fs.mkdir("/src");
            await fs.writeFile("/src/hot.ts", "revision 0");
            const statCold = await measureMedian(20, () =>
                fs.stat("/src/hot.ts")
            );
            const readCold = await measureMedian(20, () =>
                fs.readFile("/src/hot.ts")
            );

            // A frequently-edited file: 300 distinct saves.
            for (let i = 1; i <= 300; i++) {
                await fs.writeFile("/src/hot.ts", `revision ${i}`);
            }

            const statHot = await measureMedian(20, () =>
                fs.stat("/src/hot.ts")
            );
            const readHot = await measureMedian(20, () =>
                fs.readFile("/src/hot.ts")
            );
            const listHot = await measureMedian(10, () => fs.list("/src"));
            report("hot-file", {
                statCold,
                statHot,
                readCold,
                readHot,
                listHot,
            });
            expect(decode(await fs.readFile("/src/hot.ts"))).toBe(
                "revision 300"
            );

            // The load-bearing budget: per-operation latency must not scale
            // with the number of retained versions of the file.
            expect(statHot).toBeLessThan(statCold * 4 + 5);
            expect(readHot).toBeLessThan(readCold * 4 + 5);
        }
    );

    it(
        "absorbs write bursts across a tree at interactive latency",
        { retry: 1, timeout: 240_000 },
        async () => {
            await fs.mkdir("/project");
            for (const dir of ["a", "b", "c", "d"]) {
                await fs.mkdir(`/project/${dir}`);
            }
            // One burst = 100 small edits spread over the tree (a large
            // multi-file change applied at once).
            const burst = async (round: number) => {
                const start = performance.now();
                for (let i = 0; i < 100; i++) {
                    const dir = ["a", "b", "c", "d"][i % 4];
                    await fs.writeFile(
                        `/project/${dir}/file-${i}.txt`,
                        `round ${round} content ${i}`
                    );
                }
                return performance.now() - start;
            };
            const first = await burst(0);
            const second = await burst(1); // overwrites: version churn
            const third = await burst(2);
            report("burst-100-files", { first, second, third });
            // A 100-file burst must stay comfortably interactive, and
            // overwrite bursts must not degrade versus creation bursts.
            expect(third).toBeLessThan(first * 4 + 2_000);
            expect(decode(await fs.readFile("/project/a/file-0.txt"))).toBe(
                "round 2 content 0"
            );
        }
    );

    it(
        "lists wide directories at usable latency",
        { retry: 1, timeout: 240_000 },
        async () => {
            await fs.mkdir("/wide");
            for (let i = 0; i < 2000; i++) {
                await fs.writeFile(
                    `/wide/entry-${String(i).padStart(5, "0")}.txt`,
                    `content ${i}`
                );
            }
            const listWide = await measureMedian(5, () => fs.list("/wide"));
            const statOne = await measureMedian(20, () =>
                fs.stat("/wide/entry-01000.txt")
            );
            report("wide-directory", { entries: 2000, listWide, statOne });
            expect((await fs.list("/wide")).length).toBe(2000);
            // Single-entry operations must not pay for directory width.
            expect(statOne).toBeLessThan(15);
        }
    );
});

describe("shared fs multi-party propagation", () => {
    const peers: Peerbit[] = [];

    afterEach(async () => {
        await Promise.allSettled(
            peers.splice(0).map(async (peer) => {
                try {
                    await peer.stop();
                } catch {
                    /* benign close races */
                }
            })
        );
    });

    it(
        "propagates edits between parties quickly and cold-joins a populated tree",
        { retry: 1, timeout: 240_000 },
        async () => {
            const a = await Peerbit.create();
            const b = await Peerbit.create();
            peers.push(a, b);
            await a.dial(b);
            const fsA = await openSharedFs({
                peerbit: a,
                machineLabel: "party-a",
            });
            const fsB = await openSharedFs({
                peerbit: b,
                address: fsA.address,
                machineLabel: "party-b",
            });

            // Write→visible latency for a stream of small edits.
            await fsA.mkdir("/live");
            const latencies: number[] = [];
            for (let i = 0; i < 20; i++) {
                const start = performance.now();
                await fsA.writeFile("/live/ping.txt", `tick ${i}`);
                await waitUntil(
                    async () => {
                        expect(
                            decode(await fsB.readFile("/live/ping.txt"))
                        ).toBe(`tick ${i}`);
                    },
                    { intervalMs: 10 }
                );
                latencies.push(performance.now() - start);
            }
            const propagation = median(latencies);

            // Cold join: a third party attaches after 500 files exist.
            await fsA.mkdir("/tree");
            for (let i = 0; i < 500; i++) {
                await fsA.writeFile(`/tree/f-${i}.txt`, `payload ${i}`);
            }
            await waitUntil(async () => {
                expect((await fsB.list("/tree")).length).toBe(500);
            });
            const c = await Peerbit.create();
            peers.push(c);
            await c.dial(a);
            const joinStart = performance.now();
            const fsC = await openSharedFs({
                peerbit: c,
                address: fsA.address,
                machineLabel: "party-c",
            });
            await waitUntil(async () => {
                expect((await fsC.list("/tree")).length).toBe(500);
                expect(decode(await fsC.readFile("/tree/f-499.txt"))).toBe(
                    "payload 499"
                );
            });
            const coldJoin = performance.now() - joinStart;
            report("propagation", {
                medianWriteToVisibleMs: propagation,
                coldJoin500Files: coldJoin,
            });
            // Edits between live parties must land sub-second on a local
            // link; a 500-file cold join must complete within the budget.
            expect(propagation).toBeLessThan(process.env.CI ? 5_000 : 1_500);
            expect(coldJoin).toBeLessThan(process.env.CI ? 90_000 : 45_000);
        }
    );
});
