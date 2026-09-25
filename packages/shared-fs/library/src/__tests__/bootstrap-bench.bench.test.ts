import { performance } from "node:perf_hooks";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    openSharedFs,
    type BootstrapTelemetryEvent,
    type SharedFsOpenProfileEvent,
} from "../index.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

const enabled = process.env.PEERBIT_SHARED_FS_COLD_JOIN_BENCH === "1";
const manualDescribe = enabled ? describe : describe.skip;

type RunSample = {
    run: number;
    overlayReadyMs: number;
    treeReadableMs: number;
    writeReadyMs: number;
    pendingDrainMs: number;
    retirementTailMs?: number;
    milestonesMs: Record<string, number>;
    durationsMs: Record<string, number>;
    openProfile: SharedFsOpenProfileEvent[];
};

const requiredSharedLogOpenProfileNames = [
    "sharedLog.open.localState",
    "sharedLog.open.blockStore",
    "sharedLog.open.remoteBlocks",
    "sharedLog.open.lowerLog",
    "sharedLog.open.rpcSubscriptions",
    "sharedLog.open.providerAndOwnership",
    "sharedLog.open.replication",
    "sharedLog.open.synchronizer",
    "sharedLog.open.total",
] as const;

const percentile = (values: number[], ratio: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
};

const distribution = (values: number[]) =>
    values.length === 0
        ? undefined
        : {
              p50: percentile(values, 0.5),
              p95: percentile(values, 0.95),
              max: Math.max(...values),
          };

const numberFromEnv = (
    name: string,
    fallback: number,
    minimum: number,
    maximum: number
) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
        throw new Error(
            `${name} must be a number between ${minimum} and ${maximum}`
        );
    }
    return value;
};

manualDescribe("bootstrap benchmark (manual)", () => {
    const peers: Peerbit[] = [];
    afterEach(async () => {
        await Promise.allSettled(peers.splice(0).map((peer) => peer.stop()));
    });

    it(
        "measures sequential 500-file cold joins",
        { timeout: 7_200_000 },
        async () => {
            const runs = numberFromEnv(
                "PEERBIT_SHARED_FS_COLD_JOIN_RUNS",
                15,
                10,
                20
            );
            if (!Number.isInteger(runs)) {
                throw new Error(
                    "PEERBIT_SHARED_FS_COLD_JOIN_RUNS must be an integer"
                );
            }
            const slowThresholdMs = numberFromEnv(
                "PEERBIT_SHARED_FS_COLD_JOIN_SLOW_MS",
                2_500,
                1,
                120_000
            );
            const donorPeer = await Peerbit.create();
            peers.push(donorPeer);
            const donor = await openSharedFs({
                peerbit: donorPeer,
                machineLabel: "benchmark-donor",
            });
            await donor.writeBatch(
                Array.from({ length: 500 }, (_, index) => ({
                    path: `/t/d-${index % 50}/f-${index}.txt`,
                    content: `payload ${index}`,
                }))
            );
            const snapshot = await donor.snapshotWrite();

            const milestoneSamples = new Map<string, number[]>();
            const durationSamples = new Map<string, number[]>();
            const overlayReadySamples: number[] = [];
            const treeReadableSamples: number[] = [];
            const writeReadySamples: number[] = [];
            const pendingDrainSamples: number[] = [];
            const retirementTailSamples: number[] = [];
            const runSamples: RunSample[] = [];

            for (let run = 0; run < runs; run++) {
                const joinPeer = await Peerbit.create();
                peers.push(joinPeer);
                try {
                    await joinPeer.dial(donorPeer);
                    const events: BootstrapTelemetryEvent[] = [];
                    const openProfile: SharedFsOpenProfileEvent[] = [];
                    const startedAt = performance.now();
                    const joiner = await openSharedFs({
                        peerbit: joinPeer,
                        address: donor.address,
                        machineLabel: `benchmark-joiner-${run}`,
                        telemetry: {
                            bootstrap: (event) => events.push(event),
                            openProfile: (event) => openProfile.push(event),
                        },
                    });

                    const overlayDeadline = Date.now() + 180_000;
                    while (
                        !events.some((event) => event.type === "overlay-ready")
                    ) {
                        const terminal = events.find(
                            (event) =>
                                event.type === "fallback" ||
                                event.type === "aborted" ||
                                event.type === "overlay-retired"
                        );
                        if (terminal) {
                            throw new Error(
                                `run ${run + 1} did not reach a readable overlay: ${terminal.type}`
                            );
                        }
                        if (Date.now() >= overlayDeadline) {
                            throw new Error(
                                `run ${run + 1} timed out waiting for overlay-ready (phase=${joiner.bootstrapStatus().phase})`
                            );
                        }
                        await new Promise((resolve) => setTimeout(resolve, 5));
                    }

                    const convergence = joiner.awaitBootstrapConverged();
                    const directories = await joiner.list("/t");
                    let files = 0;
                    for (const directory of directories) {
                        files += (await joiner.list(directory.path)).length;
                    }
                    const sample = decode(
                        await joiner.readFile("/t/d-42/f-42.txt")
                    );
                    const treeReadableMs = performance.now() - startedAt;
                    const converged = await convergence;
                    await joiner.awaitWriteReady({ timeout: 120_000 });

                    expect(converged.verified).toBe(true);
                    expect(directories).toHaveLength(50);
                    expect(files).toBe(500);
                    expect(sample).toBe("payload 42");

                    const runMilestones: Record<string, number> = {};
                    const runDurations: Record<string, number> = {};
                    for (const event of events) {
                        const milestones =
                            milestoneSamples.get(event.type) ?? [];
                        milestones.push(event.atMs);
                        milestoneSamples.set(event.type, milestones);
                        runMilestones[event.type] ??= event.atMs;
                        if ("durationMs" in event) {
                            const durations =
                                durationSamples.get(event.type) ?? [];
                            durations.push(event.durationMs);
                            durationSamples.set(event.type, durations);
                            runDurations[event.type] ??= event.durationMs;
                        }
                    }
                    const overlayReady = events.find(
                        (event) => event.type === "overlay-ready"
                    );
                    const overlayRetired = events.find(
                        (event) => event.type === "overlay-retired"
                    );
                    const pendingDrained = events.find(
                        (event) => event.type === "pending-drained"
                    );
                    const writeReady = events.find(
                        (event) => event.type === "write-ready"
                    );
                    expect(overlayReady?.atMs).toBeTypeOf("number");
                    expect(overlayRetired?.verified).toBe(true);
                    expect(pendingDrained?.durationMs).toBeTypeOf("number");
                    expect(writeReady?.atMs).toBeTypeOf("number");
                    for (const name of requiredSharedLogOpenProfileNames) {
                        expect(
                            openProfile.filter((event) => event.name === name),
                            `${name} must emit exactly once during Documents.open`
                        ).toHaveLength(1);
                    }
                    for (const event of openProfile) {
                        expect(
                            event.name.startsWith("sharedLog.open.") ||
                                event.name ===
                                    "sharedLog.blocks.resolveProviders"
                        ).toBe(true);
                        expect(event.component).toBe("shared-log");
                        expect(event.durationMs).toBeTypeOf("number");
                        expect(event.durationMs!).toBeGreaterThanOrEqual(0);
                    }
                    overlayReadySamples.push(overlayReady!.atMs);
                    treeReadableSamples.push(treeReadableMs);
                    writeReadySamples.push(writeReady!.atMs);
                    pendingDrainSamples.push(pendingDrained!.durationMs);
                    let retirementTailMs: number | undefined;
                    if (
                        overlayRetired?.type === "overlay-retired" &&
                        overlayRetired.sincePendingDrainedMs !== undefined
                    ) {
                        retirementTailMs = overlayRetired.sincePendingDrainedMs;
                        retirementTailSamples.push(retirementTailMs);
                    }
                    const runSample: RunSample = {
                        run: run + 1,
                        overlayReadyMs: overlayReady!.atMs,
                        treeReadableMs,
                        writeReadyMs: writeReady!.atMs,
                        pendingDrainMs: pendingDrained!.durationMs,
                        retirementTailMs,
                        milestonesMs: runMilestones,
                        durationsMs: runDurations,
                        openProfile,
                    };
                    runSamples.push(runSample);
                    // Preserve every completed sample even if a later cold
                    // join reaches its explicit timeout or the process stops.
                    console.log(
                        "bootstrap-bench-run:",
                        JSON.stringify(runSample, (_key, value) =>
                            typeof value === "number"
                                ? Number(value.toFixed(1))
                                : value
                        )
                    );
                } finally {
                    const index = peers.indexOf(joinPeer);
                    if (index >= 0) {
                        peers.splice(index, 1);
                    }
                    await joinPeer.stop();
                }
            }

            const fast = runSamples.filter(
                (sample) => sample.overlayReadyMs <= slowThresholdMs
            );
            const slow = runSamples.filter(
                (sample) => sample.overlayReadyMs > slowThresholdMs
            );
            const summarize = (samples: Map<string, number[]>) =>
                Object.fromEntries(
                    [...samples]
                        .sort(([left], [right]) => left.localeCompare(right))
                        .map(([name, values]) => [name, distribution(values)])
                );
            const summarizeRunMap = (
                samples: RunSample[],
                key: "milestonesMs" | "durationsMs"
            ) => {
                const names = new Set(
                    samples.flatMap((sample) => Object.keys(sample[key]))
                );
                return Object.fromEntries(
                    [...names].sort().map((name) => [
                        name,
                        distribution(
                            samples.flatMap((sample) => {
                                const value = sample[key][name];
                                return value === undefined ? [] : [value];
                            })
                        ),
                    ])
                );
            };
            const summarizeCluster = (samples: RunSample[]) => ({
                count: samples.length,
                overlayReadyMs: distribution(
                    samples.map((sample) => sample.overlayReadyMs)
                ),
                treeReadableMs: distribution(
                    samples.map((sample) => sample.treeReadableMs)
                ),
                writeReadyMs: distribution(
                    samples.map((sample) => sample.writeReadyMs)
                ),
                pendingDrainMs: distribution(
                    samples.map((sample) => sample.pendingDrainMs)
                ),
                retirementTailMs: distribution(
                    samples.flatMap((sample) =>
                        sample.retirementTailMs === undefined
                            ? []
                            : [sample.retirementTailMs]
                    )
                ),
                milestonesMs: summarizeRunMap(samples, "milestonesMs"),
                durationsMs: summarizeRunMap(samples, "durationsMs"),
            });
            const openProfileNames = [
                ...new Set([
                    ...requiredSharedLogOpenProfileNames,
                    "sharedLog.open.fanout",
                    "sharedLog.blocks.resolveProviders",
                    ...runSamples.flatMap((sample) =>
                        sample.openProfile.map((event) => event.name)
                    ),
                ]),
            ].sort();
            const sharedLogOpenProfile = Object.fromEntries(
                openProfileNames.map((name) => {
                    const events = runSamples.flatMap((sample) =>
                        sample.openProfile.filter(
                            (event) => event.name === name
                        )
                    );
                    const eventsPerRun = runSamples.map(
                        (sample) =>
                            sample.openProfile.filter(
                                (event) => event.name === name
                            ).length
                    );
                    return [
                        name,
                        {
                            emitted: events.length,
                            runsWithEvent: eventsPerRun.filter(
                                (count) => count > 0
                            ).length,
                            eventsPerRun: distribution(eventsPerRun),
                            durationMs: distribution(
                                events.flatMap((event) =>
                                    event.durationMs === undefined
                                        ? []
                                        : [event.durationMs]
                                )
                            ),
                        },
                    ];
                })
            );
            console.log(
                "bootstrap-bench:",
                JSON.stringify(
                    {
                        runs,
                        snapshot: {
                            documents: Number(snapshot.docs),
                            bytes: Number(snapshot.bytes),
                            segments: snapshot.segments,
                        },
                        milestonesMs: summarize(milestoneSamples),
                        durationsMs: summarize(durationSamples),
                        treeReadableMs: distribution(treeReadableSamples),
                        writeReadyMs: distribution(writeReadySamples),
                        pendingDrainMs: distribution(pendingDrainSamples),
                        retirementTailMs: distribution(retirementTailSamples),
                        sharedLogOpenProfile,
                        samples: runSamples,
                        overlayReadyClusters: {
                            thresholdMs: slowThresholdMs,
                            modeCounts: {
                                fast: fast.length,
                                slow: slow.length,
                            },
                            fast: summarizeCluster(fast),
                            slow: summarizeCluster(slow),
                        },
                    },
                    (_key, value) =>
                        typeof value === "number"
                            ? Number(value.toFixed(1))
                            : value
                )
            );
        }
    );
});
