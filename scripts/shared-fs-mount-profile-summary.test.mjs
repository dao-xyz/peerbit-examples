import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    parseNativeMountBenchmarkArguments,
    runNativeMountBenchmark,
} from "./shared-fs-native-mount-benchmark.mjs";
import {
    classifyMountProfileFailure,
    durationStats,
    formatMountProfileSummaryMarkdown,
    formatProfilingOverheadMarkdown,
    parseMountProfileSummaryArguments,
    parseMountProfileText,
    runMountProfileSummary,
    summarizeMountProfile,
    summarizeWriteFileBreakdown,
} from "./shared-fs-mount-profile-summary.mjs";

const T0 = 1_790_000_000_000_000_000n;

const line = (
    source,
    phase,
    operation,
    offsetNs,
    durationNs,
    ok = true,
    detail
) =>
    JSON.stringify({
        schema: "peerbit.shared-fs.mount-profile",
        schemaVersion: 1,
        source,
        phase,
        operation,
        startUnixNs: (T0 + BigInt(offsetNs)).toString(),
        durationNs,
        ok,
        ...(detail ? { detail } : {}),
    });

const adapter = (phase, operation, offset, duration, ok, detail) =>
    line("native-adapter", phase, operation, offset, duration, ok, detail);
const daemon = (phase, operation, offset, duration, ok, detail) =>
    line("node-daemon", phase, operation, offset, duration, ok, detail);

// A serialized adapter: three IPC-backed callbacks and one local callback.
const adapterProfile = (withSummary = true) =>
    [
        adapter("profile.start", "open", 0, 0, true, {
            pid: 11,
            queueCapacity: 16384,
        }),
        adapter("ipc.queue", "getattr", 1_100, 100, true, {
            requestId: 1,
            localPort: 5000,
        }),
        adapter("ipc.roundTrip", "getattr", 1_200, 8_000, true, {
            requestId: 1,
            localPort: 5000,
            connected: true,
        }),
        adapter("native.callback", "getattr", 1_000, 10_000, true),
        adapter("ipc.queue", "read", 20_100, 300, true, {
            requestId: 2,
            localPort: 5000,
        }),
        adapter("ipc.roundTrip", "read", 20_400, 15_000, true, {
            requestId: 2,
            localPort: 5000,
        }),
        adapter("native.callback", "read", 20_000, 20_000, true, {
            bytes: 4096,
            offset: 0,
        }),
        adapter("ipc.queue", "getattr", 50_100, 0, true, {
            requestId: 3,
            localPort: 5000,
        }),
        adapter("ipc.roundTrip", "getattr", 50_100, 4_000, false, {
            requestId: 3,
            localPort: 5000,
            code: "ENOENT",
        }),
        adapter("native.callback", "getattr", 50_000, 5_000, false, {
            errno: -2,
            code: "ENOENT",
        }),
        adapter("native.callback", "statfs", 60_000, 500, true),
        ...(withSummary
            ? [
                  adapter("profile.summary", "close", 0, 70_000, true, {
                      pid: 11,
                      queueCapacity: 16384,
                      emitted: 12,
                      written: 10,
                      dropped: 2,
                      writeErrors: 0,
                  }),
              ]
            : []),
    ].join("\n") + "\n";

const daemonProfile = () =>
    [
        daemon("profile.start", "open", 0, 0, true, { pid: 22 }),
        daemon("ipc.service", "getattr", 2_000, 5_000, true, {
            requestId: 1,
            protocol: "v2",
            remotePort: 5000,
        }),
        daemon("ipc.service", "read", 21_000, 12_000, true, {
            requestId: 2,
            protocol: "v2",
            remotePort: 5000,
        }),
        daemon("ipc.service", "getattr", 51_000, 2_000, false, {
            requestId: 3,
            protocol: "v2",
            remotePort: 5000,
            code: "ENOENT",
        }),
        daemon("mount.target.writeFile", "writeFile", 23_000, 7_000, true, {
            bytes: 5,
            mutationGeneration: 2,
        }),
        daemon("mount.localCommit", "fsync", 22_000, 9_000, true, {
            trigger: "fsync",
            requiredCommit: true,
            commitsStarted: 1,
            commitsJoined: 0,
            writeFileNs: 7_000,
        }),
        daemon("mount.localCommit", "flush", 22_500, 8_000, true, {
            trigger: "flush",
            requiredCommit: true,
            commitsStarted: 0,
            commitsJoined: 1,
            writeFileNs: 0,
        }),
        daemon("mount.localCommit", "release", 40_000, 1_000, false, {
            trigger: "release",
            requiredCommit: true,
            commitsStarted: 1,
            commitsJoined: 0,
            writeFileNs: 600,
            code: "EAGAIN",
        }),
        daemon("profile.summary", "close", 0, 70_000, true, {
            pid: 22,
            emitted: 7,
            written: 7,
            dropped: 0,
            lost: 0,
            writeErrors: 0,
        }),
    ].join("\n") + "\n";

const parsedInputs = (adapterText = adapterProfile()) => [
    parseMountProfileText(adapterText, "native-adapter.ndjson"),
    parseMountProfileText(daemonProfile(), "node-daemon.ndjson"),
];

test("parses only valid schema records and counts every skipped line", () => {
    const parsed = parseMountProfileText(
        [
            adapter("native.callback", "getattr", 1, 2, true),
            "peerbit-shared-fs-native: unrelated diagnostic",
            JSON.stringify({ schema: "other", schemaVersion: 1 }),
            adapter("native.callback", "getattr", 1, 2, true).replace(
                '"schemaVersion":1',
                '"schemaVersion":2'
            ),
            adapter("native.callback", "getattr", 1, -2, true),
            adapter("native.callback", "getattr", 1, 2, true).replace(
                /"startUnixNs":"\d+"/u,
                '"startUnixNs":1790000000000000000'
            ),
            "   ",
            "",
        ].join("\n")
    );
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0].start, T0 + 1n);
    assert.equal(parsed.records[0].end, T0 + 3n);
    assert.deepEqual(parsed.ignored, {
        blank: 1,
        nonJson: 1,
        foreignSchema: 1,
        unsupportedVersion: 1,
        invalid: 2,
    });
});

test("classifies absent, unavailable, and other failures", () => {
    assert.equal(classifyMountProfileFailure("ENOENT"), "absent");
    for (const code of ["EAGAIN", "EIO", "EBUSY", "ETIMEDOUT", undefined]) {
        assert.equal(classifyMountProfileFailure(code), "unavailable");
    }
    for (const code of ["EEXIST", "EACCES", "EBADF", "ENOSYS"]) {
        assert.equal(classifyMountProfileFailure(code), "error");
    }
});

test("uses nearest-rank percentiles", () => {
    assert.deepEqual(durationStats([]), { count: 0 });
    const stats = durationStats(
        Array.from({ length: 100 }, (_, index) => 100 - index)
    );
    assert.equal(stats.count, 100);
    assert.equal(stats.minNs, 1);
    assert.equal(stats.p50Ns, 50);
    assert.equal(stats.p95Ns, 95);
    assert.equal(stats.p99Ns, 99);
    assert.equal(stats.maxNs, 100);
    assert.equal(stats.totalNs, 5050);
});

test("joins adapter round trips with daemon service by port and request id", () => {
    const summary = summarizeMountProfile({ inputs: parsedInputs() });
    const { ipc } = summary;
    assert.equal(ipc.roundTrips, 3);
    assert.equal(ipc.services, 3);
    assert.equal(ipc.joined, 3);
    assert.equal(ipc.keyedJoins, 3);
    assert.equal(ipc.timeJoins, 0);
    assert.equal(ipc.unmatchedRoundTrips, 0);
    assert.equal(ipc.unmatchedServices, 0);
    assert.equal(ipc.containmentViolations, 0);
    assert.equal(ipc.connectionSetupSamples, 1);
    // transport = round trip - service: 3000, 3000, 2000.
    assert.equal(ipc.transportNs.count, 3);
    assert.equal(ipc.transportNs.minNs, 2000);
    assert.equal(ipc.transportNs.p50Ns, 3000);
    assert.equal(ipc.transportNs.totalNs, 8000);
    assert.equal(ipc.queueNs.totalNs, 400);
    assert.equal(ipc.queueShareOfLane, 400 / (400 + 27_000));
    // Daemon service starts 800, 600, and 900 ns into its round trip.
    assert.equal(ipc.serviceStartOffsetNs.minNs, 600);
    assert.equal(ipc.serviceStartOffsetNs.maxNs, 900);
});

test("derives adapter overhead from contained round trips", () => {
    const { adapterCallbacks } = summarizeMountProfile({
        inputs: parsedInputs(),
    });
    assert.equal(adapterCallbacks.callbacks, 4);
    assert.equal(adapterCallbacks.callbacksWithIpc, 3);
    assert.equal(adapterCallbacks.callbacksWithoutIpc, 1);
    assert.equal(adapterCallbacks.orphanRoundTrips, 0);
    assert.equal(adapterCallbacks.overlappingCallbacks, 0);
    assert.match(adapterCallbacks.attribution, /^exact/u);
    // 10000-8000, 20000-15000, 5000-4000.
    assert.equal(adapterCallbacks.adapterOverheadNs.minNs, 1000);
    assert.equal(adapterCallbacks.adapterOverheadNs.p50Ns, 2000);
    assert.equal(adapterCallbacks.adapterOverheadNs.maxNs, 5000);
});

test("separates absent, unavailable, and error failures per phase", () => {
    const { phases } = summarizeMountProfile({ inputs: parsedInputs() });
    const find = (source, phase, operation) =>
        phases.find(
            (group) =>
                group.source === source &&
                group.phase === phase &&
                group.operation === operation
        );
    const callback = find("native-adapter", "native.callback", "getattr");
    assert.equal(callback.count, 2);
    assert.equal(callback.ok, 1);
    assert.deepEqual(callback.failures, {
        absent: 1,
        unavailable: 0,
        error: 0,
    });
    assert.deepEqual(callback.codes, { ENOENT: 1 });
    assert.deepEqual(find("node-daemon", "ipc.service", "getattr").failures, {
        absent: 1,
        unavailable: 0,
        error: 0,
    });
    assert.deepEqual(
        find("node-daemon", "mount.localCommit", "release").failures,
        { absent: 0, unavailable: 1, error: 0 }
    );
    // Groups are ordered by total time so the costliest phases lead.
    assert.deepEqual(
        phases.map((group) => group.totalNs),
        [...phases.map((group) => group.totalNs)].sort((a, b) => b - a)
    );
});

test("reports commit fences without double counting their target writes", () => {
    const { localCommit } = summarizeMountProfile({ inputs: parsedInputs() });
    assert.deepEqual(
        localCommit.map((fence) => fence.trigger),
        ["flush", "fsync", "release"]
    );
    const [flush, fsync, release] = localCommit;
    assert.equal(fsync.fenceNs.p50Ns, 9000);
    assert.equal(fsync.exclusiveOfWriteFileNs.p50Ns, 2000);
    // A fence that joined another fence's commit has no exclusive sample.
    assert.equal(flush.joinedInFlight, 1);
    assert.equal(flush.exclusiveOfWriteFileNs.count, 0);
    assert.equal(release.failed, 1);
    assert.equal(release.exclusiveOfWriteFileNs.p50Ns, 400);
});

// One profiled library write: contiguous sub-phases laid out from `offset`
// inside a `mount.target.writeFile` parent that starts 50 ns earlier.
const profiledWrite = ({
    writeId,
    offset,
    phases,
    outsideNs = 100,
    ok = true,
    parentDetail = {},
}) => {
    const lines = [];
    let cursor = offset + 50;
    for (const [phase, durationNs, detail = {}, phaseOk = true] of phases) {
        lines.push(
            daemon(
                `writeFile.${phase}`,
                "writeFile",
                cursor,
                durationNs,
                phaseOk,
                {
                    writeId,
                    ...detail,
                }
            )
        );
        cursor += durationNs;
    }
    const subPhaseNs = cursor - (offset + 50);
    lines.push(
        daemon(
            "mount.target.writeFile",
            "writeFile",
            offset,
            subPhaseNs + outsideNs,
            ok,
            { bytes: 4096, mutationGeneration: 2, writeId, ...parentDetail }
        )
    );
    return lines;
};

const existingWrite = (writeId, offset, versionPutNs) =>
    profiledWrite({
        writeId,
        offset,
        phases: [
            ["prepare", 100],
            ["resolvePath", 200],
            ["readHeads", 100],
            ["hash", 100],
            ["loadBase", 300],
            ["chunk", 100],
            [
                "touchChunks",
                1_000,
                {
                    chunks: 1,
                    probes: 1,
                    probeNs: 200,
                    witnessQueries: 0,
                    witnessNs: 0,
                    chunkPuts: 1,
                    chunkPutBytes: 4096,
                    chunkPutNs: 780,
                    absentPuts: 1,
                    linkedPuts: 0,
                    unprobedPuts: 0,
                    dedupSkips: 0,
                    dedupSkipBytes: 0,
                },
            ],
            ["guard", 150, { checkpoint: "before-version" }],
            ["versionPut", versionPutNs],
            ["cacheApply", 50, { document: "version" }],
            ["verifyChunks", 300, { chunks: 1, reputs: 0, reputBytes: 0 }],
            ["guard", 150, { checkpoint: "after-version" }],
            ["result", 50, { outcome: "created", newFile: false }],
        ],
    });

const breakdownProfile = () =>
    [
        daemon("profile.start", "open", 0, 0, true, { pid: 33 }),
        // Two existing-file writes: 2_600 ns of sub-phases besides versionPut.
        ...existingWrite(1, 100_000, 4_000),
        ...existingWrite(2, 200_000, 6_000),
        // A new file adds a naming put and a second cache update.
        ...profiledWrite({
            writeId: 3,
            offset: 300_000,
            phases: [
                ["prepare", 100],
                [
                    "touchChunks",
                    500,
                    {
                        probes: 1,
                        probeNs: 100,
                        witnessQueries: 1,
                        witnessNs: 400,
                        chunkPuts: 0,
                        chunkPutBytes: 0,
                        chunkPutNs: 0,
                        dedupSkips: 1,
                        dedupSkipBytes: 1024,
                    },
                ],
                ["versionPut", 2_000],
                ["cacheApply", 50, { document: "version" }],
                ["namingPut", 2_000],
                ["cacheApply", 50, { document: "naming" }],
                ["result", 50, { outcome: "created", newFile: true }],
            ],
        }),
        // Identical bytes: the library no-op.
        ...profiledWrite({
            writeId: 4,
            offset: 400_000,
            phases: [
                ["prepare", 100],
                ["hash", 100],
                ["guard", 100, { checkpoint: "no-op" }],
                ["result", 50, { outcome: "unchanged", newFile: false }],
            ],
        }),
        // A failure closes its sub-phase with a code; the parent fails too.
        ...profiledWrite({
            writeId: 5,
            offset: 500_000,
            ok: false,
            parentDetail: { code: "EAGAIN" },
            phases: [
                ["prepare", 100],
                ["resolvePath", 200, { code: "EAGAIN" }, false],
            ],
        }),
        // A custom target without the capability, and an older profile.
        daemon("mount.target.writeFile", "writeFile", 600_000, 900, true, {
            bytes: 1,
            mutationGeneration: 2,
            writeId: 6,
        }),
        daemon("mount.target.writeFile", "writeFile", 700_000, 900, true, {
            bytes: 1,
            mutationGeneration: 2,
        }),
        // Sub-phases without a parent, and one outside its parent's window.
        daemon("writeFile.prepare", "writeFile", 800_000, 100, true, {
            writeId: 99,
        }),
        daemon("writeFile.result", "writeFile", 900_000, 100, true, {
            writeId: 1,
        }),
        daemon("profile.summary", "close", 0, 1_000_000, true, {
            pid: 33,
            emitted: 0,
            written: 0,
            dropped: 0,
            lost: 0,
            writeErrors: 0,
        }),
    ].join("\n") + "\n";

test("breaks library writeFile time into sub-phases without double counting", () => {
    const summary = summarizeMountProfile({
        inputs: [
            parseMountProfileText(breakdownProfile(), "node-daemon.ndjson"),
        ],
    });
    const breakdown = summary.writeFileBreakdown;
    assert.equal(breakdown.writeFileRecords, 6);
    assert.equal(breakdown.joinedWrites, 5);
    assert.equal(breakdown.parentsWithoutSubPhases, 1);
    assert.equal(breakdown.unkeyedParents, 1);
    assert.equal(breakdown.orphanSubPhases, 1);
    assert.equal(breakdown.containmentViolations, 1);
    assert.equal(breakdown.overlappingSubPhases, 0);
    assert.deepEqual(breakdown.kindCounts, {
        newFile: 1,
        existingFile: 2,
        unchanged: 1,
        failed: 1,
        incomplete: 0,
    });
    assert.equal(breakdown.subPhaseGaps, 0);
    assert.equal(breakdown.incompleteWrites, 0);

    const all = breakdown.all;
    // Parents: 6_600+100, 8_600+100, 4_750+100, 350+100, 300+100.
    assert.equal(all.totalWriteFileNs, 21_100);
    assert.equal(all.writeFileNs.count, 5);
    assert.deepEqual(
        all.phases.map((phase) => phase.phase),
        [
            "writeFile.prepare",
            "writeFile.resolvePath",
            "writeFile.readHeads",
            "writeFile.hash",
            "writeFile.loadBase",
            "writeFile.chunk",
            "writeFile.touchChunks",
            "writeFile.guard",
            "writeFile.versionPut",
            "writeFile.cacheApply",
            "writeFile.verifyChunks",
            "writeFile.namingPut",
            "writeFile.result",
        ]
    );
    const phase = (name) => all.phases.find((entry) => entry.phase === name);
    const versionPut = phase("writeFile.versionPut");
    assert.equal(versionPut.writes, 3);
    assert.equal(versionPut.records, 3);
    assert.equal(versionPut.totalNs, 12_000);
    assert.equal(versionPut.perWriteNs.p50Ns, 4_000);
    assert.equal(versionPut.perWriteNs.p95Ns, 6_000);
    assert.equal(versionPut.shareOfWriteFile, 12_000 / 21_100);
    // Repeated sub-phases are summed per write before the percentiles.
    const guard = phase("writeFile.guard");
    assert.equal(guard.writes, 3);
    assert.equal(guard.records, 5);
    assert.deepEqual(
        [guard.perWriteNs.minNs, guard.perWriteNs.maxNs],
        [100, 300]
    );
    assert.equal(phase("writeFile.cacheApply").perWriteNs.maxNs, 100);
    // Sub-phases plus outside time account for every parent nanosecond once.
    const subPhaseTotal = all.phases.reduce(
        (sum, entry) => sum + entry.totalNs,
        0
    );
    assert.equal(all.outsideSubPhasesNs.totalNs, 500);
    assert.equal(subPhaseTotal + all.outsideSubPhasesNs.totalNs, 21_100);
    // Shares partition the parent time (up to floating-point rounding).
    assert.ok(
        Math.abs(
            all.phases.reduce((sum, entry) => sum + entry.shareOfWriteFile, 0) +
                all.outsideShareOfWriteFile -
                1
        ) < 1e-12
    );

    assert.equal(breakdown.byKind.existingFile.writes, 2);
    assert.equal(
        breakdown.byKind.newFile.phases.find(
            (entry) => entry.phase === "writeFile.namingPut"
        ).perWriteNs.p50Ns,
        2_000
    );
    assert.deepEqual(breakdown.touchChunks.totals, {
        probes: 3,
        witnessQueries: 1,
        dedupSkips: 1,
        dedupSkipBytes: 1024,
        chunkPuts: 2,
        chunkPutBytes: 8192,
        absentPuts: 2,
        linkedPuts: 0,
        unprobedPuts: 0,
        reputs: 0,
        reputBytes: 0,
    });
    assert.equal(breakdown.touchChunks.writes, 3);
    assert.equal(breakdown.touchChunks.taskNs.chunkPutNs.p50Ns, 780);
    assert.equal(breakdown.touchChunks.taskNs.witnessNs.maxNs, 400);

    // The per-phase table still lists sub-phases on their own.
    assert.equal(
        summary.phases.find((group) => group.phase === "writeFile.versionPut")
            .count,
        3
    );

    const markdown = formatMountProfileSummaryMarkdown(summary);
    assert.match(markdown, /### writeFile breakdown/u);
    assert.match(
        markdown,
        /Joined 5\/6 mount\.target\.writeFile records .*new file 1, existing file 2, unchanged 1, failed 1.*orphan sub-phase records=1, containment violations=1/u
    );
    assert.match(
        markdown,
        /^\| writeFile\.versionPut \| 3 \| 3 \| 0\.004 ms \| 0\.006 ms \| 56\.9% \|$/mu
    );
    assert.match(
        markdown,
        /^\| \(outside sub-phases\) \| 5 \| — \| 0\.000 ms \| 0\.000 ms \| 2\.4% \|$/mu
    );
    assert.match(markdown, /2 chunk puts \(8192 bytes; absent 2/u);
    assert.match(
        markdown,
        /^\| Sub-phase \(p50\/write\) \| new file \(1\) \| existing file \(2\) \| unchanged \(1\) \| failed \(1\) \|$/mu
    );
    assert.match(markdown, /never add a phase to its parent/u);
});

test("joins sub-phases per profile file and flags overlapping ones", () => {
    const first = parseMountProfileText(
        existingWrite(1, 100_000, 4_000).join("\n"),
        "a/node-daemon.ndjson"
    );
    const second = parseMountProfileText(
        existingWrite(1, 100_000, 5_000).join("\n"),
        "b/node-daemon.ndjson"
    );
    const breakdown = summarizeWriteFileBreakdown([
        ...first.records,
        ...second.records,
    ]);
    // The same writeId in two files is two writes, not an ambiguous join.
    assert.equal(breakdown.joinedWrites, 2);
    assert.equal(breakdown.ambiguousJoins, 0);
    assert.equal(
        breakdown.all.phases.find(
            (entry) => entry.phase === "writeFile.versionPut"
        ).totalNs,
        9_000
    );

    const overlapping = parseMountProfileText(
        [
            daemon("writeFile.prepare", "writeFile", 1_000, 500, true, {
                writeId: 7,
            }),
            daemon("writeFile.hash", "writeFile", 1_400, 500, true, {
                writeId: 7,
            }),
            daemon("mount.target.writeFile", "writeFile", 900, 2_000, true, {
                writeId: 7,
            }),
        ].join("\n")
    );
    const flagged = summarizeWriteFileBreakdown(overlapping.records);
    assert.equal(flagged.overlappingSubPhases, 1);
    assert.equal(flagged.joinedWrites, 1);
    // An overlapping chain cannot partition its parent: it is excluded.
    assert.equal(flagged.incompleteWrites, 1);
    assert.equal(flagged.all.writes, 0);
    // Profiles without writeFile sub-phases add no breakdown section.
    const plain = summarizeMountProfile({ inputs: parsedInputs() });
    assert.equal(plain.writeFileBreakdown.joinedWrites, 0);
    assert.equal(plain.writeFileBreakdown.unkeyedParents, 1);
    assert.doesNotMatch(
        formatMountProfileSummaryMarkdown(plain),
        /### writeFile breakdown/u
    );
});

const newFileWrite = (writeId, offset, { drop, ok = true } = {}) =>
    profiledWrite({
        writeId,
        offset,
        ok,
        ...(ok ? {} : { parentDetail: { code: "EAGAIN" } }),
        phases: ok
            ? [
                  ["prepare", 100],
                  ["resolvePath", 100],
                  ["readHeads", 50],
                  ["hash", 50],
                  ["chunk", 50],
                  [
                      "touchChunks",
                      700,
                      {
                          probes: 1,
                          probeNs: 100,
                          chunkPuts: 1,
                          chunkPutBytes: 1024,
                          chunkPutNs: 600,
                          absentPuts: 1,
                      },
                  ],
                  ["guard", 50, { checkpoint: "before-version" }],
                  ["versionPut", 700],
                  ["cacheApply", 20, { document: "version" }],
                  ["verifyChunks", 200, { chunks: 1, reputs: 0 }],
                  ["guard", 50, { checkpoint: "before-naming" }],
                  ["resolveParent", 30],
                  ["namingPut", 600],
                  ["cacheApply", 20, { document: "naming" }],
                  ["result", 30, { outcome: "created", newFile: true }],
              ]
            : [
                  ["prepare", 100],
                  ["resolvePath", 200, { code: "EAGAIN" }, false],
              ],
    }).filter(
        // Simulate the bounded writer dropping one record of this write.
        (line) => drop === undefined || JSON.parse(line).phase !== drop
    );

test("keeps chains with dropped sub-phase records out of the breakdown", () => {
    const text =
        [
            ...newFileWrite(1, 100_000),
            // A dropped middle record leaves a gap; its time would otherwise
            // be reported as outside the library.
            ...newFileWrite(2, 200_000, { drop: "writeFile.touchChunks" }),
            // Without writeFile.result a new file would look like an
            // existing one.
            ...newFileWrite(3, 300_000, { drop: "writeFile.result" }),
            ...newFileWrite(4, 400_000, { drop: "writeFile.prepare" }),
            // A failed call whose failing sub-phase was dropped.
            ...newFileWrite(5, 500_000, {
                ok: false,
                drop: "writeFile.resolvePath",
            }),
        ].join("\n") + "\n";
    const summary = summarizeMountProfile({
        inputs: [parseMountProfileText(text, "node-daemon.ndjson")],
    });
    const breakdown = summary.writeFileBreakdown;
    assert.equal(breakdown.joinedWrites, 5);
    assert.equal(breakdown.subPhaseGaps, 1);
    assert.equal(breakdown.overlappingSubPhases, 0);
    assert.equal(breakdown.incompleteWrites, 4);
    assert.deepEqual(breakdown.kindCounts, {
        newFile: 1,
        existingFile: 0,
        unchanged: 0,
        failed: 0,
        incomplete: 4,
    });
    assert.deepEqual(Object.keys(breakdown.byKind), ["newFile"]);

    // Only the complete write feeds the tables: 2_750 ns of sub-phases plus
    // 100 ns outside.
    const all = breakdown.all;
    assert.equal(all.writes, 1);
    assert.equal(all.totalWriteFileNs, 2_850);
    assert.equal(all.outsideSubPhasesNs.totalNs, 100);
    const namingPut = all.phases.find(
        (entry) => entry.phase === "writeFile.namingPut"
    );
    assert.equal(namingPut.writes, 1);
    assert.equal(namingPut.shareOfWriteFile, 600 / 2_850);
    assert.equal(breakdown.touchChunks.writes, 1);
    assert.equal(breakdown.touchChunks.totals.chunkPuts, 1);

    const markdown = formatMountProfileSummaryMarkdown(summary);
    assert.match(
        markdown,
        /new file 1, existing file 0, unchanged 0, failed 0, incomplete 4\).*sub-phase gaps=1, incomplete chains=4\./u
    );
    assert.match(
        markdown,
        /Incomplete chains \(dropped, overlapping, or out-of-order sub-phase records\) are excluded from the tables below, which cover 1 complete writes\./u
    );
    assert.match(
        markdown,
        /^\| mount\.target\.writeFile \| 1 \| 1 \| 0\.003 ms \| 0\.003 ms \| 100% \|$/mu
    );
});

test("reports drops and sessions that ended without a summary", () => {
    const complete = summarizeMountProfile({ inputs: parsedInputs() });
    assert.equal(complete.integrity.dropped, 2);
    assert.equal(complete.integrity.incompleteSessions, 0);
    assert.equal(complete.integrity.adapterRecordsPresent, true);

    const killed = summarizeMountProfile({
        inputs: parsedInputs(adapterProfile(false)),
    });
    assert.equal(killed.integrity.incompleteSessions, 1);
    assert.equal(killed.integrity.dropped, 0);

    const daemonOnly = summarizeMountProfile({
        inputs: [parseMountProfileText(daemonProfile(), "node-daemon.ndjson")],
    });
    assert.equal(daemonOnly.integrity.adapterRecordsPresent, false);
    assert.equal(daemonOnly.ipc.unmatchedServices, 3);
    assert.match(
        formatMountProfileSummaryMarkdown(daemonOnly),
        /Adapter records present: no/u
    );
});

test("falls back to request id and time when no connection port exists", () => {
    const withoutPorts = (text) =>
        text
            .replaceAll(/,"localPort":5000/gu, "")
            .replaceAll(/,"remotePort":5000/gu, "");
    const summary = summarizeMountProfile({
        inputs: [
            parseMountProfileText(withoutPorts(adapterProfile()), "adapter"),
            parseMountProfileText(withoutPorts(daemonProfile()), "daemon"),
        ],
    });
    assert.equal(summary.ipc.joined, 3);
    assert.equal(summary.ipc.timeJoins, 3);

    // Outside the tolerance, a time-only join is refused rather than guessed.
    const strict = summarizeMountProfile({
        inputs: [
            parseMountProfileText(withoutPorts(adapterProfile()), "adapter"),
            parseMountProfileText(
                withoutPorts(daemonProfile()).replace(
                    (T0 + 2_000n).toString(),
                    (T0 + 900_000_000n).toString()
                ),
                "daemon"
            ),
        ],
        joinToleranceNs: 0,
    });
    assert.equal(strict.ipc.joined, 2);
    assert.equal(strict.ipc.unmatchedServices, 1);
});

test("flags keyed joins whose clocks disagree beyond the tolerance", () => {
    const skewed = daemonProfile().replace(
        (T0 + 21_000n).toString(),
        (T0 + 5_000_000n).toString()
    );
    const summary = summarizeMountProfile({
        inputs: [
            parseMountProfileText(adapterProfile(), "adapter"),
            parseMountProfileText(skewed, "daemon"),
        ],
    });
    assert.equal(summary.ipc.joined, 3);
    assert.equal(summary.ipc.containmentViolations, 1);
});

test("marks overlapping callbacks as ambiguous instead of attributing them", () => {
    const overlapping =
        adapterProfile() +
        adapter("native.callback", "getattr", 1_500, 30_000, true) +
        "\n";
    const { adapterCallbacks } = summarizeMountProfile({
        inputs: [parseMountProfileText(overlapping, "adapter")],
    });
    assert.ok(adapterCallbacks.overlappingCallbacks > 0);
    assert.match(adapterCallbacks.attribution, /^ambiguous/u);
});

const benchmarkReport = async () => {
    const temporary = await mkdtemp(
        join(tmpdir(), "peerbit-mount-profile-summary-bench-")
    );
    try {
        return await runNativeMountBenchmark(
            parseNativeMountBenchmarkArguments([
                "--mount",
                temporary,
                "--target-kind",
                "local-filesystem-control",
                "--samples",
                "2",
                "--warmups",
                "1",
                "--small-files",
                "1",
                "--readdir-entries",
                "1",
                "--overwrite-base-bytes",
                "4096",
                "--timeout-ms",
                "30000",
            ])
        );
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
};

test("attributes records to measured benchmark samples and excludes warmups", async () => {
    const report = await benchmarkReport();
    const stat = report.scenarios.find(({ name }) => name === "stat-1048576");
    const read = report.scenarios.find(({ name }) => name === "read-4096");
    const at = (value, phase, source = "native-adapter") =>
        JSON.stringify({
            schema: "peerbit.shared-fs.mount-profile",
            schemaVersion: 1,
            source,
            phase,
            operation: "getattr",
            startUnixNs: value,
            durationNs: 1000,
            ok: true,
        });
    const text = [
        at(stat.warmupSamples[0].startedAtUnixNs, "native.callback"),
        at(stat.samples[0].startedAtUnixNs, "native.callback"),
        at(stat.samples[0].endedAtUnixNs, "native.callback"),
        at(read.samples[1].startedAtUnixNs, "ipc.service", "node-daemon"),
        at(T0.toString(), "native.callback"),
    ].join("\n");
    const summary = summarizeMountProfile({
        inputs: [parseMountProfileText(text, "profile")],
        benchmarks: [{ label: "A1", report }],
    });
    const [attribution] = summary.benchmark;
    assert.equal(attribution.label, "A1");
    assert.equal(attribution.warmupRecords, 1);
    assert.equal(attribution.unattributedRecords, 1);
    const statSummary = attribution.scenarios.find(
        ({ name }) => name === "stat-1048576"
    );
    // Two callbacks in sample 0, none in sample 1.
    assert.equal(statSummary.callbacksPerSample.maxNs, 2);
    assert.equal(statSummary.callbacksPerSample.minNs, 0);
    const readSummary = attribution.scenarios.find(
        ({ name }) => name === "read-4096"
    );
    assert.deepEqual(
        readSummary.phases.map(({ phase }) => phase),
        ["node-daemon ipc.service"]
    );
    assert.equal(readSummary.phases[0].nsPerSample.maxNs, 1000);
    assert.match(
        formatMountProfileSummaryMarkdown(summary),
        /### Benchmark attribution: A1/u
    );

    const tampered = structuredClone(report);
    tampered.schemaVersion = 2;
    assert.throws(
        () =>
            summarizeMountProfile({
                inputs: [parseMountProfileText(text, "profile")],
                benchmarks: [{ label: "bad", report: tampered }],
            }),
        /envelope is invalid/u
    );
});

test("formats alternating profiled and unprofiled passes", async () => {
    const report = await benchmarkReport();
    const scaled = (factor) => {
        const copy = structuredClone(report);
        for (const scenario of copy.scenarios) {
            scenario.summary.p50Ns *= factor;
        }
        return copy;
    };
    // The validator recomputes summaries, so the overhead formatter must
    // refuse a tampered report instead of reporting its numbers.
    assert.throws(
        () =>
            formatProfilingOverheadMarkdown([
                { label: "A1", profiled: false, report: scaled(2) },
            ]),
        /invalid p50Ns summary/u
    );
    const markdown = formatProfilingOverheadMarkdown([
        { label: "A1", profiled: false, report },
        { label: "B1", profiled: true, report },
        { label: "B2", profiled: true, report },
        { label: "A2", profiled: false, report },
    ]);
    assert.match(markdown, /A1 \(unprofiled\) p50 \| B1 \(profiled\) p50/u);
    assert.match(markdown, /\| stat-1048576 \|.*\| 1\.000× \|/u);
});

test("runs from profile directories and writes JSON and Markdown", async () => {
    const temporary = await mkdtemp(
        join(tmpdir(), "peerbit-mount-profile-summary-cli-")
    );
    try {
        const profile = join(temporary, "profile");
        await mkdir(profile);
        await writeFile(
            join(profile, "native-adapter.ndjson"),
            adapterProfile()
        );
        await writeFile(join(profile, "node-daemon.ndjson"), daemonProfile());
        await writeFile(join(profile, "notes.txt"), "not a profile\n");
        const options = parseMountProfileSummaryArguments([
            "--profile-dir",
            profile,
            "--json",
            join(temporary, "out", "summary.json"),
            "--markdown",
            join(temporary, "out", "summary.md"),
            "--max-rows",
            "2",
            "--title",
            "Shared FS mount profile: pass B1 (profiled)",
        ]);
        const { summary, markdown } = await runMountProfileSummary(options);
        // Distinct titles keep several passes apart in one step summary.
        assert.match(
            markdown,
            /^## Shared FS mount profile: pass B1 \(profiled\)$/mu
        );
        assert.equal(summary.inputs.length, 2);
        assert.equal(summary.ipc.joined, 3);
        const written = JSON.parse(
            await readFile(join(temporary, "out", "summary.json"), "utf8")
        );
        assert.equal(written.schema, "peerbit.shared-fs.mount-profile-summary");
        assert.equal(
            await readFile(join(temporary, "out", "summary.md"), "utf8"),
            markdown
        );
        assert.match(markdown, /### IPC lane: queue vs service/u);
        assert.match(markdown, /### Local commit fences/u);
        assert.match(markdown, /more phase groups in the JSON summary/u);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});

test("rejects incomplete or unknown summary arguments", () => {
    assert.throws(
        () => parseMountProfileSummaryArguments([]),
        /provide --profile-dir/u
    );
    assert.throws(
        () => parseMountProfileSummaryArguments(["--input"]),
        /requires a value/u
    );
    assert.throws(
        () => parseMountProfileSummaryArguments(["--bogus", "x"]),
        /Unknown argument/u
    );
    assert.throws(
        () => parseMountProfileSummaryArguments(["--ab-report", "A1=x.json"]),
        /--ab-report requires/u
    );
    assert.throws(
        () =>
            parseMountProfileSummaryArguments([
                "--input",
                "x",
                "--title",
                "two\nlines",
            ]),
        /--title requires a single line/u
    );
    assert.throws(
        () =>
            parseMountProfileSummaryArguments([
                "--input",
                "x",
                "--join-tolerance-ns",
                "-1",
            ]),
        /non-negative/u
    );
    const options = parseMountProfileSummaryArguments([
        "--ab-report",
        "B1:profiled=b1.json",
        "--benchmark",
        "B1=b1.json",
    ]);
    assert.equal(options.abReports[0].profiled, true);
    assert.equal(options.benchmarks[0].label, "B1");
});
