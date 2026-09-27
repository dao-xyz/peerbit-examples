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
