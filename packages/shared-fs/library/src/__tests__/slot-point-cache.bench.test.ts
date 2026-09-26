import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Peerbit } from "peerbit";
import { describe, expect, it } from "vitest";
import {
    IndexableSharedFsEntry,
    NamingEvent,
    SharedFileSystem,
    openSharedFs,
} from "../index.js";

const enabled = process.env.PEERBIT_SHARED_FS_SLOT_CACHE_BENCH === "1";
const manualDescribe = enabled ? describe : describe.skip;
const widths = (
    process.env.PEERBIT_SHARED_FS_SLOT_CACHE_BENCH_WIDTHS ?? "100,10000"
)
    .split(",")
    .filter((value) => value.trim() !== "")
    .map((value) => Number(value.trim()));
const indexWidth = Number(
    process.env.PEERBIT_SHARED_FS_SLOT_CACHE_BENCH_INDEX_WIDTH ?? 100_000
);

const percentile = (samples: number[], fraction: number) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * fraction) - 1];
};

type QueryKind = "point" | "sweep" | "node";

/**
 * Point metadata lookups in one wide directory, cold and warm. The bench only
 * uses public operations plus cache fields that exist on both this design and
 * the previous sweep-only one, so the same file can measure a baseline.
 */
manualDescribe("shared fs exact slot point-lookup benchmark", () => {
    it("measures cold and warm point lookups by directory width", async () => {
        const run = async (width: number) => {
            const peer = await Peerbit.create();
            try {
                const fs = await openSharedFs({
                    peerbit: peer,
                    machineLabel: `slot-bench-${width}`,
                });
                const program: any = fs.program;
                const counts: Record<QueryKind, number> = {
                    point: 0,
                    sweep: 0,
                    node: 0,
                };
                const queryRows = program.queryRows.bind(program);
                program.queryRows = async (query: any[]) => {
                    const keys = new Set(
                        query.map((clause) =>
                            Array.isArray(clause.key)
                                ? clause.key.join(".")
                                : clause.key
                        )
                    );
                    counts[
                        keys.has("name")
                            ? "point"
                            : keys.has("parentId")
                              ? "sweep"
                              : "node"
                    ]++;
                    return queryRows(query);
                };
                const take = () => {
                    const taken = { ...counts };
                    counts.point = counts.sweep = counts.node = 0;
                    return taken;
                };
                const clearCaches = () => {
                    program.slotSweepCache.clear();
                    program.slotPointCache?.clear();
                    program.namingRowCache.clear();
                    program.versionRowCache.clear();
                };
                // Forget only the wide directory's own slots; its entry in the
                // root and the per-node caches stay warm.
                const forgetWideSlots = (wideId: string) => {
                    program.slotSweepCache.delete(wideId);
                    program.slotPointCache?.evictParent(wideId);
                };
                const timed = async <T>(operation: () => Promise<T>) => {
                    const started = performance.now();
                    const value = await operation();
                    return { ms: performance.now() - started, value };
                };
                const name = (index: number) =>
                    `/wide/entry-${String(index).padStart(6, "0")}.txt`;

                await fs.mkdir("/wide");
                const setupStarted = performance.now();
                for (let start = 0; start < width; start += 5_000) {
                    await fs.writeBatch(
                        Array.from(
                            { length: Math.min(5_000, width - start) },
                            (_, offset) => ({
                                path: name(start + offset),
                                content: "x",
                            })
                        )
                    );
                    console.error(
                        JSON.stringify({
                            phase: "setup",
                            width,
                            entries: Math.min(start + 5_000, width),
                            elapsedMs: Math.round(
                                performance.now() - setupStarted
                            ),
                            queries: { ...counts },
                        })
                    );
                }
                const setupMs = performance.now() - setupStarted;
                const setupQueries = take();

                // Resolve /wide once so every measured lookup below only
                // differs in how the wide directory's own slot is answered.
                clearCaches();
                const wideId = (await fs.stat("/wide"))!.nodeId;
                take();

                const target = name(Math.floor(width / 2));
                const coldHit = await timed(() => fs.stat(target));
                expect(coldHit.value).toBeDefined();
                const coldHitQueries = take();
                const warmHits: number[] = [];
                for (let index = 0; index < 100; index++) {
                    warmHits.push((await timed(() => fs.stat(target))).ms);
                }
                const warmHitQueries = take();

                forgetWideSlots(wideId);
                const coldMiss = await timed(() => fs.stat("/wide/absent"));
                expect(coldMiss.value).toBeUndefined();
                const coldMissQueries = take();
                const warmMisses: number[] = [];
                for (let index = 0; index < 100; index++) {
                    warmMisses.push(
                        (await timed(() => fs.stat("/wide/absent"))).ms
                    );
                }
                const warmMissQueries = take();

                forgetWideSlots(wideId);
                const list = await timed(() => fs.list("/wide"));
                expect(list.value).toHaveLength(width);
                const listQueries = take();
                const afterList = await timed(() => fs.stat(name(width - 1)));
                expect(afterList.value).toBeDefined();
                const afterListQueries = take();

                return {
                    width,
                    setupMs,
                    setupQueries,
                    coldHitMs: coldHit.ms,
                    coldHitQueries,
                    warmHitP50Ms: percentile(warmHits, 0.5),
                    warmHitP95Ms: percentile(warmHits, 0.95),
                    warmHitQueries,
                    coldMissMs: coldMiss.ms,
                    coldMissQueries,
                    warmMissP50Ms: percentile(warmMisses, 0.5),
                    warmMissP95Ms: percentile(warmMisses, 0.95),
                    warmMissQueries,
                    coldListMs: list.ms,
                    listQueries,
                    statAfterListMs: afterList.ms,
                    afterListQueries,
                    pointCache: program.slotPointCache?.snapshot(),
                };
            } finally {
                await peer.stop().catch(() => {});
            }
        };

        const report = [];
        for (const width of widths) report.push(await run(width));
        console.log(
            "slot point-lookup benchmark:",
            JSON.stringify(
                report,
                (_key, value) =>
                    typeof value === "number"
                        ? Number(value.toFixed(3))
                        : value,
                2
            )
        );

        // Structural gates only; timings are descriptive because CI runners
        // are heterogeneous.
        for (const result of report) {
            expect(result.warmHitQueries).toEqual({
                point: 0,
                sweep: 0,
                node: 0,
            });
            expect(result.warmMissQueries).toEqual({
                point: 0,
                sweep: 0,
                node: 0,
            });
            // A listed directory answers its slots without slot queries.
            expect(result.afterListQueries.point).toBe(0);
            expect(result.afterListQueries.sweep).toBe(0);
            if (result.pointCache) {
                // Cold lookups read one exact slot, never the whole parent.
                expect(result.coldHitQueries.sweep).toBe(0);
                expect(result.coldHitQueries.point).toBe(1);
                expect(result.coldMissQueries).toEqual({
                    point: 1,
                    sweep: 0,
                    node: 0,
                });
            }
        }
    }, 600_000);
    it("measures exact lookups against a seeded wide SQLite index", async () => {
        // Seeds one directory's naming rows straight into a disk-backed
        // SQLite index (no log, signing, or content), so 100k widths are
        // reachable in minutes. Path resolution then runs unchanged on top.
        const parentId = "dir:bench-wide";
        const entryName = (i: number) =>
            `entry-${String(i).padStart(6, "0")}.txt`;
        // Loaded only when the gated case runs; the library does not depend
        // on the SQLite indexer directly (Peerbit provides it).
        const { create } = await import("@peerbit/indexer-sqlite3");
        const directory = await mkdtemp(join(tmpdir(), "shared-fs-slot-"));
        const indices = await create(directory);
        try {
            await indices.start();
            const index = await indices.init({
                schema: IndexableSharedFsEntry,
                indexBy: ["id"],
            });
            const seedStarted = performance.now();
            for (let i = 0; i < indexWidth; i++) {
                await index.put(
                    new IndexableSharedFsEntry(
                        new NamingEvent({
                            id: `naming:bench-${i}`,
                            nodeId: `file:bench-${i}`,
                            parentId,
                            name: entryName(i),
                            causalDepth: 1n,
                            parentNamingIds: [],
                            createdAt: BigInt(i + 1),
                            authorKey: "bench-author",
                            machineLabel: "bench-machine",
                        })
                    )
                );
            }
            const seedMs = performance.now() - seedStarted;

            const program: any = new SharedFileSystem();
            const counts = { point: 0, sweep: 0, node: 0, rows: 0 };
            program.queryRows = async (query: any[]) => {
                const keys = new Set(
                    query.map((clause) => [clause.key].flat().join("."))
                );
                counts[
                    keys.has("name")
                        ? "point"
                        : keys.has("parentId")
                          ? "sweep"
                          : "node"
                ]++;
                const rows = (await index.iterate({ query }).all()).map(
                    (result: any) => result.value
                );
                counts.rows += rows.length;
                return rows;
            };
            const take = () => {
                const taken = { ...counts };
                counts.point = counts.sweep = counts.node = counts.rows = 0;
                return taken;
            };
            const forgetSlots = () => {
                program.slotSweepCache.clear();
                program.slotPointCache?.clear();
            };
            const resolve = async (name: string) => {
                const started = performance.now();
                const slot = await program.slotResolution(parentId, name);
                return { ms: performance.now() - started, slot };
            };
            const target = entryName(Math.floor(indexWidth / 2));

            const coldHit = await resolve(target);
            expect(coldHit.slot?.nodeId).toBe(
                `file:bench-${Math.floor(indexWidth / 2)}`
            );
            const coldHitQueries = take();
            const warmHits: number[] = [];
            for (let i = 0; i < 100; i++)
                warmHits.push((await resolve(target)).ms);
            const warmHitQueries = take();
            forgetSlots();
            const coldMiss = await resolve("absent.txt");
            expect(coldMiss.slot).toBeUndefined();
            const coldMissQueries = take();
            const warmMisses: number[] = [];
            for (let i = 0; i < 100; i++)
                warmMisses.push((await resolve("absent.txt")).ms);
            const warmMissQueries = take();
            program.clearBootstrapTimers();

            const report = {
                width: indexWidth,
                seedMs,
                coldHitMs: coldHit.ms,
                coldHitQueries,
                warmHitP50Ms: percentile(warmHits, 0.5),
                warmHitP95Ms: percentile(warmHits, 0.95),
                warmHitQueries,
                coldMissMs: coldMiss.ms,
                coldMissQueries,
                warmMissP50Ms: percentile(warmMisses, 0.5),
                warmMissP95Ms: percentile(warmMisses, 0.95),
                warmMissQueries,
                pointCache: program.slotPointCache?.snapshot(),
            };
            console.log(
                "slot point-lookup index benchmark:",
                JSON.stringify(
                    report,
                    (_key, value) =>
                        typeof value === "number"
                            ? Number(value.toFixed(3))
                            : value,
                    2
                )
            );
            const none = { point: 0, sweep: 0, node: 0, rows: 0 };
            expect(warmHitQueries).toEqual(none);
            expect(warmMissQueries).toEqual(none);
            if (program.slotPointCache) {
                expect(coldHitQueries).toMatchObject({ point: 1, sweep: 0 });
                expect(coldMissQueries).toEqual({ ...none, point: 1 });
            }
        } finally {
            await indices.stop().catch(() => {});
            await rm(directory, { recursive: true, force: true });
        }
    }, 600_000);
});
