import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { StringMatch } from "@peerbit/document";
import { Peerbit } from "peerbit";
import { describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import { Cells } from "../readiness/cells.js";
import { M } from "../readiness/constants.js";
import { decodeStructures, structuresPath } from "../readiness/persist.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import { NAMESPACE_V1, SCOPE_NAMESPACE_V1 } from "../readiness/scopes.js";
import { compareScope } from "../readiness/shadow.js";
import { ScopeTap, documentsIndexPort } from "../readiness/tap.js";

/**
 * K2 measurement (M1 plan sections 7.2 and 10.6): the product tap's
 * main-thread upkeep per add, replace and CUT on the write path, the anchor
 * worker's lag, the freeze round trip, and restore against rebuild, at 50k
 * and 200k namespace rows. Bench lane only (S16):
 *
 *   PEERBIT_SHARED_FS_READINESS_BENCH=1 \
 *   [PEERBIT_SHARED_FS_READINESS_BENCH_ROWS=50000,200000] \
 *   [PEERBIT_SHARED_FS_READINESS_BENCH_OUT=results.ndjson] \
 *   CI=true pnpm exec vitest run ... src/__tests__/readiness-upkeep.bench.test.ts
 *
 * Exit (plan section 7.2): main-thread p90 <= 20 us for adds and replaces
 * at 200k; the worker lag bounded and back to 0 within 1 s after ingest
 * stops; the restore (map plus cells) < 200 ms at 200k.
 */

const enabled = process.env.PEERBIT_SHARED_FS_READINESS_BENCH === "1";
const manualDescribe = enabled ? describe : describe.skip;
const targets = (
    process.env.PEERBIT_SHARED_FS_READINESS_BENCH_ROWS ?? "50000,200000"
)
    .split(",")
    .map(Number);
const out = process.env.PEERBIT_SHARED_FS_READINESS_BENCH_OUT;

const r2 = (x: number) => Math.round(x * 100) / 100;
const percentile = (values: number[], p: number) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[
        Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ];
};
/** Nanosecond samples as microsecond percentiles. */
const summarize = (ns: number[]) => ({
    n: ns.length,
    p50_us: r2(percentile(ns, 50) / 1000),
    p90_us: r2(percentile(ns, 90) / 1000),
    p99_us: r2(percentile(ns, 99) / 1000),
    max_us: r2(ns.reduce((a, b) => Math.max(a, b), 0) / 1000),
});
const msSummary = (ms: number[]) => ({
    n: ms.length,
    p50_ms: r2(percentile(ms, 50)),
    p99_ms: r2(percentile(ms, 99)),
});

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime =>
    (fs.program as any).readinessRuntime;

/**
 * Times every change event through the tap: the listener calls
 * `tap.onChange`, so an instance wrapper sees exactly the main-thread work.
 * Each event's time is divided over the element changes it caused and
 * filed under its kind. The replace verify's index read (async, also main
 * thread, one per replace) is timed separately as `verify`.
 */
const instrument = (runtime: ReadinessRuntime) => {
    const state = runtime.scope(SCOPE_NAMESPACE_V1)!;
    const { tap, laneSet } = state;
    const samples = {
        add: [] as number[],
        replace: [] as number[],
        cut: [] as number[],
        verify: [] as number[],
    };
    const port = tap.port as { readHead: typeof tap.port.readHead };
    const readHead = port.readHead.bind(port);
    port.readHead = async (key) => {
        const t0 = performance.now();
        try {
            return await readHead(key);
        } finally {
            samples.verify.push((performance.now() - t0) * 1e6);
        }
    };
    let lagHighWater = 0;
    const original = tap.onChange.bind(tap);
    tap.onChange = (event: any) => {
        const { adds, replaces, removes } = tap.stats;
        const t0 = performance.now();
        original(event);
        const ns = (performance.now() - t0) * 1e6;
        const dAdds = tap.stats.adds - adds;
        const dReplaces = tap.stats.replaces - replaces;
        const dRemoves = tap.stats.removes - removes;
        const rows = dAdds + dReplaces + dRemoves;
        if (rows > 0) {
            const perRow = ns / rows;
            const kind =
                dReplaces > 0 ? "replace" : dRemoves > 0 ? "cut" : "add";
            samples[kind].push(perRow);
        }
        lagHighWater = Math.max(lagHighWater, laneSet.lag());
    };
    return {
        state,
        samples,
        lag: () => lagHighWater,
        resetLag: () => (lagHighWater = 0),
    };
};

manualDescribe("readiness upkeep bench", () => {
    for (const target of targets) {
        it(
            `upkeep, lag, freeze and restore at ${target} rows`,
            { timeout: 3_600_000 },
            async () => {
                const root = await mkdtemp(
                    join(tmpdir(), "shared-fs-readiness-bench-")
                );
                const rows: Record<string, unknown>[] = [];
                const emit = (row: Record<string, unknown>) => {
                    const line = JSON.stringify({
                        bench: "readiness-upkeep",
                        target,
                        load1: r2(loadavg()[0]),
                        node: process.version,
                        at: new Date().toISOString(),
                        ...row,
                    });
                    rows.push(JSON.parse(line));
                    if (out) appendFileSync(out, line + "\n");
                    console.log(line);
                };
                const directory = join(root, "peer");
                let peer = await Peerbit.create({ directory });
                try {
                    let fs = await openSharedFs({
                        peerbit: peer,
                        bootstrap: false,
                        gc: false,
                    });
                    const address = fs.address!;
                    let runtime = runtimeOf(fs);
                    await runtime.whenStarted();
                    expect(runtime.anchorHost!.mode).toBe("worker");
                    const probe = instrument(runtime);
                    const { tap, laneSet, cells } = probe.state;

                    // ---- grow through the product write path
                    const BATCH = 1000;
                    let files = 0;
                    const growStart = performance.now();
                    while (tap.count < target) {
                        await fs.writeBatch(
                            Array.from({ length: BATCH }, (_, i) => ({
                                path: `/g${Math.floor((files + i) / 5000)}/f${files + i}.txt`,
                                content: `v0-${files + i}`,
                            }))
                        );
                        files += BATCH;
                    }
                    const ingestEnd = performance.now();
                    const growLag = probe.lag();
                    // The backlog drains at worker speed: a digest at the
                    // current seq returns once the worker reached it.
                    await laneSet.digestNow().digest;
                    const drainMs = performance.now() - ingestEnd;
                    emit({
                        phase: "grow",
                        rows: tap.count,
                        files,
                        wallS: r2((ingestEnd - growStart) / 1000),
                        add: summarize(probe.samples.add.splice(0)),
                        lagHighWater: growLag,
                        drainMs: r2(drainMs),
                        lagAfterDrain: laneSet.lag(),
                    });

                    // ---- mixed workload at the target, per kind
                    const program: any = fs.program;
                    const ids = async (
                        kind: string,
                        n: number,
                        offset: number
                    ) =>
                        (
                            await program.entries.index.index
                                .iterate(
                                    {
                                        query: [
                                            new StringMatch({
                                                key: "kind",
                                                value: kind,
                                            }),
                                        ],
                                    },
                                    { shape: { id: true } }
                                )
                                .all()
                        )
                            .slice(offset, offset + n)
                            .map((row: any) => row.value.id as string);
                    const measure = async (
                        label: string,
                        fn: () => Promise<void>
                    ) => {
                        for (const list of Object.values(probe.samples)) {
                            list.length = 0;
                        }
                        probe.resetLag();
                        const t0 = performance.now();
                        await fn();
                        await tap.verifyIdle();
                        const wallMs = performance.now() - t0;
                        const lagHighWater = probe.lag();
                        const t1 = performance.now();
                        await laneSet.digestNow().digest;
                        emit({
                            phase: "mixed",
                            kind: label,
                            rows: tap.count,
                            add: summarize(probe.samples.add.splice(0)),
                            replace: summarize(probe.samples.replace.splice(0)),
                            cut: summarize(probe.samples.cut.splice(0)),
                            // Index reads of replace verifies (async).
                            verify: summarize(probe.samples.verify.splice(0)),
                            wallMs: r2(wallMs),
                            lagHighWater,
                            drainMs: r2(performance.now() - t1),
                            lagAfterDrain: laneSet.lag(),
                        });
                    };
                    await measure("edit(writeBatch)", async () => {
                        for (let b = 0; b < 3; b++) {
                            await fs.writeBatch(
                                Array.from({ length: 1000 }, (_, i) => ({
                                    path: `/g${Math.floor((b * 1000 + i) / 5000)}/f${b * 1000 + i}.txt`,
                                    content: `v1-${b}-${i}`,
                                }))
                            );
                        }
                    });
                    await measure("delete(writeBatch)", async () => {
                        await fs.writeBatch(
                            Array.from({ length: 1000 }, (_, i) => ({
                                path: `/g${Math.floor((5000 + i) / 5000)}/f${5000 + i}.txt`,
                                delete: true as const,
                            }))
                        );
                    });
                    const cutTargets = [
                        ...(await ids("file-version", 1000, 5000)),
                        ...(await ids("naming", 1000, 5000)),
                    ];
                    await measure("cut(entries.del)", async () => {
                        for (const id of cutTargets) {
                            await program.entries.del(id);
                        }
                    });
                    const reputTargets = await ids("naming", 1000, 3000);
                    await measure("replace(put, non-unique)", async () => {
                        for (const id of reputTargets) {
                            const doc = await program.entries.index.get(id, {
                                local: true,
                                remote: false,
                            });
                            await program.entries.put(doc);
                        }
                    });
                    const uniqueTargets = await ids("file-version", 300, 3000);
                    await measure("replace(put, unique)", async () => {
                        for (const id of uniqueTargets) {
                            const doc = await program.entries.index.get(id, {
                                local: true,
                                remote: false,
                            });
                            await program.entries.put(doc, { unique: true });
                        }
                    });

                    // ---- freeze: cells copy plus one digest round trip
                    {
                        await tap.verifyIdle();
                        const copyNs: number[] = [];
                        const roundTripMs: number[] = [];
                        for (let i = 0; i < 100; i++) {
                            const t0 = performance.now();
                            cells.copy();
                            const { digest } = laneSet.digestNow();
                            copyNs.push((performance.now() - t0) * 1e6);
                            await digest;
                            roundTripMs.push(performance.now() - t0);
                        }
                        // `above` for a responder with hlcProved > 0: O(n).
                        const aboveMs: number[] = [];
                        for (let i = 0; i < 20; i++) {
                            const t0 = performance.now();
                            tap.above(tap.hlc / 2n);
                            aboveMs.push(performance.now() - t0);
                        }
                        emit({
                            phase: "freeze",
                            copy: summarize(copyNs),
                            roundTrip: msSummary(roundTripMs),
                            above: msSummary(aboveMs),
                        });
                    }

                    // ---- shadow at the target (the K2 comparison)
                    {
                        const t0 = performance.now();
                        const outcome = await compareScope(
                            probe.state,
                            runtime.cellKey
                        );
                        emit({
                            phase: "shadow",
                            rows: tap.count,
                            outcome,
                            ms: r2(performance.now() - t0),
                        });
                        expect(outcome.kind).toBe("equal");
                    }

                    // ---- clean close: the structures file; restore vs rebuild
                    const closeStart = performance.now();
                    await peer.stop();
                    const closeMs = performance.now() - closeStart;
                    const file = await structuresPath(
                        directory,
                        address,
                        NAMESPACE_V1
                    );
                    const bytes = await readFile(file);
                    const restoreMs: number[] = [];
                    for (let rep = 0; rep < 3; rep++) {
                        const t0 = performance.now();
                        const decoded = decodeStructures(
                            bytes,
                            address,
                            SCOPE_NAMESPACE_V1
                        );
                        if (!decoded.ok) throw new Error(decoded.reason);
                        const restored = new Cells(
                            M,
                            runtime.cellKey[0],
                            runtime.cellKey[1]
                        );
                        restored.restore(decoded.state.cells);
                        restoreMs.push(performance.now() - t0);
                    }

                    peer = await Peerbit.create({ directory });
                    const openStart = performance.now();
                    fs = await openSharedFs({
                        peerbit: peer,
                        address,
                        bootstrap: false,
                        gc: false,
                    });
                    const openMs = performance.now() - openStart;
                    runtime = runtimeOf(fs);
                    await runtime.whenStarted();
                    const startedMs = performance.now() - openStart;
                    const start = runtime.starts.get("namespace-v1");
                    const rebuildMs: number[] = [];
                    for (let rep = 0; rep < 3; rep++) {
                        const t0 = performance.now();
                        const fresh = new ScopeTap(
                            NAMESPACE_V1,
                            documentsIndexPort(
                                (fs.program as any).entries,
                                NAMESPACE_V1
                            )
                        );
                        fresh.addSink(
                            new Cells(M, runtime.cellKey[0], runtime.cellKey[1])
                        );
                        await fresh.seedFromScan();
                        rebuildMs.push(performance.now() - t0);
                    }
                    emit({
                        phase: "persist",
                        fileBytes: bytes.length,
                        closeMs: r2(closeMs),
                        restoreMs: restoreMs.map(r2),
                        reopenMs: r2(openMs),
                        reopenStartedMs: r2(startedMs),
                        start,
                        rebuildCellsMapMs: rebuildMs.map(r2),
                        rows: runtime.namespace!.count,
                    });
                    expect(start).toEqual({ kind: "restored" });
                    const shadow = await compareScope(
                        runtime.scope(SCOPE_NAMESPACE_V1)!,
                        runtime.cellKey
                    );
                    expect(shadow.kind).toBe("equal");
                    emit({
                        phase: "host",
                        stats: { ...runtime.anchorHost!.stats },
                    });
                } finally {
                    await peer.stop().catch(() => {});
                    await rm(root, { recursive: true, force: true });
                }
                expect(rows.length).toBeGreaterThan(0);
            }
        );
    }
});
